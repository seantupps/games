require('./bootstrap');

const { chromium } = require('playwright');
const { ensureTestStack, buildAppUrl, buildHubUrl } = require('./emulator-utils');
const { STEP_MS } = require('./timeouts');
const { playwrightHeadless, playwrightSlowMo, shouldCloseBrowser } = require('./env-defaults');
const { DESKTOP_VIEWPORT } = require('./viewport-constants');
const {
    isMpHeaded,
    mpHeadedContextOpts,
    layoutMpHeadedWindows,
    layoutMpHeadedMobileWindows,
    centerMpViewerOnPages,
    syncMpHeadedMobileViewport
} = require('../platform/mp-headed-view');
const GameRegistry = require('../../../shared/games/registry');
const {
    resolveMpPlayerSlots,
    enrichMpContext,
    invokeBeforeLoop,
    playerDefsForCount
} = require('./mp-player-utils');
const { createTestLogger, isMpChatterSuppressed, isLogVerbose } = require('./test-logger');

/**
 * Shared multiplayer audit library for game simulations.
 * Orchestrates two players (P1 and P2) in isolated browser contexts.
 * 
 * @param {string} gameId - 'piles', 'line', etc.
 * @param {Object} options - Configuration and hooks.
 */
function isFastMpProfile(options = {}) {
    return options.fastMp === true || process.env.FIVE_MP_FAST === '1';
}

function isMpOptimized(options = {}) {
    return options.mpOptimized === true || process.env.FIVE_MP_OPTIMIZED === '1';
}

async function runMultiplayerAudit(gameId, options = {}) {
    const envHeadless = playwrightHeadless();
    const fastMp = isFastMpProfile(options);
    const mpOptimized = isMpOptimized(options) && !fastMp;
    let slimAudit = false;
    let configScenario = null;
    let configRounds = 1;
    try {
        const { isSlimAudit, getScenario, getRounds } = require('./run-config');
        slimAudit = isSlimAudit();
        configScenario = getScenario();
        configRounds = getRounds();
    } catch (_) { /* run-config optional */ }
    const {
        headless = envHeadless,
        maxMoves: maxMovesOption,
        gameMode = 'classic',
        roomId = `MP_AUDIT_${gameId.toUpperCase()}_${gameMode.toUpperCase()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
        beforeLoop: beforeLoopOption = null,
        afterMove = async (page1, page2, moveResult) => { },
        browser: providedBrowser = null,
        context1: providedContext1 = null,
        context2: providedContext2 = null,
        page1: providedPage1 = null,
        page2: providedPage2 = null,
        skipStackCheck = false,
        manageContexts = true,
        isMobile = false,
        skipBootstrap = false,
        skipHubWarmup = false,
        deferBootstrapWait = false,
        skipGameLoop = false,
        skipCleanup = false,
        skipScoreVerify = false,
        skipRefresh = options.skipRefresh ?? (fastMp || slimAudit),
        skipPostVictory = options.skipPostVictory ?? (fastMp || slimAudit),
        expectedScores = null
    } = options;

    const maxMoves = maxMovesOption ?? (fastMp
        ? Number(process.env.FIVE_MP_MAX_MOVES || 10)
        : isMobile
            ? Number(process.env.FIVE_MP_MAX_MOVES_MOBILE || 16)
            : Number(process.env.FIVE_MP_MAX_MOVES || 50));

    const suppressBrowserConsole = isMpChatterSuppressed() || fastMp;
    const logger = createTestLogger({ gameId, gameMode, roomId });
    /** Strip legacy [TEST] prefix — logger.step adds it. */
    const log = (msg) => logger.step(String(msg).replace(/^\[TEST\]\s*/, ''));

    log(`Starting Multiplayer Audit for game: ${gameId.toUpperCase()} (${gameMode.toUpperCase()}) in Room: ${roomId}...`);

    let browser = providedBrowser;
    let context1 = providedContext1;
    let context2 = providedContext2;
    let page1 = providedPage1;
    let page2 = providedPage2;
    let ownsBrowser = false;

    if (!browser) {
        browser = await chromium.launch({
            headless,
            slowMo: playwrightSlowMo()
        });
        ownsBrowser = true;
    }

    if (!context1) {
        const desktopOpts = !headless && isMpHeaded()
            ? mpHeadedContextOpts({ players: 2 })
            : { viewport: DESKTOP_VIEWPORT };
        context1 = await browser.newContext(desktopOpts);
    }
    if (!context2) {
        const desktopOpts = !headless && isMpHeaded()
            ? mpHeadedContextOpts({ players: 2 })
            : { viewport: DESKTOP_VIEWPORT };
        context2 = await browser.newContext(desktopOpts);
    }
    if (!page1) page1 = await context1.newPage();
    if (!page2) page2 = await context2.newPage();

    if (!headless) {
        if (isMobile) {
            await layoutMpHeadedMobileWindows([page1, page2]);
        } else {
            await layoutMpHeadedWindows([page1, page2]);
        }
    }

    let slots = resolveMpPlayerSlots({
        page1, page2, context1, context2,
        isMobile: !!isMobile,
        playerSlots: options.playerSlots,
        pages: options.pages,
        roles: options.roles,
        isMobileSlot: options.isMobileSlot,
        playerDefs: options.playerDefs
    });
    if (slots.length < 2) {
        throw new Error('runMultiplayerAudit requires at least 2 player slots');
    }
    page1 = slots[0].page;
    page2 = slots[1].page;
    const beforeLoop = beforeLoopOption;

    const MOVE_SYNC_MS = Number(process.env.FIVE_MP_MOVE_SYNC_MS || (fastMp ? 20 : mpOptimized ? 40 : 75));
    const GAME_READY_POLL_MS = Number(process.env.FIVE_MP_READY_POLL_MS || (fastMp ? 40 : mpOptimized ? 60 : 120));
    const NAV_WAIT = (fastMp || mpOptimized) ? 'domcontentloaded' : 'load';
    const VICTORY_DWELL_MS = Number(process.env.FIVE_VICTORY_DWELL_MS || (mpOptimized ? 400 : fastMp ? 200 : 0));
    const injectVictoryDwell = async (page) => {
        if (!(VICTORY_DWELL_MS > 0)) return;
        await page.evaluate((ms) => {
            const win = document.getElementById('game-frame')?.contentWindow;
            if (win) win.FIVE_VICTORY_DWELL_MS = ms;
        }, VICTORY_DWELL_MS).catch(() => { });
    };
    const bannerWaitMs = fastMp
        ? Number(process.env.FIVE_MP_BANNER_MS || 600)
        : mpOptimized
            ? Number(process.env.FIVE_MP_BANNER_MS || 1200)
            : STEP_MS;

    // Setup logging handlers with duplicate suppression and total log caps to prevent spam
    const setupConsole = (page, playerLabel) => {
        if (suppressBrowserConsole) return;
        const logCounts = {};
        let totalLogs = 0;
        const maxLogsOfSameMessage = 3;
        const maxTotalLogs = 40;

        page.on('console', msg => {
            if (totalLogs >= maxTotalLogs) {
                if (totalLogs === maxTotalLogs) {
                    console.log(`[BROWSER - ${playerLabel}] WARNING: Maximum console log cap reached. Suppressing further console logs.`);
                    totalLogs++;
                }
                return;
            }

            const text = msg.text();
            const type = msg.type().toUpperCase();

            if (text.includes('[HUB]') || text.includes('Guest global listener') || text.includes('NetworkEngine.on')) {
                return;
            }

            const isImportant = ['WINNER', 'FAILURE', 'SUCCESS'].some(tag => text.includes(tag))
                || (text.includes('[TEST]') && !text.includes('showWinBanner'))
                || (text.includes('HOST:') && !text.includes('listener'))
                || (text.includes('[ENGINE]') && (text.includes('auto-reset') || text.includes('scheduling')));
            const isCriticalType = type === 'ERROR' || type === 'WARNING';

            if (!isImportant && !isCriticalType) {
                return;
            }

            // Deduplicate and count
            const logKey = `${type}:${text}`;
            logCounts[logKey] = (logCounts[logKey] || 0) + 1;

            if (logCounts[logKey] > maxLogsOfSameMessage) {
                if (logCounts[logKey] === maxLogsOfSameMessage + 1) {
                    console.log(`[BROWSER - ${playerLabel}] LOG DUPLICATE CAP REACHED: Suppressing spam for "${text}"`);
                }
                return;
            }

            console.log(`[BROWSER - ${playerLabel}] ${type}: ${text}`);
            totalLogs++;
        });

        page.on('pageerror', err => {
            console.error(`[BROWSER - ${playerLabel}] PAGE ERROR: ${err.message}\n${err.stack}`);
        });

        page.on('response', response => {
            if (response.status() >= 400 && !response.url().includes('favicon')) {
                const url = response.url();
                const logKey = `NET_ERROR:${response.status()}:${url}`;
                logCounts[logKey] = (logCounts[logKey] || 0) + 1;
                if (logCounts[logKey] <= maxLogsOfSameMessage) {
                    console.error(`[BROWSER - ${playerLabel}] NETWORK ERROR ${response.status()}: ${url}`);
                }
            }
        });
    };

    setupConsole(page1, 'P1');
    setupConsole(page2, 'P2');

    try {
        if (!skipStackCheck) await ensureTestStack();

        if (!skipBootstrap) {
            const hubUrl = buildHubUrl();
            const seedRoom = ({ rId, gId, gMode }) => {
                const db = window.NetworkEngine.db;
                const p1Uid = 'u_host_p1';
                const p2Uid = 'u_guest_p2';
                const updates = {};
                updates[`games/${rId}`] = {
                    host: p1Uid,
                    status: 'playing',
                    global: {
                        game: gId,
                        mode: gMode,
                        firstPlayer: 'P1',
                        resetCount: 1,
                        turn: 'P1'
                    },
                    playerData: {
                        [p1Uid]: { name: 'HostP1', color: '#3b82f6' },
                        [p2Uid]: { name: 'GuestP2', color: '#ef4444' }
                    }
                };
                updates[`gameData/${rId}`] = null;
                return db.ref().update(updates);
            };

            if (!skipHubWarmup) {
                const dwellArg = VICTORY_DWELL_MS > 0 ? VICTORY_DWELL_MS : 0;
                await page1.addInitScript(({ uid, name, color, dwell }) => {
                    sessionStorage.setItem('game_uid', uid);
                    sessionStorage.setItem('username', name);
                    sessionStorage.setItem('userColor', color);
                    if (dwell > 0) window.FIVE_VICTORY_DWELL_MS = dwell;
                }, { uid: 'u_host_p1', name: 'HostP1', color: '#3b82f6', dwell: dwellArg });
                await page2.addInitScript(({ uid, name, color, dwell }) => {
                    sessionStorage.setItem('game_uid', uid);
                    sessionStorage.setItem('username', name);
                    sessionStorage.setItem('userColor', color);
                    if (dwell > 0) window.FIVE_VICTORY_DWELL_MS = dwell;
                }, { uid: 'u_guest_p2', name: 'GuestP2', color: '#ef4444', dwell: dwellArg });

                await Promise.all([
                    page1.goto(hubUrl, { waitUntil: NAV_WAIT }),
                    page2.goto(hubUrl, { waitUntil: NAV_WAIT })
                ]);

                await page1.waitForFunction(() => window.NetworkEngine && window.NetworkEngine.isInitialized, { timeout: STEP_MS });
            }

            // Clean and Seed the Room state directly in Firebase from P1 client
            await page1.evaluate(seedRoom, { rId: roomId, gId: gameId, gMode: gameMode });

            const p1Url = buildAppUrl(roomId, 'P1', gameId, gameMode);
            const p2Url = buildAppUrl(roomId, 'P2', gameId, gameMode);

            await Promise.all([
                page1.goto(p1Url, { waitUntil: NAV_WAIT }),
                page2.goto(p2Url, { waitUntil: NAV_WAIT })
            ]);

            // Ensure both page-frames exist
            await Promise.all([
                page1.waitForSelector('#game-frame'),
                page2.waitForSelector('#game-frame')
            ]);
        } else if (!deferBootstrapWait) {
            await Promise.all([
                page1.waitForSelector('#game-frame', { timeout: STEP_MS }),
                page2.waitForSelector('#game-frame', { timeout: STEP_MS })
            ]);
        }

        const mpAuditCtx = enrichMpContext({
            roomId,
            fastMp,
            mpOptimized,
            gameId,
            gameMode,
            scenario: options.scenario ?? configScenario
        }, slots);

        if (deferBootstrapWait && beforeLoop) {
            await invokeBeforeLoop(beforeLoop, slots, mpAuditCtx);
        }

        const gameReadyMs = fastMp
            ? Number(process.env.FIVE_MP_READY_MS || 1500)
            : mpOptimized
                ? Number(process.env.FIVE_MP_READY_MS || 2000)
                : STEP_MS;
        const waitForGameReady = async (page, role) => {
            const deadline = Date.now() + gameReadyMs;
            let lastStatus = 'starting';
            let lastLogAt = 0;
            const boardKind = GameRegistry.boardKindFor(gameId, gameMode);
            const boardReady = (status) => GameRegistry.auditBoardReady(status, boardKind);
            while (Date.now() < deadline) {
                const status = await page.evaluate(({ rId, gId }) => {
                    const frame = document.getElementById('game-frame');
                    if (!frame) return 'No iframe';
                    if (!frame.contentWindow) return 'No contentWindow';

                    try {
                        const href = frame.contentWindow.location.href;
                        if (!href || href === 'about:blank') return 'Iframe location empty/blank';
                        if (!href.includes(rId)) return `Iframe location ${href} does not contain room ${rId}`;
                        if (!href.includes(gId)) return `Iframe location ${href} does not contain game ${gId}`;
                    } catch (e) {
                        return `Iframe cross-origin or navigation error: ${e.message}`;
                    }

                    const g = frame.contentWindow.game;
                    if (!g) return 'No game object inside iframe yet';
                    const hasPiles = g.piles ? Object.values(g.piles).some(arr => arr.length > 0) : false;
                    const hasNodes = g.nodes ? g.nodes.length > 0 : false;
                    const hasTiles = Array.isArray(g.tiles) && g.tiles.length > 0;
                    const resetCount = g.roomData && g.roomData.global && typeof g.roomData.global.resetCount === 'number' ? g.roomData.global.resetCount : 0;
                    const auditReady = typeof g.isAuditReady === 'function'
                        ? !!g.isAuditReady()
                        : undefined;
                    return {
                        isMultiplayer: g.isMultiplayer,
                        playerRole: g.playerRole,
                        roomId: g.roomId,
                        identitySynced: g.identitySynced,
                        auditReady,
                        hasPiles: hasPiles,
                        hasNodes: hasNodes,
                        hasTiles,
                        started: !!g.started,
                        dictReady: !!g._dictReady,
                        resetCount: resetCount
                    };
                }, { rId: roomId, gId: gameId });

                lastStatus = status;
                const now = Date.now();
                if (isLogVerbose() && now - lastLogAt >= 1000) {
                    lastLogAt = now;
                    const snap = typeof status === 'object'
                        ? JSON.stringify(status)
                        : String(status);
                    logger.debug(`${gameId}/${gameMode} ${role} ready wait (${Math.round((deadline - now) / 1000)}s left): ${snap}`);
                }

                if (typeof status === 'object'
                    && status.isMultiplayer
                    && status.playerRole === role
                    && status.roomId === roomId
                    && boardReady(status)) {
                    await injectVictoryDwell(page);
                    if (!suppressBrowserConsole) console.log(`[MP] ${role} ready (${gameId})`);
                    return;
                }
                await page.waitForTimeout(GAME_READY_POLL_MS);
            }
            const snap = typeof lastStatus === 'object'
                ? JSON.stringify(lastStatus)
                : String(lastStatus);
            throw new Error(`Timeout waiting for game ready on ${role} after ${gameReadyMs}ms — last: ${snap}`);
        };

        await Promise.all([
            waitForGameReady(page1, 'P1'),
            waitForGameReady(page2, 'P2')
        ]);
        await Promise.all([injectVictoryDwell(page1), injectVictoryDwell(page2)]);
        if (!headless) {
            if (isMobile) {
                await layoutMpHeadedMobileWindows([page1, page2]);
            } else {
                await layoutMpHeadedWindows([page1, page2]);
                await centerMpViewerOnPages([page1, page2]);
            }
        }

        {
            const { enableMobileHub } = require('../../platform/mobile/lib/mobile_assertions');
            const mobilePages = slots.filter((s) => s.isMobile).map((s) => s.page);
            if (mobilePages.length) {
                await Promise.all(mobilePages.map((p) => enableMobileHub(p)));
                await Promise.all(mobilePages.map((p) =>
                    p.evaluate(() => window.FiveViewport?.syncHubViewport?.()).catch(() => { })
                ));
                if (!headless) {
                    await Promise.all(mobilePages.map((p) =>
                        syncMpHeadedMobileViewport(p, { relayoutPages: mobilePages })
                    ));
                }
            } else if (isMobile) {
                await Promise.all([enableMobileHub(page1), enableMobileHub(page2)]);
                await Promise.all([
                    page1.evaluate(() => window.FiveViewport?.syncHubViewport?.()),
                    page2.evaluate(() => window.FiveViewport?.syncHubViewport?.())
                ]);
                if (!headless) {
                    await Promise.all([
                        syncMpHeadedMobileViewport(page1, { relayoutPages: [page1, page2] }),
                        syncMpHeadedMobileViewport(page2, { relayoutPages: [page1, page2] })
                    ]);
                }
            }
        }

        // Execute pre-loop hooks (skipped when deferBootstrapWait — ran before game-ready wait)
        if (beforeLoop && !deferBootstrapWait) {
            await invokeBeforeLoop(beforeLoop, slots, mpAuditCtx);
        }

        if (skipGameLoop) {
            if (!skipCleanup && shouldCloseBrowser()) {
                await page1.evaluate((rId) => {
                    const db = window.NetworkEngine?.db;
                    if (db) {
                        const updates = {};
                        updates[`games/${rId}`] = null;
                        updates[`gameData/${rId}`] = null;
                        return db.ref().update(updates);
                    }
                }, roomId).catch(() => { });
            }
            log(`SUCCESS: MULTIPLAYER ${gameId.toUpperCase()} (${gameMode.toUpperCase()}) AUDIT COMPLETED SUCCESSFULLY`);
            return;
        }

        const sessionRounds = Math.max(1, Number(options.rounds ?? configRounds ?? 1));
        const sessionWinCounts = { P1: 0, P2: 0 };

        for (let sessionRound = 1; sessionRound <= sessionRounds; sessionRound++) {
            const isLastSessionRound = sessionRound === sessionRounds;
            const roundSkipScoreVerify = skipScoreVerify || !isLastSessionRound;
            const roundSkipCleanup = skipCleanup || !isLastSessionRound;

            if (sessionRound > 1) {
                log(`[TEST] Session round ${sessionRound}/${sessionRounds} — waiting for next game in party...`);
                await Promise.all([
                    waitForGameReady(page1, 'P1'),
                    waitForGameReady(page2, 'P2')
                ]);
                const nextBaseline = await page1.evaluate(() => {
                    const g = document.getElementById('game-frame')?.contentWindow?.game;
                    return g?.roomData?.global?.resetCount ?? g?.roomData?.meta?.resetCount ?? null;
                });
                if (nextBaseline != null) mpAuditCtx.baselineResetCount = nextBaseline;
            }

            log(`[TEST] Starting ${gameId.toUpperCase()} Move Loop (round ${sessionRound}/${sessionRounds})...`);
            let isOver = false;
            let victoryBannerSnap = null;
            let victoryWinner = null;
            let moveCount = fastMp ? 0 : (options.initialMoveCount || 0);
            let consecutiveNoProgress = 0;
            let lastStateStr = '';
            const pollMs = fastMp ? 25 : mpOptimized ? 40 : 50;
            const stuckLimit = fastMp ? 18 : (isMobile ? 24 : 35);
            const refreshPollMs = mpOptimized ? 30 : 100;
            const refreshPollMax = mpOptimized ? 30 : 40;

            while (!isOver && moveCount < maxMoves) {
            // Retrieve current active turn and state from P1's game view
            const stateSnapshot = await page1.evaluate(() => {
                const frame = document.getElementById('game-frame');
                if (!frame || !frame.contentWindow || !frame.contentWindow.game) return null;
                const g = frame.contentWindow.game;
                const pathLen = Array.isArray(g.path) ? g.path.length : 0;
                const pilePieces = g.piles
                    ? Object.values(g.piles).reduce((n, arr) => n + (arr?.length || 0), 0)
                    : 0;
                return {
                    turn: g.turn,
                    isOver: g.isOver,
                    eventsCount: g.gameEvents ? g.gameEvents.length : 0,
                    pathLen,
                    pilePieces
                };
            });

            if (!stateSnapshot) {
                consecutiveNoProgress++;
                if (consecutiveNoProgress > 20) {
                    throw new Error('[TEST] Stuck! No game instance found in iframe for 20 consecutive checks.');
                }
                await page1.waitForTimeout(pollMs);
                continue;
            }

            const currentStateStr = `${stateSnapshot.turn}:${stateSnapshot.isOver}:`
                + `${stateSnapshot.eventsCount}:${stateSnapshot.pathLen}:${stateSnapshot.pilePieces}`;
            if (currentStateStr === lastStateStr) {
                consecutiveNoProgress++;
                if (consecutiveNoProgress > stuckLimit) {
                    throw new Error(
                        `[TEST] Stuck! Turn loop no progress after ${stuckLimit} polls (~${stuckLimit * pollMs}ms). `
                        + `moveCount=${moveCount}/${maxMoves} state=${currentStateStr}`
                    );
                }
                if (consecutiveNoProgress > 0 && consecutiveNoProgress % 10 === 0) {
                    logger.mpProgress(`${gameId} move loop idle ${consecutiveNoProgress}/${stuckLimit} — ${currentStateStr}`);
                }
                await page1.waitForTimeout(pollMs);
                continue;
            }

            // We have progress! Reset stuck counter
            consecutiveNoProgress = 0;
            lastStateStr = currentStateStr;

            if (stateSnapshot.isOver) {
                isOver = true;
                log(`[TEST] Game Over detected via state snapshot.`);
                break;
            }

            const currentTurn = stateSnapshot.turn;
            const activePage = (currentTurn === 'P1') ? page1 : page2;

            // Submit a random valid move from the active player's client context
            const moveData = await activePage.evaluate((role) => {
                const frame = document.getElementById('game-frame');
                const g = frame ? frame.contentWindow.game : null;
                if (!g) return { error: true, message: 'Game instance not found' };

                if (g.isOver) return { isOver: true };

                const moves = g.getValidMoves();
                if (moves.length === 0) {
                    g.setGameOver(g.turn === 'P1' ? 'P2' : 'P1'); // Force win registration on no moves
                    return { isOver: true, noMoves: true };
                }

                const move = moves[Math.floor(Math.random() * moves.length)];
                g.submitMove(move);

                return { isOver: g.isOver || false, move, role };
            }, currentTurn);

            if (moveData.error) {
                logger.child({ moveCount, step: 'move-loop' }).fail('Client error during move', {
                    role: currentTurn,
                    message: moveData.message
                });
            }

            if (moveData.isOver) {
                isOver = true;
                log(`[TEST] Game Over detected after move submission.`);
                const snapOk = (b) => b && b.text.includes('WINS') && (b.visible || b.text.length > 0);
                const readBanners = () => Promise.all([
                    page1.evaluate(() => {
                        const b = document.getElementById('global-win-banner');
                        return {
                            visible: b?.classList.contains('visible'),
                            text: b?.innerText || '',
                            color: b ? getComputedStyle(b).color : ''
                        };
                    }),
                    page2.evaluate(() => {
                        const b = document.getElementById('global-win-banner');
                        return {
                            visible: b?.classList.contains('visible'),
                            text: b?.innerText || '',
                            color: b ? getComputedStyle(b).color : ''
                        };
                    })
                ]);
                const bannerDeadline = Date.now() + bannerWaitMs;
                while (Date.now() < bannerDeadline) {
                    victoryBannerSnap = await readBanners();
                    if (snapOk(victoryBannerSnap[0]) && snapOk(victoryBannerSnap[1])) break;
                    await page1.waitForTimeout(fastMp ? 25 : mpOptimized ? 40 : 50);
                }
                break;
            } else {
                moveCount++;
                if (moveCount % 5 === 0) {
                    logger.mpProgress(`Move ${moveCount} by ${moveData.role}`);
                }
                if (afterMove) {
                    await afterMove(page1, page2, moveData);
                }
                // Allow brief delay for Firebase RTDB sync across player pages
                await page1.waitForTimeout(MOVE_SYNC_MS);

                // ==========================================
                // PERMANENT REFRESH PERSISTENCE TEST
                // ==========================================
                const isGameOverNow = await page1.evaluate(() => {
                    const frame = document.getElementById('game-frame');
                    return frame && frame.contentWindow && frame.contentWindow.game ? frame.contentWindow.game.isOver : false;
                });

                if (!skipRefresh && moveCount % 3 === 1 && !isGameOverNow) {
                    const pageToRefresh = Math.random() > 0.5 ? page1 : page2;
                    const roleToRefresh = pageToRefresh === page1 ? 'P1' : 'P2';
                    const refreshLog = logger.child({ step: 'refresh', moveCount, role: roleToRefresh });
                    log(`[REFRESH] Refreshing ${roleToRefresh}...`);

                    const turnBefore = await page1.evaluate(() => {
                        const frame = document.getElementById('game-frame');
                        return frame && frame.contentWindow && frame.contentWindow.game ? frame.contentWindow.game.turn : null;
                    });

                    const scoresBefore = await page1.evaluate(() => {
                        const frame = document.getElementById('game-frame');
                        return frame && frame.contentWindow && frame.contentWindow.game ? frame.contentWindow.game.scores : null;
                    });

                    let scoresP2Before = await page2.evaluate(() => {
                        const frame = document.getElementById('game-frame');
                        return frame && frame.contentWindow && frame.contentWindow.game ? frame.contentWindow.game.scores : null;
                    });
                    for (let si = 0; si < 20 && scoresP2Before == null; si++) {
                        await page2.waitForTimeout(100);
                        scoresP2Before = await page2.evaluate(() => {
                            const frame = document.getElementById('game-frame');
                            return frame && frame.contentWindow && frame.contentWindow.game ? frame.contentWindow.game.scores : null;
                        });
                    }

                    if (JSON.stringify(scoresBefore) !== JSON.stringify(scoresP2Before)) {
                        refreshLog.fail('Score desync between P1 and P2 before refresh', {
                            scoresP1: scoresBefore,
                            scoresP2: scoresP2Before
                        });
                    }

                    const boardSnapshotFn = () => {
                        const frame = document.getElementById('game-frame');
                        const g = frame && frame.contentWindow && frame.contentWindow.game;
                        if (!g) return null;
                        if (g.piles) {
                            const piles = {};
                            Object.keys(g.piles).forEach(pk => {
                                piles[pk] = g.piles[pk].map(p => ({
                                    id: p.id, type: p.type, slot: p.slot, gridIdx: p.gridIdx
                                }));
                            });
                            return { kind: 'piles', piles };
                        }
                        if (g.nodes) {
                            return {
                                kind: 'line',
                                nodeCount: g.nodes.length,
                                path: (g.path || []).slice(),
                                endpoints: g.endpoints ? { ...g.endpoints } : null
                            };
                        }
                        return null;
                    };

                    let boardBeforeP1 = null;
                    let boardBeforeP2 = null;
                    const boardSyncDeadline = Date.now() + STEP_MS;
                    while (Date.now() < boardSyncDeadline) {
                        boardBeforeP1 = await page1.evaluate(boardSnapshotFn);
                        boardBeforeP2 = await page2.evaluate(boardSnapshotFn);
                        if (JSON.stringify(boardBeforeP1) === JSON.stringify(boardBeforeP2)) break;
                        await page1.waitForTimeout(50);
                    }
                    const boardBeforeStr = JSON.stringify(boardBeforeP1);
                    const boardBeforeP2Str = JSON.stringify(boardBeforeP2);
                    if (boardBeforeStr !== boardBeforeP2Str) {
                        refreshLog.fail('Board desync between P1 and P2 before refresh', {
                            boardP1: boardBeforeP1,
                            boardP2: boardBeforeP2
                        });
                    }

                    await pageToRefresh.reload({ waitUntil: NAV_WAIT });
                    await waitForGameReady(pageToRefresh, roleToRefresh);

                    const refreshSyncDeadline = Date.now() + STEP_MS;
                    let boardAfterP1 = null;
                    let boardAfterP2 = null;
                    let turnAfter = turnBefore;
                    while (Date.now() < refreshSyncDeadline) {
                        boardAfterP1 = await page1.evaluate(boardSnapshotFn);
                        boardAfterP2 = await page2.evaluate(boardSnapshotFn);
                        const p1Str = JSON.stringify(boardAfterP1);
                        const p2Str = JSON.stringify(boardAfterP2);
                        if (p1Str === boardBeforeStr && p2Str === boardBeforeStr) {
                            turnAfter = await page1.evaluate(() => {
                                const g = document.getElementById('game-frame')?.contentWindow?.game;
                                return g ? g.turn : null;
                            });
                            break;
                        }
                        await page1.waitForTimeout(refreshPollMs);
                    }
                    if (boardAfterP1 == null) {
                        boardAfterP1 = await page1.evaluate(boardSnapshotFn);
                        boardAfterP2 = await page2.evaluate(boardSnapshotFn);
                        turnAfter = await page1.evaluate(() => {
                            const g = document.getElementById('game-frame')?.contentWindow?.game;
                            return g ? g.turn : null;
                        });
                    }

                    const scoresAfter = await page1.evaluate(() => {
                        const frame = document.getElementById('game-frame');
                        return frame && frame.contentWindow && frame.contentWindow.game ? frame.contentWindow.game.scores : null;
                    });

                    if (turnBefore !== turnAfter) {
                        refreshLog.fail('Turn order changed after refresh', {
                            expectedTurn: turnBefore,
                            actualTurn: turnAfter,
                            refreshedRole: roleToRefresh
                        });
                    }

                    if (JSON.stringify(scoresBefore) !== JSON.stringify(scoresAfter)) {
                        refreshLog.fail('Scores changed after refresh', {
                            scoresBefore,
                            scoresAfter,
                            refreshedRole: roleToRefresh
                        });
                    }

                    const boardAfterStr = JSON.stringify(boardAfterP1);
                    if (boardAfterStr !== boardBeforeStr) {
                        refreshLog.fail('Board state changed on P1 after refresh', {
                            refreshedRole: roleToRefresh,
                            boardBefore: boardBeforeP1,
                            boardAfterP1
                        });
                    }
                    if (JSON.stringify(boardAfterP2) !== boardBeforeStr) {
                        refreshLog.fail('Board desync after refresh — P1 vs P2 mismatch', {
                            refreshedRole: roleToRefresh,
                            turnBefore,
                            turnAfter,
                            scoresBefore,
                            scoresAfter,
                            boardBefore: boardBeforeP1,
                            boardAfterP1,
                            boardAfterP2
                        });
                    }

                    log(`[REFRESH] SUCCESS: ${roleToRefresh} refresh preserved state.`);
                }
            }

            // Dual-verification check on state.isOver
            const checkOver = await page1.evaluate(() => {
                const frame = document.getElementById('game-frame');
                return frame ? frame.contentWindow.game.isOver : false;
            });
            if (checkOver) {
                isOver = true;
                victoryWinner = await page1.evaluate(() => {
                    const g = document.getElementById('game-frame')?.contentWindow?.game;
                    if (g?.clearAutoReset) g.clearAutoReset();
                    return g?.winner || null;
                });
                // Capture banner before host auto-reset hides it (audit rooms use a short delay).
                const snap = await Promise.all([
                    page1.evaluate(() => {
                        const b = document.getElementById('global-win-banner');
                        return {
                            visible: b?.classList.contains('visible'),
                            text: b?.innerText || '',
                            color: b ? getComputedStyle(b).color : ''
                        };
                    }),
                    page2.evaluate(() => {
                        const b = document.getElementById('global-win-banner');
                        return {
                            visible: b?.classList.contains('visible'),
                            text: b?.innerText || '',
                            color: b ? getComputedStyle(b).color : ''
                        };
                    })
                ]);
                victoryBannerSnap = snap;
                break;
            }
        }

        if (!isOver) {
            throw new Error(
                `[TEST] Game did not end after ${moveCount} moves (max ${maxMoves}) — cannot verify victory`
            );
        }

        const { verifyMpVictoryOutcome, resolveVictoryAuditPolicy } = require('../platform/win-banner-policy');
        const victoryPolicy = resolveVictoryAuditPolicy(gameId, gameMode);
        const resetMs = isMobile
            ? Number(process.env.FIVE_AUTO_RESET_WAIT_MS || 8000)
            : mpOptimized
                ? Number(process.env.FIVE_AUTO_RESET_WAIT_MS || 1500)
                : Math.max(STEP_MS, 5000);

        log('[TEST] Verifying victory outcome (registry policy)...');
        const preVictoryResetCount = mpAuditCtx.baselineResetCount
            ?? (await page1.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                return g?.roomData?.global?.resetCount ?? g?.roomData?.meta?.resetCount ?? 1;
            }));

        const victoryResult = await verifyMpVictoryOutcome(page1, page2, gameId, gameMode, {
            bannerMs: bannerWaitMs,
            resetMs,
            isMobile,
            victoryWinner,
            skipAutoReset: skipPostVictory
        });
        let actualWinner = victoryResult.winner;
        if (actualWinner) {
            log(`[TEST] Victory winner: ${actualWinner}`);
        }
        if (victoryPolicy.verifyHubWinBanner) {
            console.log(
                `SUCCESS: Victory Banner verified on both clients. Text: "${victoryResult.p1Banner?.text}".`
            );
        }

        if (skipPostVictory) {
            if (!roundSkipCleanup) {
                await page1.evaluate((rId) => {
                    const db = window.NetworkEngine?.db;
                    if (db) {
                        const updates = {};
                        updates[`games/${rId}`] = null;
                        updates[`gameData/${rId}`] = null;
                        return db.ref().update(updates);
                    }
                }, roomId).catch(() => { });
            }
            if (!isLastSessionRound) {
                log(`[TEST] Session round ${sessionRound}/${sessionRounds} complete (fast audit).`);
                continue;
            }
            log(`SUCCESS: MULTIPLAYER ${gameId.toUpperCase()} (${gameMode.toUpperCase()}) FAST AUDIT OK`);
            return;
        }

        if (!actualWinner) {
            actualWinner = await page1.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                return g?.winner || null;
            });
        }
        if (actualWinner && sessionWinCounts[actualWinner] != null) {
            sessionWinCounts[actualWinner] += 1;
        }
        log(`[TEST] Actual winner before post-victory checks: ${actualWinner}`);

        const syncTurnMs = isMobile
            ? Number(process.env.FIVE_MP_TURN_SYNC_MS || 15000)
            : mpOptimized
                ? Number(process.env.FIVE_MP_TURN_SYNC_MS || 2000)
                : Math.max(STEP_MS, 5000);

        if (victoryPolicy.expectAutoReset && !skipPostVictory) {
            const { assertRematchResetEpoch } = require('../platform/mp-reset-audit');
            log('[TEST] Verifying rematch resetCount epoch...');
            await assertRematchResetEpoch(page1, page2, {
                ...mpAuditCtx,
                baselineResetCount: preVictoryResetCount,
                gameId,
                gameMode,
                resetSyncMs: syncTurnMs
            });
            log('[TEST] SUCCESS: rematch resetCount epoch verified.');
        }

        if (victoryPolicy.expectTurnAlternation) {
            log('[TEST] Verifying Turn Alternation post-reset...');
            const waitPostResetTurn = (page, label) => page.waitForFunction(
                async ({ rId }) => {
                    const snap = await window.NetworkEngine.db.ref(`games/${rId}/global/turn`).once('value');
                    const g = document.getElementById('game-frame')?.contentWindow?.game;
                    return snap.val() === 'P2' && g && !g.isOver;
                },
                { rId: roomId },
                { timeout: syncTurnMs }
            ).catch(() => {
                throw new Error(`Turn alternation sync timed out on ${label} after ${syncTurnMs}ms`);
            });

            await Promise.all([
                waitPostResetTurn(page1, 'P1'),
                waitPostResetTurn(page2, 'P2')
            ]);

            const [p1Turn, p2Turn] = await Promise.all([
                page1.evaluate(() => {
                    const g = document.getElementById('game-frame')?.contentWindow?.game;
                    return g ? { turn: g.turn, firstPlayer: g.firstPlayer } : null;
                }),
                page2.evaluate(() => {
                    const g = document.getElementById('game-frame')?.contentWindow?.game;
                    return g ? { turn: g.turn, firstPlayer: g.firstPlayer } : null;
                })
            ]);

            log(`[TEST] Post-Reset Turn State - P1: ${JSON.stringify(p1Turn)}, P2: ${JSON.stringify(p2Turn)}`);
            console.log('SUCCESS: Turn alternation verified. Game correctly started with P2 (Guest) turn.');
        } else {
            log('[TEST] Skipping turn alternation (supportsTurnIndicator=false).');
        }

        if (GameRegistry.hasCapability(gameId, 'supportsScoreboard', gameMode)) {
            log('[TEST] Verifying Scoreboard sync post-reset...');
            const getScoreState = async (page) => {
                return await page.evaluate(() => {
                    const frame = document.getElementById('game-frame');
                    const game = frame && frame.contentWindow ? frame.contentWindow.game : null;
                    return game ? game.scores : null;
                });
            };

            const p1Scores = await getScoreState(page1);
            if (!p1Scores) {
                throw new Error('Could not retrieve host score state post-reset.');
            }

            await page2.waitForFunction(
                (expected) => {
                    const g = document.getElementById('game-frame')?.contentWindow?.game;
                    return g?.scores && JSON.stringify(g.scores) === JSON.stringify(expected);
                },
                p1Scores,
                { timeout: syncTurnMs }
            ).catch(() => {
                throw new Error(`Guest scoreboard did not sync with host within ${syncTurnMs}ms`);
            });

            const p2Scores = await getScoreState(page2);
            log(`[TEST] Post-Reset Score State - P1: ${JSON.stringify(p1Scores)}, P2: ${JSON.stringify(p2Scores)}`);

            if (!p2Scores) {
                throw new Error('Could not retrieve guest score state post-reset.');
            }

            if (JSON.stringify(p1Scores) !== JSON.stringify(p2Scores)) {
                throw new Error(
                    `Scores mismatch post-reset! P1: ${JSON.stringify(p1Scores)}, P2: ${JSON.stringify(p2Scores)}`
                );
            }

            if (!roundSkipScoreVerify) {
                const scoresExpected = expectedScores || (sessionRounds > 1
                    ? { ...sessionWinCounts }
                    : (() => {
                        const base = { P1: 0, P2: 0 };
                        if (actualWinner) base[actualWinner] = (base[actualWinner] || 0) + 1;
                        return base;
                    })());

                if (p1Scores.P1 !== scoresExpected.P1 || p1Scores.P2 !== scoresExpected.P2) {
                    throw new Error(
                        `Expected scores ${JSON.stringify(scoresExpected)}, got: ${JSON.stringify(p1Scores)}`
                    );
                }
                console.log('SUCCESS: Scoreboard sync verified post-reset.');
            } else {
                log('[TEST] Skipping strict score verification (multi-game session).');
            }
        } else {
            log('[TEST] Skipping scoreboard post-reset (supportsScoreboard=false).');
        }

        if (!roundSkipCleanup) {
            // Delete firebase data for room cleanup
            await page1.evaluate((rId) => {
                const db = window.NetworkEngine?.db;
                if (db) {
                    const updates = {};
                    updates[`games/${rId}`] = null;
                    updates[`gameData/${rId}`] = null;
                    return db.ref().update(updates);
                }
            }, roomId).catch(() => { });
        }

        if (!isLastSessionRound) {
            log(`[TEST] Session round ${sessionRound}/${sessionRounds} complete.`);
            continue;
        }

        log(`SUCCESS: MULTIPLAYER ${gameId.toUpperCase()} (${gameMode.toUpperCase()}) AUDIT COMPLETED SUCCESSFULLY`);
        }

    } catch (err) {
        throw err;
    } finally {
        if (ownsBrowser && shouldCloseBrowser()) {
            await browser.close();
        } else if (manageContexts && shouldCloseBrowser()) {
            await page1.close().catch(() => { });
            await page2.close().catch(() => { });
            await context1.close().catch(() => { });
            await context2.close().catch(() => { });
        }
    }
}

module.exports = {
    runMultiplayerAudit,
    isFastMpProfile,
    isMpOptimized,
    resolveMpPlayerSlots,
    enrichMpContext,
    invokeBeforeLoop,
    playerDefsForCount
};
