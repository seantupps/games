/**
 * Mobile viewport + touch emulation for production RTDB tests.
 * Reuses prod-utils room/uid helpers; keeps reads/writes minimal (quota).
 */
process.env.FIVE_FIREBASE_TARGET = 'production';

const {
    RUN_ID,
    prodRoom,
    prodUid,
    ensureProdStack,
    launchBrowser,
    setupPlayerPage,
    waitForNetwork,
    seedRoom,
    joinRoom,
    waitForGameReady,
    cleanupRoom,
    cleanupPresence,
    buildHubUrl,
    buildAppUrl
} = require('./prod-utils');

const { getDeviceContextOptions, resolveDeviceName } = require('../mobile/lib/device-presets');
const { enableMobileHub } = require('../mobile/lib/mobile_assertions');

const STEP_MS = Number(process.env.FIVE_PROD_MOBILE_MS || 15000);

async function applyTouchDeviceMedia(context) {
    await context.addInitScript(() => {
        if (window.__fiveTouchMediaPatched) return;
        window.__fiveTouchMediaPatched = true;
        const orig = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
            const m = orig(query);
            if (query === '(hover: none)') return { ...m, matches: true };
            if (query === '(pointer: coarse)') return { ...m, matches: true };
            return m;
        };
        if (navigator.maxTouchPoints < 1) {
            try {
                Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
            } catch (_) { /* ignore */ }
        }
    });
}

async function createProdMobileContext(browser) {
    const opts = getDeviceContextOptions();
    const context = await browser.newContext(opts);
    await applyTouchDeviceMedia(context);
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_MS);
    return { context, page, deviceName: resolveDeviceName(), viewport: opts.viewport };
}

async function createProdMobilePair(browser) {
    const opts = getDeviceContextOptions();
    const context1 = await browser.newContext(opts);
    const context2 = await browser.newContext(opts);
    await applyTouchDeviceMedia(context1);
    await applyTouchDeviceMedia(context2);
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    page1.setDefaultTimeout(STEP_MS);
    page2.setDefaultTimeout(STEP_MS);
    return { context1, context2, page1, page2, deviceName: resolveDeviceName() };
}

async function waitForNetworkMobile(page) {
    await waitForNetwork(page);
    await enableMobileHub(page);
    await page.evaluate(() => window.FiveViewport?.syncHubViewport?.());
}

async function assertMobileShell(page) {
    const state = await page.evaluate(() => ({
        fiveMobile: document.documentElement.classList.contains('five-mobile'),
        bar: document.getElementById('mobile-bar')
            ? getComputedStyle(document.getElementById('mobile-bar')).display
            : null,
        firebase: window.NetworkEngine?.firebaseTarget
    }));
    if (state.firebase !== 'production') {
        throw new Error(`Expected production Firebase, got ${state.firebase}`);
    }
    if (!state.fiveMobile || state.bar !== 'flex') {
        throw new Error(`Mobile shell not active: ${JSON.stringify(state)}`);
    }
}

async function assertClassicPilesReady(page, roleLabel = '') {
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const piles = g?.piles;
        return piles && (piles.B?.length === 5) && (piles.R?.length === 5) && (piles.G?.length === 5);
    }, { timeout: STEP_MS });
    const counts = await page.evaluate(() => {
        const p = document.getElementById('game-frame').contentWindow.game.piles;
        return { B: p.B.length, R: p.R.length, G: p.G.length };
    });
    if (counts.B !== 5 || counts.R !== 5 || counts.G !== 5) {
        throw new Error(
            `${roleLabel} classic piles not 5-5-5: ${JSON.stringify(counts)}`
        );
    }
}

module.exports = {
    RUN_ID,
    STEP_MS,
    prodRoom,
    prodUid,
    ensureProdStack,
    launchBrowser,
    setupPlayerPage,
    waitForNetworkMobile,
    assertMobileShell,
    assertClassicPilesReady,
    createProdMobileContext,
    createProdMobilePair,
    seedRoom,
    joinRoom,
    waitForGameReady,
    cleanupRoom,
    cleanupPresence,
    buildHubUrl,
    buildAppUrl
};
