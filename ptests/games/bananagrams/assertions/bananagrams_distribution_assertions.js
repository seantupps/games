/**
 * Assert board + pool letter counts match the starting tile bag (solo or MP).
 * Intended after post-game review — all tiles should still be accounted for.
 */

/** @param {import('playwright').Frame} frame @param {Record<string, { tiles?: { id?: string, letter?: string }[] }>|null} [endingSnapshots] */
async function readTileDistributionState(frame, endingSnapshots = null) {
    return frame.evaluate((snaps) => {
        const g = window.game;
        const rules = typeof BananaRules !== 'undefined' ? BananaRules : null;
        if (!g || !rules) {
            return { ok: false, reason: 'missing-game-or-rules' };
        }

        const cfg = rules.resolveBagConfig(new URLSearchParams(window.location.search));
        const mode = g._isMultiplayerMode?.() ? 'multiplayer' : 'solo';
        const bag = rules.getTileBag(mode, cfg);
        const bagLabel = mode === 'multiplayer' ? 'scrabble-mp' : (cfg.soloVariant === 'classic' ? 'solo-classic' : 'solo-fast');

        const frozen = g._mpFinalAuthoritySnapshot || null;
        const canonical = {
            ...(frozen?.canonical || {}),
            ...(g._mpCanonicalById || {})
        };
        const resolveLetter = (entry) => {
            if (typeof entry === 'string') {
                const fromCanon = canonical[entry];
                if (fromCanon) return g._mpNormLetter?.(fromCanon) || fromCanon;
                const ch = entry.toUpperCase();
                return /^[A-Z]$/.test(ch) ? ch : null;
            }
            const id = entry && typeof entry === 'object' ? entry.id : null;
            if (id && canonical[id]) {
                return g._mpNormLetter?.(canonical[id]) || canonical[id];
            }
            if (id && typeof g._mpLetter === 'function') {
                const fromLive = g._mpLetter(id);
                if (fromLive) return g._mpNormLetter?.(fromLive) || fromLive;
            }
            const ch = String(entry?.letter || '').toUpperCase();
            return /^[A-Z]$/.test(ch) ? ch : null;
        };

        const counts = {};
        const add = (entry) => {
            const ch = resolveLetter(entry);
            if (!ch) return;
            counts[ch] = (counts[ch] || 0) + 1;
        };

        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const inReview = !!(
            g._postGameReview
            || g._inReviewExperience?.()
            || board?.phase === 'review'
            || board?.reviewPhase === true
        );
        const reviewLayoutsOrig = board?.reviewLayoutsOrig || null;
        const reviewLayouts = board?.reviewLayouts || g._reviewLayouts || null;
        const ownedByPlayer = board?.tilesOwnedByPlayer
            || (typeof g.isHost === 'function' && g.isHost() && g._mpOwned ? g._mpOwned : null);
        const useReviewLayouts = mode === 'multiplayer'
            && inReview
            && (reviewLayoutsOrig || reviewLayouts)
            && Object.values(reviewLayoutsOrig || reviewLayouts).some((list) => list?.length);

        const expectedTotal = rules.poolTotal(bag);
        const ownedTotal = ownedByPlayer
            ? Object.values(ownedByPlayer).reduce((n, list) => n + (list?.length || 0), 0)
            : 0;

        const addUniqueTiles = (lists) => {
            const seenIds = new Set();
            Object.values(lists || {}).forEach((list) => {
                (list || []).forEach((t) => {
                    const id = t?.id;
                    if (id) {
                        if (seenIds.has(id)) return;
                        seenIds.add(id);
                    }
                    add(t);
                });
            });
            return seenIds.size || Object.values(lists || {}).reduce((n, list) => n + (list?.length || 0), 0);
        };

        let countSource = 'runtime';
        let countedTiles = 0;
        const snapLayouts = snaps && typeof snaps === 'object'
            ? Object.fromEntries(
                Object.values(snaps)
                    .filter((s) => s?.uid && s?.tiles?.length)
                    .map((s) => [s.uid, s.tiles])
            )
            : null;
        const snapTotal = snapLayouts
            ? Object.values(snapLayouts).reduce((n, list) => n + (list?.length || 0), 0)
            : 0;
        const preferReviewLayouts = snaps === null;
        if (mode === 'multiplayer' && frozen?.canonical && Object.keys(frozen.canonical).length) {
            Object.entries(frozen.canonical).forEach(([id, ch]) => add({ id, letter: ch }));
            countedTiles = Object.keys(frozen.canonical).length;
            countSource = 'frozen-authority';
        } else if (mode === 'multiplayer' && inReview && !preferReviewLayouts && snapLayouts && snapTotal >= expectedTotal) {
            countedTiles = addUniqueTiles(snapLayouts);
            countSource = g.isHost?.() && Object.keys(canonical).length
                ? 'host-canonical'
                : 'ending-snapshots';
        } else if (useReviewLayouts && reviewLayoutsOrig) {
            countedTiles = addUniqueTiles(reviewLayoutsOrig);
            countSource = 'review-orig';
        } else if (useReviewLayouts) {
            countedTiles = addUniqueTiles(reviewLayouts);
            countSource = 'review-display';
        } else if (mode === 'multiplayer' && inReview && ownedByPlayer && ownedTotal >= expectedTotal) {
            countedTiles = addUniqueTiles(ownedByPlayer);
            countSource = 'owned-ids';
        } else {
            (g.tiles || []).forEach((t) => add(t));
            const pool = Array.isArray(g._tilePool) ? g._tilePool : [];
            pool.forEach((id) => add(id));
            countedTiles = (g.tiles?.length ?? 0) + pool.length;
            countSource = 'runtime';
        }

        const mismatches = [];
        const letters = new Set([...Object.keys(bag), ...Object.keys(counts)]);
        for (const letter of letters) {
            const got = counts[letter] || 0;
            const want = bag[letter] || 0;
            if (got !== want) mismatches.push({ letter, got, want });
        }

        const actualTotal = Object.values(counts).reduce((sum, n) => sum + n, 0);

        return {
            ok: mismatches.length === 0 && actualTotal === expectedTotal,
            bagLabel,
            mode,
            expectedTotal,
            actualTotal,
            countSource,
            boardTiles: countedTiles,
            poolLen: countSource === 'runtime' && Array.isArray(g._tilePool) ? g._tilePool.length : 0,
            mismatches,
            counts
        };
    }, endingSnapshots);
}

/** @param {import('playwright').Frame} frame @param {string} [label] @param {{ endingSnapshots?: Record<string, { tiles?: { id?: string, letter?: string }[] }>, requireReviewLayouts?: boolean }} [opts] */
async function assertTileDistributionInReview(frame, label = 'tile-distribution', opts = {}) {
    const inReview = await frame.evaluate(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        return !!(
            g?._postGameReview
            || g?._inReviewExperience?.()
            || board?.phase === 'review'
            || board?.reviewPhase === true
        );
    });
    if (!inReview) {
        throw new Error(`${label}: expected post-game review before distribution check`);
    }

    const snapArg = opts.requireReviewLayouts ? null : (opts.endingSnapshots || null);
    const state = await readTileDistributionState(frame, snapArg);
    if (!state.ok) {
        throw new Error(
            `${label}: tile distribution must match starting bag (${JSON.stringify({
                bag: state.bagLabel,
                mode: state.mode,
                expectedTotal: state.expectedTotal,
                actualTotal: state.actualTotal,
                boardTiles: state.boardTiles,
                poolLen: state.poolLen,
                countSource: state.countSource,
                mismatches: (state.mismatches || []).slice(0, 12)
            })})`
        );
    }
    return state;
}

function letterCountsFromTiles(tiles) {
    const counts = {};
    (tiles || []).forEach((t) => {
        const ch = String(t?.letter || '').toUpperCase();
        if (!/^[A-Z]$/.test(ch)) return;
        counts[ch] = (counts[ch] || 0) + 1;
    });
    return counts;
}

function diffCounts(a, b) {
    const letters = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    const mismatches = [];
    for (const letter of letters) {
        const got = a[letter] || 0;
        const want = b[letter] || 0;
        if (got !== want) mismatches.push({ letter, got, want, delta: got - want });
    }
    return mismatches.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/**
 * Id-pool diagnostics: canonical authority, membership partition, runtime letter drift.
 * Returns a compact summary suitable for logging (no legacy owned.letter probes).
 */
async function probeTileDistributionSources(hostFrame, guestFrame, hostUid, guestUid) {
    const hostProbe = await hostFrame.evaluate(({ hostUid, guestUid }) => {
        const g = window.game;
        const rules = typeof BananaRules !== 'undefined' ? BananaRules : null;
        const bag = rules ? rules.getTileBag('multiplayer', rules.resolveBagConfig(
            new URLSearchParams(window.location.search)
        )) : null;
        const board = (typeof RtdbSchema !== 'undefined' && g.roomData)
            ? RtdbSchema.readBoardFromRoom(g.roomData)
            : g.roomData?.global?.board;
        const frozen = g._mpFinalAuthoritySnapshot || null;
        const canonical = {
            ...(frozen?.canonical || {}),
            ...(g._mpCanonicalById || {})
        };
        const letterFor = (id, fallbackLetter) => {
            if (id && canonical[id]) {
                return String(g._mpNormLetter?.(canonical[id]) || canonical[id]).toUpperCase();
            }
            if (id && typeof g._mpLetter === 'function') {
                const live = g._mpLetter(id);
                if (live) return String(g._mpNormLetter?.(live) || live).toUpperCase();
            }
            const ch = String(fallbackLetter || '').toUpperCase();
            return /^[A-Z]$/.test(ch) ? ch : null;
        };
        const sigFromTiles = (tiles) => {
            const c = {};
            (tiles || []).forEach((t) => {
                const ch = letterFor(t?.id, t?.letter);
                if (!ch) return;
                c[ch] = (c[ch] || 0) + 1;
            });
            return c;
        };
        const sigFromCanon = (canonMap) => {
            const c = {};
            Object.values(canonMap || {}).forEach((letter) => {
                const ch = String(g._mpNormLetter?.(letter) || letter || '').toUpperCase();
                if (/^[A-Z]$/.test(ch)) c[ch] = (c[ch] || 0) + 1;
            });
            return c;
        };
        const runtimeDrift = (tiles) => {
            const drift = [];
            (tiles || []).forEach((t) => {
                if (!t?.id) return;
                const canon = letterFor(t.id, null);
                const rt = String(t.letter || '').toUpperCase();
                if (canon && rt && canon !== rt) {
                    drift.push({ id: t.id, canonical: canon, runtime: rt });
                }
            });
            return drift;
        };
        const membershipFromFrozen = () => {
            if (!frozen?.canonical) return null;
            const seen = new Set();
            (frozen.pool || []).forEach((id) => { if (id) seen.add(id); });
            Object.values(frozen.ownedByPlayer || {}).forEach((ids) => {
                (ids || []).forEach((id) => { if (id) seen.add(id); });
            });
            return {
                canonical: Object.keys(frozen.canonical).length,
                pool: (frozen.pool || []).length,
                unique: seen.size
            };
        };
        const reviewOrig = board?.reviewLayoutsOrig || null;
        const reviewOrigSigs = reviewOrig
            ? Object.fromEntries(
                Object.entries(reviewOrig).map(([uid, list]) => [
                    uid,
                    { n: list?.length || 0, sig: sigFromTiles(list) }
                ])
            )
            : null;
        const hostDrift = runtimeDrift(g.tiles);
        return {
            bag,
            frozen: membershipFromFrozen(),
            frozenSig: frozen?.canonical ? sigFromCanon(frozen.canonical) : null,
            reviewOrigSigs,
            reviewOrigTotal: reviewOrig
                ? Object.values(reviewOrig).reduce((n, list) => n + (list?.length || 0), 0)
                : 0,
            host: {
                runtimeN: g.tiles?.length || 0,
                ownedN: g._mpOwned?.[hostUid]?.length || 0,
                runtimeSig: sigFromTiles(g.tiles),
                runtimeDrift: hostDrift.slice(0, 6),
                runtimeDriftN: hostDrift.length
            },
            guestOnHost: {
                ownedN: g._mpOwned?.[guestUid]?.length || 0,
                boardOwnedN: board?.tilesOwnedByPlayer?.[guestUid]?.length || 0
            },
            lastInvariant: g._lastMpDistCheck || null,
            firstCorrupt: g._mpFirstLetterCorruption || null
        };
    }, { hostUid, guestUid });

    const guestProbe = await guestFrame.evaluate(() => {
        const g = window.game;
        const canonical = {
            ...(g._mpFinalAuthoritySnapshot?.canonical || {}),
            ...(g._mpCanonicalById || {})
        };
        const letterFor = (id, fallbackLetter) => {
            if (id && canonical[id]) {
                return String(g._mpNormLetter?.(canonical[id]) || canonical[id]).toUpperCase();
            }
            if (id && typeof g._mpLetter === 'function') {
                const live = g._mpLetter(id);
                if (live) return String(g._mpNormLetter?.(live) || live).toUpperCase();
            }
            const ch = String(fallbackLetter || '').toUpperCase();
            return /^[A-Z]$/.test(ch) ? ch : null;
        };
        const drift = [];
        (g.tiles || []).forEach((t) => {
            if (!t?.id) return;
            const canon = letterFor(t.id, null);
            const rt = String(t.letter || '').toUpperCase();
            if (canon && rt && canon !== rt) drift.push({ id: t.id, canonical: canon, runtime: rt });
        });
        const sig = {};
        (g.tiles || []).forEach((t) => {
            const ch = letterFor(t?.id, t?.letter);
            if (!ch) return;
            sig[ch] = (sig[ch] || 0) + 1;
        });
        return {
            runtimeN: g.tiles?.length || 0,
            runtimeSig: sig,
            runtimeDrift: drift.slice(0, 6),
            runtimeDriftN: drift.length
        };
    });

    const bag = hostProbe.bag || {};
    const reviewOrigCombined = Object.values(hostProbe.reviewOrigSigs || {}).reduce((acc, { sig }) => {
        Object.entries(sig || {}).forEach(([ch, n]) => { acc[ch] = (acc[ch] || 0) + n; });
        return acc;
    }, {});

    return {
        frozen: hostProbe.frozen,
        frozenVsBag: diffCounts(hostProbe.frozenSig, bag),
        reviewOrigTotal: hostProbe.reviewOrigTotal,
        reviewOrigVsBag: diffCounts(reviewOrigCombined, bag),
        reviewOrigSigs: hostProbe.reviewOrigSigs,
        hostRuntimeDriftN: hostProbe.host.runtimeDriftN,
        hostRuntimeDrift: hostProbe.host.runtimeDrift,
        guestRuntimeDriftN: guestProbe.runtimeDriftN,
        guestRuntimeDrift: guestProbe.runtimeDrift,
        lastInvariant: hostProbe.lastInvariant,
        firstCorrupt: hostProbe.firstCorrupt,
        host: hostProbe.host,
        guestRuntime: guestProbe
    };
}

/** One-line summary for test logs. */
function formatDistributionDiagnostics(distState, probe) {
    const parts = [
        `${distState.countSource} total=${distState.actualTotal}/${distState.expectedTotal}`,
        `bagMismatches=${distState.mismatches?.length || 0}`
    ];
    if (probe?.frozen) {
        parts.push(`frozen canon=${probe.frozen.canonical} unique=${probe.frozen.unique} pool=${probe.frozen.pool}`);
    }
    if (probe?.reviewOrigTotal) {
        parts.push(`reviewOrig=${probe.reviewOrigTotal}`);
    }
    const driftN = (probe?.hostRuntimeDriftN || 0) + (probe?.guestRuntimeDriftN || 0);
    if (driftN) {
        parts.push(`runtimeDrift=${driftN}`);
    } else {
        parts.push('runtimeDrift=0');
    }
    if (probe?.lastInvariant && probe.lastInvariant.ok === false) {
        parts.push('lastInvariant=FAIL');
    }
    if (probe?.firstCorrupt) {
        parts.push(`firstCorrupt=${probe.firstCorrupt.id || '?'}`);
    }
    return parts.join(', ');
}

module.exports = {
    readTileDistributionState,
    assertTileDistributionInReview,
    probeTileDistributionSources,
    formatDistributionDiagnostics,
    letterCountsFromTiles,
    diffCounts
};
