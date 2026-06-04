/**
 * Cross-game MP banner helpers — shorten in-game banners for headless sync tests.
 */
const { bannerInstantMs } = require('../infra/speed-profiles');
const { getGameFrame } = require('./mp-waits');

async function clearBanners(frame) {
    await frame.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        g._bannerUntil = 0;
        g._syncBannerEl();
    });
}

async function enableFastBanners(frame) {
    await frame.evaluate(() => {
        const g = window.game;
        if (!g || g._bannerFast) return;
        g._bannerFast = true;
        const orig = g._showBanner.bind(g);
        g._showBanner = (text, ms = 2200, opts) => orig(text, Math.min(ms, 500), opts);
    });
}

async function enableInstantBanners(frame) {
    const capMs = bannerInstantMs();
    await frame.evaluate((cap) => {
        const g = window.game;
        if (!g) return;
        g._bannerInstant = true;
        g._bannerFast = true;
        const orig = g._showBanner.bind(g);
        g._showBanner = (text, ms = 2200, opts) => orig(text, Math.min(ms, cap), opts);
    }, capMs);
}

async function dismissBanners(page1, page2) {
    await Promise.all([
        clearBanners(await getGameFrame(page1)),
        clearBanners(await getGameFrame(page2))
    ]);
}

module.exports = {
    clearBanners,
    enableFastBanners,
    enableInstantBanners,
    dismissBanners
};