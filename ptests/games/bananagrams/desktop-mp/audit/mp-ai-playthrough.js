/**
 * MP 2p AI playthrough — solver-driven placement, peel, dump via game APIs.
 * Host/guest alternate; guest actions flushed on host. No UI drag required.
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
    waitForDeal,
    getHandAndPool,
    assertStartingRackConnected,
    waitPoolBoth,
    waitForDiag,
    getGameFrame,
    enableFastBanners,
    enableInstantBanners,
    splitViaDrag,
    flushHostBananaInteractions,
    syncGuestInventoryToHost,
    syncGuestPoolFromHost,
    syncGuestFromHost,
    waitDumpResult,
    waitGuestDumpResult,
    assertActionBannerOnBoth,
    dismissBanners,
    mpPollMs,
    mpVictoryWaitMs,
    mpReviewWaitMs
} = require('../../lib/mp-lib');
const stateLog = require('./actions-state-log');
const { centerMpViewerOnPages, isMpHeaded, syncMpHeadedMobileViewport } = require('../../../../shared/platform/mp-headed-view');
const { shouldCloseBrowser } = require('../../../../shared/infra/env-defaults');
const {
    mergeGuestLayoutOnHost,
    pushHostReviewStateToClients
} = require('../../assertions/bananagrams_postgame_assertions');
const { assertTileDistributionInReview } = require('../../assertions/bananagrams_distribution_assertions');

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
    if (BananaGrid.isStartingRack(g.tiles, originPt, opts)) {
        return {
            rack: g.tiles.map((t) => ({ id: t.id, letter: t.letter })),
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
            boardCells.push({ gx, gy, letter: t.letter });
        } else {
            rack.push({ id: t.id, letter: t.letter });
        }
    }
    const allPlaced = typeof g._allTilesPlaced === 'function' ? g._allTilesPlaced() : false;
    const gridCheck = BananaGrid.validateGrid(g.tiles, g._checker);
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

async function applyPlacements(frame, snap, solved, opts = {}) {
    const reservedTileIds = opts.reservedTileIds || [];
    return frame.evaluate(({ placements, origin, gap, reservedIds }) => {
        const g = window.game;
        const reserved = new Set(reservedIds || []);
        const used = new Set();
        const halfGap = gap / 2;
        for (const p of placements) {
            const tx = origin + p.gx * gap;
            const ty = origin + p.gy * gap;
            const want = String(p.letter || '').toUpperCase();
            let best = null;
            let bestD = Infinity;
            for (const t of g.tiles) {
                if (used.has(t.id) || reserved.has(t.id) || t.letter.toUpperCase() !== want) continue;
                if (Math.abs(t.x - tx) <= halfGap && Math.abs(t.y - ty) <= halfGap) {
                    best = t;
                    bestD = 0;
                    break;
                }
                const d = (t.x - tx) ** 2 + (t.y - ty) ** 2;
                if (d < bestD) { bestD = d; best = t; }
            }
            if (!best) return { ok: false, reason: 'missing-tile', letter: p.letter };
            used.add(best.id);
            best.x = tx;
            best.y = ty;
            best.faceUp = true;
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
        if (typeof g.requestRender === 'function') g.requestRender();
        return { ok: true, placed: used.size };
    }, {
        placements: solved.placements,
        origin: snap.origin,
        gap: snap.gap,
        reservedIds: reservedTileIds
    });
}

async function publishGuestStep(hostPage, page, isGuest) {
    if (!isGuest) {
        await flushHostBananaInteractions(hostPage);
        return;
    }
    await syncGuestInventoryToHost(hostPage, page, GUEST_UID);
    await flushHostBananaInteractions(hostPage);
}

async function readHostPoolLen(hostPage) {
    return hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return -1;
        if (typeof g.isHost === 'function' && g.isHost()) {
            return g._tilePool?.length ?? -1;
        }
        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        if (Array.isArray(board?.pool)) return board.pool.length;
        return g._tilePool?.length ?? -1;
    });
}

/** Merge host bunch count into a client snapshot (guest local pool can lag). */
async function snapshotWithHostPool(frame, hostPage) {
    const snap = await frame.evaluate(() => window.snapshotMpAiState());
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
        const grid = BananaGrid.validateGrid(g.tiles, g._checker);
        if (!grid.ok) return false;
        if (!BananaGrid.isConnected(g.tiles)) return false;
        if (!BananaGrid.eachTileOccupiesUniqueCell(g.tiles)) return false;
        const hasThree = (grid.words || []).some((w) => String(w || '').length >= 3);
        if (!hasThree) return false;
        return typeof g._allTilesPlaced === 'function' ? g._allTilesPlaced() : true;
    });
    if (!gridReady) return null;
    if (snap.rack.length && snap.poolLen !== 0) return null;
    if (!snap.boardCells.length && snap.poolLen !== 0) return null;

    if (isGuest) {
        await syncGuestPoolFromHost(hostPage, page);
        await syncGuestInventoryToHost(hostPage, page, GUEST_UID);
    }

    // Bunch empty + valid grid → win (hub victory banner), not peel.
    if (snap.poolLen === 0) {
        if (!sideMatchesDesiredWin(ctx)) return null;

        const triggerWin = async () => {
            if (isGuest) await syncGuestPoolFromHost(hostPage, page);
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
    await assertActionBannerOnBoth(hostPage, page, 'Peel!', actorUid, `${label} peel`);
    await dismissBanners(hostPage, page);

    const poolAfter = await readHostPoolLen(hostPage);
    if (poolAfter === 0) await syncGuestPoolFromHost(hostPage, page);
    await waitPoolBoth(hostPage, page, poolAfter);
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

    if (isGuest) await syncGuestInventoryToHost(hostPage, page, GUEST_UID);
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
    await assertActionBannerOnBoth(hostPage, page, 'Dump!', actorUid, `${label} dump`);
    await dismissBanners(hostPage, page);
    log(`[AI] ${label} dump (pool ${snap.poolLen}→${snap.poolLen - 2})`);
    return { dumps: 1 };
}

/** Periodic dump (solo-style) so MP audit hits dump goals without relying on stuck solver. */
async function tryForcedDump(ctx, snap, label) {
    const { frame, page, hostPage, mp, isGuest } = ctx;
    if (!snap.rack.length || snap.poolLen < 15) return null;

    if (isGuest) await syncGuestInventoryToHost(hostPage, page, GUEST_UID);

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
    await assertActionBannerOnBoth(hostPage, page, 'Dump!', actorUid, `${label} dump`);
    await dismissBanners(hostPage, page);
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

function recordStep(stats, step) {
    if (step.action === 'idle') return false;
    stats.peels += step.peels || 0;
    stats.hostPeels += step.hostPeels || 0;
    stats.guestPeels += step.guestPeels || 0;
    stats.dumps += step.dumps || 0;
    stats.placements += step.placed || 0;
    return true;
}

async function runPlayerStep(ctx, label, round = 0) {
    const { frame, page, hostPage, isGuest } = ctx;
    if (isGuest) {
        await syncGuestPoolFromHost(hostPage, page);
        await syncGuestInventoryToHost(hostPage, page, GUEST_UID);
    }

    const snap = await snapshotWithHostPool(frame, hostPage);
    if (snap.winner) return { win: true, action: 'win' };

    if (ctx.desiredWinSide && !sideMatchesDesiredWin(ctx) && snap.poolLen <= 10) {
        return { action: 'idle' };
    }

    const reservedTileIds = reservedRackIdsForSteering(snap, ctx);
    let solved = solveForPlayerStep(snap, ctx);
    let applySnap = snap;

    if (solved.changed) {
        let applied = await applyPlacements(frame, applySnap, solved, { reservedTileIds });
        if (!applied.ok) {
            if (isGuest) await syncGuestInventoryToHost(hostPage, page, GUEST_UID);
            applySnap = await snapshotWithHostPool(frame, hostPage);
            solved = solveForPlayerStep(applySnap, ctx);
            if (solved.changed) {
                applied = await applyPlacements(frame, applySnap, solved, {
                    reservedTileIds: reservedRackIdsForSteering(applySnap, ctx)
                });
            }
        }
        if (!applied?.ok) {
            throw new Error(`${label} apply failed (${JSON.stringify(applied)})`);
        }
        await publishGuestStep(hostPage, page, isGuest);
        const snapAfter = await snapshotWithHostPool(frame, hostPage);
        if (snapAfter.winner) {
            return { win: true, action: 'win', placed: applied.placed, winSnap: snapAfter };
        }
        if (snapAfter.poolLen === 0 || (!snapAfter.rack.length && snapAfter.boardCells.length)) {
            const peelAfter = await tryPeel(ctx, snapAfter, label);
            if (peelAfter) {
                if (isGuest) await syncGuestInventoryToHost(hostPage, page, GUEST_UID);
                log(`[AI] ${label} place+peel (${applied.placed} tiles)`);
                if (peelAfter.final) {
                    return {
                        win: true, action: 'win', placed: applied.placed,
                        winSnap: peelAfter.winSnap,
                        ...peelAfter
                    };
                }
                return { action: 'place+peel', placed: applied.placed, ...peelAfter };
            }
        }
        log(`[AI] ${label} place (${applied.placed} tiles)`);
        return { action: 'place', placed: applied.placed };
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
    const raw = opts.winSide ?? process.env.FIVE_MP_WIN_SIDE ?? null;
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

/** Solver input for this side — withhold rack tiles so non-target side cannot clear. */
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
            const grid = BananaGrid.validateGrid(tiles, g._checker);
            const connected = BananaGrid.isConnected(tiles);
            const unique = BananaGrid.eachTileOccupiesUniqueCell(tiles);
            const hasThree = (grid.words || []).some((w) => String(w || '').length >= 3);
            return {
                uid,
                tileCount: tiles.length,
                validWinBoard: !!(grid.ok && connected && unique && hasThree),
                connected,
                gridOk: grid.ok,
                words: grid.words || [],
                invalidReason: grid.ok ? null : (grid.reason || null)
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

    const validPlayers = (state.players || []).filter((p) => p?.validWinBoard);
    if (validPlayers.length !== 1) {
        throw new Error(
            `${label}: exactly one player must have a fully connected valid board, `
            + `got ${validPlayers.length} (${JSON.stringify(state)})`
        );
    }
    if (validPlayers[0].uid !== state.winnerUid) {
        throw new Error(
            `${label}: valid-board player must be winner `
            + `(winner=${state.winnerUid}, valid=${validPlayers[0].uid})`
        );
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
            log(`${label}: loser ${loser.uid} review board also valid (${loser.tileCount} tiles) — lost race`);
        } else {
            log(`${label}: loser ${loser.uid} review board has straggler(s) `
                + `(${loser.tileCount} tiles, connected=${loser.connected}, gridOk=${loser.gridOk})`);
        }
    }
    const playerWord = losers.length === 1 ? 'both players' : `all ${losers.length + 1} players`;
    log(`SUCCESS: ${label} — bunch=0; winner valid; review layouts for ${playerWord}`);
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
        assertWinBanner = false
    } = opts;

    const maxRounds = (playToWin && assertActionsWinInvariants)
        ? Math.max(maxRoundTrips, 30)
        : maxRoundTrips;

    const victoryOpts = {
        assertActionsWinInvariants,
        frame1,
        frame2
    };

    const goals = {
        minPeels, minDumps, minPlacements, minHostPeels, minGuestPeels
    };

    await injectSnapshot([frame1, frame2]);
    if (isMpHeaded() && !mobile) await centerMpViewerOnPages([page1, page2]);
    if (playToWin && forcedWinSide) {
        log(`[AI] Play-to-win: steering for ${desiredWinSide} victory (--win=${desiredWinSide})`);
    } else if (playToWin) {
        log(`[AI] Play-to-win: steering for ${desiredWinSide} victory (default; --win=guest to override)`);
    }
    const stats = {
        peels: 0, hostPeels: 0, guestPeels: 0, dumps: 0, placements: 0, rounds: 0,
        desiredWinSide
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
            desiredWinSide
        },
        {
            frame: frame2,
            page: page2,
            hostPage: page1,
            mp,
            isGuest: true,
            label: 'P2 (Guest)',
            assertWinBanner,
            desiredWinSide
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
            await flushHostBananaInteractions(page1);
            await page2.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                if (!g || g.isHost?.()) return;
                if (g._myEndingLayoutPublished) return;
                g._freezeMyEndingLayout?.();
                g._publishMyEndingLayout?.();
            }).catch(() => {});
            await flushHostBananaInteractions(page1);
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
            await syncGuestPoolFromHost(page1, page2);
            await assertActionsPoolZero(page1, page2, mp, winLabel);
            await pushHostReviewStateToClients(frame1, [page1, page2]);
            await mergeGuestLayoutOnHost(frame1, [page1, page2]);
            await assertActionsReviewLayouts(frame1, page1, mp, winLabel);

            const dist = await assertTileDistributionInReview(
                frame1,
                `${winLabel} tile-distribution`,
                { requireReviewLayouts: true }
            );
            log(`SUCCESS: ${winLabel} — tile distribution OK (${dist.bagLabel}, `
                + `${dist.actualTotal} tiles via ${dist.countSource})`);
            log(`SUCCESS: ${winLabel} — all actions win invariants passed`);
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

            if (playToWin && round % 3 === 0 && snap.poolLen >= 15 && snap.rack.length > 0
                && sideMatchesDesiredWin(side)) {
                const forced = await tryForcedDump(side, snap, `${side.label} r${round} periodic`);
                if (forced && recordStep(stats, forced)) {
                    await publishGuestStep(side.hostPage, side.page, side.isGuest);
                    progress = true;
                    idleRounds = 0;
                    if (isMpHeaded() && !mobile) await centerMpViewerOnPages([page1, page2]);
                    continue;
                }
            }

            if (!playToWin
                && stats.dumps < minDumps
                && stats.placements >= Math.min(20, minPlacements)
                && round >= 6
                && round % 3 === 0) {
                const forced = await tryForcedDump(side, snap, `${side.label} r${round} periodic`);
                if (forced && recordStep(stats, forced)) {
                    await publishGuestStep(side.hostPage, side.page, side.isGuest);
                    progress = true;
                    idleRounds = 0;
                    if (await finishIfGoalsMet(round)) return stats;
                    if (isMpHeaded() && !mobile) await centerMpViewerOnPages([page1, page2]);
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
            if (recordStep(stats, step)) {
                progress = true;
                idleRounds = 0;
                if (await finishIfGoalsMet(round)) return stats;
            }
            if (isMpHeaded() && !mobile) await centerMpViewerOnPages([page1, page2]);
        }

        if (!progress) idleRounds += 1;
        const hostPool = await readHostPoolLen(page1);
        const idleCap = hostPool === 0 ? 40 : 15;
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
    await frame1.evaluate(() => {
        const g = window.game;
        if (!g?.isHost?.()) throw new Error('resetMpForAiPlaythrough requires host frame');
        g.onGameReset();
        g._hostBeginSplit();
        g._persistMpLayout?.();
    });

    await waitForDiag(page1, 'AI reset host started', ({ minHand }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return !!g?.gameStarted && (g.tiles?.length ?? 0) >= minHand;
    }, { minHand: expectedHand }, RESET_WAIT_MS, mp);
    await waitForDiag(page2, 'AI reset guest started', ({ minHand }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return !!g?.gameStarted && (g.tiles?.length ?? 0) >= minHand;
    }, { minHand: expectedHand }, RESET_WAIT_MS, mp);

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
    await syncGuestFromHost(page1, page2, GUEST_UID);
    log(`[AI] Fresh split ready (pool=${poolTarget}, both racks connected).`);
    if (isMpHeaded() && !mobile) await centerMpViewerOnPages([page1, page2]);
    return { frame1, frame2, expectedPool: poolTarget };
}

/** Boot through deal + SPLIT for standalone --scenario=actions. */
async function bootMpForAi(page1, page2, { mobile = false, instantBanners = false } = {}) {
    const mp = { page1, page2 };
    await waitForDeal(page1, 'P1', mp);
    await waitForDeal(page2, 'P2', mp);
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
    if (isMpHeaded() && !mobile) await centerMpViewerOnPages([page1, page2]);
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
    const {
        waitForHostReviewReady,
        waitMpClientsInReview,
        waitMpClientsPostWinReady,
        mergeGuestLayoutOnHost,
        pushHostReviewStateToClients
    } = require('../../assertions/bananagrams_postgame_assertions');
    const { waitPostGameReview } = require('../../mobile/bananagrams_mp_postgame');

    log('MP actions open: waiting for post-game review...');
    await waitForNaturalVictoryInReview(page1, page2, mp, {
        assertActionsWinInvariants: true,
        frame1,
        frame2
    });
    await flushHostBananaInteractions(page1);

    await frame2.evaluate(() => {
        const g = window.game;
        if (!g || g.isHost?.()) return;
        g._myEndingLayoutPublished = false;
        if (typeof g._freezeMyEndingLayout === 'function') g._freezeMyEndingLayout();
        g._publishMyEndingLayout?.();
    });
    await frame1.evaluate(() => {
        window.game._processBananaInteractions?.(window.game.roomData?.interactions?.banana);
    }).catch(() => {});

    await pushHostReviewStateToClients(frame1, pages);
    await mergeGuestLayoutOnHost(frame1, pages);

    await waitMpClientsInReview(frames, 'actions-open-review', reviewSyncMs, pages, frame1);
    await waitMpClientsPostWinReady(
        frames,
        [HOST_UID, GUEST_UID],
        'actions-open-boards',
        reviewSyncMs,
        pages,
        frame1
    );
    await waitForHostReviewReady(frame1, page1, reviewSyncMs);
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

async function runMpAiActionsOnly(page1, page2, options = {}) {
    preloadAiDictionary();
    const mobile = !!options.mobile;
    const keepOpen = !shouldCloseBrowser();
    log(keepOpen
        ? 'MP actions: headed open — play to win, stop in post-game review.'
        : 'MP actions: solo-style AI playthrough (play to win)...');
    const { frame1, frame2, mp } = await bootMpForAi(page1, page2, { mobile, instantBanners: true });
    const {
        assertHostPeelGuestDisconnectedTilesStable
    } = require('../../assertions/bananagrams_mp_host_peel_guest_disconnected_assertions');
    await assertHostPeelGuestDisconnectedTilesStable({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        log
    });
    const reset = await resetMpForAiPlaythrough({
        page1, page2, frame1, frame2, mp, mobile, instantBanners: true
    });
    const stats = await runMpAiPlaythrough({
        page1, page2,
        frame1: reset.frame1,
        frame2: reset.frame2, mp, mobile,
        playToWin: true,
        assertActionsWinInvariants: true,
        winSide: options.winSide ?? process.env.FIVE_MP_WIN_SIDE ?? null
    });
    if (keepOpen) {
        await awaitMpActionsReviewOpen(page1, page2, { mobile });
        if (isMpHeaded()) {
            if (mobile) {
                const { enableMobileHub } = require('../../../../platform/mobile/lib/mobile_assertions');
                await Promise.all([page1, page2].map((p) => enableMobileHub(p)));
                await Promise.all([page1, page2].map((p) => syncMpHeadedMobileViewport(p)));
            } else {
                await centerMpViewerOnPages([page1, page2]);
            }
        }
    }
    log(keepOpen
        ? 'SUCCESS: MP actions complete (post-game review).'
        : 'SUCCESS: MP actions playthrough complete.');
    return stats;
}

module.exports = {
    runMpAiPlaythrough,
    runMpAiActionsOnly,
    bootMpForAi,
    resetMpForAiPlaythrough,
    seedBananaRoom,
    joinGuest,
    injectSnapshot,
    applyPlacements,
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
    awaitMpActionsReviewOpen,
    preloadAiDictionary,
    readMpBoardSyncState,
    readPlayerWinBoardFromFrame
};
