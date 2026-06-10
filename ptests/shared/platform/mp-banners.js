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
    await setBannerDurationCap(frame, 500);
}

/** Cap in-game banner duration; null restores production timing. */
async function setBannerDurationCap(frame, capMs) {
    await frame.evaluate((cap) => {
        const g = window.game;
        if (!g) return;
        if (!g._showBannerOrig) g._showBannerOrig = g._showBanner.bind(g);
        const orig = g._showBannerOrig;
        if (cap == null) {
            g._showBanner = orig;
            g._bannerFast = false;
            return;
        }
        g._bannerFast = true;
        g._showBanner = (text, ms = 2200, opts) => orig(text, Math.min(ms, cap), opts);
    }, capMs);
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

/** Wait until action banners expire naturally (no programmatic clear). */
async function waitForBannersCleared(frames, timeoutMs = 8000) {
    const list = Array.isArray(frames) ? frames : [frames];
    await Promise.all(list.map((frame) => frame.waitForFunction(() => {
        const g = window.game;
        if (!g) return true;
        const text = g._bannerText || '';
        const until = g._bannerUntil || 0;
        return !text || until <= Date.now();
    }, {}, { timeout: timeoutMs })));
}

module.exports = {
    clearBanners,
    enableFastBanners,
    setBannerDurationCap,
    enableInstantBanners,
    dismissBanners,
    waitForBannersCleared
};