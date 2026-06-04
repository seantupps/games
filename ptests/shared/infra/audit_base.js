require('./bootstrap');

const { chromium } = require('playwright');
const { ensureTestStack, buildAppUrl, buildHubUrl } = require('./emulator-utils');
const { STEP_MS } = require('./timeouts');
const { playwrightHeadless, playwrightSlowMo, shouldCloseBrowser } = require('./env-defaults');
const { createTestLogger, isMpChatterSuppressed } = require('./test-logger');

/**
 * Shared audit library for game simulations.
 * @param {string} gameId - 'piles', 'line', etc.
 * @param {Object} options - Configuration and hooks.
 */
async function runGameAudit(gameId, options = {}) {
    const {
        headless = playwrightHeadless(),
        maxMoves = 50,
        beforeLoop = async (page, context) => { },
        afterMove = async (page, moveData) => { },
        gameMode = 'classic',
        page: providedPage = null,
        context: providedContext = null,
        browser: providedBrowser = null,
        skipStackCheck = false,
        manageContext = true
    } = options;

    const suppressBrowserConsole = isMpChatterSuppressed() || !!options.quiet;
    const logger = createTestLogger({ gameId, gameMode });
    const log = (msg) => logger.step(String(msg).replace(/^\[TEST\]\s*/, ''));
    const fail = (msg, details) => logger.fail(msg, details);

    log(`Starting Audit for game: ${gameId.toUpperCase()} (${gameMode.toUpperCase()})...`);

    let browser = providedBrowser;
    let context = providedContext;
    let page = providedPage;
    let ownsBrowser = false;

    if (!page) {
        browser = await chromium.launch({
            headless: playwrightHeadless(),
            slowMo: playwrightSlowMo()
        });
        context = await browser.newContext();
        page = await context.newPage();
        ownsBrowser = true;
    }

    if (!suppressBrowserConsole) {
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('[HUB]') || text.includes('Guest global listener')) return;
            const importantTags = ['WINNER', 'FAILURE', 'SUCCESS', '[TEST]'];
            if (importantTags.some(tag => text.includes(tag))) {
                console.log(`[BROWSER] ${msg.type().toUpperCase()}: ${text}`);
            }
        });
    }

    page.on('response', response => {
        if (response.status() >= 400 && !response.url().includes('favicon')) {
            console.error(`[BROWSER] NETWORK ERROR ${response.status()}: ${response.url()}`);
        }
    });

    try {
        if (!skipStackCheck) await ensureTestStack();
        if (options.fastStart) {
            await page.goto(buildAppUrl('lobby', 'P1', gameId, gameMode));
        } else {
            await page.goto(buildHubUrl('lobby'));
            await page.evaluate(() => { localStorage.clear(); localStorage.setItem('username', 'TotallyAwesome5'); });
            await page.goto(buildAppUrl('lobby', 'P1', gameId, gameMode));
        }
        await page.waitForSelector('#game-frame');

        // Wait until parent has synchronized identity with the iframe and the iframe is ready
        await page.waitForFunction(() => {
            const frame = document.getElementById('game-frame');
            return frame && frame.contentWindow && frame.contentWindow.game && (frame.contentWindow.game.identitySynced || frame.contentWindow.game.playerRole);
        }, { timeout: STEP_MS });

        const victoryDwellMs = Number(process.env.FIVE_VICTORY_DWELL_MS || 0);
        if (victoryDwellMs > 0) {
            await page.evaluate((ms) => {
                const win = document.getElementById('game-frame')?.contentWindow;
                if (win) win.FIVE_VICTORY_DWELL_MS = ms;
            }, victoryDwellMs).catch(() => { });
        }

        if (options.isMobile) {
            const { enableMobileHub } = require('../../platform/mobile/lib/mobile_assertions');
            await enableMobileHub(page);
            await page.evaluate(() => window.FiveViewport?.syncHubViewport?.());
        }

        // Hook for custom initialization (e.g., UI drag tests)
        if (beforeLoop) await beforeLoop(page, { gameId, context, isMobile: !!options.isMobile });

        if (options.skipGameLoop) {
            log(`SUCCESS: ${gameId.toUpperCase()} (${gameMode.toUpperCase()}) UI AUDIT COMPLETED`);
            return;
        }

        log(`[TEST] Starting ${gameId.toUpperCase()} Move Loop...`);
        let isOver = false;
        let moveCount = options.initialMoveCount || 0;
        let retryCount = 0;

        while (!isOver && moveCount < maxMoves) {
            moveCount++;
            const moveData = await page.evaluate((rc) => {
                const frame = document.getElementById('game-frame');
                const g = frame ? frame.contentWindow.game : null;
                if (!g) return { retry: true, retryCount: rc };

                // Let's do checking within the evaluation block
                if (g.isOver) return { isOver: true };

                const moves = g.getValidMoves();
                if (moves.length === 0) {
                    g.setGameOver(g.turn === 'P1' ? 'P2' : 'P1'); // Force win registration on no moves
                    return { isOver: true };
                }

                const move = moves[Math.floor(Math.random() * moves.length)];
                g.submitMove(move);

                // Re-evaluate if game is over immediately after the move is submitted
                if (g.isOver) return { isOver: true, move: move };

                return { isOver: false, move: move };
            }, retryCount);

            if (moveData.retry) {
                retryCount = (moveData.retryCount || 0) + 1;
                if (retryCount > 2) {
                    fail('Game failed to initialize after 2 retries.');
                }
                log(`[TEST] Game not ready (Retry ${retryCount}/2), retrying...`);
                await page.waitForTimeout(1000);
                moveCount--;
                continue;
            }
            retryCount = 0;

            if (moveData.isOver) {
                isOver = true;
                log(`[TEST] Game Over detected after ${moveCount} iterations.`);
            } else {
                if (moveCount % 5 === 0) logger.mpProgress(`Move ${moveCount}`);
                if (afterMove) await afterMove(page, moveData);
                // No timeout needed - we can fast-track completely!
            }
        }

        const { verifySpVictoryOutcome } = require('../platform/win-banner-policy');
        await verifySpVictoryOutcome(page, gameId, gameMode, {
            timeoutMs: STEP_MS,
            resetMs: options.isMobile
                ? Number(process.env.FIVE_AUTO_RESET_WAIT_MS || 8000)
                : STEP_MS,
            isMobile: !!options.isMobile
        });

        log(`SUCCESS: ${gameId.toUpperCase()} (${gameMode.toUpperCase()}) AUDIT COMPLETED SUCCESSFULLY`);

    } catch (err) {
        throw err;
    } finally {
        if (ownsBrowser && browser && shouldCloseBrowser()) {
            await browser.close();
        } else if (manageContext && context && shouldCloseBrowser()) {
            await context.close().catch(() => { });
        }
    }
}

module.exports = { runGameAudit };
