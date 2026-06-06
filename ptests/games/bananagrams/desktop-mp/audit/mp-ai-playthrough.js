/**
 * MP 2p AI playthrough — solver-driven mid-game placement; peel/dump/win via game APIs.
 * Winning placement uses real pointer drag (natural snap + _checkPeel on release).
 * Guest/host sync relies on RTDB board + banana interactions (no inventory/pool test cheats).
 */
const { solveAttemptFromBrowserState, getDictionary } = require('../../ai');
const {
    log,
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    RESET_WAIT_MS,
    seedBananaRoom,
    joinGuest,
    joinBananaPartyViaInvite,
    assertHostDealPool,
    EXPECTED_MP_2P_POOL,
    waitForDeal,
    getHandAndPool,
    assertStartingRackConnected,
    waitPoolBoth,
    waitPoolBothWithFlush,
    assertPoolSyncedBothStrict,
    assertPoolSyncedBothNatural,
    readPoolSyncState,
    waitForDiag,
    getGameFrame,
    enableFastBanners,
    enableInstantBanners,
    splitViaDrag,
    flushHostBananaInteractions,
    naturalDrag,
    waitDumpResult,
    waitGuestDumpResult,
    assertActionBannerOnBoth,
    dismissBanners,
    mpPollMs,
    mpVictoryWaitMs,
    mpReviewWaitMs
} = require('../../lib/mp-lib');
const stateLog = require('./actions-state-log');
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const {
    centerMpViewerOnPages,
    isMpHeaded,
    layoutMpHeadedWindows,
    mpHeadedSlotSize,
    relayoutMpHeadedForReview
} = require('../../../../shared/platform/mp-headed-view');
const {
    capturePreReviewBoardsByPlayer,
    assertReviewPreservesPreWinBoards,
    waitMpResetAfterDone,
    waitMpClientsInReview,
    waitMpClientsPostWinReady,
    waitForHostReviewReady,
    assertGuestReviewVisibleWithoutInteraction,
    assertReviewViewportStable,
    assertReviewBoardsFullyVisible,
    mergeGuestLayoutOnHost
} = require('../../assertions/bananagrams_postgame_assertions');
const {
    assertTileDistributionInReview,
    probeTileDistributionSources,
    readTileDistributionState,
    formatDistributionDiagnostics
} = require('../../assertions/bananagrams_distribution_assertions');

async function probeHeadedMobileViewport(pages, label, mobile) {
    if (!mobile || !isMpHeaded()) return;
    const {
        headedMobileViewportProbeEnabled,
        assertHeadedMobileEmulatedViewport
    } = require('../../../../shared/platform/mp-headed-assertions');
    if (!headedMobileViewportProbeEnabled()) return;
    await assertHeadedMobileEmulatedViewport(pages, label, log);
}

async function syncHeadedDesktopMpView(pages, logFn = log) {
    if (!isMpHeaded()) return;
    await layoutMpHeadedWindows(pages);
    const slot = mpHeadedSlotSize(pages.length);
    logFn(`Headed MP tiles: ${slot.width}×${slot.height} (${pages.length}p)`);
    await centerMpViewerOnPages(pages);
}

/** In-browser snapshot (solo-style largest-component rack/board). */
const SNAPSHOT_BROWSER_STATE = `() => {
    const g = window.game;
    const won = !!(
        g._winnerUid || g._victoryRegistered || g.isOver
        || g._inReviewExperience?.()
        || (typeof g._isBoardInReview === 'function' && g._isBoardInReview())
    );
    const origin = g.ORIGIN;
    const gap = BananaRules.TILE_GAP;
    const opts = g._rackLayoutOptions();
    const rackBounds = BananaGrid.getRackBounds(
        { x: origin, y: origin }, opts.cols, opts.gap, opts.tileSize, opts.handBelowCenter
    );
    const originPt = { x: origin, y: origin };
    const tileLetter = (t) => {
        if (typeof g._mpLetter === 'function' && g._mpPoolUsesTileIds?.()) {
            const canon = g._mpLetter(t.id);
            if (canon) return canon;
        }
        return t.letter;
    };
    if (typeof g._mpHydrateTiles === 'function' && g._mpPoolUsesTileIds?.()) {
        g.tiles = g._mpHydrateTiles(g.tiles);
    }
    if (BananaGrid.isStartingRack(g.tiles, originPt, opts)) {
        return {
            rack: g.tiles.map((t) => ({ id: t.id, letter: tileLetter(t) })),
            boardCells: [],
            poolLen: g._tilePool.length,
            tileCount: g.tiles.length,
            gameStarted: !!g.gameStarted,
            origin, gap, winner: won, allPlaced: false, gridOk: false
        };
    }
    const toCell = (t) => ({
        gx: Math.round((t.x - origin) / gap),
        gy: Math.round((t.y - origin) / gap)
    });
    const visited = new Set();
    let largest = [];
    for (const seed of g.tiles) {
        if (visited.has(seed.id)) continue;
        const component = [];
        const queue = [seed];
        visited.add(seed.id);
        while (queue.length) {
            const cur = queue.pop();
            component.push(cur);
            const { gx, gy } = toCell(cur);
            for (const other of g.tiles) {
                if (visited.has(other.id)) continue;
                const { gx: ox, gy: oy } = toCell(other);
                if (Math.abs(ox - gx) + Math.abs(oy - gy) === 1) {
                    visited.add(other.id);
                    queue.push(other);
                }
            }
        }
        if (component.length > largest.length) largest = component;
    }
    const boardIds = new Set(largest.map((t) => t.id));
    const rack = [];
    const boardCells = [];
    for (const t of g.tiles) {
        if (boardIds.has(t.id)) {
            const { gx, gy } = toCell(t);
            boardCells.push({ gx, gy, letter: tileLetter(t), id: t.id });
        } else {
            rack.push({ id: t.id, letter: tileLetter(t) });
        }
    }
    const handForGrid = typeof g._snapHandForValidation === 'function'
        ? g._snapHandForValidation(g.tiles)
        : g.tiles;
    const allPlaced = typeof g._allTilesPlacedOn === 'function'
        ? g._allTilesPlacedOn(handForGrid)
        : false;
    const gridCheck = BananaGrid.validateGrid(handForGrid, g._checker);
    return {
        rack,
        boardCells,
        poolLen: g._tilePool.length,
        tileCount: g.tiles.length,
        gameStarted: !!g.gameStarted,
        origin,
        gap,
        winner: won,
        allPlaced,
        gridOk: gridCheck.ok
    };
}`;

async function injectSnapshot(frames) {
    await Promise.all(frames.map((f) => f.evaluate((fnStr) => {
        window.snapshotMpAiState = new Function('return ' + fnStr)();
    }, SNAPSHOT_BROWSER_STATE)));
}

/** Focus audit helper — solver-driven placement until peel-ready grid. */
async function solveAndApplyAiMove(frame) {
    await injectSnapshot([frame]);
    let snap = await frame.evaluate(() => window.snapshotMpAiState());
    for (let attempt = 0; attempt < 8; attempt++) {
        const peelReady = await frame.evaluate(() => {
            const g = window.game;
            if (!g?._checker || typeof BananaGrid === 'undefined') return false;
            const hand = typeof g._snapHandForValidation === 'function'
                ? g._snapHandForValidation(g.tiles)
                : g.tiles;
            const grid = BananaGrid.validateGrid(hand, g._checker);
            if (!grid.ok || !BananaGrid.isConnected(hand)) return false;
            const hasThree = (grid.words || []).some((w) => String(w || '').length >= 3);
            if (!hasThree) return false;
            return typeof g._allTilesPlacedOn === 'function' ? g._allTilesPlacedOn(hand) : true;
        });
        if (peelReady) return { ok: true };
        const solved = solveAttemptFromBrowserState({
            boardCells: snap.boardCells,
            rackLetters: (snap.rack || []).map((r) => r.letter)
        });
        if (!solved.changed || !solved.placements?.length) {
            return {
                ok: false,
                reason: 'solver-stuck',
                rack: snap.rack?.length ?? 0,
                board: snap.boardCells?.length ?? 0
            };
        }
        const applied = await applyPlacements(frame, snap, solved);
        if (!applied.ok) return { ok: false, reason: 'apply-failed', applied };
        snap = await frame.evaluate(() => window.snapshotMpAiState());
        if ((snap.rack || []).length > 0 && (snap.rack || []).length <= 2) {
            const brute = await frame.evaluate(() => {
                const g = window.game;
                if (!g?._checker || typeof BananaGrid === 'undefined') return false;
                const gap = window.BananaRules.TILE_GAP;
                const origin = g.ORIGIN;
                const toCell = (t) => ({
                    gx: Math.round((t.x - origin) / gap),
                    gy: Math.round((t.y - origin) / gap)
                });
                const occupied = new Set((g.tiles || []).map((t) => {
                    const { gx, gy } = toCell(t);
                    return `${gx},${gy}`;
                }));
                const rackTiles = (g.tiles || []).filter((t) => {
                    const { gx, gy } = toCell(t);
                    return Math.abs(gx) > 8 || Math.abs(gy) > 8;
                });
                if (!rackTiles.length) return true;
                const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
                for (const tile of rackTiles) {
                    let placed = false;
                    for (const [dx, dy] of dirs) {
                        for (const key of occupied) {
                            const [gx, gy] = key.split(',').map(Number);
                            const nx = gx + dx;
                            const ny = gy + dy;
                            const nkey = `${nx},${ny}`;
                            if (occupied.has(nkey)) continue;
                            tile.x = origin + nx * gap;
                            tile.y = origin + ny * gap;
                            const hand = typeof g._snapHandForValidation === 'function'
                                ? g._snapHandForValidation(g.tiles)
                                : g.tiles;
                            const grid = BananaGrid.validateGrid(hand, g._checker);
                            if (grid.ok && BananaGrid.isConnected(hand)) {
                                occupied.add(nkey);
                                placed = true;
                                g._persistMpLayout?.();
                                break;
                            }
                            occupied.delete(nkey);
                        }
                        if (placed) break;
                    }
                    if (!placed) return false;
                }
                g.requestRender?.();
                return true;
            });
            if (!brute) {
                return { ok: false, reason: 'brute-stuck', rack: snap.rack?.length ?? 0 };
            }
            snap = await frame.evaluate(() => window.snapshotMpAiState());
        }
    }
    return { ok: false, reason: 'max-attempts' };
}

async function readPeelSeq(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return board?.peelSeq || 0;
    });
}

/** Drop grid placements that would consume rack tiles reserved for win steering. */
function filterPlacementsForReservedRack(snap, placements, reservedIds) {
    const reserved = new Set(reservedIds || []);
    if (!reserved.size) return placements || [];
    const reservedLetters = new Set(
        (snap.rack || []).filter((r) => reserved.has(r.id))
            .map((r) => String(r.letter).toUpperCase())
    );
    if (!reservedLetters.size) return placements || [];
    const occupied = new Set((snap.boardCells || []).map((c) => `${c.gx},${c.gy}`));
    return (placements || []).filter((p) => {
        const want = String(p.letter || '').toUpperCase();
        if (occupied.has(`${p.gx},${p.gy}`)) return true;
        return !reservedLetters.has(want);
    });
}

function attachSnapshotTileIds(snap, placements) {
    return require('../lib/ai-snapshot-apply').attachSnapshotTileIds(snap, placements);
}

async function applyPlacements(frame, snap, solved, opts = {}) {
    const reservedTileIds = opts.reservedTileIds || [];
    const raw = opts.onlyPlacements ?? solved.placements;
    const placements = attachSnapshotTileIds(snap, raw);
    if (!placements.length) return { ok: true, placed: 0 };
    return frame.evaluate(({ placements, origin, gap, reservedIds }) => {
        const g = window.game;
        const reserved = new Set(reservedIds || []);
        const used = new Set();
        const halfGap = gap / 2;
        const byId = new Map((g.tiles || []).map((t) => [t.id, t]));
        for (const p of placements) {
            const tx = origin + p.gx * gap;
            const ty = origin + p.gy * gap;
            const want = String(p.letter || '').toUpperCase();
            let best = null;
            if (p.id && byId.has(p.id) && !used.has(p.id) && !reserved.has(p.id)) {
                const pinned = byId.get(p.id);
                const pinLetter = typeof g._mpLetter === 'function'
                    ? (g._mpLetter(pinned.id) || pinned.letter)
                    : pinned.letter;
                if (pinLetter.toUpperCase() === want) best = pinned;
            }
            if (!best) {
                let bestD = Infinity;
                for (const t of g.tiles) {
                    if (used.has(t.id) || reserved.has(t.id)) continue;
                    const tileLetter = typeof g._mpLetter === 'function'
                        ? (g._mpLetter(t.id) || t.letter)
                        : t.letter;
                    if (tileLetter.toUpperCase() !== want) continue;
                    if (Math.abs(t.x - tx) <= halfGap && Math.abs(t.y - ty) <= halfGap) {
                        best = t;
                        bestD = 0;
                        break;
                    }
                    const d = (t.x - tx) ** 2 + (t.y - ty) ** 2;
                    if (d < bestD) { bestD = d; best = t; }
                }
            }
            if (!best) return { ok: false, reason: 'missing-tile', letter: p.letter };
            used.add(best.id);
            best.x = tx;
            best.y = ty;
            best.faceUp = true;
            if (typeof g._mpLetter === 'function') {
                const canon = g._mpLetter(best.id);
                if (canon) best.letter = canon;
            }
        }
        const rackOpts = g._rackLayoutOptions();
        const rb = BananaGrid.getRackBounds(
            { x: origin, y: origin },
            rackOpts.cols, rackOpts.gap, rackOpts.tileSize, rackOpts.handBelowCenter
        );
        const unassigned = g.tiles.filter((t) => !used.has(t.id));
        for (let i = 0; i < unassigned.length; i++) {
            const row = Math.floor(i / rackOpts.cols);
            const col = i % rackOpts.cols;
            unassigned[i].x = rb.x + col * rackOpts.gap;
            unassigned[i].y = rb.y + row * rackOpts.gap;
            unassigned[i].faceUp = true;
        }
        if (g._persistMpLayout) g._persistMpLayout();
        if (typeof g._mpHydrateTiles === 'function') {
            g.tiles = g._mpHydrateTiles(g.tiles);
        }
        if (typeof g.requestRender === 'function') g.requestRender();
        return { ok: true, placed: used.size };
    }, {
        placements,
        origin: snap.origin,
        gap: snap.gap,
        reservedIds: reservedTileIds
    });
}

async function snapshotMpAiState(frame) {
    return frame.evaluate(() => window.snapshotMpAiState());
}

/** Rack tile id for a win-drag placement (bulk apply must not consume this tile). */
function rackTileIdForPlacement(snap, placement) {
    const want = String(placement.letter || '').toUpperCase();
    const match = (snap.rack || []).find((r) => String(r.letter).toUpperCase() === want);
    return match?.id ?? null;
}

/** Placements that move a rack tile onto the grid (vs reorg on existing board). */
function splitWinPlacements(snap, solved) {
    const occupied = new Set((snap.boardCells || []).map((c) => `${c.gx},${c.gy}`));
    const rackLetters = new Set(
        (snap.rack || []).map((r) => String(r.letter).toUpperCase())
    );
    const fromRack = [];
    const onBoard = [];
    for (const p of solved.placements || []) {
        const key = `${p.gx},${p.gy}`;
        const needFromRack = !occupied.has(key)
            && rackLetters.has(String(p.letter).toUpperCase());
        if (needFromRack) fromRack.push(p);
        else onBoard.push(p);
    }
    return { fromRack, onBoard };
}

/** Drag one rack tile onto the grid (triggers real snap + peel/win check on pointer-up). */
async function dragPlacementToGrid(page, frame, snap, placement) {
    const meta = await frame.evaluate(({ p, origin, gap }) => {
        const g = window.game;
        if (!g || !BananaGrid) return { ok: false, reason: 'no-game' };
        const want = String(p.letter || '').toUpperCase();
        const tx = origin + p.gx * gap;
        const ty = origin + p.gy * gap;
        const halfGap = gap / 2;
        const atTarget = (t) => Math.abs(t.x - tx) <= halfGap && Math.abs(t.y - ty) <= halfGap;
        const opts = g._rackLayoutOptions();
        const rb = BananaGrid.getRackBounds(
            { x: origin, y: origin },
            opts.cols, opts.gap, opts.tileSize, opts.handBelowCenter
        );
        let tile = (g.tiles || []).find((t) => t.letter.toUpperCase() === want
            && BananaGrid.isTileInRack(t, rb, opts.tileSize));
        if (!tile) {
            tile = (g.tiles || []).find((t) => t.letter.toUpperCase() === want && !atTarget(t));
        }
        if (!tile) {
            const placed = (g.tiles || []).find((t) => t.letter.toUpperCase() === want && atTarget(t));
            if (placed) {
                return {
                    ok: true,
                    alreadyAtTarget: true,
                    id: placed.id,
                    tx,
                    ty,
                    beforeCount: g.tiles.length
                };
            }
            return { ok: false, reason: 'no-rack-tile', letter: want };
        }
        return { ok: true, id: tile.id, tx, ty, beforeCount: g.tiles.length };
    }, { p: placement, origin: snap.origin, gap: snap.gap });
    if (!meta.ok) {
        throw new Error(`dragPlacementToGrid: ${meta.reason} (${JSON.stringify({ placement, meta })})`);
    }
    if (!meta.alreadyAtTarget) {
        await naturalDrag(page, frame, meta.id, meta.tx, meta.ty);
    }
    await frame.evaluate(() => new Promise((resolve) => queueMicrotask(resolve)));
    const after = await frame.evaluate(({ beforeCount, id }) => {
        const g = window.game;
        const dup = (g.tiles || []).filter((t) => t.id === id).length;
        return {
            tileCount: g.tiles.length,
            dup,
            won: !!(g._winnerUid || g._victoryRegistered || g.isOver)
        };
    }, { beforeCount: meta.beforeCount, id: meta.id });
    if (after.dup > 1) {
        throw new Error(`dragPlacementToGrid: duplicate tile id after drag (${JSON.stringify(after)})`);
    }
    return after;
}

async function waitForNaturalWinAfterAction(ctx, label) {
    const { page, hostPage, mp } = ctx;
    const winWaitMs = Math.max(mpVictoryWaitMs(), WAIT_MS, STEP_MS);
    await flushHostBananaInteractions(hostPage);
    await waitForDiag(hostPage, `${label} win host`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board;
        return !!(g?._winnerUid || g?._victoryRegistered || g?.isOver
            || g?._postGameReview || board?.phase === 'review');
    }, {}, winWaitMs, mp);
    await waitForDiag(page, `${label} win guest`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board;
        return !!(g?._winnerUid || g?._victoryRegistered || g?.isOver
            || g?._postGameReview || board?.phase === 'review');
    }, {}, winWaitMs, mp);
    if (!await readMpWinState(hostPage)) {
        throw new Error(`${label}: win did not register via natural sync`);
    }
}

async function publishGuestStep(hostPage, page, isGuest) {
    await flushHostBananaInteractions(hostPage);
}

async function readHostPoolLen(hostPage) {
    return hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?._tilePool?.length ?? -1;
    });
}

/** Merge host bunch count into a client snapshot (guest local pool can lag). */
async function snapshotWithHostPool(frame, hostPage) {
    const snap = await snapshotMpAiState(frame);
    const hostPool = await readHostPoolLen(hostPage);
    if (hostPool >= 0) snap.poolLen = hostPool;
    return snap;
}

async function readWinnerSide(hostPage, guestPage) {
    const state = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        const winnerUid = g?._winnerUid || board?.winnerUid || null;
        const inReview = !!(g?._victoryRegistered || g?.isOver || g?._postGameReview
            || board?.phase === 'review' || board?.reviewPhase === true);
        return { winnerUid, inReview };
    });
    if (!state?.winnerUid) return null;
    const guestUid = await guestPage.evaluate(() => {
        return document.getElementById('game-frame')?.contentWindow?.game?._myUid?.() || null;
    });
    const hostUid = await hostPage.evaluate(() => {
        return document.getElementById('game-frame')?.contentWindow?.game?._myUid?.() || null;
    });
    if (state.winnerUid === guestUid) return 'guest';
    if (state.winnerUid === hostUid) return 'host';
    return null;
}

async function readMpWinState(target) {
    return target.evaluate(() => {
        const g = window.game || document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        return !!(g?._winnerUid || g?.isOver || g?._postGameReview
            || board?.phase === 'review' || board?.reviewPhase === true);
    });
}

async function tryPeel(ctx, snap, label) {
    const { frame, page, hostPage, mp, isGuest } = ctx;
    const gridReady = await frame.evaluate(() => {
        const g = window.game;
        if (!g?._checker || typeof BananaGrid === 'undefined') return false;
        const hand = typeof g._snapHandForValidation === 'function'
            ? g._snapHandForValidation(g.tiles)
            : g.tiles;
        const grid = BananaGrid.validateGrid(hand, g._checker);
        if (!grid.ok) return false;
        if (!BananaGrid.isConnected(hand)) return false;
        if (!BananaGrid.eachTileOccupiesUniqueCell(hand)) return false;
        const hasThree = (grid.words || []).some((w) => String(w || '').length >= 3);
        if (!hasThree) return false;
        return typeof g._allTilesPlacedOn === 'function' ? g._allTilesPlacedOn(hand) : true;
    });
    if (!gridReady) return null;
    if (snap.rack.length && snap.poolLen !== 0) return null;
    if (!snap.boardCells.length && snap.poolLen !== 0) return null;

    // Bunch empty + valid grid → win (hub victory banner), not peel.
    if (snap.poolLen === 0) {
        if (!sideMatchesDesiredWin(ctx)) return null;
        // Win-by-drag handles rack→grid; here the grid is already complete with empty rack.
        if (snap.rack.length) return null;

        const triggerWin = async () => {
            const claimed = await frame.evaluate(() => {
                window.game._bannerText = '';
                return window.game._checkPeel();
            });
            if (!claimed) throw new Error(`${label} win at pool=0 did not claim`);
            await flushHostBananaInteractions(hostPage);
        };

        if (ctx.assertWinBanner) {
            const { assertHubWinBannerVisibleSameTime } = require('../../assertions/bananagrams_mp_win_banner_sync_assertions');
            const timing = await assertHubWinBannerVisibleSameTime({
                page1: hostPage,
                page2: page,
                label: `${label} hub win banner`,
                triggerWin
            });
            log(`[AI] ${label} hub win banner synced (host=${timing.hostMs}ms, guest=${timing.guestMs}ms, `
                + `skew=${timing.skew}ms, max=${timing.maxSkewMs}ms)`);
        } else {
            await triggerWin();
        }

        let won = await readMpWinState(hostPage);
        if (!won) return null;
        const winWaitMs = mpVictoryWaitMs();
        await waitForDiag(hostPage, `${label} win host`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!(g?._winnerUid || g?._victoryRegistered || g?.isOver);
        }, {}, winWaitMs, mp);
        await waitForDiag(page, `${label} win guest`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!(g?._winnerUid || g?._victoryRegistered || g?.isOver);
        }, {}, winWaitMs, mp);
        won = await readMpWinState(hostPage);
        if (!won) throw new Error(`${label} win at pool=0 did not register`);
        log(`[AI] ${label} win (pool=0)`);
        return {
            peels: 0,
            hostPeels: 0,
            guestPeels: 0,
            final: true,
            winSnap: snap
        };
    }

    // Party peel needs one tile per active player in the bunch.
    if (snap.poolLen < 2) return null;
    const peelBefore = await readPeelSeq(hostPage);
    const poolBefore = snap.poolLen;
    const isLastBunchPeel = poolBefore <= 2;
    if (isLastBunchPeel) {
        await assertPoolSyncedBothStrict(hostPage, page, poolBefore, `${label} pre last-bunch peel`);
    }
    const peeled = await frame.evaluate(() => {
        window.game._bannerText = '';
        return window.game._checkPeel();
    });
    if (!peeled) return null;

    await flushHostBananaInteractions(hostPage);

    const actorUid = isGuest ? GUEST_UID : HOST_UID;
    if (isGuest) {
        await waitForDiag(hostPage, `${label} guest peel on host`, ({ peel, uid }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return (board?.peelSeq || 0) > peel && board?.peelActorUid === uid;
        }, { peel: peelBefore, uid: GUEST_UID }, WAIT_MS, mp);
    } else {
        await waitForDiag(page, `${label} host peel on guest`, ({ peel, uid }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return (board?.peelSeq || 0) > peel && board?.peelActorUid === uid;
        }, { peel: peelBefore, uid: HOST_UID }, WAIT_MS, mp);
    }
    if (!ctx.instantBanners) {
        await assertActionBannerOnBoth(hostPage, page, 'Peel!', actorUid, `${label} peel`);
        await dismissBanners(hostPage, page);
    }

    const peelSyncMs = Math.max(WAIT_MS, mpVictoryWaitMs());
    if (isGuest) {
        await waitForDiag(page, `${label} guest peel seq`, ({ peel }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return (board?.peelSeq || 0) > peel;
        }, { peel: peelBefore }, peelSyncMs, mp);
    }
    const poolAfter = await readHostPoolLen(hostPage);
    const poolWaitMs = poolAfter === 0 ? peelSyncMs : WAIT_MS;
    if (isLastBunchPeel) {
        await assertPoolSyncedBothNatural(hostPage, page, poolAfter, `${label} post last-bunch peel`, 150);
    }
    await waitPoolBothWithFlush(hostPage, page, poolAfter, poolWaitMs, mp);
    const won = await readMpWinState(hostPage);
    if (poolBefore > 0 && poolAfter >= poolBefore && !won) {
        throw new Error(`${label} peel did not drain bunch (${poolBefore}→${poolAfter})`);
    }
    log(`[AI] ${label} peel (pool ${poolBefore}→${poolAfter})`);
    return {
        peels: 1,
        hostPeels: isGuest ? 0 : 1,
        guestPeels: isGuest ? 1 : 0,
        final: false
    };
}

async function tryDump(ctx, snap, solved, label) {
    const { frame, page, hostPage, mp, isGuest } = ctx;
    const stuck = solved.stuck || (!solved.changed && !solved.cleared && snap.poolLen >= 3);
    if (!stuck || !snap.rack.length || snap.poolLen < 3) return null;

    const beforeIds = await frame.evaluate(() => [...window.game.tiles.map((t) => t.id)]);
    const tileId = snap.rack[0]?.id;
    const dumped = await frame.evaluate((rid) => {
        const t = window.game.tiles.find((tile) => tile.id === rid) || window.game.tiles[0];
        return t ? window.game._handleDump(t) : false;
    }, tileId);
    if (!dumped) return null;

    await flushHostBananaInteractions(hostPage);
    if (isGuest) {
        await waitGuestDumpResult(page, hostPage, 'P2', beforeIds, mp);
    } else {
        await waitDumpResult(hostPage, 'P1', beforeIds, mp);
    }
    await waitPoolBoth(hostPage, page, snap.poolLen - 2);
    const actorUid = isGuest ? GUEST_UID : HOST_UID;
    if (!ctx.instantBanners) {
        await assertActionBannerOnBoth(hostPage, page, 'Dump!', actorUid, `${label} dump`);
        await dismissBanners(hostPage, page);
    }
    log(`[AI] ${label} dump (pool ${snap.poolLen}→${snap.poolLen - 2})`);
    return { dumps: 1 };
}

/** Periodic dump (solo-style) so MP audit hits dump goals without relying on stuck solver. */
async function tryForcedDump(ctx, snap, label, { minPool = 15 } = {}) {
    const { frame, page, hostPage, mp, isGuest } = ctx;
    if (!snap.rack.length || snap.poolLen < minPool) return null;

    const beforeIds = await frame.evaluate(() => [...window.game.tiles.map((t) => t.id)]);
    const tileId = snap.rack[0]?.id;
    const dumped = await frame.evaluate((rid) => {
        const t = window.game.tiles.find((tile) => tile.id === rid) || window.game.tiles[0];
        return t ? window.game._handleDump(t) : false;
    }, tileId);
    if (!dumped) return null;

    await flushHostBananaInteractions(hostPage);
    if (isGuest) {
        await waitGuestDumpResult(page, hostPage, 'P2', beforeIds, mp);
    } else {
        await waitDumpResult(hostPage, 'P1', beforeIds, mp);
    }
    await waitPoolBoth(hostPage, page, snap.poolLen - 2);
    const actorUid = isGuest ? GUEST_UID : HOST_UID;
    if (!ctx.instantBanners) {
        await assertActionBannerOnBoth(hostPage, page, 'Dump!', actorUid, `${label} dump`);
        await dismissBanners(hostPage, page);
    }
    log(`[AI] ${label} forced dump (pool ${snap.poolLen}→${snap.poolLen - 2})`);
    return { dumps: 1 };
}

function goalsMet(stats, goals) {
    return stats.placements >= goals.minPlacements
        && stats.peels >= goals.minPeels
        && stats.dumps >= goals.minDumps
        && stats.hostPeels >= goals.minHostPeels
        && stats.guestPeels >= goals.minGuestPeels;
}

function recordStep(stats, step, side = null) {
    if (step.action === 'idle') return false;
    stats.peels += step.peels || 0;
    stats.hostPeels += step.hostPeels || 0;
    stats.guestPeels += step.guestPeels || 0;
    if (step.dumps) {
        stats.dumps += step.dumps;
        if (side?.isGuest) stats.guestDumps = (stats.guestDumps || 0) + step.dumps;
        else if (side) stats.hostDumps = (stats.hostDumps || 0) + step.dumps;
    }
    stats.placements += step.placed || 0;
    return true;
}

/** Real drag for the last rack tile — bulk-apply the rest, peel if needed, then drag to win. */
async function executeWinDragStep(ctx, label, applySnap, solved, reservedTileIds) {
    const { frame, page, hostPage, isGuest } = ctx;
    const { fromRack, onBoard } = splitWinPlacements(applySnap, solved);
    if (!fromRack.length) return null;

    let placed = 0;
    const last = fromRack[fromRack.length - 1];
    const winDragReserve = rackTileIdForPlacement(applySnap, last);
    const bulkReserved = winDragReserve
        ? [...reservedTileIds, winDragReserve]
        : reservedTileIds;
    const bulk = [...onBoard, ...fromRack.slice(0, -1)];
    if (bulk.length) {
        const bulkApplied = await applyPlacements(frame, applySnap, solved, {
            reservedTileIds: bulkReserved,
            onlyPlacements: bulk
        });
        if (!bulkApplied.ok) {
            throw new Error(`${label} bulk apply before win-drag failed (${JSON.stringify(bulkApplied)})`);
        }
        placed += bulkApplied.placed;
    }
    const dragSnap = await snapshotWithHostPool(frame, hostPage);
    if (dragSnap.poolLen !== 0) return null;
    log(`[AI] ${label} win-drag (${last.letter} → ${last.gx},${last.gy})...`);
    await dragPlacementToGrid(page, frame, dragSnap, last);
    await publishGuestStep(hostPage, page, isGuest);
    await waitForNaturalWinAfterAction(ctx, `${label} win-drag`);
    const snapAfter = await snapshotWithHostPool(frame, hostPage);
    log(`[AI] ${label} win-drag+win (${placed + 1} tiles)`);
    return {
        win: true,
        action: 'win-drag',
        placed: placed + 1,
        winSnap: snapAfter
    };
}

async function runPlayerStep(ctx, label, round = 0) {
    const { frame, page, hostPage, isGuest } = ctx;

    const snap = await snapshotWithHostPool(frame, hostPage);
    if (snap.winner) return { win: true, action: 'win' };

    const reservedTileIds = reservedRackIdsForSteering(snap, ctx);
    let solved = solveForPlayerStep(snap, ctx);
    let applySnap = snap;

    if (solved.changed) {
        let winDrag = ctx.winDrag !== false
            && applySnap.poolLen === 0
            && sideMatchesDesiredWin(ctx);
        const { fromRack } = winDrag
            ? splitWinPlacements(applySnap, solved)
            : { fromRack: [] };
        if (winDrag && !fromRack.length) winDrag = false;
        if (winDrag) {
            const winResult = await executeWinDragStep(ctx, label, applySnap, solved, reservedTileIds);
            if (winResult) return winResult;
            if (applySnap.poolLen === 0) {
                throw new Error(`${label} win-drag failed with pool=0`);
            }
        }

        let placed = 0;
        let applied = await applyPlacements(frame, applySnap, solved, { reservedTileIds });
        if (!applied.ok) {
            applySnap = await snapshotWithHostPool(frame, hostPage);
            solved = solveForPlayerStep(applySnap, ctx);
            if (solved.changed) {
                applied = await applyPlacements(frame, applySnap, solved, {
                    reservedTileIds: reservedRackIdsForSteering(applySnap, ctx)
                });
            }
        }
        if (!applied?.ok) {
            if (isGuest && ctx.desiredWinSide && !sideMatchesDesiredWin(ctx)) {
                return { action: 'idle' };
            }
            throw new Error(`${label} apply failed (${JSON.stringify(applied)})`);
        }
        placed = applied.placed;
        await publishGuestStep(hostPage, page, isGuest);
        const snapAfter = await snapshotWithHostPool(frame, hostPage);
        if (snapAfter.winner) {
            return { win: true, action: 'win', placed, winSnap: snapAfter };
        }
        const peelReady = snapAfter.poolLen === 0
            || (!snapAfter.rack.length && snapAfter.boardCells.length);
        if (peelReady) {
            const peelAfter = await tryPeel(ctx, snapAfter, label);
            if (peelAfter) {
                log(`[AI] ${label} place+peel (${placed} tiles)`);
                if (peelAfter.final) {
                    return {
                        win: true, action: 'win', placed,
                        winSnap: peelAfter.winSnap,
                        ...peelAfter
                    };
                }
                return { action: 'place+peel', placed, ...peelAfter };
            }
        }
        log(`[AI] ${label} place (${placed} tiles)`);
        return { action: 'place', placed };
    }

    const peel = await tryPeel(ctx, snap, label);
    if (peel) {
        if (peel.final) return { win: true, action: 'win', winSnap: peel.winSnap, ...peel };
        return { action: 'peel', ...peel };
    }

    const dump = await tryDump(ctx, snap, solved, label);
    if (dump) {
        await publishGuestStep(hostPage, page, isGuest);
        return { action: 'dump', ...dump };
    }

    if (!solved.changed && !solved.cleared && snap.poolLen >= 3 && snap.rack.length) {
        const forced = await tryForcedDump(ctx, snap, `${label} stuck`);
        if (forced) {
            await publishGuestStep(hostPage, page, isGuest);
            return { action: 'dump', ...forced };
        }
    }

    if (stateLog.enabled()) {
        const skips = [
            stateLog.explainSkippedAction(snap, solved, 'place'),
            stateLog.explainSkippedAction(snap, solved, 'peel'),
            stateLog.explainSkippedAction(snap, solved, 'dump')
        ].join(' | ');
        stateLog.logTurn(round, Date.now(), [snap], [label], [solved], [`${label}:idle`, skips]);
    }
    return { action: 'idle' };
}

/**
 * @param {object} opts
 * @param {import('playwright').Page} opts.page1
 * @param {import('playwright').Page} opts.page2
 * @param {import('playwright').Frame} opts.frame1
 * @param {import('playwright').Frame} opts.frame2
 * @param {object} opts.mp
 * @param {boolean} [opts.mobile]
 * @param {number} [opts.minPeels]
 * @param {number} [opts.minDumps]
 * @param {number} [opts.minPlacements]
 * @param {number} [opts.maxRoundTrips]
 * @param {Function} [opts.assertBoardStatesHealthy]
 */
function resolvePlayToWin(opts) {
    if (opts.playToWin != null) return !!opts.playToWin;
    return process.env.FIVE_MP_AI_PLAY_TO_WIN !== '0';
}

/** @returns {{ side: 'host'|'guest'|null, forced: boolean }} */
function resolveWinSteering(opts, playToWin) {
    if (!playToWin) return { side: null, forced: false };
    const raw = opts.winSide ?? (() => {
        try {
            const { getWinSide } = require('../../../../shared/infra/run-config');
            return getWinSide();
        } catch (_) {
            return null;
        }
    })();
    if (raw === 'host' || raw === 'p1') return { side: 'host', forced: true };
    if (raw === 'guest' || raw === 'p2') return { side: 'guest', forced: true };
    return { side: 'host', forced: false };
}

/** @deprecated use resolveWinSteering */
function resolveDesiredWinSide(opts, playToWin) {
    return resolveWinSteering(opts, playToWin).side;
}

function sideMatchesDesiredWin(ctx) {
    if (!ctx.desiredWinSide) return true;
    return ctx.desiredWinSide === 'host' ? !ctx.isGuest : ctx.isGuest;
}

const STEER_MIN_RACK_KEEP = 1;

/** Tile ids the steered side must keep in rack (solver never sees these letters). */
function reservedRackIdsForSteering(snap, ctx) {
    if (!ctx.desiredWinSide || sideMatchesDesiredWin(ctx)) return [];
    const rack = snap.rack || [];
    if (rack.length <= STEER_MIN_RACK_KEEP) {
        return rack.map((r) => r.id).filter(Boolean);
    }
    return rack.slice(-STEER_MIN_RACK_KEEP).map((r) => r.id).filter(Boolean);
}

/** Solver input for this side — steered-away player still builds a grid; keeps reserved rack tiles. */
function solveForPlayerStep(snap, ctx) {
    let rackLetters = (snap.rack || []).map((r) => r.letter);
    if (ctx.desiredWinSide && !sideMatchesDesiredWin(ctx)) {
        if (rackLetters.length <= STEER_MIN_RACK_KEEP) {
            return { changed: false, cleared: false, stuck: true, placements: [], rackLeft: rackLetters };
        }
        rackLetters = rackLetters.slice(0, -STEER_MIN_RACK_KEEP);
    }
    return solveAttemptFromBrowserState({
        boardCells: snap.boardCells,
        rackLetters
    });
}

async function readMpBoardSyncState(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return {
            localPool: g?._tilePool?.length ?? -1,
            boardPool: Array.isArray(board?.pool) ? board.pool.length : -1,
            boardSeq: board?.seq ?? null,
            phase: board?.phase ?? null,
            winner: !!(g?._winnerUid || g?.isOver || g?._postGameReview
                || board?.phase === 'review' || board?.reviewPhase === true)
        };
    });
}

/** Read + validate one player's board from their game frame. */
async function readPlayerWinBoardFromFrame(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        if (!g?._checker || typeof BananaGrid === 'undefined') {
            return { ok: false, reason: 'missing-game' };
        }
        const me = g._myUid();
        const tiles = (g.tiles || []).map((t) => ({
            id: t.id,
            letter: t.letter,
            x: t.x,
            y: t.y,
            faceUp: true
        }));
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const rackOpts = g._rackLayoutOptions();
        const allPlaced = typeof g._allTilesPlacedOn === 'function'
            ? g._allTilesPlacedOn(tiles)
            : BananaGrid.allTilesPlacedInGrid(tiles, origin, rackOpts);
        const grid = BananaGrid.validateGrid(tiles, g._checker);
        const connected = BananaGrid.isConnected(tiles);
        const unique = BananaGrid.eachTileOccupiesUniqueCell(tiles);
        const hasThree = (grid.words || []).some((w) => String(w || '').length >= 3);
        return {
            uid: me,
            tileCount: tiles.length,
            validWinBoard: !!(allPlaced && grid.ok && connected && unique && hasThree),
            allPlaced,
            gridOk: grid.ok,
            connected,
            words: grid.words || [],
            invalidReason: grid.ok ? null : (grid.reason || null)
        };
    });
}

async function assertActionsWinSnap(snap, label = 'actions win') {
    if (!snap) {
        throw new Error(`${label}: missing win snapshot`);
    }
    if (!snap.boardCells?.length && !snap.allPlaced) {
        throw new Error(`${label}: winner must have board tiles`);
    }
    if (snap.poolLen !== 0) {
        throw new Error(`${label}: bunch must be 0 at win (pool=${snap.poolLen})`);
    }
    if (!snap.allPlaced || !snap.gridOk) {
        throw new Error(
            `${label}: winner must have all tiles in a connected valid grid `
            + `(allPlaced=${snap.allPlaced}, gridOk=${snap.gridOk}, rack=${snap.rack?.length ?? 0})`
        );
    }
    log(`${label}: winner grid valid (${snap.boardCells?.length || snap.tileCount} cells, pool=0)`);
}

async function assertActionsWinBoards(winnerFrame, loserFrame, winnerUid, label = 'actions win') {
    const [winnerBoard, loserBoard] = await Promise.all([
        readPlayerWinBoardFromFrame(winnerFrame),
        readPlayerWinBoardFromFrame(loserFrame)
    ]);

    if (!winnerBoard?.validWinBoard) {
        throw new Error(
            `${label}: winner must have a fully connected valid board `
            + `(${JSON.stringify({ winnerUid, winnerBoard })})`
        );
    }

    const validPlayers = [winnerBoard, loserBoard].filter((p) => p?.validWinBoard);
    if (validPlayers.length !== 1) {
        throw new Error(
            `${label}: exactly one player must have a fully connected valid board, `
            + `got ${validPlayers.length} (${JSON.stringify({ winnerBoard, loserBoard })})`
        );
    }

    if (winnerBoard.uid !== winnerUid) {
        throw new Error(
            `${label}: valid-board player must be winner `
            + `(winner=${winnerUid}, valid=${winnerBoard.uid})`
        );
    }

    log(`${label}: winner ${winnerUid} has valid connected crossword `
        + `(${winnerBoard.words.slice(0, 8).join(', ')}${winnerBoard.words.length > 8 ? '…' : ''})`);
}

async function assertActionsPoolZero(hostPage, guestPage, mp, label = 'actions win') {
    await flushHostBananaInteractions(hostPage);
    const poolWaitMs = mpVictoryWaitMs();

    await waitForDiag(hostPage, `${label} bunch=0 host`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const local = g?._tilePool?.length ?? -1;
        if (local !== 0) return false;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        if (Array.isArray(board?.pool)) return board.pool.length === 0;
        return true;
    }, {}, poolWaitMs, mp);
    await waitForDiag(guestPage, `${label} bunch=0 guest`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const local = g?._tilePool?.length ?? -1;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const inReview = board?.phase === 'review'
            || !!(g?._winnerUid || board?.winnerUid || g?._postGameReview);
        if (inReview) return local === 0;
        if (local !== 0) return false;
        if (Array.isArray(board?.pool)) return board.pool.length === 0;
        return true;
    }, {}, poolWaitMs, mp);
    log(`SUCCESS: ${label} — bunch=0 on host and guest`);
}

/** Review boards must stay visible on both clients (no flash/disappear after guest win). */
async function assertActionsReviewPersists(frames, pages, mp, label = 'actions review', opts = {}) {
    const minTilesPerOwner = opts.minTilesPerOwner ?? 6;
    const settleMs = Math.max(mpReviewWaitMs(), 400);
    await mergeGuestLayoutOnHost(frames[0], pages);
    await flushHostBananaInteractions(pages[0]);
    await frames[0].evaluate(() => {
        window.game._processBananaInteractions?.(window.game.roomData?.interactions?.banana);
    }).catch(() => {});
    await waitForHostReviewReady(frames[0], pages[0], mpReviewWaitMs());
    await assertGuestReviewVisibleWithoutInteraction(
        pages[0], `${label} host visible`, 2, minTilesPerOwner
    );
    await assertGuestReviewVisibleWithoutInteraction(
        pages[1], `${label} guest visible`, 2, minTilesPerOwner
    );
    for (let i = 0; i < frames.length; i++) {
        await assertReviewBoardsFullyVisible(frames[i], `${label} P${i + 1} fit`);
    }
    await new Promise((r) => setTimeout(r, settleMs));
    for (let i = 0; i < frames.length; i++) {
        await assertGuestReviewVisibleWithoutInteraction(
            pages[i], `${label} P${i + 1} persisted`, 2, minTilesPerOwner
        );
        await assertReviewViewportStable(frames[i], `${label} P${i + 1} viewport`);
        await assertReviewBoardsFullyVisible(frames[i], `${label} P${i + 1} persisted-fit`);
    }
    log(`SUCCESS: ${label} — review boards persisted on host and guest`);
}

/** Both hub clients show the win banner after victory (review transition). */
async function assertActionsWinBanner(pages, label = 'actions win banner') {
    const { isHubWinBannerDomVisible } = require('../../assertions/bananagrams_mp_win_banner_sync_assertions');
    const timeoutMs = mpVictoryWaitMs();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const states = await Promise.all(pages.map((p) => isHubWinBannerDomVisible(p)));
        if (states.every((s) => s.visible)) {
            log(`SUCCESS: ${label} — hub win banner visible on host and guest`);
            return;
        }
        await new Promise((r) => setTimeout(r, 40));
    }
    const states = await Promise.all(pages.map((p) => isHubWinBannerDomVisible(p)));
    throw new Error(`${label}: hub win banner not visible on both clients (${JSON.stringify(states)})`);
}

/** Validate review layouts: winner connected crossword, loser has straggler(s). */
async function assertActionsReviewLayouts(frame1, hostPage, mp, label = 'actions review') {
    const layoutWaitMs = mpReviewWaitMs();

    await waitForDiag(hostPage, `${label} layouts ready`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const winnerUid = g?._winnerUid || board?.winnerUid;
        if (!winnerUid) return false;
        const layouts = board?.reviewLayoutsOrig || board?.reviewLayouts || g?._reviewLayouts || {};
        const roster = Object.keys(room?.playerData || {}).filter(Boolean);
        return roster.every((uid) => Array.isArray(layouts[uid]) && layouts[uid].length > 0);
    }, {}, layoutWaitMs, mp);

    const state = await frame1.evaluate(() => {
        const g = window.game;
        if (!g?._checker || typeof BananaGrid === 'undefined') {
            return { ok: false, reason: 'missing-game' };
        }
        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const winnerUid = g._winnerUid || board?.winnerUid || null;
        const layouts = board?.reviewLayoutsOrig || board?.reviewLayouts || g._reviewLayouts || {};
        const roster = Object.keys(room?.playerData || {}).filter(Boolean).sort();

        const validateLayout = (uid, tileList) => {
            if (!Array.isArray(tileList) || !tileList.length) {
                return { uid, validWinBoard: false, tileCount: 0, reason: 'no-layout' };
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
                : { ok: false, words: [] };
            const mainConnected = mainTiles.length >= 6 && BananaGrid.isConnected(mainTiles);
            const hasThree = (mainGrid.words || []).some((w) => String(w || '').length >= 3);
            return {
                uid,
                tileCount: tiles.length,
                stragglers: disconnected,
                validWinBoard: !!(fullGrid.ok && fullConnected && unique
                    && (fullGrid.words || []).some((w) => String(w || '').length >= 3)),
                connected: mainConnected,
                gridOk: mainGrid.ok,
                words: mainGrid.words || [],
                invalidReason: mainGrid.ok ? null : (mainGrid.reason || fullGrid.reason || null)
            };
        };

        return {
            winnerUid,
            players: roster.map((uid) => validateLayout(uid, layouts[uid]))
        };
    });

    if (!state?.winnerUid) {
        throw new Error(`${label}: no winnerUid (${JSON.stringify(state)})`);
    }

    const winnerPlayer = (state.players || []).find((p) => p.uid === state.winnerUid);
    if (!winnerPlayer?.validWinBoard) {
        throw new Error(
            `${label}: winner must have a fully connected valid crossword `
            + `(${JSON.stringify(state)})`
        );
    }

    for (const player of state.players || []) {
        if (player.uid === state.winnerUid) continue;
        if (!player.connected || !player.gridOk) {
            throw new Error(
                `${label}: loser must show a connected valid crossword in review `
                + `(${JSON.stringify(player)})`
            );
        }
    }

    const losers = (state.players || []).filter((p) => p.uid !== state.winnerUid);
    if (!losers.length) {
        throw new Error(`${label}: missing loser layout(s) (${JSON.stringify(state)})`);
    }
    for (const loser of losers) {
        if (!loser.tileCount) {
            throw new Error(`${label}: loser layout empty (${JSON.stringify(loser)})`);
        }
    }

    log(`${label}: winner review board connected (${winnerPlayer.tileCount} tiles)`);
    for (const loser of losers) {
        if (loser.validWinBoard) {
            log(`${label}: loser ${loser.uid} also has valid win board (${loser.tileCount} tiles) — lost race`);
        } else {
            log(`${label}: loser ${loser.uid} review board connected with straggler(s) `
                + `(${loser.tileCount} tiles)`);
        }
    }
    const playerWord = losers.length === 1 ? 'both players' : `all ${losers.length + 1} players`;
    log(`SUCCESS: ${label} — bunch=0; winner valid; connected review layouts for ${playerWord}`);
}

/** Actions scenario: bunch empty + exactly one fully connected valid crossword (the winner). */
async function assertActionsWinInvariants(hostPage, guestPage, frame1, frame2, mp, label = 'actions win') {
    await assertActionsPoolZero(hostPage, guestPage, mp, label);
}

async function awaitMpVictorySettled(hostPage, guestPage, mp, label = 'AI win', opts = {}) {
    const requireWin = opts.requireWin !== false;
    const mpPages = { page1: hostPage, page2: guestPage };
    const victoryMs = mpVictoryWaitMs();
    await flushHostBananaInteractions(hostPage);
    try {
        await waitForDiag(hostPage, `${label} settled on host`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            return !!(g?._winnerUid || g?.isOver || g?._postGameReview
                || board?.phase === 'review' || board?.reviewPhase === true);
        }, {}, victoryMs, mpPages);
    } catch (err) {
        if (requireWin) throw err;
        return;
    }
    const syncDeadline = Date.now() + victoryMs;
    while (Date.now() < syncDeadline) {
        await flushHostBananaInteractions(hostPage);
        const [host, guest] = await Promise.all([
            readMpBoardSyncState(hostPage),
            readMpBoardSyncState(guestPage)
        ]);
        if (host.boardSeq != null && host.boardSeq === guest.boardSeq
            && host.localPool === guest.localPool && host.boardPool === guest.boardPool
            && (!opts.assertActionsWinInvariants || (host.localPool === 0 && host.boardPool === 0))) {
            break;
        }
        await new Promise((r) => setTimeout(r, mpPollMs()));
    }
}

async function runMpAiPlaythrough(opts) {
    if (process.env.FIVE_MP_ACTIONS_DEBUG === '0') {
        process.env.BANANA_AI_QUIET = '1';
    }
    const playToWin = resolvePlayToWin(opts);
    const { side: desiredWinSide, forced: forcedWinSide } = resolveWinSteering(opts, playToWin);
    const {
        page1, page2, frame1, frame2, mp, mobile = false,
        minPeels = Number(process.env.FIVE_MP_AI_MIN_PEELS || 4),
        minDumps = Number(process.env.FIVE_MP_AI_MIN_DUMPS || 2),
        minPlacements = Number(process.env.FIVE_MP_AI_MIN_PLACEMENTS || 30),
        minHostPeels = Number(process.env.FIVE_MP_AI_MIN_HOST_PEELS || 2),
        minGuestPeels = Number(process.env.FIVE_MP_AI_MIN_GUEST_PEELS || 2),
        maxRoundTrips = playToWin
            ? Number(process.env.FIVE_BANANA_MAX_TURNS || process.env.FIVE_MP_AI_MAX_ROUNDS || 30)
            : Number(process.env.FIVE_MP_AI_MAX_ROUNDS || 30),
        assertBoardStatesHealthy = null,
        assertActionsWinInvariants = false,
        assertWinBanner = false,
        aggressiveDumping = false,
        aggressiveDumpsPerPlayer = 10,
        winDrag = true,
        pause = false,
        instantBanners = false
    } = opts;

    const sessionPause = pause || resolveSessionPause(opts);

    const aggressiveRoundBudget = aggressiveDumping ? aggressiveDumpsPerPlayer * 4 : 0;
    const maxRounds = (playToWin && assertActionsWinInvariants)
        ? Math.max(maxRoundTrips, 30, aggressiveRoundBudget)
        : Math.max(maxRoundTrips, aggressiveRoundBudget);

    const victoryOpts = {
        assertActionsWinInvariants,
        frame1,
        frame2
    };

    const goals = {
        minPeels, minDumps, minPlacements, minHostPeels, minGuestPeels
    };

    await injectSnapshot([frame1, frame2]);
    if (isMpHeaded()) {
        if (mobile) {
            await centerMpViewerOnPages([page1, page2], { mobile: true });
            await probeHeadedMobileViewport([page1, page2], 'playthrough start', mobile);
        } else {
            await syncHeadedDesktopMpView([page1, page2]);
        }
    }
    if (playToWin && forcedWinSide) {
        log(`[AI] Play-to-win: steering for ${desiredWinSide} victory (--win=${desiredWinSide})`);
    } else if (playToWin) {
        log(`[AI] Play-to-win: steering for ${desiredWinSide} victory (default; --win=guest to override)`);
    }
    if (aggressiveDumping) {
        log(`[AI] Aggressive dumping: ${aggressiveDumpsPerPlayer} forced dumps per player`);
    }
    if (!winDrag) {
        log('[AI] Win drag disabled — last tile via bulk apply + peel/win API (set WIN_DRAG in actions-audit.js)');
    }
    const stats = {
        peels: 0, hostPeels: 0, guestPeels: 0, dumps: 0, hostDumps: 0, guestDumps: 0,
        placements: 0, rounds: 0, desiredWinSide
    };
    let idleRounds = 0;

    const sides = [
        {
            frame: frame1,
            page: page1,
            hostPage: page1,
            mp,
            isGuest: false,
            label: 'P1 (Host)',
            assertWinBanner,
            desiredWinSide,
            playToWin,
            mobile,
            instantBanners,
            winDrag
        },
        {
            frame: frame2,
            page: page2,
            hostPage: page1,
            mp,
            isGuest: true,
            label: 'P2 (Guest)',
            assertWinBanner,
            desiredWinSide,
            playToWin,
            mobile,
            instantBanners,
            winDrag
        }
    ];

    const finishIfGoalsMet = async (round) => {
        if (playToWin || !goalsMet(stats, goals)) return false;
        if (assertBoardStatesHealthy) {
            await assertBoardStatesHealthy('after AI playthrough');
        }
        log(`[AI] Goals met: placements=${stats.placements} peels=${stats.peels} `
            + `dumps=${stats.dumps} in ${round} round-trips.`);
        return true;
    };

    const finishActionsWin = async (side, round, step = null) => {
        const winLabel = `${side.label} win`;
        const actualSide = side.isGuest ? 'guest' : 'host';
        if (forcedWinSide && actualSide !== desiredWinSide) {
            throw new Error(
                `${winLabel}: expected ${desiredWinSide} to win (--win=${desiredWinSide})`
            );
        }
        log(`[AI] Win detected (${side.label}, round ${round}, side=${actualSide}).`);
        let winnerSnap = step?.winSnap || null;
        if (!winnerSnap?.allPlaced || !winnerSnap?.gridOk) {
            winnerSnap = await snapshotWithHostPool(side.frame, page1);
        }
        await awaitMpVictorySettled(page1, page2, mp, winLabel, victoryOpts);
        if (assertActionsWinInvariants) {
            const reviewSyncMs = Math.max(mpReviewWaitMs(), WAIT_MS);
            const pages = [page1, page2];
            const frames = [frame1, frame2];
            await flushHostBananaInteractions(page1);
            await frame1.evaluate(() => {
                window.game._processBananaInteractions?.(window.game.roomData?.interactions?.banana);
            }).catch(() => {});
            const alreadyInReview = !!winnerSnap?.winner;
            if (!alreadyInReview) {
                if (winnerSnap?.allPlaced && winnerSnap?.gridOk) {
                    await assertActionsWinSnap(winnerSnap, winLabel);
                } else {
                    const winnerBoard = await readPlayerWinBoardFromFrame(side.frame);
                    if (!winnerBoard?.validWinBoard) {
                        throw new Error(
                            `${winLabel}: winner must have a fully connected valid board `
                            + `(${JSON.stringify({ winnerSnap, winnerBoard })})`
                        );
                    }
                    log(`${winLabel}: winner grid valid (${winnerBoard.tileCount} cells, pool=0)`);
                }
            }
            await assertActionsPoolZero(page1, page2, mp, winLabel);
            const preWinByUid = await capturePreReviewBoardsByPlayer(frames);
            const preWinDiag = await frame1.evaluate(({ hostUid, guestUid, snaps }) => {
                const g = window.game;
                const hostTiles = snaps?.[hostUid]?.tiles || [];
                const guestTiles = snaps?.[guestUid]?.tiles || [];
                const hostIds = new Set(hostTiles.map((t) => t.id));
                const overlap = guestTiles.filter((t) => hostIds.has(t.id)).map((t) => t.id);
                const letterConflicts = [];
                hostTiles.forEach((ht) => {
                    const gt = guestTiles.find((x) => x.id === ht.id);
                    if (gt && String(gt.letter).toUpperCase() !== String(ht.letter).toUpperCase()) {
                        letterConflicts.push({ id: ht.id, host: ht.letter, guest: gt.letter });
                    }
                });
                return {
                    hostN: hostTiles.length,
                    guestN: guestTiles.length,
                    overlapIds: overlap.slice(0, 6),
                    overlapN: overlap.length,
                    letterConflicts: letterConflicts.slice(0, 6),
                    letterConflictN: letterConflicts.length,
                    dedupedN: hostTiles.length + guestTiles.length - overlap.length,
                    poolN: g._tilePool?.length ?? -1,
                    lastDistFail: g._lastMpDistCheck?.ok === false ? g._lastMpDistCheck : null,
                    firstCorrupt: g._mpFirstLetterCorruption || null
                };
            }, { hostUid: HOST_UID, guestUid: GUEST_UID, snaps: preWinByUid });
            log(`[DIST] preWin boards host=${preWinDiag.hostN} guest=${preWinDiag.guestN} `
                + `deduped=${preWinDiag.dedupedN} overlap=${preWinDiag.overlapN} `
                + `letterConflicts=${preWinDiag.letterConflictN} pool=${preWinDiag.poolN}`);
            if (preWinDiag.lastDistFail) {
                log(`[DIST] preWin last host invariant fail=${JSON.stringify(preWinDiag.lastDistFail)}`);
            }
            if (preWinDiag.firstCorrupt) {
                log(`[DIST] preWin first corrupt=${JSON.stringify(preWinDiag.firstCorrupt)}`);
            }
            log(`${winLabel}: waiting for natural RTDB review sync on all clients...`);
            await waitMpClientsInReview(frames, `${winLabel} in-review`, reviewSyncMs, pages);
            await assertActionsWinBanner(pages, `${winLabel} hub win banner`);
            await waitMpClientsPostWinReady(
                frames, [HOST_UID, GUEST_UID], `${winLabel} boards`, reviewSyncMs, pages
            );
            await assertGuestReviewVisibleWithoutInteraction(page1, `${winLabel} host review`);
            await assertGuestReviewVisibleWithoutInteraction(page2, `${winLabel} guest review`);
            await assertActionsReviewLayouts(frame1, page1, mp, winLabel);
            if (sessionPause) {
                log(`${winLabel}: pause mode — skipping strict review snapshot checks`);
            } else {
                await assertActionsReviewPersists(frames, pages, mp, winLabel);
                await assertReviewPreservesPreWinBoards(
                    [frame1, frame2],
                    preWinByUid,
                    `${winLabel} review-boards`
                );

                const distState = await readTileDistributionState(frame1, null);
                const probe = await probeTileDistributionSources(
                    frame1, frame2, HOST_UID, GUEST_UID
                );
                log(`[DIST] review ${formatDistributionDiagnostics(distState, probe)}`);
                if (probe.hostRuntimeDriftN) {
                    log(`[DIST] host runtime≠canonical sample=${JSON.stringify(probe.hostRuntimeDrift)}`);
                }
                if (probe.guestRuntimeDriftN) {
                    log(`[DIST] guest runtime≠canonical sample=${JSON.stringify(probe.guestRuntimeDrift)}`);
                }
                const dist = await assertTileDistributionInReview(
                    frame1,
                    `${winLabel} tile-distribution`,
                    { endingSnapshots: preWinByUid }
                );
                log(`SUCCESS: ${winLabel} — tile distribution OK (${dist.bagLabel}, `
                    + `${dist.actualTotal} tiles via ${dist.countSource})`);
                log(`SUCCESS: ${winLabel} — all actions win invariants passed`);
            }
        }
    };

    for (let round = 1; round <= maxRounds; round++) {
        stats.rounds = round;
        let progress = false;

        for (const side of sides) {
            await flushHostBananaInteractions(page1);

            const snap = await snapshotWithHostPool(side.frame, page1);
            if (snap.winner) {
                await finishActionsWin(side, round, { winSnap: snap });
                return stats;
            }

            const playerDumps = side.isGuest ? stats.guestDumps : stats.hostDumps;
            if (aggressiveDumping
                && playerDumps < aggressiveDumpsPerPlayer
                && snap.poolLen >= 3
                && snap.rack.length > 0) {
                const forced = await tryForcedDump(
                    side,
                    snap,
                    `${side.label} aggressive ${playerDumps + 1}/${aggressiveDumpsPerPlayer}`,
                    { minPool: 3 }
                );
                if (forced && recordStep(stats, forced, side)) {
                    await publishGuestStep(side.hostPage, side.page, side.isGuest);
                    progress = true;
                    idleRounds = 0;
                    continue;
                }
            }

            if (!aggressiveDumping
                && !playToWin
                && stats.dumps < minDumps
                && stats.placements >= Math.min(20, minPlacements)
                && round >= 6
                && round % 3 === 0) {
                const forced = await tryForcedDump(side, snap, `${side.label} r${round} periodic`);
                if (forced && recordStep(stats, forced, side)) {
                    await publishGuestStep(side.hostPage, side.page, side.isGuest);
                    progress = true;
                    idleRounds = 0;
                    if (await finishIfGoalsMet(round)) return stats;
                    continue;
                }
            }

            const step = await runPlayerStep(side, `${side.label} r${round}`, round);
            if (step.win) {
                await finishActionsWin(side, round, step);
                return stats;
            }
            const winSideKey = await readWinnerSide(page1, page2);
            if (winSideKey) {
                const winSide = winSideKey === 'guest' ? sides[1] : sides[0];
                const preWinSnap = await snapshotWithHostPool(winSide.frame, page1);
                await finishActionsWin(winSide, round, { winSnap: preWinSnap });
                return stats;
            }
            if (recordStep(stats, step, side)) {
                progress = true;
                idleRounds = 0;
                if (await finishIfGoalsMet(round)) return stats;
            }
        }

        if (!progress) idleRounds += 1;
        const hostPool = await readHostPoolLen(page1);
        const idleCap = hostPool === 0 ? 12 : 15;
        if (idleRounds >= idleCap) {
            const lastSnaps = await Promise.all(sides.map((s) => snapshotWithHostPool(s.frame, page1)));
            const lastLabels = sides.map((s) => s.label);
            const lastSolved = lastSnaps.map((snap) => solveAttemptFromBrowserState({
                boardCells: snap.boardCells,
                rackLetters: snap.rack.map((r) => r.letter)
            }));
            await stateLog.logFailure(
                page1, page2, round, lastSnaps, lastLabels, lastSolved,
                `stalled-${idleRounds}-idle-hostPool=${hostPool}`
            );
            await Promise.all(sides.map((s) => stateLog.probeFrame(s.frame, s.label)));
            const hostDiag = await frame1.evaluate(() => {
                const g = window.game;
                if (!g?._checker || typeof BananaGrid === 'undefined') return null;
                const hand = typeof g._snapHandForValidation === 'function'
                    ? g._snapHandForValidation(g.tiles) : g.tiles;
                const v = BananaGrid.validateGrid(hand, g._checker);
                const uid = g._myUid?.();
                return {
                    tiles: g.tiles?.length ?? 0,
                    owned: g._mpOwned?.[uid]?.length ?? 0,
                    pool: g._tilePool?.length ?? 0,
                    gridOk: !!v.ok,
                    invalid: (v.invalid || []).slice(0, 8),
                    words: (v.words || []).slice(0, 10),
                    connected: BananaGrid.isConnected(hand),
                    unique: BananaGrid.eachTileOccupiesUniqueCell(hand),
                    dist: g._lastMpDistCheck || null
                };
            });
            log(`[STALL-DIAG] host=${JSON.stringify(hostDiag)}`);
            throw new Error(`AI playthrough stalled (${idleRounds} idle round-trips, `
                + `stats=${JSON.stringify(stats)}, hostPool=${hostPool})`);
        }
    }

    if (playToWin) {
        throw new Error(
            `MP actions did not finish in ${maxRounds} round-trips `
            + `(peels=${stats.peels}, dumps=${stats.dumps}, placements=${stats.placements})`
        );
    }

    throw new Error(
        `AI playthrough did not reach goals in ${maxRoundTrips} round-trips `
        + `(placements=${stats.placements}/${minPlacements}, `
        + `peels=${stats.peels}/${minPeels}, dumps=${stats.dumps}/${minDumps}, `
        + `hostPeels=${stats.hostPeels}/${minHostPeels}, guestPeels=${stats.guestPeels}/${minGuestPeels})`
    );
}

/**
 * Redeal + SPLIT so AI starts from fresh starting racks (after edge-case tests mutate boards).
 */
async function resetMpForAiPlaythrough(opts) {
    const {
        page1, page2, frame1, frame2, mp, mobile = false, expectedPool = null,
        instantBanners = false
    } = opts;

    log('[AI] Reset to fresh split hands (solver playthrough)...');
    const expectedHand = await frame1.evaluate(() => (
        typeof BananaRules !== 'undefined' ? BananaRules.startingHandSize(2) : 21
    ));
    await flushHostBananaInteractions(page1);
    const resetDiag = await frame1.evaluate(() => {
        const g = window.game;
        if (!g?.isHost?.()) throw new Error('resetMpForAiPlaythrough requires host frame');
        g._bananaHandled = {};
        g._bananaAck = {};
        if (g.roomData?.interactions) g.roomData.interactions.banana = null;
        const db = window.NetworkEngine?.db;
        const rId = g.roomId;
        if (db && rId) {
            db.ref(`games/${rId}/interactions/banana`).set(null);
        }
        const buildReset = g.sync?.buildHostResetUpdates
            || (typeof GameSync !== 'undefined' ? GameSync.buildHostResetUpdates : null);
        let resetCount = g.roomData?.global?.resetCount ?? null;
        let resetUpdates = null;
        if (buildReset) {
            resetUpdates = buildReset(g, { wasOver: false, includeBoard: false });
            resetCount = g.lastResetCount ?? g.roomData?.global?.resetCount ?? resetCount;
        }
        g.onGameReset();
        const uids = g._getPlayerUids();
        const handSize = g._handSizeForParty?.() ?? 21;
        const uid = g._myUid();
        const owned = g._mpOwned?.[uid] || [];
        if (!uids || uids.length < 2) {
            throw new Error(`reset: party too small (${JSON.stringify(uids)})`);
        }
        if (owned.length < handSize) {
            throw new Error(`reset: host not dealt (${owned.length}/${handSize})`);
        }
        g._hostBeginSplit();
        if ((g.tiles?.length || 0) < owned.length) {
            g.tiles = g._mergeInventoryWithLayout(
                owned,
                g._mpPlayerLayouts?.[uid] || {},
                null
            );
            g._localInventorySeq = g._mpInventorySeq?.[uid] || 1;
        }
        g._persistMpLayout?.();
        if (buildReset && resetUpdates) {
            resetUpdates['global/board'] = g.serializeBoard();
            g.updateMetadata(resetUpdates);
            resetCount = g.lastResetCount ?? g.roomData?.global?.resetCount ?? resetCount;
        }
        g._mpAssertDealEpochMembership?.('ai-reset');
        return {
            uids: uids.length,
            handSize,
            owned: owned.length,
            tiles: g.tiles?.length ?? 0,
            gameStarted: !!g.gameStarted,
            resetCount
        };
    });
    log(`[AI] Reset host diag: ${JSON.stringify(resetDiag)}`);
    await Promise.all([frame1, frame2].map((frame) => frame.evaluate(() => {
        const g = window.game;
        if (!g) return;
        g._lastDumpSeq = 0;
        g._lastPeelSeq = 0;
        g._bannerText = '';
        g._bannerUntil = 0;
    })));

    await waitForDiag(page1, 'AI reset host started', ({ minHand }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return !!g?.gameStarted && (g.tiles?.length ?? 0) >= minHand;
    }, { minHand: expectedHand }, RESET_WAIT_MS, mp);

    const epochTarget = resetDiag.resetCount ?? 2;
    await waitForDiag(page2, 'AI reset guest epoch', ({ rc }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const epoch = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readResetCount(room)
            : (room?.global?.resetCount ?? 0);
        return epoch >= rc;
    }, { rc: epochTarget }, RESET_WAIT_MS, mp);
    await frame2.evaluate(() => {
        const g = window.game;
        if (!g || g.isHost?.()) return;
        g._clearLocalLayout?.();
        g._lastPeelSeq = 0;
        g._localInventorySeq = 0;
        g._mpAwaitReset = false;
        g._mpAppliedResetCount = g.lastResetCount ?? g.roomData?.global?.resetCount ?? 0;
        const board = (typeof RtdbSchema !== 'undefined' && g.roomData)
            ? RtdbSchema.readBoardFromRoom(g.roomData)
            : g.roomData?.global?.board;
        if (board) {
            g._applyMultiplayerBoard(board, { force: true, reset: true });
        }
        g.requestRender?.();
    });
    await waitForDiag(page2, 'AI reset guest started', ({ minHand }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return !!g?.gameStarted && (g.tiles?.length ?? 0) >= minHand;
    }, { minHand: expectedHand }, RESET_WAIT_MS, mp);
    await flushHostBananaInteractions(page1);

    const poolTarget = expectedPool ?? (await getHandAndPool(page1)).poolAfterDeal;
    await waitPoolBoth(page1, page2, poolTarget);
    const bannerFn = instantBanners ? enableInstantBanners : enableFastBanners;
    await Promise.all([
        bannerFn(frame1),
        bannerFn(frame2),
        assertStartingRackConnected(page1, 'AI reset host rack', mp),
        assertStartingRackConnected(page2, 'AI reset guest rack', mp)
    ]);
    await flushHostBananaInteractions(page1);
    await Promise.all([frame1, frame2].map((frame) => frame.evaluate(() => {
        const g = window.game;
        if (!g) return;
        g._lastDumpSeq = 0;
        g._lastPeelSeq = 0;
    })));
    log(`[AI] Fresh split ready (pool=${poolTarget}, both racks connected).`);
    if (isMpHeaded()) {
        if (mobile) {
            await centerMpViewerOnPages([page1, page2], { mobile: true });
            await probeHeadedMobileViewport([page1, page2], 'after AI reset split', mobile);
        } else {
            await syncHeadedDesktopMpView([page1, page2]);
        }
    }
    return { frame1, frame2, expectedPool: poolTarget };
}

/** Boot through deal + SPLIT for standalone --scenario=actions. */
async function bootMpForAi(page1, page2, { mobile = false, instantBanners = false } = {}) {
    const mp = { page1, page2 };
    await waitForDeal(page1, 'P1', mp);
    await waitForDeal(page2, 'P2', mp);
    await assertHostDealPool(page1, EXPECTED_MP_2P_POOL, 'host deal bunch', mp);
    await Promise.all([
        assertStartingRackConnected(page1, 'host deal', mp),
        assertStartingRackConnected(page2, 'guest deal', mp)
    ]);
    const frame1 = await getGameFrame(page1);
    const frame2 = await getGameFrame(page2);
    const bannerFn = instantBanners ? enableInstantBanners : enableFastBanners;
    await Promise.all([bannerFn(frame1), bannerFn(frame2)]);
    const split = await splitViaDrag(frame1, { mobile });
    if (!split.ok) throw new Error(`SPLIT failed (${JSON.stringify(split)})`);
    await Promise.all([
        waitForDiag(page1, 'SPLIT host', () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!g?.gameStarted;
        }, {}, WAIT_MS, mp),
        waitForDiag(page2, 'SPLIT guest', () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!g?.gameStarted;
        }, {}, WAIT_MS, mp)
    ]);
    if (isMpHeaded()) {
        if (mobile) {
            await centerMpViewerOnPages([page1, page2], { mobile: true });
            await probeHeadedMobileViewport([page1, page2], 'after boot SPLIT', mobile);
        } else {
            await syncHeadedDesktopMpView([page1, page2]);
        }
    }
    return { frame1, frame2, mp };
}

/** Headed --open: wait for a real empty-bunch win to enter post-game review (never debugTriggerWin). */
async function waitForNaturalVictoryInReview(page1, page2, mp, opts = {}) {
    const reviewMs = Math.max(WAIT_MS, Number(process.env.FIVE_MP_REVIEW_SYNC_MS || 1200)) * 4;
    await awaitMpVictorySettled(page1, page2, mp, 'actions open win');
    if (opts.assertActionsWinInvariants) {
        await assertActionsPoolZero(page1, page2, mp, 'actions open win');
    }
    const frame1 = await getGameFrame(page1);
    await frame1.waitForFunction(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        const pool = g?._tilePool?.length ?? -1;
        const boardPool = Array.isArray(board?.pool) ? board.pool.length : pool;
        const inReview = !!(g?._winnerUid && (
            g._postGameReview
            || board?.phase === 'review'
            || board?.reviewPhase === true
        ));
        return inReview && pool === 0 && boardPool === 0;
    }, undefined, { timeout: reviewMs }).catch(async () => {
        const snap = await frame1.evaluate(() => {
            const g = window.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            return {
                winnerUid: g?._winnerUid ?? null,
                postGameReview: !!g?._postGameReview,
                phase: board?.phase ?? null,
                pool: g?._tilePool?.length ?? null,
                boardPool: board?.pool?.length ?? null,
                tileCount: g?.tiles?.length ?? 0
            };
        });
        throw new Error(`actions open: expected legal win (bunch=0, review) (${JSON.stringify(snap)})`);
    });
}

async function awaitMpActionsReviewOpen(page1, page2, { mobile = false } = {}) {
    const mp = { page1, page2 };
    const reviewSyncMs = mobile
        ? Number(process.env.FIVE_MP_REVIEW_SYNC_MS || 1200)
        : WAIT_MS;
    const frame1 = await getGameFrame(page1);
    const frame2 = await getGameFrame(page2);
    const frames = [frame1, frame2];
    const pages = [page1, page2];
    log('MP actions open: waiting for post-game review...');
    await waitForNaturalVictoryInReview(page1, page2, mp, {
        assertActionsWinInvariants: true,
        frame1,
        frame2
    });
    await flushHostBananaInteractions(page1);
    await frame1.evaluate(() => {
        window.game._processBananaInteractions?.(window.game.roomData?.interactions?.banana);
    }).catch(() => {});

    await waitMpClientsInReview(frames, 'actions-open-review', reviewSyncMs, pages);
    await waitMpClientsPostWinReady(
        frames,
        [HOST_UID, GUEST_UID],
        'actions-open-boards',
        reviewSyncMs,
        pages
    );
    await assertGuestReviewVisibleWithoutInteraction(page1, 'actions-open host review');
    await assertGuestReviewVisibleWithoutInteraction(page2, 'actions-open guest review');
    await waitForHostReviewReady(frame1, page1, reviewSyncMs);
    await assertActionsReviewPersists(frames, pages, mp, 'actions open review');
    const { waitPostGameReview } = require('../../mobile/bananagrams_mp_postgame');
    if (isMpHeaded()) {
        await relayoutMpHeadedForReview(pages, { mobile });
    }
    await waitPostGameReview(page1, 'host', { hostOnly: true });
    await waitPostGameReview(page2, 'guest');
    await assertActionsReviewLayouts(frame1, page1, mp, 'actions open review');

    const dist = await assertTileDistributionInReview(
        frame1,
        'actions open review tile-distribution',
        { requireReviewLayouts: true }
    );
    log(`SUCCESS: actions open — tile distribution OK (${dist.bagLabel}, `
        + `${dist.actualTotal} tiles via ${dist.countSource})`);
    log('SUCCESS: MP actions open — stopped in post-game review.');
}

function preloadAiDictionary() {
    if (process.env.BANANA_AI_QUIET !== '0') process.env.BANANA_AI_QUIET = '1';
    getDictionary();
}

function resolveSessionRounds(opts = {}) {
    const raw = opts.rounds ?? (() => {
        try {
            const { getRounds } = require('../../../../shared/infra/run-config');
            return getRounds();
        } catch (_) {
            return 1;
        }
    })();
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
}

function resolveSessionPause(opts = {}) {
    if (opts.pause != null) return !!opts.pause;
    try {
        const { isPaused } = require('../../../../shared/infra/run-config');
        return isPaused();
    } catch (_) {
        return false;
    }
}

function pauseTimeoutMs() {
    return Number(process.env.FIVE_PAUSE_TIMEOUT_MS || 3600000);
}

/** Headed review layout while waiting for manual Done. */
async function syncPausedReviewView(pages, mobile) {
    if (!isMpHeaded()) return;
    await relayoutMpHeadedForReview(pages, { mobile });
}

async function readMpPauseState(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        const hand = g?.tiles || [];
        const inReview = !!(g?._postGameReview || board?.phase === 'review' || board?.reviewPhase === true);
        const btn = document.getElementById('banana-done-btn');
        return {
            inReview,
            doneVisible: !!btn?.classList.contains('show'),
            winnerUid: g?._winnerUid || board?.winnerUid || null,
            tileCount: hand.length,
            faceDown: hand.length > 0 && hand.every((t) => !t.faceUp),
            isHost: !!g?.isHost?.()
        };
    });
}

/** Block until host manually presses Done (no 3s finiteTimeout cap). */
async function waitForManualDoneAfterReview(page1, page2, frame1, frame2, roundLabel, { mobile = false } = {}) {
    const pauseMs = pauseTimeoutMs();
    const reviewReadyMs = Math.min(pauseMs, 120000);

    await Promise.all([page1, page2].map((page) => page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (g?.clearAutoReset) g.clearAutoReset();
    })));

    await frame1.waitForFunction(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board;
        const inReview = !!(g?._postGameReview || board?.phase === 'review' || board?.reviewPhase === true);
        const btn = document.getElementById('banana-done-btn');
        return inReview && !!g?.isHost?.() && btn?.classList.contains('show');
    }, undefined, { timeout: reviewReadyMs });

    await frame2.waitForFunction(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board;
        return !!(g?._postGameReview || board?.phase === 'review' || board?.reviewPhase === true
            || board?.winnerUid);
    }, undefined, { timeout: reviewReadyMs });

    await syncPausedReviewView([page1, page2], mobile);
    log(`[PAUSE] ${roundLabel}: post-game review — press Done on host to continue.`);

    const waitLeftReview = async (frame, label) => {
        try {
            await frame.waitForFunction(() => {
                const g = window.game;
                const board = g?.roomData?.global?.board;
                const inReview = !!(g?._postGameReview || board?.phase === 'review' || board?.reviewPhase === true);
                if (inReview) return false;
                const minHand = typeof BananaRules !== 'undefined' ? BananaRules.startingHandSize(2) : 11;
                const hand = g?.tiles || [];
                return !!(g
                    && !board?.winnerUid
                    && !g._winnerUid
                    && !g._victoryRegistered
                    && !g.isOver
                    && hand.length >= minHand
                    && hand.every((t) => !t.faceUp));
            }, undefined, { timeout: pauseMs });
        } catch (err) {
            const snap = await readMpPauseState(frame).catch(() => null);
            throw new Error(`${label}: timed out waiting for manual Done (${JSON.stringify(snap)}): ${err.message}`);
        }
    };

    await Promise.all([
        waitLeftReview(frame1, `${roundLabel} host`),
        waitLeftReview(frame2, `${roundLabel} guest`)
    ]);
    log(`[PAUSE] ${roundLabel}: host Done detected — starting next round.`);
}

/** Host Done → face-down redeal between scenarios (no SPLIT). */
async function exitReviewAfterActionsSession(page1, page2, frame1, frame2, mp, label) {
    const inReview = await frame1.evaluate(() => {
        const g = window.game;
        return !!(g?._inReviewExperience?.() || g?._postGameReview || g?.winnerUid);
    });
    if (!inReview) {
        log(`[AI] ${label}: not in review — skip Done exit.`);
        return;
    }
    const { clickDone } = require('../../mobile/bananagrams_mp_postgame');
    log(`${label}: host Done → leave review for next scenario...`);
    await clickDone(frame1);
    await Promise.all([
        waitMpResetAfterDone(frame1, `${label} host`, RESET_WAIT_MS),
        waitMpResetAfterDone(frame2, `${label} guest`, RESET_WAIT_MS)
    ]);
    await dismissBanners(page1, page2);
}

/** After host Done: face-down redeal is already applied — SPLIT and resume play (no full reset). */
async function resumeMpSplitAfterReviewDone(page1, page2, frame1, frame2, mp, mobile, label) {
    await flushHostBananaInteractions(page1);
    await frame1.evaluate(() => {
        const g = window.game;
        if (!g) return;
        g._bananaHandled = {};
        g._bananaAck = {};
        if (g._inReviewExperience?.()) {
            g._exitReviewLocalState?.();
        }
        g._hostReviewTransitionActive = false;
        g._postGameReview = false;
    });
    await Promise.all([enableInstantBanners(frame1), enableInstantBanners(frame2)]);
    const split = await splitViaDrag(frame1, { mobile });
    if (!split.ok) {
        throw new Error(`${label} SPLIT after review failed (${JSON.stringify(split)})`);
    }
    await flushHostBananaInteractions(page1);
    await frame2.evaluate(() => {
        const g = window.game;
        if (!g || g.isHost?.()) return;
        g._clearLocalLayout?.();
        g._mpAppliedResetCount = g.lastResetCount ?? g.roomData?.global?.resetCount ?? 0;
        const board = (typeof RtdbSchema !== 'undefined' && g.roomData)
            ? RtdbSchema.readBoardFromRoom(g.roomData)
            : g.roomData?.global?.board;
        if (board) {
            g._applyMultiplayerBoard(board, { force: true, reset: true });
        }
        if (board?.gameStarted && !g.gameStarted && typeof g._guestBeginSplit === 'function') {
            g._guestBeginSplit();
        }
        g.requestRender?.();
    });
    const expectedHand = await frame1.evaluate(() => (
        typeof BananaRules !== 'undefined' ? BananaRules.startingHandSize(2) : 21
    ));
    await Promise.all([
        waitForDiag(page1, `${label} SPLIT host`, ({ minHand }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!g?.gameStarted && (g.tiles?.length ?? 0) >= minHand;
        }, { minHand: expectedHand }, RESET_WAIT_MS, mp),
        waitForDiag(page2, `${label} SPLIT guest`, ({ minHand }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!g?.gameStarted && (g.tiles?.length ?? 0) >= minHand;
        }, { minHand: expectedHand }, RESET_WAIT_MS, mp)
    ]);
    await flushHostBananaInteractions(page1);
    const poolTarget = (await getHandAndPool(page1)).poolAfterDeal;
    await waitPoolBoth(page1, page2, poolTarget);
    await Promise.all([
        assertStartingRackConnected(page1, `${label} host rack`, mp),
        assertStartingRackConnected(page2, `${label} guest rack`, mp)
    ]);
    log(`[AI] ${label} — fresh split after review (pool=${poolTarget}).`);
    return { frame1, frame2, expectedPool: poolTarget };
}

/** Host Done → fresh split hands for the next game in the same party session. */
async function advanceActionsRoundAfterReview(page1, page2, frame1, frame2, mp, mobile, roundLabel, options = {}) {
    const pause = !!options.pause;
    if (pause) {
        await waitForManualDoneAfterReview(page1, page2, frame1, frame2, roundLabel, { mobile });
    } else {
        const { clickDone } = require('../../mobile/bananagrams_mp_postgame');
        log(`${roundLabel}: host Done → next game in party...`);
        await clickDone(frame1);
        await Promise.all([
            waitMpResetAfterDone(frame1, `${roundLabel} host`, RESET_WAIT_MS),
            waitMpResetAfterDone(frame2, `${roundLabel} guest`, RESET_WAIT_MS)
        ]);
    }
    await dismissBanners(page1, page2);
    const freshFrame1 = await getGameFrame(page1);
    const freshFrame2 = await getGameFrame(page2);
    return resumeMpSplitAfterReviewDone(
        page1, page2, freshFrame1, freshFrame2, mp, mobile, roundLabel
    );
}

/** Final round: sync review UI and stop (user inspects; --open keeps browser). */
async function finishPausedReviewSession(page1, page2, { mobile = false } = {}) {
    await awaitMpActionsReviewOpen(page1, page2, { mobile });
    await syncPausedReviewView([page1, page2], mobile);
    if (isMpHeaded()) {
        const hostFrame = await getGameFrame(page1);
        const { assertHeadedMpLayout } = require('../../../../shared/platform/mp-headed-assertions');
        await assertHeadedMpLayout({
            pages: [page1, page2],
            mobile,
            hostPage: page1,
            hostFrame,
            log
        });
    }
    log('[PAUSE] Post-game review ready — press Done on host when finished inspecting.');
}

async function runMpAiActionsOnly(page1, page2, options = {}) {
    preloadAiDictionary();
    const mobile = !!options.mobile;
    const headedReview = isMpHeaded();
    const rounds = resolveSessionRounds(options);
    const pause = resolveSessionPause(options);
    if (pause) {
        const pauseMs = pauseTimeoutMs();
        page1.setDefaultTimeout(pauseMs);
        page2.setDefaultTimeout(pauseMs);
    }
    const winDrag = options.winDrag ?? false;
    log(headedReview
        ? `MP actions: headed — play to win (${rounds} round${rounds > 1 ? 's' : ''}`
            + `${pause ? ', pause in review' : ''}), assert post-game review + Done.`
        : `MP actions: solo-style AI playthrough (play to win, ${rounds} round${rounds > 1 ? 's' : ''}`
            + `${pause ? ', pause in review' : ''})...`);
    const mp = { page1, page2 };
    let frame1;
    let frame2;
    if (!options.skipSeed) {
        ({ frame1, frame2 } = await bootMpForAi(page1, page2, { mobile, instantBanners: true }));
        await probeHeadedMobileViewport([page1, page2], 'after bootMpForAi', mobile);
    } else {
        frame1 = await getGameFrame(page1);
        frame2 = await getGameFrame(page2);
    }
    let activeFrame1 = frame1;
    let activeFrame2 = frame2;
    const reset = await resetMpForAiPlaythrough({
        page1, page2, frame1, frame2, mp, mobile, instantBanners: true
    });
    activeFrame1 = reset.frame1;
    activeFrame2 = reset.frame2;
    await probeHeadedMobileViewport([page1, page2], 'after resetMpForAiPlaythrough', mobile);

    const roundStats = [];
    for (let round = 1; round <= rounds; round++) {
        log(`MP actions round ${round}/${rounds}...`);
        const stats = await runMpAiPlaythrough({
            page1, page2,
            frame1: activeFrame1,
            frame2: activeFrame2,
            mp, mobile,
            playToWin: true,
            assertActionsWinInvariants: true,
            winDrag,
            winSide: options.winSide ?? null,
            aggressiveDumping: !!options.aggressiveDumping,
            aggressiveDumpsPerPlayer: Number(options.aggressiveDumpsPerPlayer) || 10,
            pause,
            instantBanners: true
        });
        roundStats.push({ round, ...stats });
        await probeHeadedMobileViewport([page1, page2], `after playthrough round ${round}`, mobile);

        if (round < rounds) {
            const next = await advanceActionsRoundAfterReview(
                page1, page2, activeFrame1, activeFrame2, mp, mobile, `round ${round}`,
                { pause }
            );
            activeFrame1 = next.frame1;
            activeFrame2 = next.frame2;
            continue;
        }

        if (pause) {
            await finishPausedReviewSession(page1, page2, { mobile });
        } else if (headedReview) {
            await awaitMpActionsReviewOpen(page1, page2, { mobile });
            await probeHeadedMobileViewport([page1, page2], 'after review open', mobile);
            await relayoutMpHeadedForReview([page1, page2], { mobile });
            await probeHeadedMobileViewport([page1, page2], 'after review relayout', mobile);
            activeFrame1 = await getGameFrame(page1);
            const { assertHeadedMpLayout } = require('../../../../shared/platform/mp-headed-assertions');
            await assertHeadedMpLayout({
                pages: [page1, page2],
                mobile,
                hostPage: page1,
                hostFrame: activeFrame1,
                log
            });
        }
    }

    if (!pause) {
        activeFrame1 = await getGameFrame(page1);
        activeFrame2 = await getGameFrame(page2);
        await exitReviewAfterActionsSession(
            page1, page2, activeFrame1, activeFrame2, mp, 'actions session'
        );
    }

    log(pause
        ? `SUCCESS: MP actions complete (${rounds} round${rounds > 1 ? 's' : ''}, paused in review).`
        : headedReview
            ? `SUCCESS: MP actions complete (${rounds} round${rounds > 1 ? 's' : ''}, post-game review + Done verified).`
            : `SUCCESS: MP actions playthrough complete (${rounds} round${rounds > 1 ? 's' : ''}).`);
    return rounds > 1 ? { rounds: roundStats, ...roundStats[roundStats.length - 1] } : roundStats[0];
}

module.exports = {
    runMpAiPlaythrough,
    runMpAiActionsOnly,
    bootMpForAi,
    resetMpForAiPlaythrough,
    seedBananaRoom,
    joinGuest,
    joinBananaPartyViaInvite,
    injectSnapshot,
    applyPlacements,
    solveAndApplyAiMove,
    readPeelSeq,
    resolvePlayToWin,
    resolveWinSteering,
    resolveDesiredWinSide,
    awaitMpVictorySettled,
    assertActionsWinInvariants,
    assertActionsWinSnap,
    assertActionsWinBoards,
    assertActionsPoolZero,
    assertActionsReviewLayouts,
    assertActionsReviewPersists,
    assertActionsWinBanner,
    awaitMpActionsReviewOpen,
    resolveSessionRounds,
    resolveSessionPause,
    advanceActionsRoundAfterReview,
    exitReviewAfterActionsSession,
    resumeMpSplitAfterReviewDone,
    waitForManualDoneAfterReview,
    finishPausedReviewSession,
    preloadAiDictionary,
    readMpBoardSyncState,
    readPlayerWinBoardFromFrame
};
