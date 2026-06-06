/**
 * Guest-win review: hub victory banner must appear on host + guest and stay in the upper viewport.
 * Reproduces manual bug where host #global-win-banner ends up at the bottom after review refit.
 */
const { assertWinBannerLayout } = require('./layout-hub');
const { assertActionsWinBanner } = require('../runners/mp-audit/mp-ai-playthrough');
const { isHubWinBannerDomVisible } = require('./mp-sync-win-banner');
const { log } = require('../lib/mp-state');

const UPPER_VIEWPORT_FRACTION = 0.55;

/** Host hub banner must sit in upper viewport (not pushed to bottom by Done obstacle clearance). */
async function assertHostWinBannerUpperViewport(hostPage, label = 'host win banner position') {
    const snap = await hostPage.evaluate((maxFrac) => {
        const b = document.getElementById('global-win-banner');
        const vv = window.visualViewport;
        const vh = vv?.height ?? window.innerHeight;
        const r = b?.getBoundingClientRect() || {};
        const frame = document.getElementById('game-frame');
        const fdoc = frame?.contentDocument;
        const done = fdoc?.getElementById('banana-done-btn');
        const doneRect = done?.getBoundingClientRect?.();
        return {
            visible: !!b?.classList.contains('visible'),
            fitting: !!b?.classList.contains('is-fitting'),
            text: (b?.innerText || '').slice(0, 48),
            top: r.top,
            bottom: r.bottom,
            vh,
            maxTop: vh * maxFrac,
            inlineTop: b?.style?.getPropertyValue('--win-banner-top') || null,
            topDefault: getComputedStyle(document.documentElement).getPropertyValue('--win-banner-top-default').trim(),
            doneShow: !!done?.classList.contains('show'),
            doneTop: doneRect?.top ?? null,
            doneBottom: doneRect?.bottom ?? null
        };
    }, UPPER_VIEWPORT_FRACTION);

    if (!snap.visible) {
        throw new Error(`${label}: hub win banner not visible (${JSON.stringify(snap)})`);
    }
    if (snap.top > snap.maxTop) {
        throw new Error(
            `${label}: hub win banner too low on host (top=${snap.top}, max=${snap.maxTop}, `
            + `vh=${snap.vh}) — likely Done/obstacle clearance bug (${JSON.stringify(snap)})`
        );
    }
    log(`SUCCESS: ${label} — host banner in upper viewport (top=${Math.round(snap.top)} / ${Math.round(snap.vh)})`);
}

/**
 * After guest win + review: banner visible on both clients, layout OK, host not at bottom.
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 * @param {import('playwright').Frame} guestFrame
 * @param {string} [label]
 */
async function assertGuestWinHubBannerReview(hostPage, guestPage, guestFrame, label = 'guest win hub banner') {
    await assertActionsWinBanner([hostPage, guestPage], `${label} visible`);

    await Promise.all([
        assertWinBannerLayout(hostPage, `${label} host layout`),
        assertWinBannerLayout(guestPage, `${label} guest layout`)
    ]);

    // Allow review viewport refit + post-game clearance to settle (common repro window).
    await hostPage.waitForTimeout(700);
    await guestPage.waitForTimeout(700);

    await assertHostWinBannerUpperViewport(hostPage, `${label} host upper viewport`);

    const [hostState, guestState] = await Promise.all([
        isHubWinBannerDomVisible(hostPage),
        isHubWinBannerDomVisible(guestPage)
    ]);
    if (!hostState.visible || !guestState.visible) {
        throw new Error(`${label}: banner lost after review refit `
            + `(host=${JSON.stringify(hostState)}, guest=${JSON.stringify(guestState)})`);
    }

    log(`SUCCESS: ${label} — hub win banner on host + guest after review refit`);
}

module.exports = {
    assertGuestWinHubBannerReview,
    assertHostWinBannerUpperViewport,
    UPPER_VIEWPORT_FRACTION
};
