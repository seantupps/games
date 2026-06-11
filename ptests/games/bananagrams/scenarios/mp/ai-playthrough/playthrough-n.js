/**
 * MP N-player (3p+) AI playthrough — solver drives all party members via game APIs.
 */
const { Game, getDictionary, boardPlacements } = require('../../../ai');
const {
    injectSnapshot,
    applyPlacements
} = require('../../../lib/ai-playthrough-apply');
const { readBoardField } = require('../../../assertions/core/capture');
const {
    assertActionsWinSnap,
    assertActionsReviewLayouts,
    assertActionsReviewPersists,
    assertActionsWinBanner,
    readPlayerWinBoardFromFrame
} = require('../../../assertions/mp/review-actions');
const { readMpBoardSyncState } = require('../../../assertions/mp/victory');
const { preloadAiDictionary } = require('../../../lib/ai-dictionary');
const {
    WAIT_MS,
    RESET_WAIT_MS,
    flushHostBananaInteractions,
    syncGuestInventoryToHost,
    syncGuestPoolFromHost,
    waitDumpResult,
    waitGuestDumpResult,
    waitForDiag,
    getGameFrame,
    splitViaDrag,
    enableFastBanners,
    enableInstantBanners,
    mpPollMs,
    mpVictoryWaitMs,
    mpReviewWaitMs
} = require('../../../lib/mp-state');
const { assertStartingRackConnected } = require('../../../assertions/mp/deal');
const { assertActionBannerOnBoth } = require('../../../../../shared/assertions/mp-authority');
const { buildAppUrl } = require('../../../../../shared/infra/emulator-utils');
const {
    applySpeedProfile,
    mpAiRoundTripCapEnabled,
    resolveMpAiMaxRoundTrips
} = require('../../../../../shared/infra/speed-profiles');
const { shouldCloseBrowser } = require('../../../../../shared/infra/env-defaults');
const { BANANA_3P_PLAYERS } = require('../../../lib/mp-ctx');
const { createBananaMpSession } = require('../../../lib/banana-mp-party');
const {
    centerMpViewerOnPages,
    isMpHeaded,
    relayoutMpHeadedForReview
} = require('../../../../../shared/platform/mp-headed-view');
const {
    mergeGuestLayoutOnHost,
    pushHostReviewStateToClients,
    capturePreReviewBoardsByPlayer,
    seedHostReviewLayoutsFromSnapshots,
    diagnoseReviewLayoutOnFrame,
    assertReviewPreservesPreWinBoards,
    waitForHostReviewReady,
    waitMpClientsInReview,
    waitMpClientsPostWinReady,
    assertGuestReviewVisibleWithoutInteraction
} = require('../../../assertions/mp/review');
const { assertTileDistributionInReview } = require('../../../assertions/mp/distribution');
const { resolvePlaythroughCtx, buildAiSideCtxs } = require('../../../lib/mp-ai-side-ctx');
const { resolveSessionRounds, resolveSessionPause, pauseTimeoutMs } = require('../../../lib/mp-session-config');

const waitOpts = { timeout: WAIT_MS };

function log(msg) {
    console.log(`[3P-AI] ${msg}`);
}

/** Headed mobile viewport relayout during play can reload the host iframe — center only on desktop. */
function recenterHeadedDuringPlay(mobileAll) {
    return isMpHeaded() && !mobileAll;
}

/** Dump draws 3 and returns 1 — keep enough bunch tiles for the next party peel. */
function minPoolBeforeDump(playerCount) {
    return playerCount + 2;
}

/** After peel/dump, pool must be 0 (win) or still allow a full party peel. */
function poolAftermathOk(poolBefore, delta, playerCount) {
    const poolAfter = poolBefore - delta;
    return poolAfter === 0 || poolAfter >= playerCount;
}

function canPeelWithoutDeadlock(poolBefore, playerCount) {
    return poolBefore >= playerCount
        && poolAftermathOk(poolBefore, playerCount, playerCount);
}

function canDumpWithoutDeadlock(poolBefore, playerCount) {
    return poolBefore >= minPoolBeforeDump(playerCount)
        && poolAftermathOk(poolBefore, 2, playerCount);
}

let playerSolvers = null;

function ensurePlayerSolvers(playerCount = 3) {
    if (playerSolvers?.length === playerCount) return playerSolvers;
    const dict = getDictionary();
    playerSolvers = Array.from({ length: playerCount }, () => ({
        solve(state) {
            const rackLetters = state.rackLetters || [];
            const game = new Game(dict, null, { handSize: Math.max(rackLetters.length, 1) });
            for (const { gx, gy, letter } of state.boardCells || []) {
                game.board.setCell(gx, gy, letter);
            }
            game.rack = rackLetters.map((c) => String(c).toUpperCase());
            const [cleared, changed] = game.solveAttempt();
            return {
                cleared,
                changed,
                stuck: !cleared && !changed,
                placements: boardPlacements(game.board),
                rackLeft: [...game.rack],
                reorgs: game.reorgs
            };
        }
    }));
    return playerSolvers;
}

async function waitPoolAll(pages, count) {
    await Promise.all(pages.map((p, i) => waitForDiag(p, `P${i + 1} pool=${count}`, ({ want }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return (g?._tilePool?.length ?? -1) === want;
    }, { want: count }, WAIT_MS)));
}

async function dismissBannersAll(pages) {
    await Promise.all(pages.map((p) => p.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return;
        g._bannerText = '';
        g._bannerUntil = 0;
        g._syncBannerEl?.();
    })));
}

async function publishGuestStep(hostPage, page, uid, isGuest) {
    if (!isGuest) {
        await flushHostBananaInteractions(hostPage);
        return;
    }
    await syncGuestInventoryToHost(hostPage, page, uid);
    await flushHostBananaInteractions(hostPage);
}

async function tryPeel(ctx, snap, label) {
    const { frame, page, hostPage, pages, playerCount, uid, color, actorIndex, isGuest } = ctx;
    const playerUids = BANANA_3P_PLAYERS.slice(0, playerCount).map((p) => p.uid);
    if (await readWinnerUid(hostPage, playerUids)) return null;
    const gameOver = await frame.evaluate(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        return !!(g?._winnerUid || g?.isOver || g?._victoryRegistered
            || board?.phase === 'review' || board?.reviewPhase === true);
    });
    if (gameOver) return null;
    if (snap.rack.length || !snap.boardCells.length || !snap.allPlaced || !snap.gridOk) {
        return null;
    }
    const hostPool = await readPoolLen(hostPage);
    const poolLen = hostPool >= 0 ? hostPool : snap.poolLen;

    if (poolLen === 0) {
        if (ctx.desiredWinSide && !sideMatchesDesiredWin3p(ctx)) return null;
        const peeled = await frame.evaluate(() => {
            window.game._bannerText = '';
            return window.game._checkPeel();
        });
        if (!peeled) return null;
        await flushHostBananaInteractions(hostPage);
        const winnerUid = await readWinnerUid(hostPage, playerUids);
        if (!winnerUid) return null;
        await Promise.all(pages.map((p, i) => waitForDiag(p, `${label} win P${i + 1}`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!(g?._winnerUid || g?._victoryRegistered || g?.isOver);
        }, {}, WAIT_MS)));
        const winSnap = await snapshotWithHostPool(frame, hostPage);
        log(`${label} win (pool=0)`);
        return { peels: 0, peelByUid: {}, final: true, winSnap };
    }

    if (poolLen < playerCount) return null;
    if (!canPeelWithoutDeadlock(poolLen, playerCount)) return null;

    if (isGuest) await syncGuestInventoryToHost(hostPage, page, uid);
    const peelBefore = await readBoardField(hostPage, 'peelSeq');
    const poolBefore = poolLen;
    const peeled = await frame.evaluate(() => {
        window.game._bannerText = '';
        return window.game._checkPeel();
    });
    if (!peeled) return null;

    await flushHostBananaInteractions(hostPage);
    if (await readWinnerUid(hostPage, playerUids)) {
        const winSnap = await snapshotWithHostPool(frame, hostPage);
        return { peels: 1, peelByUid: { [uid]: 1 }, final: true, winSnap };
    }
    const gameOverAfterPeel = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        return !!(g?._winnerUid || g?.isOver || g?._victoryRegistered
            || board?.phase === 'review' || board?.reviewPhase === true);
    });
    if (gameOverAfterPeel) return null;

    const mpDiag = (viewerPage) => ({ page1: hostPage, page2: viewerPage });
    const waitPeelOnPage = (p, pageLabel) => waitForDiag(p, pageLabel, ({ peel, actorUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > peel && board?.peelActorUid === actorUid;
    }, { peel: peelBefore, actorUid: uid }, WAIT_MS, mpDiag(p));

    // Match 2p: one counterparty peel sync before banner (host↔acting guest).
    if (actorIndex === 0) {
        await waitPeelOnPage(pages[1], `${label} host peel on P2`);
    } else {
        await waitPeelOnPage(hostPage, `${label} peel on host`);
    }
    if (!ctx.instantBanners) {
        await assertActionBannerOnBoth(hostPage, page, 'Peel!', uid, `${label} peel`, WAIT_MS);
        await dismissBannersAll(pages);
    }

    const extraPeelSyncs = [];
    for (let i = 1; i < pages.length; i++) {
        if (i === actorIndex || (actorIndex === 0 && i === 1)) continue;
        extraPeelSyncs.push(waitPeelOnPage(pages[i], `${label} peel on P${i + 1}`));
    }
    if (extraPeelSyncs.length) await Promise.all(extraPeelSyncs);

    const poolAfter = poolBefore - playerCount;
    if (poolAfter > 0) {
        await waitPoolAll(pages, poolAfter);
    } else if (await readWinnerUid(hostPage, playerUids)) {
        const winSnap = await snapshotWithHostPool(frame, hostPage);
        return { peels: 1, peelByUid: { [uid]: 1 }, final: true, winSnap };
    }

    log(`${label} peel (pool ${poolBefore}→${poolAfter})`);
    return {
        peels: 1,
        peelByUid: { [uid]: 1 },
        final: false
    };
}

async function tryDump(ctx, snap, solved, label) {
    const { frame, page, hostPage, pages, uid, color, actorIndex, isGuest, role, playerCount } = ctx;
    const minPool = minPoolBeforeDump(playerCount);
    const stuck = solved.stuck || (!solved.changed && !solved.cleared && snap.poolLen >= minPool);
    if (!stuck || !snap.rack.length || snap.poolLen < minPool) return null;
    if (!canDumpWithoutDeadlock(snap.poolLen, playerCount)) return null;
    if (ctx.playToWin && ctx.desiredWinSide && sideMatchesDesiredWin3p(ctx)) return null;

    if (isGuest) await syncGuestInventoryToHost(hostPage, page, uid);
    const beforeIds = await frame.evaluate(() => [...window.game.tiles.map((t) => t.id)]);
    const tileId = snap.rack[0]?.id;
    const dumped = await frame.evaluate((rid) => {
        const t = window.game.tiles.find((tile) => tile.id === rid) || window.game.tiles[0];
        return t ? window.game._handleDump(t) : false;
    }, tileId);
    if (!dumped) return null;

    await flushHostBananaInteractions(hostPage);
    if (isGuest) {
        await waitGuestDumpResult(page, hostPage, role, beforeIds, { page1: pages[0], page2: page });
    } else {
        await waitDumpResult(hostPage, role, beforeIds, { page1: hostPage, page2: pages[1] });
    }
    await waitPoolAll(pages, snap.poolLen - 2);
    if (!ctx.instantBanners) {
        await assertActionBannerOnBoth(hostPage, page, 'Dump!', uid, `${label} dump`, WAIT_MS);
        await dismissBannersAll(pages);
    }
    log(`${label} dump (pool ${snap.poolLen}→${snap.poolLen - 2})`);
    return { dumps: 1 };
}

async function tryForcedDump(ctx, snap, label, options = {}) {
    const { frame, page, hostPage, pages, uid, color, actorIndex, isGuest, role, playerCount } = ctx;
    const minPool = options.minPool ?? Math.max(minPoolBeforeDump(playerCount), 10);
    if (!snap.rack.length || snap.poolLen < minPool) return null;
    if (!canDumpWithoutDeadlock(snap.poolLen, playerCount)) return null;
    if (ctx.playToWin) return null;

    if (isGuest) await syncGuestInventoryToHost(hostPage, page, uid);

    const beforeIds = await frame.evaluate(() => [...window.game.tiles.map((t) => t.id)]);
    const tileId = snap.rack[0]?.id;
    const dumped = await frame.evaluate((rid) => {
        const t = window.game.tiles.find((tile) => tile.id === rid) || window.game.tiles[0];
        return t ? window.game._handleDump(t) : false;
    }, tileId);
    if (!dumped) return null;

    await flushHostBananaInteractions(hostPage);
    if (isGuest) {
        await waitGuestDumpResult(page, hostPage, role, beforeIds, { page1: pages[0], page2: page });
    } else {
        await waitDumpResult(hostPage, role, beforeIds, { page1: hostPage, page2: pages[1] });
    }
    await waitPoolAll(pages, snap.poolLen - 2);
    if (!ctx.instantBanners) {
        await assertActionBannerOnBoth(hostPage, page, 'Dump!', uid, `${label} dump`, WAIT_MS);
        await dismissBannersAll(pages);
    }
    log(`${label} forced dump (pool ${snap.poolLen}→${snap.poolLen - 2})`);
    return { dumps: 1 };
}

function goalsMet(stats, goals, playerUids, poolLen = Infinity) {
    const placementsOk = stats.placements >= goals.minPlacements;
    const peelsOk = stats.peels >= goals.minPeels;
    const dumpsOk = stats.dumps >= goals.minDumps;
    const perPlayerOk = playerUids.every(
        (uid) => (stats.peelByUid[uid] || 0) >= goals.minPeelsPerPlayer
    );
    if (poolLen < 10) {
        return placementsOk && peelsOk && dumpsOk;
    }
    return placementsOk && peelsOk && dumpsOk && perPlayerOk;
}

async function readPoolLen(hostPage) {
    return hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const local = g?._tilePool?.length ?? -1;
        if (Array.isArray(board?.pool)) return board.pool.length;
        return local;
    });
}

async function snapshotWithHostPool(frame, hostPage) {
    const snap = await frame.evaluate(() => window.snapshotMpAiState());
    const hostPool = await readPoolLen(hostPage);
    if (hostPool >= 0) snap.poolLen = hostPool;
    return snap;
}

async function readWinnerUid(hostPage, playerUids) {
    const state = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        return {
            winnerUid: g?._winnerUid || board?.winnerUid || null,
            inReview: !!(g?._victoryRegistered || g?.isOver || g?._postGameReview
                || board?.phase === 'review' || board?.reviewPhase === true)
        };
    });
    if (!state?.winnerUid || !playerUids.includes(state.winnerUid)) return null;
    return state.winnerUid;
}

async function seedRoom3p(hostPage, roomId) {
    const HOST = BANANA_3P_PLAYERS[0];
    await hostPage.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
    }, { uid: HOST.uid, name: HOST.name, color: HOST.color });
    await hostPage.goto(buildAppUrl(roomId, HOST.role, 'bananagrams', 'multiplayer'));
    await hostPage.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    const playerData = {};
    for (const p of BANANA_3P_PLAYERS) {
        playerData[p.uid] = { name: p.name, color: p.color };
    }
    await hostPage.evaluate(({ rId, hostUid, pd }) => {
        const db = window.NetworkEngine.db;
        return db.ref().update({
            [`games/${rId}`]: {
                host: hostUid,
                status: 'playing',
                global: {
                    game: 'bananagrams',
                    mode: 'multiplayer',
                    firstPlayer: 'P1',
                    resetCount: 1,
                    turn: 'P1'
                },
                playerData: pd
            },
            [`gameData/${rId}`]: null
        });
    }, { rId: roomId, hostUid: HOST.uid, pd: playerData });
}

async function joinPlayer3p(page, roomId, player) {
    await page.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
    }, { uid: player.uid, name: player.name, color: player.color });
    await page.goto(buildAppUrl(roomId, player.role, 'bananagrams', 'multiplayer'));
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await page.evaluate(async ({ rId, uid, name, color }) => {
        const ne = window.NetworkEngine;
        if (ne.roomId !== rId) ne.joinRoom(rId);
        await ne.registerPlayerInRoom(name, color);
        await ne.db.ref(`games/${rId}/users/${uid}`).set(Date.now());
    }, { rId: roomId, uid: player.uid, name: player.name, color: player.color });
}

async function waitForDeal3p(page, uid, allPages = null) {
    await waitForDiag(page, `deal uid=${uid}`, ({ u }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g
            && g.isMultiplayer
            && g.mode === 'multiplayer'
            && g._dictReady
            && g._checker
            && g.tiles?.length > 0
            && g._myUid?.() === u;
    }, { u: uid }, WAIT_MS, allPages ? { page1: allPages[0], page2: allPages[1] } : null);
}

async function bootMpForAiN(browser, { mobileAll = false, instantBanners = true, playerCount = 3 } = {}) {
    const { contexts, pages } = await createBananaMpSession(browser, { mobileAll, playerCount: 3 });
    const roomId = `MP_BANANA_3P_ACTIONS_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    await seedRoom3p(pages[0], roomId);
    await joinPlayer3p(pages[1], roomId, BANANA_3P_PLAYERS[1]);
    await joinPlayer3p(pages[2], roomId, BANANA_3P_PLAYERS[2]);
    await Promise.all(BANANA_3P_PLAYERS.map((p, i) => waitForDeal3p(pages[i], p.uid, pages)));
    const frames = await Promise.all(pages.map((p) => getGameFrame(p)));
    const bannerFn = instantBanners ? enableInstantBanners : enableFastBanners;
    await Promise.all(frames.map(bannerFn));
    await Promise.all([
        assertStartingRackConnected(pages[0], '3p actions host deal', { page1: pages[0], page2: pages[1] }),
        assertStartingRackConnected(pages[1], '3p actions P2 deal', { page1: pages[0], page2: pages[1] }),
        assertStartingRackConnected(pages[2], '3p actions P3 deal', { page1: pages[0], page2: pages[2] })
    ]);
    const split = await splitViaDrag(frames[0], { mobile: mobileAll });
    if (!split.ok) throw new Error(`3p SPLIT failed (${JSON.stringify(split)})`);
    await Promise.all(pages.map((p, i) => waitForDiag(p, `SPLIT ${BANANA_3P_PLAYERS[i].role}`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return !!g?.gameStarted;
    }, {}, WAIT_MS)));
    await flushHostBananaInteractions(pages[0]);
    for (let i = 1; i < pages.length; i++) {
        await syncGuestInventoryToHost(pages[0], pages[i], BANANA_3P_PLAYERS[i].uid);
    }
    if (isMpHeaded()) await centerMpViewerOnPages(pages, { mobile: mobileAll });
    return { pages, frames, contexts, roomId };
}

function recordStep(stats, step) {
    if (step.action === 'idle') return false;
    stats.peels += step.peels || 0;
    stats.dumps += step.dumps || 0;
    stats.placements += step.placed || 0;
    if (step.peelByUid) {
        Object.entries(step.peelByUid).forEach(([uid, n]) => {
            stats.peelByUid[uid] = (stats.peelByUid[uid] || 0) + n;
        });
    }
    return true;
}

async function runPlayerStep(ctx, label) {
    const { frame, page, hostPage, uid, isGuest } = ctx;
    if (isGuest) await syncGuestInventoryToHost(hostPage, page, uid);

    const snap = await snapshotWithHostPool(frame, hostPage);
    if (snap.winner) return { win: true, action: 'win', winSnap: snap };

    if (ctx.desiredWinSide && !sideMatchesDesiredWin3p(ctx) && snap.poolLen <= ctx.playerCount + 2) {
        const peelAfter = snap.poolLen - ctx.playerCount;
        const peelBlocked = snap.poolLen > 0
            && (peelAfter <= 0 ? false : peelAfter < ctx.playerCount);
        if (!peelBlocked) return { action: 'idle' };
    }

    const reservedTileIds = reservedRackIdsForSteering3p(snap, ctx);
    const solved = solveForPlayerStep3p(snap, ctx);

    if (solved.changed) {
        const applied = await applyPlacements(frame, snap, solved, { reservedTileIds });
        if (!applied.ok) {
            log(`${label} apply skipped (${JSON.stringify(applied)})`);
            return { action: 'idle' };
        }
        await publishGuestStep(hostPage, page, uid, isGuest);
        const snapAfter = await snapshotWithHostPool(frame, hostPage);
        if (snapAfter.winner) {
            return { win: true, action: 'win', placed: applied.placed, winSnap: snapAfter };
        }
        if (snapAfter.poolLen === 0 || (!snapAfter.rack.length && snapAfter.boardCells.length)) {
            const peelAfter = await tryPeel(ctx, snapAfter, label);
            if (peelAfter) {
                if (isGuest) await syncGuestInventoryToHost(hostPage, page, uid);
                log(`${label} place+peel (${applied.placed} tiles)`);
                if (peelAfter.final) {
                    return {
                        win: true,
                        action: 'win',
                        placed: applied.placed,
                        winSnap: peelAfter.winSnap,
                        ...peelAfter
                    };
                }
                return { action: 'place+peel', placed: applied.placed, ...peelAfter };
            }
        }
        log(`${label} place (${applied.placed} tiles)`);
        return { action: 'place', placed: applied.placed };
    }

    const peel = await tryPeel(ctx, snap, label);
    if (peel) {
        if (peel.final) return { win: true, action: 'win', winSnap: peel.winSnap, ...peel };
        return { action: 'peel', ...peel };
    }

    const dump = await tryDump(ctx, snap, solved, label);
    if (dump) {
        await publishGuestStep(hostPage, page, uid, isGuest);
        return { action: 'dump', ...dump };
    }

    if (!solved.changed && !solved.cleared && snap.poolLen >= minPoolBeforeDump(ctx.playerCount) && snap.rack.length) {
        const forced = await tryForcedDump(ctx, snap, `${label} stuck`, {
            minPool: minPoolBeforeDump(ctx.playerCount)
        });
        if (forced) {
            await publishGuestStep(hostPage, page, uid, isGuest);
            return { action: 'dump', ...forced };
        }
    }

    return { action: 'idle' };
}

/**
 * @param {object} opts
 * @param {import('playwright').Page[]} opts.pages
 * @param {import('playwright').Frame[]} opts.frames
 * @param {number} [opts.playerCount]
 * @param {boolean} [opts.playToWin]
 */
function resolvePlayToWin(opts) {
    if (opts.playToWin != null) return !!opts.playToWin;
    return process.env.FIVE_MP_AI_PLAY_TO_WIN !== '0';
}

function resolveWinSteering3p(opts, playToWin) {
    if (!playToWin) return { side: null, forced: false };
    const raw = opts.winSide ?? (() => {
        try {
            const { getWinSide } = require('../../../../../shared/infra/run-config');
            return getWinSide();
        } catch (_) {
            return null;
        }
    })();
    if (raw === 'host' || raw === 'p1') return { side: 'host', forced: true };
    if (raw === 'guest' || raw === 'p2') return { side: 'guest', forced: true };
    return { side: 'host', forced: false };
}

function sideMatchesDesiredWin3p(ctx) {
    if (!ctx.desiredWinSide) return true;
    if (ctx.desiredWinSide === 'host') return ctx.actorIndex === 0;
    if (ctx.desiredWinSide === 'guest') return ctx.actorIndex === 1;
    return false;
}

const STEER_MIN_RACK_KEEP = 1;

function reservedRackIdsForSteering3p(snap, ctx) {
    if (!ctx.desiredWinSide || sideMatchesDesiredWin3p(ctx)) return [];
    const rack = snap.rack || [];
    if (rack.length <= STEER_MIN_RACK_KEEP) {
        return rack.map((r) => r.id).filter(Boolean);
    }
    return rack.slice(-STEER_MIN_RACK_KEEP).map((r) => r.id).filter(Boolean);
}

function solveForPlayerStep3p(snap, ctx) {
    let rackLetters = (snap.rack || []).map((r) => r.letter);
    if (ctx.desiredWinSide && !sideMatchesDesiredWin3p(ctx)) {
        if (rackLetters.length <= STEER_MIN_RACK_KEEP) {
            return { changed: false, cleared: false, stuck: true, placements: [], rackLeft: rackLetters };
        }
        rackLetters = rackLetters.slice(0, -STEER_MIN_RACK_KEEP);
    }
    const solvers = ensurePlayerSolvers(ctx.playerCount || 3);
    return solvers[ctx.actorIndex].solve({
        boardCells: snap.boardCells,
        rackLetters
    });
}

function expectedWinActorIndex(desiredWinSide) {
    if (desiredWinSide === 'host') return 0;
    if (desiredWinSide === 'guest') return 1;
    return null;
}

async function awaitMpVictorySettled3p(hostPage, pages, label, opts = {}) {
    const requireWin = opts.requireWin !== false;
    const victoryMs = mpVictoryWaitMs();
    await flushHostBananaInteractions(hostPage);
    const mpDiag = (page) => ({ page1: hostPage, page2: page });

    try {
        await waitForDiag(hostPage, `${label} settled on host`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            return !!(g?._winnerUid || g?.isOver || g?._postGameReview
                || board?.phase === 'review' || board?.reviewPhase === true);
        }, {}, victoryMs, mpDiag(hostPage));
    } catch (err) {
        if (requireWin) throw err;
        return;
    }

    for (let i = 1; i < pages.length; i++) {
        await waitForDiag(pages[i], `${label} settled P${i + 1}`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            return !!(g?._winnerUid || g?.isOver || g?._postGameReview
                || board?.phase === 'review' || board?.reviewPhase === true);
        }, {}, victoryMs, mpDiag(pages[i]));
    }

    const syncDeadline = Date.now() + victoryMs;
    while (Date.now() < syncDeadline) {
        await flushHostBananaInteractions(hostPage);
        const states = await Promise.all(pages.map((p) => readMpBoardSyncState(p)));
        const host = states[0];
        const allSynced = states.every((s) => s.boardSeq != null && s.boardSeq === host.boardSeq
            && s.localPool === host.localPool && s.boardPool === host.boardPool);
        const poolZero = !opts.assertActionsWinInvariants || (host.localPool === 0 && host.boardPool === 0);
        if (allSynced && poolZero) break;
        await new Promise((r) => setTimeout(r, mpPollMs()));
    }
}

async function assertActionsPoolZeroAll(pages, label = 'actions win') {
    await flushHostBananaInteractions(pages[0]);
    const poolWaitMs = mpVictoryWaitMs();
    for (let i = 0; i < pages.length; i++) {
        await waitForDiag(pages[i], `${label} bunch=0 P${i + 1}`, () => {
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
        }, {}, poolWaitMs, { page1: pages[0], page2: pages[i] });
    }
    log(`SUCCESS: ${label} — bunch=0 on all ${pages.length} players`);
}

async function publishGuestEndingLayouts(pages, hostPage = pages?.[0]) {
    for (const guestPage of pages.slice(1)) {
        await guestPage.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g || g.isHost?.()) return;
            // Victory may auto-publish before final tile sync — always re-freeze at settlement.
            g._myEndingLayoutPublished = false;
            g._freezeMyEndingLayout?.();
            g._publishMyEndingLayout?.();
        });
        if (hostPage) await flushHostBananaInteractions(hostPage);
    }
}

async function logPreWinReviewDiagnostics(frames, preWinByUid, label) {
    for (let i = 0; i < frames.length; i++) {
        const uid = await frames[i].evaluate(() => window.game?._myUid?.() || null);
        const entry = uid ? preWinByUid[uid] : null;
        if (!entry?.tiles?.length) continue;
        const diag = await diagnoseReviewLayoutOnFrame(frames[i], entry.uid, entry.tiles);
        log(`${label} preWin P${i + 1} (${entry.uid}): main=${diag.mainTileCount}/${diag.tileCount} `
            + `gridOk=${diag.gridOk} stragglers=${diag.stragglerCount}`
            + `${diag.invalidWord ? ` invalidWord=${JSON.stringify(diag.invalidWord)}` : ''}`
            + `${diag.letterDrifts?.length ? ` letterDrifts=${diag.letterDrifts.length}` : ''}`);
        if (diag.letterDrifts?.length) {
            log(`${label} preWin P${i + 1} letterDrifts sample=${JSON.stringify(diag.letterDrifts.slice(0, 4))}`);
        }
    }
}

async function finishActionsWin3p(ctx) {
    const {
        side,
        round,
        step,
        hostPage,
        pages,
        frames,
        forcedWinSide,
        desiredWinSide,
        assertActionsWinInvariants
    } = ctx;
    const winLabel = `${side.label} win`;
    const expectedIndex = expectedWinActorIndex(desiredWinSide);
    if (forcedWinSide && expectedIndex != null && side.actorIndex !== expectedIndex) {
        throw new Error(
            `${winLabel}: expected ${desiredWinSide} to win (--win=${desiredWinSide})`
        );
    }
    log(`Win detected (${side.label}, round ${round}, side=${side.actorIndex === 0 ? 'host' : `P${side.actorIndex + 1}`}).`);

    if (!assertActionsWinInvariants) return;

    await awaitMpVictorySettled3p(hostPage, pages, winLabel, { assertActionsWinInvariants: true });

    const reviewSyncMs = Math.max(mpReviewWaitMs(), WAIT_MS);
    const hostFrame = frames[0];
    const mp = { page1: hostPage, page2: pages[1] };
    const playerUids = BANANA_3P_PLAYERS.slice(0, pages.length).map((p) => p.uid);

    await flushHostBananaInteractions(hostPage);
    await hostFrame.evaluate(() => {
        window.game._processBananaInteractions?.(window.game.roomData?.interactions?.banana);
    }).catch(() => {});

    let winnerSnap = step?.winSnap || null;
    if (!winnerSnap?.allPlaced || !winnerSnap?.gridOk || winnerSnap?.poolLen !== 0) {
        winnerSnap = await snapshotWithHostPool(side.frame, hostPage);
    }
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

    for (const guestPage of pages.slice(1)) {
        await syncGuestPoolFromHost(hostPage, guestPage);
    }
    await assertActionsPoolZeroAll(pages, winLabel);

    const preWinByUid = await capturePreReviewBoardsByPlayer(frames);
    await logPreWinReviewDiagnostics(frames, preWinByUid, winLabel);

    await publishGuestEndingLayouts(pages, hostPage);
    await flushHostBananaInteractions(hostPage);

    log(`${winLabel}: waiting for natural RTDB review sync on all clients...`);
    await waitMpClientsInReview(frames, `${winLabel} in-review`, reviewSyncMs, pages, hostFrame);
    await assertActionsWinBanner(pages, `${winLabel} hub win banner`);
    await waitMpClientsPostWinReady(
        frames, playerUids, `${winLabel} boards`, reviewSyncMs, pages, hostFrame
    );
    for (let i = 0; i < pages.length; i++) {
        await assertGuestReviewVisibleWithoutInteraction(
            pages[i], `${winLabel} P${i + 1} review`, 2, 6
        );
    }

    await assertActionsReviewLayouts(hostFrame, hostPage, mp, winLabel);
    await assertActionsReviewPersists(frames, pages, mp, winLabel);
    await assertReviewPreservesPreWinBoards(frames, preWinByUid, `${winLabel} review-boards`);

    const dist = await assertTileDistributionInReview(
        hostFrame,
        `${winLabel} tile-distribution`,
        { requireReviewLayouts: true }
    );
    log(`SUCCESS: ${winLabel} — tile distribution OK (${dist.bagLabel}, `
        + `${dist.actualTotal} tiles via ${dist.countSource})`);
    log(`SUCCESS: ${winLabel} — all actions win invariants passed`);
}

async function runMpAiPlaythroughN(opts) {
    process.env.BANANA_AI_QUIET = '1';
    const ctx = resolvePlaythroughCtx(opts);
    const playToWin = resolvePlayToWin(opts);
    const { side: desiredWinSide, forced: forcedWinSide } = resolveWinSteering3p(opts, playToWin);
    const {
        minPeels = Number(process.env.FIVE_MP_AI_MIN_PEELS || 6),
        minDumps = Number(process.env.FIVE_MP_AI_MIN_DUMPS || 1),
        minPlacements = Number(process.env.FIVE_MP_AI_MIN_PLACEMENTS || 45),
        minPeelsPerPlayer = Number(process.env.FIVE_MP_AI_MIN_PEELS_PER_PLAYER || 1),
        maxRoundTrips = resolveMpAiMaxRoundTrips(playToWin, { playFallback: 30, auditFallback: 120 }),
        assertActionsWinInvariants = false,
        mobileAll = false,
        instantBanners = false
    } = opts;

    const pages = ctx.pages;
    const frames = ctx.frames;
    const playerCount = ctx.playerCount;
    const hostPage = ctx.host.page;

    const maxRounds = mpAiRoundTripCapEnabled() && (playToWin && assertActionsWinInvariants)
        ? Math.max(maxRoundTrips, 30)
        : maxRoundTrips;

    const playerUids = ctx.uids;
    const goals = { minPeels, minDumps, minPlacements, minPeelsPerPlayer };

    await injectSnapshot(frames);
    const headedView = { mobile: mobileAll };
    if (recenterHeadedDuringPlay(mobileAll)) await centerMpViewerOnPages(pages, headedView);
    if (playToWin && forcedWinSide) {
        log(`Play-to-win: steering for ${desiredWinSide} victory (--win=${desiredWinSide})`);
    } else if (playToWin) {
        log(`Play-to-win: steering for ${desiredWinSide} victory (default; --win=guest for P2)`);
    }

    const stats = {
        peels: 0,
        dumps: 0,
        placements: 0,
        rounds: 0,
        peelByUid: Object.fromEntries(playerUids.map((u) => [u, 0]))
    };
    let idleRounds = 0;

    const sides = buildAiSideCtxs(ctx, {
        desiredWinSide,
        playToWin,
        instantBanners
    });

    const finishIfGoalsMet = async (round) => {
        if (playToWin) return false;
        const poolLen = await readPoolLen(hostPage);
        if (!goalsMet(stats, goals, playerUids, poolLen)) return false;
        log(`Goals met: placements=${stats.placements} peels=${stats.peels} `
            + `dumps=${stats.dumps} pool=${poolLen} `
            + `peelByUid=${JSON.stringify(stats.peelByUid)} in ${round} round-trips.`);
        return true;
    };

    for (let round = 1; round <= maxRounds; round++) {
        stats.rounds = round;
        let progress = false;

        for (const side of sides) {
            await flushHostBananaInteractions(hostPage);

            const snap = await snapshotWithHostPool(side.frame, hostPage);
            if (snap.winner) {
                await finishActionsWin3p({
                    side, round, step: { winSnap: snap }, hostPage, pages, frames,
                    forcedWinSide, desiredWinSide, assertActionsWinInvariants
                });
                return stats;
            }

            const winnerUid = await readWinnerUid(hostPage, playerUids);
            if (winnerUid) {
                const winnerSide = sides.find((s) => s.uid === winnerUid);
                const preWinSnap = await snapshotWithHostPool(winnerSide.frame, hostPage);
                await finishActionsWin3p({
                    side: winnerSide, round, step: { winSnap: preWinSnap }, hostPage, pages, frames,
                    forcedWinSide, desiredWinSide, assertActionsWinInvariants
                });
                return stats;
            }

            if (!playToWin
                && stats.dumps < minDumps
                && stats.placements >= Math.min(25, minPlacements)
                && round >= 3
                && round % 2 === 0) {
                const forced = await tryForcedDump(side, snap, `${side.label} r${round} periodic`, {
                    minPool: 10
                });
                if (forced && recordStep(stats, forced)) {
                    await publishGuestStep(side.hostPage, side.page, side.uid, side.isGuest);
                    progress = true;
                    idleRounds = 0;
                    if (await finishIfGoalsMet(round)) return stats;
                    if (recenterHeadedDuringPlay(mobileAll)) await centerMpViewerOnPages(pages, headedView);
                    continue;
                }
            }

            const step = await runPlayerStep(side, `${side.label} r${round}`);
            if (step.win) {
                await finishActionsWin3p({
                    side, round, step, hostPage, pages, frames,
                    forcedWinSide, desiredWinSide, assertActionsWinInvariants
                });
                return stats;
            }
            await flushHostBananaInteractions(hostPage);
            const winnerAfter = await readWinnerUid(hostPage, playerUids);
            if (winnerAfter) {
                const winnerSide = sides.find((s) => s.uid === winnerAfter);
                const preWinSnap = await snapshotWithHostPool(winnerSide.frame, hostPage);
                await finishActionsWin3p({
                    side: winnerSide, round, step: { winSnap: preWinSnap }, hostPage, pages, frames,
                    forcedWinSide, desiredWinSide, assertActionsWinInvariants
                });
                return stats;
            }
            if (recordStep(stats, step)) {
                progress = true;
                idleRounds = 0;
                if (await finishIfGoalsMet(round)) return stats;
            }
            if (recenterHeadedDuringPlay(mobileAll)) await centerMpViewerOnPages(pages, headedView);
        }

        if (!progress) idleRounds += 1;
        const hostPool = await readPoolLen(hostPage);
        const idleCap = hostPool === 0 ? 40 : 15;
        if (idleRounds >= idleCap) {
            throw new Error(`3p AI playthrough stalled (${idleRounds} idle round-trips, `
                + `hostPool=${hostPool}, stats=${JSON.stringify(stats)})`);
        }
    }

    if (playToWin) {
        throw new Error(
            `3p MP actions did not finish in ${maxRounds} round-trips `
            + `(peels=${stats.peels}, dumps=${stats.dumps}, placements=${stats.placements})`
        );
    }

    throw new Error(
        `3p AI playthrough did not reach goals in ${maxRounds} round-trips `
        + `(placements=${stats.placements}/${minPlacements}, `
        + `peels=${stats.peels}/${minPeels}, dumps=${stats.dumps}/${minDumps}, `
        + `peelByUid=${JSON.stringify(stats.peelByUid)})`
    );
}

/** Fresh SPLIT on all three clients after fixture tests mutate boards. */
async function resetMpForAiPlaythroughN(opts) {
    const {
        pages,
        frames,
        expectedPool = null,
        playerCount = 3,
        instantBanners = false,
        mobileAll = false
    } = opts;
    const hostPage = pages[0];
    const hostFrame = frames[0];

    log('Reset to fresh split hands (3p solver playthrough)...');
    const expectedHand = await hostFrame.evaluate((n) => (
        typeof BananaRules !== 'undefined' ? BananaRules.startingHandSize(n) : 21
    ), playerCount);

    await flushHostBananaInteractions(hostPage);
    await Promise.all(frames.map((f) => f.evaluate(() => {
        const g = window.game;
        if (!g) return;
        g._bannerText = '';
        g._syncBannerEl?.();
    })));

    await hostFrame.evaluate(() => {
        const g = window.game;
        if (!g?.isHost?.()) throw new Error('resetMpForAiPlaythroughN requires host frame');
        g._bananaHandled = {};
        g._bananaAck = {};
        const db = window.NetworkEngine?.db;
        const rId = g.roomId;
        if (db && rId) {
            db.ref(`games/${rId}/interactions/banana`).set(null);
        }
        g.onGameReset();
        g._hostBeginSplit();
        g._persistMpLayout?.();
    });
    await flushHostBananaInteractions(hostPage);

    for (let i = 0; i < pages.length; i++) {
        const role = BANANA_3P_PLAYERS[i].role;
        await waitForDiag(pages[i], `AI reset ${role} started`, ({ minHand }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!g?.gameStarted && (g.tiles?.length ?? 0) >= minHand;
        }, { minHand: expectedHand }, RESET_WAIT_MS);
    }

    const poolTarget = expectedPool ?? (await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?._tilePool?.length ?? -1;
    }));
    if (poolTarget >= 0) await waitPoolAll(pages, poolTarget);
    const bannerFn = instantBanners ? enableInstantBanners : enableFastBanners;
    await Promise.all(frames.map(bannerFn));
    for (let i = 0; i < pages.length; i++) {
        const mp = { page1: pages[0], page2: pages[i === 0 ? 1 : i] };
        await assertStartingRackConnected(
            pages[i],
            `AI reset ${BANANA_3P_PLAYERS[i].role} rack`,
            mp
        );
    }
    await flushHostBananaInteractions(hostPage);
    for (let i = 1; i < pages.length; i++) {
        await syncGuestInventoryToHost(hostPage, pages[i], BANANA_3P_PLAYERS[i].uid);
    }
    log(`Fresh split ready (pool=${poolTarget}, ${playerCount} players).`);
    if (isMpHeaded() && !mobileAll) await centerMpViewerOnPages(pages);
    else if (isMpHeaded()) await centerMpViewerOnPages(pages, { mobile: true });
    return { expectedPool: poolTarget };
}

/** Headed --open: sync all clients into post-game review (parity with 2p awaitMpActionsReviewOpen). */
async function awaitMpActionsReviewOpenN({ pages, frames, mobileAll = false } = {}) {
    const hostPage = pages[0];
    const hostFrame = frames[0];
    const playerUids = BANANA_3P_PLAYERS.map((p) => p.uid);
    const mp = { page1: pages[0], page2: pages[1] };
    const reviewSyncMs = mobileAll
        ? Number(process.env.FIVE_MP_REVIEW_SYNC_MS || 1200)
        : WAIT_MS;

    log('MP 3p actions open: syncing post-game review...');
    await flushHostBananaInteractions(hostPage);
    await publishGuestEndingLayouts(pages, hostPage);
    await hostFrame.evaluate(() => {
        window.game._processBananaInteractions?.(window.game.roomData?.interactions?.banana);
    }).catch(() => {});

    await pushHostReviewStateToClients(hostFrame, pages);
    await mergeGuestLayoutOnHost(hostFrame, pages);

    await waitMpClientsInReview(frames, 'actions-open-review-3p', reviewSyncMs, pages, hostFrame);
    await waitMpClientsPostWinReady(
        frames,
        playerUids,
        'actions-open-boards-3p',
        reviewSyncMs,
        pages,
        hostFrame
    );
    await waitForHostReviewReady(hostFrame, hostPage, reviewSyncMs);
    const { waitPostGameReview } = require('../review-mobile');
    if (isMpHeaded()) {
        await relayoutMpHeadedForReview(pages, { mobile: mobileAll });
    }
    await waitPostGameReview(pages[0], 'host', { hostOnly: true });
    await Promise.all(pages.slice(1).map((p, i) => waitPostGameReview(p, `P${i + 2}`)));
    await assertActionsReviewLayouts(hostFrame, hostPage, mp, 'actions open review 3p');

    const dist = await assertTileDistributionInReview(
        hostFrame,
        'actions open review 3p tile-distribution',
        { requireReviewLayouts: true }
    );
    log(`SUCCESS: actions open 3p — tile distribution OK (${dist.bagLabel}, `
        + `${dist.actualTotal} tiles via ${dist.countSource})`);
    log('SUCCESS: MP 3p actions open — stopped in post-game review.');
}

/** Actions scenario entry when session is already booted via MpCtx (deal + SPLIT). */
async function runMpAiActionsOnlyNFromCtx(ctx, options = {}) {
    preloadAiDictionary();
    ensurePlayerSolvers(ctx.playerCount ?? 3);
    process.env.BANANA_AI_QUIET = '1';

    const mobileAll = !!(options.mobile ?? ctx.mobile);
    const headedReview = isMpHeaded();
    const rounds = resolveSessionRounds(options);
    const pause = resolveSessionPause(options);
    if (pause) {
        const pauseMs = pauseTimeoutMs();
        await Promise.all(ctx.pages.map((p) => p.setDefaultTimeout(pauseMs)));
    }

    const pages = ctx.pages;
    let frames = ctx.frames;
    if (!frames?.length) {
        frames = await Promise.all(pages.map((p) => getGameFrame(p)));
        ctx.frames = frames;
    }

    log(headedReview
        ? `MP 3p actions: headed — play to win (${rounds} round${rounds > 1 ? 's' : ''}`
            + `${pause ? ', pause in review' : ''}), assert post-game review + Done.`
        : `MP 3p actions: optimized AI playthrough (play to win, ${rounds} round${rounds > 1 ? 's' : ''}`
            + `${pause ? ', pause in review' : ''})...`);

    await resetMpForAiPlaythroughN({
        pages,
        frames,
        playerCount: ctx.playerCount,
        expectedPool: options.expectedPool ?? null,
        instantBanners: true,
        mobileAll
    });

    const roundStats = [];
    for (let round = 1; round <= rounds; round++) {
        log(`MP actions round ${round}/${rounds}...`);
        const stats = await runMpAiPlaythroughN({
            ctx,
            pages,
            frames,
            playerCount: ctx.playerCount,
            playToWin: true,
            assertActionsWinInvariants: true,
            mobileAll,
            winSide: options.winSide ?? null,
            instantBanners: true
        });
        roundStats.push({ round, ...stats });

        if (round < rounds) {
            throw new Error('runMpAiActionsOnlyNFromCtx: multi-round 3p actions not wired yet');
        }

        if (pause) {
            await awaitMpActionsReviewOpenN({ pages, frames, mobileAll });
            await relayoutMpHeadedForReview(pages, { mobile: mobileAll });
            log('[PAUSE] Post-game review ready — press Done on host when finished inspecting.');
            break;
        }
        if (headedReview) {
            await awaitMpActionsReviewOpenN({ pages, frames, mobileAll });
            await relayoutMpHeadedForReview(pages, { mobile: mobileAll });
            const hostFrame = await getGameFrame(pages[0]);
            const { assertHeadedMpLayout } = require('../../../../../shared/platform/mp-headed-assertions');
            await assertHeadedMpLayout({
                pages,
                mobile: mobileAll,
                hostPage: pages[0],
                hostFrame,
                log
            });
        }
    }

    log(pause
        ? `SUCCESS: MP 3p actions complete (${rounds} round${rounds > 1 ? 's' : ''}, paused in review).`
        : headedReview
            ? `SUCCESS: MP 3p actions complete (${rounds} round${rounds > 1 ? 's' : ''}, post-game review + Done verified).`
            : `SUCCESS: MP 3p actions playthrough complete (${rounds} round${rounds > 1 ? 's' : ''}).`);
    return rounds > 1 ? { rounds: roundStats, ...roundStats[roundStats.length - 1] } : roundStats[0];
}

async function runMpAiActionsOnlyN(browser, options = {}) {
    applySpeedProfile('ci', { scenario: 'actions' });
    preloadAiDictionary();
    ensurePlayerSolvers(3);
    log('Using 3 dedicated AI solver instances (P1/P2/P3).');
    process.env.BANANA_AI_QUIET = '1';
    const mobileAll = !!options.mobileAll;
    const headedReview = isMpHeaded();
    log(headedReview
        ? 'MP 3p actions: headed — play to win, assert post-game review + Done.'
        : 'MP 3p actions: optimized AI playthrough (play to win)...');

    const { pages, frames, contexts, roomId } = await bootMpForAiN(browser, {
        mobileAll,
        instantBanners: true
    });

    try {
        await resetMpForAiPlaythroughN({
            pages,
            frames,
            playerCount: 3,
            instantBanners: true,
            mobileAll
        });
        const stats = await runMpAiPlaythroughN({
            pages,
            frames,
            playerCount: 3,
            playToWin: true,
            assertActionsWinInvariants: true,
            mobileAll,
            winSide: options.winSide ?? null
        });
        if (headedReview) {
            await awaitMpActionsReviewOpenN({ pages, frames, mobileAll });
            await relayoutMpHeadedForReview(pages, { mobile: mobileAll });
            const hostFrame = await getGameFrame(pages[0]);
            const { assertHeadedMpLayout } = require('../../../../../shared/platform/mp-headed-assertions');
            await assertHeadedMpLayout({
                pages,
                mobile: mobileAll,
                hostPage: pages[0],
                hostFrame,
                log
            });
        }
        log(headedReview
            ? 'SUCCESS: MP 3p actions complete (post-game review + Done verified).'
            : 'SUCCESS: MP 3p actions playthrough complete.');
        return stats;
    } finally {
        if (shouldCloseBrowser()) {
            await pages[0].evaluate(({ rId }) => {
                const db = window.NetworkEngine?.db;
                if (db) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
            }, { rId: roomId }).catch(() => {});
            await Promise.all(contexts.map((ctx) => ctx.close().catch(() => {})));
        }
    }
}

module.exports = {
    runMpAiPlaythroughN,
    resetMpForAiPlaythroughN,
    runMpAiActionsOnlyN,
    runMpAiActionsOnlyNFromCtx,
    bootMpForAiN,
    awaitMpActionsReviewOpenN,
    // Legacy aliases (remove after callers migrate)
    runMpAiPlaythrough3p: runMpAiPlaythroughN,
    resetMpForAiPlaythrough3p: resetMpForAiPlaythroughN,
    runMpAiActionsOnly3p: runMpAiActionsOnlyN,
    bootMpForAi3p: bootMpForAiN,
    awaitMpActionsReviewOpen3p: awaitMpActionsReviewOpenN
};
