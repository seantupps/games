/**
 * MP hub win banner — host and guest should show global-win-banner at the same time.
 */

const { assertWinBannerLayout } = require('./layout-hub');

const DEFAULT_MAX_SKEW_MS = Number(process.env.FIVE_MP_WIN_BANNER_MAX_SKEW_MS || 250);
const DEFAULT_TIMEOUT_MS = Number(process.env.FIVE_MP_WIN_BANNER_TIMEOUT_MS || 3000);
const POLL_MS = 16;

/** @param {import('playwright').Page} page */
async function isHubWinBannerDomVisible(page) {
    return page.evaluate(() => {
        const b = document.getElementById('global-win-banner');
        if (!b) return { visible: false, reason: 'missing' };
        const visible = b.classList.contains('visible') && !b.classList.contains('is-fitting');
        if (!visible) {
            return {
                visible: false,
                reason: 'not-visible',
                fitting: b.classList.contains('is-fitting'),
                fading: b.classList.contains('is-fading-out'),
                text: (b.innerText || '').slice(0, 48)
            };
        }
        const r = b.getBoundingClientRect();
        if (r.width < 24 || r.height < 8) {
            return { visible: false, reason: 'tiny-rect', w: r.width, h: r.height };
        }
        return {
            visible: true,
            text: (b.innerText || '').slice(0, 48),
            fs: parseFloat(getComputedStyle(b).fontSize) || 0
        };
    });
}

/** @param {import('playwright').Page} page */
async function measureHubWinBannerVisibleMs(page, t0, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? POLL_MS;
    const deadline = t0 + timeoutMs;

    while (Date.now() < deadline) {
        const check = await isHubWinBannerDomVisible(page);
        if (check.visible) return Date.now() - t0;
        await page.waitForTimeout(pollMs);
    }
    return null;
}

/**
 * Run win trigger, assert host + guest hub banners appear within maxSkewMs of each other,
 * then verify layout on both clients.
 * @param {object} opts
 * @param {import('playwright').Page} opts.page1
 * @param {import('playwright').Page} opts.page2
 * @param {string} opts.label
 * @param {() => Promise<void>} opts.triggerWin
 * @param {number} [opts.maxSkewMs]
 */
async function assertHubWinBannerVisibleSameTime(opts) {
    const {
        page1,
        page2,
        label,
        triggerWin,
        maxSkewMs = DEFAULT_MAX_SKEW_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        assertLayout = true
    } = opts;

    const measureOpts = { timeoutMs, pollMs: POLL_MS };
    const t0 = Date.now();
    const hostMeasure = measureHubWinBannerVisibleMs(page1, t0, measureOpts);
    const guestMeasure = measureHubWinBannerVisibleMs(page2, t0, measureOpts);

    await triggerWin();

    const [hostMs, guestMs] = await Promise.all([hostMeasure, guestMeasure]);
    if (hostMs == null || guestMs == null) {
        const [hostState, guestState] = await Promise.all([
            isHubWinBannerDomVisible(page1),
            isHubWinBannerDomVisible(page2)
        ]);
        throw new Error(`${label}: hub win banner visibility timeout (hostMs=${hostMs}, guestMs=${guestMs}, `
            + `host=${JSON.stringify(hostState)}, guest=${JSON.stringify(guestState)})`);
    }

    const skew = Math.abs(hostMs - guestMs);
    if (skew > maxSkewMs) {
        throw new Error(`${label}: hub win banner skew ${skew}ms exceeds ${maxSkewMs}ms `
            + `(host=${hostMs}ms, guest=${guestMs}ms)`);
    }

    if (assertLayout) {
        await Promise.all([
            assertWinBannerLayout(page1, `${label} P1`),
            assertWinBannerLayout(page2, `${label} P2`)
        ]);
    }

    return { hostMs, guestMs, skew, maxSkewMs };
}

module.exports = {
    assertHubWinBannerVisibleSameTime,
    measureHubWinBannerVisibleMs,
    isHubWinBannerDomVisible,
    DEFAULT_MAX_SKEW_MS
};
