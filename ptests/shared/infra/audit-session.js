/**
 * Create Playwright contexts/pages for SP/MP audits by topology.
 */
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

/**
 * @param {'desktop'|'mobile'|'mixed'} topology
 * @param {('desktop'|'mobile')[]} mixedLayout
 * @param {number} index
 */
function slotKind(topology, mixedLayout, index) {
    if (topology === 'desktop') return 'desktop';
    if (topology === 'mobile') return 'mobile';
    return mixedLayout[index] || 'desktop';
}

/**
 * @param {import('playwright').Browser} browser
 * @param {object} options
 * @param {number} [options.players]
 * @param {'desktop'|'mobile'|'mixed'} [options.topology]
 * @param {('desktop'|'mobile')[]} [options.mixedLayout]
 * @param {string[]} [options.roles]
 */
async function createAuditSession(browser, options = {}) {
    const players = options.players ?? 2;
    const topology = options.topology ?? 'desktop';
    const mixedLayout = options.mixedLayout ?? [];
    const roles = options.roles ?? Array.from({ length: players }, (_, i) => `P${i + 1}`);

    const { getDeviceContextOptions } = require('../../platform/mobile/lib/device-presets');
    const { applyTouchDeviceMedia } = require('../../platform/mobile/lib/mobile-utils');
    const { enableMobileHub } = require('../../platform/mobile/lib/mobile_assertions');

    const contexts = [];
    const pages = [];
    const isMobileSlot = [];

    for (let i = 0; i < players; i++) {
        const kind = slotKind(topology, mixedLayout, i);
        const mobile = kind === 'mobile';
        isMobileSlot.push(mobile);

        const contextOpts = mobile
            ? getDeviceContextOptions(options.deviceOverrides)
            : { viewport: DESKTOP_VIEWPORT };

        const context = await browser.newContext(contextOpts);
        if (mobile) await applyTouchDeviceMedia(context);
        const page = await context.newPage();
        const mpMs = Number(process.env.FIVE_MP_READY_MS || 1200);
        page.setDefaultTimeout(mpMs);

        contexts.push(context);
        pages.push(page);
    }

    const mobilePages = pages.filter((_, i) => isMobileSlot[i]);
    if (mobilePages.length) {
        await Promise.all(mobilePages.map((p) => enableMobileHub(p)));
        await Promise.all(mobilePages.map((p) =>
            p.evaluate(() => window.FiveViewport?.syncHubViewport?.()).catch(() => {})
        ));
    }

    const {
        isMpHeaded,
        layoutMpHeadedWindows,
        layoutMpHeadedMobileWindows,
        layoutMpHeadedMixedWindows
    } = require('../platform/mp-headed-view');
    if (isMpHeaded()) {
        if (topology === 'mobile') {
            await layoutMpHeadedMobileWindows(pages);
        } else if (topology === 'mixed') {
            await layoutMpHeadedMixedWindows(pages, { mixedLayout, isMobileSlot });
        } else {
            await layoutMpHeadedWindows(pages);
        }
    }

    const cleanup = async () => {
        await Promise.all(contexts.map((ctx) => ctx.close().catch(() => {})));
    };

    return {
        contexts,
        pages,
        roles,
        isMobileSlot,
        /** @param {number} i */
        isMobile(i) { return isMobileSlot[i]; },
        cleanup,
        /** 2p compat */
        get context1() { return contexts[0]; },
        get context2() { return contexts[1]; },
        get page1() { return pages[0]; },
        get page2() { return pages[1]; }
    };
}

module.exports = {
    DESKTOP_VIEWPORT,
    slotKind,
    createAuditSession
};
