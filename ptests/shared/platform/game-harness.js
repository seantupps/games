/**
 * Cross-game Playwright helpers — iframe access, hub navigation, logging.
 */
const { STEP_MS } = require('../infra/timeouts');
const { buildAppUrl, buildHubUrl } = require('../infra/emulator-utils');

const { defaultLogger } = require('../infra/test-logger');

function logStep(label, detail) {
    defaultLogger.step(label, detail);
}

async function getGameFrame(page) {
    const handle = await page.$('#game-frame');
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error('game iframe not ready');
    return frame;
}

/**
 * Run fn in the game iframe (receives no args; use closure for data).
 * @template T
 * @param {import('playwright').Page} page
 * @param {() => T} fn
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<T>}
 */
async function evalGame(page, fn) {
    const frame = await getGameFrame(page);
    return frame.evaluate(fn);
}

/** Run fn in the hub page (parent of #game-frame). */
async function evalHub(page, fn) {
    return page.evaluate(fn);
}

/**
 * Wait until the game iframe exposes a live `game` instance.
 * @param {import('playwright').Page} page
 * @param {{ timeout?: number, predicate?: string }} [opts] — predicate is source for (g) => boolean
 */
async function waitForGameReady(page, opts = {}) {
    const timeout = opts.timeout ?? STEP_MS;
    const predicate = opts.predicate
        || 'return g && (g.identitySynced || g.playerRole || g.piles || g.tiles || g.nodes);';
    await page.waitForFunction((predSrc) => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        if (!g) return false;
        try {
            // eslint-disable-next-line no-new-func
            const fn = new Function('g', predSrc);
            return !!fn(g);
        } catch (_) {
            return false;
        }
    }, predicate, { timeout });
}

async function openLobby(page, opts = {}) {
    const username = opts.username ?? 'TotallyAwesome5';
    await page.goto(buildHubUrl('lobby'));
    await page.evaluate((name) => {
        localStorage.clear();
        localStorage.setItem('username', name);
    }, username);
}

/**
 * Hub lobby → solo iframe URL (same flow as audit_base).
 */
async function openSoloGame(page, gameId, gameMode = 'classic', opts = {}) {
    await openLobby(page, opts);
    await page.goto(buildAppUrl('lobby', 'P1', gameId, gameMode));
    await page.waitForSelector('#game-frame');
    await waitForGameReady(page, opts.ready);
    if (opts.isMobile) {
        const { enableMobileHub } = require('../../platform/mobile/lib/mobile_assertions');
        await enableMobileHub(page);
        await page.evaluate(() => window.FiveViewport?.syncHubViewport?.());
    }
}

module.exports = {
    logStep,
    getGameFrame,
    evalGame,
    evalHub,
    waitForGameReady,
    openLobby,
    openSoloGame,
    buildAppUrl,
    buildHubUrl
};
