const { chromium } = require('playwright');
const { getDeviceContextOptions, resolveDeviceName } = require('./device-presets');
const { applyPageDefaults } = require('./mobile-timeouts');
const { DEFAULT_MS } = require('./mobile-constants');

/** One browser, two isolated mobile contexts (P1 / P2). */
async function createMobilePair(browser) {
    const opts = getDeviceContextOptions();
    const context1 = await browser.newContext(opts);
    const context2 = await browser.newContext(opts);
    await applyTouchDeviceMedia(context1);
    await applyTouchDeviceMedia(context2);
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    applyPageDefaults(page1);
    applyPageDefaults(page2);
    return { context1, context2, page1, page2 };
}

async function closeMobilePair(pair) {
    if (!pair) return;
    await pair.context1?.close().catch(() => {});
    await pair.context2?.close().catch(() => {});
}

const { playwrightHeadless } = require('../../../shared/infra/env-defaults');

async function launchMobileBrowser() {
    return chromium.launch({ headless: playwrightHeadless() });
}

/** Playwright mobile contexts should match real-phone media (hover:none, coarse). */
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

async function createMobileContext(browser, overrides = {}) {
    const opts = getDeviceContextOptions(overrides);
    const context = await browser.newContext(opts);
    await applyTouchDeviceMedia(context);
    const page = await context.newPage();
    applyPageDefaults(page);
    return { context, page, deviceName: resolveDeviceName(), viewport: opts.viewport };
}

async function assertMobileHub(page) {
    const viewport = page.viewportSize();
    if (!viewport || viewport.height <= viewport.width) {
        throw new Error(`Expected portrait mobile viewport (height > width), got ${viewport?.width}x${viewport?.height}`);
    }

    await page.waitForSelector('#game-frame');
    const { assertNaturalMobileViewport, assertMobileBarLayout } = require('./mobile_assertions');
    await assertNaturalMobileViewport(page);
    await assertMobileBarLayout(page);

    await page.locator('#mobile-chat-btn').tap();
    await page.waitForSelector('#chat-container.active', { timeout: DEFAULT_MS });
    await page.locator('#mobile-chat-btn').tap();
    await page.waitForFunction(() => !document.getElementById('chat-container').classList.contains('active'));

    const iframeReady = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        return !!(frame && frame.contentWindow);
    });
    if (!iframeReady) throw new Error('Game iframe not ready on mobile hub');
}

module.exports = {
    launchMobileBrowser,
    createMobileContext,
    createMobilePair,
    closeMobilePair,
    assertMobileHub,
    applyTouchDeviceMedia,
    resolveDeviceName
};
