/**
 * Targeted review-layout failure bundle — concise root-cause for assertActionsReviewLayouts.
 */
const { getGameFrame } = require('../../../shared/platform/mp-waits');

/** @param {import('playwright').Frame} frame */
function reviewLayoutDiagScript() {
    const g = window.game;
    if (!g?._checker || typeof BananaGrid === 'undefined') {
        return { ok: false, reason: 'missing-game' };
    }
    const room = g.roomData;
    const board = (typeof RtdbSchema !== 'undefined' && room)
        ? RtdbSchema.readBoardFromRoom(room)
        : room?.global?.board;
    const winnerUid = g._winnerUid || board?.winnerUid || null;
    const origLayouts = board?.reviewLayoutsOrig || {};
    const displayLayouts = board?.reviewLayouts || g._reviewLayouts || {};
    const roster = ((typeof g._getPlayerUids === 'function' ? g._getPlayerUids() : null)
        || board?.playerUids
        || Object.keys(room?.playerData || {}).filter(Boolean)).sort();

    const normLetter = (ch) => String(ch || '').toUpperCase().replace(/[^A-Z]/g, '');
    const tileKey = (t) => `${t.id}:${normLetter(t.letter)}@${t.x},${t.y}`;

    const findWordTiles = (tiles, word) => {
        if (!word || !tiles?.length) return null;
        const target = String(word).toUpperCase();
        const onBoard = tiles.filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
        const byCell = new Map();
        onBoard.forEach((t) => {
            byCell.set(`${Math.round(t.x)},${Math.round(t.y)}`, t);
        });
        const tryLine = (dx, dy) => {
            for (const start of onBoard) {
                const sx = Math.round(start.x);
                const sy = Math.round(start.y);
                const chain = [];
                for (let i = 0; i < target.length; i++) {
                    const cell = byCell.get(`${sx + dx * i},${sy + dy * i}`);
                    if (!cell) { chain.length = 0; break; }
                    chain.push(cell);
                }
                if (chain.length === target.length) {
                    const spelled = chain.map((t) => normLetter(t.letter)).join('');
                    if (spelled === target) {
                        return chain.map((t) => tileKey(t));
                    }
                }
            }
            return null;
        };
        return tryLine(1, 0) || tryLine(0, 1);
    };

    const validateLayout = (uid, tileList, source) => {
        if (!Array.isArray(tileList) || !tileList.length) {
            return {
                uid, source, tileCount: 0, reason: 'no-layout',
                connected: false, gridOk: false, validWinBoard: false
            };
        }
        const tiles = tileList.map((t) => ({
            id: t.id,
            letter: t.letter,
            x: t.x,
            y: t.y,
            faceUp: true
        }));
        const fullGrid = BananaGrid.validateGrid(tiles, g._checker);
        const fullConnected = BananaGrid.isConnected(tiles);
        const unique = BananaGrid.eachTileOccupiesUniqueCell(tiles);
        const { tiles: mainTiles, disconnected } = BananaGrid.largestComponentTiles(tiles);
        const mainGrid = mainTiles.length
            ? BananaGrid.validateGrid(mainTiles, g._checker)
            : { ok: false, words: [], reason: 'empty-main' };
        const mainConnected = mainTiles.length >= 6 && BananaGrid.isConnected(mainTiles);
        const dupIds = tiles.map((t) => t.id).filter((id, i, arr) => arr.indexOf(id) !== i);
        const badLetters = tiles
            .filter((t) => !/^[A-Z]$/.test(normLetter(t.letter)))
            .slice(0, 6)
            .map((t) => ({ id: t.id, letter: t.letter }));
        const invalidWord = mainGrid.word || fullGrid.word || null;
        return {
            uid,
            source,
            tileCount: tiles.length,
            stragglers: disconnected,
            mainTileCount: mainTiles.length,
            validWinBoard: !!(fullGrid.ok && fullConnected && unique
                && (fullGrid.words || []).some((w) => String(w || '').length >= 3)),
            connected: mainConnected,
            gridOk: mainGrid.ok,
            words: (mainGrid.words || []).slice(0, 16),
            invalidReason: mainGrid.ok ? null : (mainGrid.reason || fullGrid.reason || null),
            invalidWord,
            invalidWordTiles: findWordTiles(mainTiles.length ? mainTiles : tiles, invalidWord),
            uniqueCells: unique,
            dupIdCount: dupIds.length,
            badLetterCount: badLetters.length,
            badLetters,
            sample: tiles.slice(0, 4).map(tileKey),
            allTileIds: tiles.map((t) => t.id)
        };
    };

    const compareLayouts = (uid) => {
        const orig = origLayouts[uid] || [];
        const display = displayLayouts[uid] || [];
        if (!orig.length && !display.length) return null;
        const origMap = new Map(orig.map((t) => [t.id, tileKey(t)]));
        const displayMap = new Map(display.map((t) => [t.id, tileKey(t)]));
        let letterDrift = 0;
        let posDrift = 0;
        let missingOnDisplay = 0;
        orig.forEach((t) => {
            const d = displayMap.get(t.id);
            if (!d) { missingOnDisplay += 1; return; }
            const oNorm = tileKey(t);
            if (oNorm !== d) {
                if (normLetter(t.letter) !== normLetter(display.find((x) => x.id === t.id)?.letter)) {
                    letterDrift += 1;
                } else {
                    posDrift += 1;
                }
            }
        });
        return {
            origN: orig.length,
            displayN: display.length,
            letterDrift,
            posDrift,
            missingOnDisplay,
            extraOnDisplay: Math.max(0, display.length - origMap.size)
        };
    };

    const players = roster.map((uid) => {
        const origVal = validateLayout(uid, origLayouts[uid], 'reviewLayoutsOrig');
        const displayVal = validateLayout(uid, displayLayouts[uid], 'reviewLayouts');
        const drift = compareLayouts(uid);
        return {
            uid,
            role: uid === winnerUid ? 'winner' : 'loser',
            wire: origVal,
            display: displayVal,
            origVsDisplay: drift
        };
    });

    const me = g._myUid?.() || null;
    const endingCache = g._endingLayoutsCache?.[me] || null;
    const endingCacheVal = Array.isArray(endingCache) && endingCache.length
        ? validateLayout(me, endingCache, 'endingLayoutsCache')
        : null;
    const runtimeVal = me ? validateLayout(me, (g.tiles || []).map((t) => ({
        id: t.id, letter: t.letter, x: t.x, y: t.y, faceUp: true
    })), 'runtime') : null;

    const loserUid = roster.find((uid) => uid !== winnerUid) || null;
    const wireLoser = loserUid ? (origLayouts[loserUid] || []) : [];
    const cacheVsWire = endingCache?.length && wireLoser.length && loserUid === me
        ? (() => {
            const wireById = new Map(wireLoser.map((t) => [t.id, normLetter(t.letter)]));
            let letterMismatch = 0;
            const samples = [];
            endingCache.forEach((t) => {
                const w = wireById.get(t.id);
                if (w == null) return;
                const c = normLetter(t.letter);
                if (c !== w) {
                    letterMismatch += 1;
                    if (samples.length < 4) samples.push({ id: t.id, cache: c, wire: w });
                }
            });
            return { letterMismatch, samples };
        })()
        : null;

    const coherence = window.__bananaMpDebug?.coherence?.()
        ?? g._mpCoherenceSnapshot?.(board, me, 'review-fail')
        ?? null;

    const runtimeDupes = runtimeVal?.tileCount
        ? (() => {
            const ids = (g.tiles || []).map((t) => t.id);
            const unique = new Set(ids);
            const epochMismatch = ids.filter((id) => g._mpIdMatchesDealEpoch?.(id) === false).length;
            return {
                total: ids.length,
                unique: unique.size,
                dupExtra: Math.max(0, ids.length - unique.size),
                epochMismatch
            };
        })()
        : null;

    const revLag = g.boardRevision != null && g.appliedRevision != null
        && g.boardRevision !== g.appliedRevision;

    const suspects = [];
    const loser = players.find((p) => p.role === 'loser');
    const guestPublishedStale = endingCacheVal?.invalidWord
        && endingCacheVal.invalidWord === loser?.wire?.invalidWord
        && !(cacheVsWire?.letterMismatch);
    const hostCorruptedLetters = !!(cacheVsWire?.letterMismatch);

    if (guestPublishedStale) {
        suspects.push(
            `Guest victory-layout froze+publishes its own invalid crossword "${endingCacheVal.invalidWord}"`
            + ' — host wire mirrors guest payload (not host letter corruption); fix guest layout projection before review'
            + ' (mp-review.js _freezeMyEndingLayout, mp-inventory-pipeline.js, mp-layout.js)'
        );
    } else if (loser?.wire?.invalidReason === 'invalid-word') {
        const tiles = loser.wire.invalidWordTiles?.length
            ? ` at [${loser.wire.invalidWordTiles.join(', ')}]`
            : '';
        suspects.push(
            `Wire reviewLayoutsOrig for ${loser.uid} contains invalid word "${loser.wire.invalidWord}"${tiles}`
            + ' — check mp-host.js victory-layout letter canonicalization'
        );
    }
    if (hostCorruptedLetters) {
        suspects.push(
            `Guest endingLayoutsCache vs host wire: ${cacheVsWire.letterMismatch} letter mismatch(es)`
            + ` ${JSON.stringify(cacheVsWire.samples)} — host canonicalization corrupted guest victory-layout`
        );
    }
    if (loser?.wire?.invalidReason === 'disconnected') {
        suspects.push(`Loser main crossword disconnected on wire — victory-layout may be incomplete`);
    }
    if (loser?.origVsDisplay?.letterDrift) {
        suspects.push(
            `reviewLayoutsOrig vs reviewLayouts letter drift (${loser.origVsDisplay.letterDrift})`
            + ' — host display transform may corrupt letters'
        );
    }
    if (runtimeDupes?.dupExtra > 0) {
        suspects.unshift(
            `Guest runtime has ${runtimeDupes.dupExtra} duplicate tile id(s)`
            + ` (${runtimeDupes.total} objects, ${runtimeDupes.unique} unique)`
            + ' — double inventory projection; check mp-board.js apply + mp-review.js review ingress'
        );
    } else if (runtimeVal && loser?.wire && runtimeVal.tileCount !== loser.wire.tileCount) {
        suspects.push(
            `Runtime tile count ${runtimeVal.tileCount} ≠ wire ${loser.wire.tileCount}`
            + ' — guest revision apply lag or stale runtime not cleared at review transition'
        );
    }
    if (revLag) {
        suspects.push(
            `Guest revision lag boardRev=${g.boardRevision} applied=${g.appliedRevision}`
            + ' — final board apply blocked; check _mpGuestRevisionAllowsBoardApply (mp-board.js)'
        );
    }
    if (coherence?.failed?.includes('inventorySynced')) {
        suspects.push('inventorySynced=false — guest inventory pipeline did not finish before review assert');
    }
    if (runtimeDupes?.epochMismatch > 0) {
        suspects.push(
            `Guest runtime has ${runtimeDupes.epochMismatch} tile id(s) from wrong deal epoch`
            + ' — stale tiles not cleared on reset/split'
        );
    }
    if (g._mpFirstLetterCorruption) {
        suspects.push(`Letter corruption recorded: ${JSON.stringify(g._mpFirstLetterCorruption)}`);
    }
    if (!suspects.length && loser && !loser.wire.gridOk) {
        suspects.push('Loser wire layout fails grid validation — inspect reviewLayoutsOrig on host board');
    }

    const owned = board?.tilesOwnedByPlayer?.[me] || [];
    const playingState = (() => {
        const tiles = g.tiles || [];
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const rackOpts = g._rackLayoutOptions?.();
        let layoutAuthority = null;
        try {
            layoutAuthority = g._mpLayoutAuthoritySnapshot?.(board, me, owned) || null;
        } catch (_) { /* ignore */ }
        return {
            onStartingRack: !!(tiles.length && BananaGrid.isStartingRack(tiles, origin, rackOpts)),
            projectionMode: g._mpTilesProjectionMode || null,
            layoutAuthority
        };
    })();

    let failureMode = 'unknown';
    if (runtimeDupes?.dupExtra > 0) failureMode = 'double-projection';
    else if (runtimeDupes?.epochMismatch > 0) failureMode = 'stale-epoch-runtime';
    else if (guestPublishedStale) failureMode = 'stale-guest-victory-layout';
    else if (hostCorruptedLetters) failureMode = 'host-letter-corruption';
    else if (revLag) failureMode = 'revision-lag';
    else if (loser?.wire?.invalidReason === 'invalid-word') failureMode = 'invalid-wire-layout';

    return {
        kind: 'review-layout',
        failureMode,
        role: g.playerRole || (g.isHost?.() ? 'host' : 'guest'),
        uid: me,
        winnerUid,
        phase: board?.phase ?? null,
        boardRevision: board?.boardRevision ?? null,
        appliedRevision: g._mpAppliedBoardRevision ?? null,
        localBoardSeq: g._boardSeq ?? null,
        boardSeq: board?.seq ?? null,
        reviewEndingLayoutsFrozen: !!g._reviewEndingLayoutsFrozen,
        myEndingLayoutPublished: !!g._myEndingLayoutPublished,
        endingCacheN: Array.isArray(endingCache) ? endingCache.length : 0,
        endingCache: endingCacheVal,
        cacheVsWire,
        runtime: runtimeVal,
        runtimeDupes,
        runtimeTileIds: (g.tiles || []).map((t) => t.id),
        endingCacheTileIds: (endingCache || []).map((t) => t.id),
        playingState,
        revLag,
        guestPublishedStale,
        hostCorruptedLetters,
        players,
        coherenceFailed: coherence?.failed || [],
        guestAuthorityReady: g._mpGuestAuthorityReadyForPlay?.() ?? null,
        firstCorrupt: g._mpFirstLetterCorruption || null,
        suspects
    };
}

/**
 * @param {import('playwright').Frame} hostFrame
 * @param {import('playwright').Frame} [guestFrame]
 */
async function captureReviewLayoutFailureDiag(hostFrame, guestFrame = null) {
    const host = await hostFrame.evaluate(reviewLayoutDiagScript);
    let guest = null;
    if (guestFrame) {
        guest = await guestFrame.evaluate(reviewLayoutDiagScript);
    }
    return { host, guest };
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} [guestPage]
 */
async function captureReviewLayoutFailureFromPages(hostPage, guestPage = null) {
    const hostFrame = await getGameFrame(hostPage);
    const guestFrame = guestPage ? await getGameFrame(guestPage) : null;
    return captureReviewLayoutFailureDiag(hostFrame, guestFrame);
}

/**
 * Compare runtime / wire / ending-cache tile id sets.
 * @param {string[]} runtimeIds
 * @param {string[]} wireIds
 * @param {string[]} cacheIds
 */
function analyzeRuntimeIdSets(runtimeIds, wireIds, cacheIds) {
    const runtime = new Set(runtimeIds || []);
    const wire = new Set(wireIds || []);
    const cache = new Set(cacheIds || []);
    const extraInRuntime = [...runtime].filter((id) => !wire.has(id));
    const missingFromRuntime = [...wire].filter((id) => !runtime.has(id));
    const cacheOnly = [...cache].filter((id) => !runtime.has(id));
    const runtimeOnly = [...runtime].filter((id) => !cache.has(id));
    const dupExtra = Math.max(0, (runtimeIds || []).length - runtime.size);

    let summary = 'runtime and wire ids differ';
    if (dupExtra > 0) {
        summary = `${dupExtra} duplicate id(s) in runtime objects (stacked projection)`;
    } else if (extraInRuntime.length && extraInRuntime.length === runtime.size - wire.size) {
        summary = `${extraInRuntime.length} extra unique id(s) in runtime not on wire (playing layer not cleared)`;
    } else if (runtime.size === wire.size + cache.size && cache.size === wire.size) {
        summary = 'runtime likely unions playing hand + ending cache without dedupe';
    }

    return {
        runtimeN: runtimeIds?.length ?? 0,
        wireN: wireIds?.length ?? 0,
        cacheN: cacheIds?.length ?? 0,
        uniqueRuntime: runtime.size,
        dupExtra,
        extraInRuntimeN: extraInRuntime.length,
        missingFromRuntimeN: missingFromRuntime.length,
        cacheOnlyN: cacheOnly.length,
        runtimeOnlyN: runtimeOnly.length,
        extraSample: extraInRuntime.slice(0, 4),
        summary
    };
}

/**
 * @param {{ host: object, guest?: object|null, playthroughContext?: object|null }} bundle
 * @param {object|null} [playthroughContext]
 */
function enrichReviewLayoutDiagBundle(bundle, playthroughContext = null) {
    const out = { ...bundle, playthroughContext: playthroughContext || bundle.playthroughContext || null };
    const loser = out.host?.players?.find((p) => p.role === 'loser');
    const wireIds = loser?.wire?.allTileIds || [];
    if (out.guest && wireIds.length) {
        out.guest = {
            ...out.guest,
            runtimeIdAnalysis: analyzeRuntimeIdSets(
                out.guest.runtimeTileIds,
                wireIds,
                out.guest.endingCacheTileIds
            )
        };
    }
    return out;
}

/**
 * @param {{ host: object, guest?: object|null, playthroughContext?: object|null }} bundle
 * @returns {string[]}
 */
function buildRootCauseChain(bundle) {
    const chain = [];
    const ctx = bundle.playthroughContext;
    const guest = bundle.guest;
    const loser = bundle.host?.players?.find((p) => p.role === 'loser');
    let n = 0;
    const step = (text) => { n += 1; chain.push(`${n}. ${text}`); };

    if (ctx?.auditSteps?.includes('refresh')) {
        step('Audit refresh test persisted mid-game guest layout to localStorage / client layout store');
    }
    if (ctx?.aiReset) {
        step(`AI playthrough reset re-dealt hands (resetCount=${ctx.aiReset.resetCount ?? '?'}, `
            + `host tiles=${ctx.aiReset.tiles ?? '?'})`);
    }

    const guestRounds = ctx?.guestRounds || [];
    if (guestRounds.length) {
        const r1 = guestRounds[0];
        if (r1.rack === 0 && r1.board > 0) {
            step(`Guest never returned to starting rack after reset — round ${r1.round}: `
                + `rack=0 board=${r1.board} grid-invalid="${r1.gridInvalidWord || '?'}"`);
        } else if (r1.rack > 0) {
            step(`Guest started playthrough on rack (round ${r1.round}: rack=${r1.rack})`);
        }
        const invalidRounds = guestRounds.filter((r) => r.gridOk === false);
        if (invalidRounds.length) {
            const first = invalidRounds[0];
            const last = invalidRounds[invalidRounds.length - 1];
            const wordTrail = [...new Set(invalidRounds.map((r) => r.gridInvalidWord).filter(Boolean))].slice(0, 4);
            step(`Guest stayed on invalid crossword all playthrough (${invalidRounds.length}/${guestRounds.length} rounds, `
                + `board ${first.board}→${last.board} tiles, invalid words: ${wordTrail.join(' → ') || '?'})`);
        }
    }

    if (ctx?.preWinGuest) {
        step(`Pre-review guest had ${ctx.preWinGuest.tileCount} positioned tiles (host valid win board)`);
    }
    if (ctx?.winRound) {
        step(`Host won round ${ctx.winRound.round}; guest steered-loser never built a valid board`);
    }

    if (guest?.guestPublishedStale && loser?.wire?.invalidWord) {
        step(`At victory guest froze invalid crossword and published victory-layout — wire invalid "${loser.wire.invalidWord}"`);
    }

    const ida = guest?.runtimeIdAnalysis;
    if (ida?.runtimeN && loser?.wire?.tileCount) {
        if (ida.dupExtra > 0) {
            step(`Review assert: guest runtime ${ida.runtimeN} objects = ${ida.uniqueRuntime} unique ids + ${ida.dupExtra} duplicates (double projection)`);
        } else if (ida.extraInRuntimeN > 0) {
            step(`Review assert: guest runtime ${ida.runtimeN} tiles vs ${ida.wireN} on wire — ${ida.extraInRuntimeN} extra id(s): ${ida.summary}`);
        } else {
            step(`Review assert: guest runtime ${ida.runtimeN} tiles vs wire ${ida.wireN} — ${ida.summary}`);
        }
    } else if (guest?.runtime?.tileCount && loser?.wire?.tileCount
        && guest.runtime.tileCount !== loser.wire.tileCount) {
        step(`Review assert: guest runtime ${guest.runtime.tileCount} tiles vs wire ${loser.wire.tileCount}`);
    }

    if (guest?.revLag) {
        step(`Guest revision lag (applied ${guest.appliedRevision} < boardRev ${guest.boardRevision}) — inventory not settled before review check`);
    }

    return chain;
}

/**
 * Rank and dedupe fix-first hints — drop contradictions when root cause is known.
 * @param {{ host: object, guest?: object|null }} bundle
 * @returns {string[]}
 */
function rankSuspects(bundle) {
    const guest = bundle.guest;
    const raw = [
        ...(bundle.guest?.suspects || []),
        ...(bundle.host?.suspects || [])
    ];
    const dropPatterns = [];
    if (guest?.guestPublishedStale && !guest?.hostCorruptedLetters) {
        dropPatterns.push(/canonicalization/i, /letter canonicalization/i);
    }
    if (guest?.runtimeIdAnalysis?.dupExtra > 0 || guest?.runtimeIdAnalysis?.extraInRuntimeN > 0) {
        dropPatterns.push(/revision apply lag or stale runtime/i);
        dropPatterns.push(/Runtime tile count \d+ ≠ wire/i);
    }

    const seen = new Set();
    return raw.filter((s) => {
        if (!s || seen.has(s)) return false;
        if (dropPatterns.some((re) => re.test(s))) return false;
        seen.add(s);
        return true;
    }).slice(0, 3);
}

/**
 * @param {{ host: object, guest?: object|null, playthroughContext?: object|null }} bundle
 * @returns {string}
 */
function inferReviewVerdict(bundle) {
    const hostPlayers = bundle.host?.players || [];
    const loser = hostPlayers.find((p) => p.role === 'loser');
    const w = loser?.wire;
    const guest = bundle.guest;
    if (!w) return 'Loser review layout missing or empty on host wire';

    const chain = buildRootCauseChain(bundle);
    if (chain.length >= 3 && guest?.guestPublishedStale && w.invalidWord) {
        const staleRound = bundle.playthroughContext?.guestRounds?.[0];
        const rackHint = staleRound?.rack === 0 ? ' (guest never left stale post-refresh layout)' : '';
        return `Stale guest crossword published at victory (invalid "${w.invalidWord}")${rackHint}`
            + ' — fix guest layout projection reset, not host letter canonicalization';
    }
    if (guest?.runtimeIdAnalysis?.dupExtra > 0) {
        const ida = guest.runtimeIdAnalysis;
        return `Guest double-projected tiles at review (${ida.runtimeN} objects / ${ida.uniqueRuntime} unique vs ${w.tileCount} wire)`
            + ' — inventory not cleared before review assert';
    }
    if (guest?.runtimeDupes?.dupExtra > 0) {
        const d = guest.runtimeDupes;
        return `Guest has double-projected tiles (${d.total} runtime / ${d.unique} unique vs ${w.tileCount} on wire)`
            + ' — review assert ran before guest inventory settled';
    }
    if (guest?.guestPublishedStale && w.invalidWord) {
        return `Guest published stale local crossword at victory (invalid "${w.invalidWord}")`
            + ' — host wire mirrors guest victory-layout; fix guest layout sync, not host letters';
    }
    if (guest?.hostCorruptedLetters && w.invalidWord) {
        return `Host corrupted guest victory-layout letters (wire invalid "${w.invalidWord}")`
            + ' — check mp-host.js victory-layout canonicalization';
    }
    if (guest?.revLag && w.invalidWord) {
        return `Guest revision lag at review (boardRev ${guest.boardRevision} vs applied ${guest.appliedRevision})`
            + ` with invalid loser wire "${w.invalidWord}"`;
    }
    if (w.invalidReason === 'invalid-word' && w.invalidWord) {
        return `Guest review wire layout has invalid word "${w.invalidWord}"`
            + ' — inspect victory-layout publish path (mp-host.js, mp-review.js)';
    }
    if (!w.connected) {
        return 'Guest review wire layout main crossword not connected — victory-layout incomplete';
    }
    if (!w.gridOk) {
        return `Guest review wire layout grid invalid (${w.invalidReason || 'unknown'})`;
    }
    return 'Guest review layout failed validation';
}

function spellInvalidChain(invalidWordTiles) {
    if (!invalidWordTiles?.length) return null;
    const letters = invalidWordTiles.map((tk) => {
        const m = String(tk).match(/:([A-Z])@/);
        return m ? m[1] : '?';
    });
    return letters.join('');
}

function formatReviewLayoutFailure(bundle) {
    const lines = [];
    lines.push('── REVIEW LAYOUT FAILURE ──────────────────────────────');
    const verdict = inferReviewVerdict(bundle);
    lines.push(`VERDICT: ${verdict}`);
    const mode = bundle.guest?.failureMode || bundle.host?.failureMode;
    if (mode && mode !== 'unknown') {
        lines.push(`MODE: ${mode}`);
    }

    const rootChain = buildRootCauseChain(bundle);
    if (rootChain.length) {
        lines.push('CHAIN:');
        rootChain.forEach((line) => lines.push(`  ${line}`));
    }

    const hostPlayers = bundle.host?.players || [];
    const loser = hostPlayers.find((p) => p.role === 'loser');
    const winner = hostPlayers.find((p) => p.role === 'winner');

    if (loser?.wire) {
        const w = loser.wire;
        lines.push(`Loser:  ${loser.uid} (${w.mainTileCount} main + ${w.stragglers} stragglers on wire)`);
        if (w.invalidWordTiles?.length) {
            const spelled = spellInvalidChain(w.invalidWordTiles);
            lines.push(`Tiles:  ${w.invalidWordTiles.join(' → ')}`);
            if (spelled && spelled !== w.invalidWord) {
                lines.push(`Chain spells: "${spelled}" (validator reported "${w.invalidWord}")`);
            }
        }
        if (w.words?.length) {
            lines.push(`Words:  ${w.words.join(', ')}${w.words.length >= 16 ? '…' : ''}`);
        }
        if (w.badLetterCount) {
            lines.push(`Bad letters: ${w.badLetterCount} tiles ${JSON.stringify(w.badLetters)}`);
        }
        if (w.dupIdCount) {
            lines.push(`Duplicate tile ids in wire layout: ${w.dupIdCount}`);
        }
    }

    if (winner?.wire?.validWinBoard) {
        lines.push(`Winner: ${winner.uid} valid (${winner.wire.tileCount} tiles)`);
    } else if (winner?.wire) {
        lines.push(`Winner: ${winner.uid} ALSO INVALID — ${winner.wire.invalidReason || 'grid-fail'}`);
    }

    if (loser?.origVsDisplay) {
        const d = loser.origVsDisplay;
        if (d.letterDrift || d.posDrift || d.missingOnDisplay || d.extraOnDisplay) {
            lines.push(
                `Orig→display drift: letter=${d.letterDrift} pos=${d.posDrift}`
                + ` missing=${d.missingOnDisplay} extra=${d.extraOnDisplay}`
            );
        }
    }

    if (bundle.guest) {
        const g = bundle.guest;
        lines.push(
            `Guest client: runtime=${g.runtime?.tileCount ?? '?'} tiles`
            + ` endingCache=${g.endingCacheN}`
            + (g.revLag ? ` REVISION LAG boardRev=${g.boardRevision} applied=${g.appliedRevision}` : '')
        );
        if (g.playingState) {
            lines.push(
                `  playingState: onStartingRack=${g.playingState.onStartingRack ? 'yes' : 'no'}`
                + ` projection=${g.playingState.projectionMode || '?'}`
                + (g.playingState.layoutAuthority?.source
                    ? ` layoutSrc=${g.playingState.layoutAuthority.source}` : '')
            );
        }
        if (g.runtimeIdAnalysis) {
            const ida = g.runtimeIdAnalysis;
            lines.push(
                `  ids: runtime=${ida.runtimeN} unique=${ida.uniqueRuntime} wire=${ida.wireN}`
                + ` cache=${ida.cacheN} dup=${ida.dupExtra} extra=${ida.extraInRuntimeN}`
            );
            if (ida.extraSample?.length) {
                lines.push(`  extra runtime ids: ${ida.extraSample.join(', ')}`);
            }
            lines.push(`  → ${ida.summary}`);
        } else if (g.runtimeDupes?.dupExtra > 0) {
            lines.push(
                `  DUPES: ${g.runtimeDupes.dupExtra} duplicate id(s)`
                + ` (${g.runtimeDupes.total} objects, ${g.runtimeDupes.unique} unique ids)`
            );
        }
        if (g.runtime && loser?.wire && g.runtime.tileCount !== loser.wire.tileCount && !g.runtimeIdAnalysis) {
            lines.push(
                `  runtime≠wire (${g.runtime.tileCount} vs ${loser.wire.tileCount})`
                + ` localSeq=${g.localBoardSeq} boardSeq=${g.boardSeq}`
            );
        }
        if (g.guestPublishedStale) {
            lines.push('  guest victory-layout = source of bad wire (cache invalid matches wire, no letter drift)');
        } else if (g.hostCorruptedLetters) {
            lines.push('  host corrupted guest letters between cache and wire');
        }
        if (g.coherenceFailed?.length) {
            lines.push(`  coherence failed: ${g.coherenceFailed.join(', ')}`);
        }
        if (g.guestAuthorityReady === false) {
            lines.push('  guestAuthorityReady=false');
        }
        if (g.endingCache?.invalidWord) {
            lines.push(
                `  endingCache invalid="${g.endingCache.invalidWord}"`
                + (g.endingCache.invalidWord === loser?.wire?.invalidWord ? ' (matches wire)' : ' (≠ wire)')
            );
        }
        if (g.cacheVsWire?.letterMismatch) {
            lines.push(`  cache→wire letter mismatch: ${g.cacheVsWire.letterMismatch} ${JSON.stringify(g.cacheVsWire.samples)}`);
        }
        if (g.runtime?.invalidWord && g.runtime.invalidWord !== loser?.wire?.invalidWord) {
            lines.push(`  guest runtime invalid word "${g.runtime.invalidWord}" (wire "${loser?.wire?.invalidWord || '?'}")`);
        }
    }

    const suspects = rankSuspects(bundle);
    if (suspects.length) {
        lines.push('Fix first:');
        suspects.forEach((s) => lines.push(`  → ${s}`));
    }

    lines.push('────────────────────────────────────────────────────────');
    return lines.join('\n');
}

module.exports = {
    captureReviewLayoutFailureDiag,
    captureReviewLayoutFailureFromPages,
    enrichReviewLayoutDiagBundle,
    formatReviewLayoutFailure,
    buildRootCauseChain,
    reviewLayoutDiagScript
};
