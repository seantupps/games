const { applyTouchDeviceMedia } = require('../platform/mobile/lib/mobile-utils');
const { getDeviceContextOptions } = require('../platform/mobile/lib/device-presets');
const {
    HUB_MS,
    launchDesktopBrowser,
    loadHubForTurnCheck,
    assertTurnLayoutParity,
    runComponent
} = require('./shared');

const spec = {
    id: 'turn-layout',
    name: 'Turn indicator spacing (desktop + mobile parity)',
    async run(browser) {
        const { context: desktopCtx, page: desktopPage } = await launchDesktopBrowser(browser);
        let mobileCtx;
        let mobilePage;
        try {
            const desktopTurnLayout = await loadHubForTurnCheck(desktopPage, false);

            const mobileOpts = getDeviceContextOptions();
            mobileCtx = await browser.newContext(mobileOpts);
            await applyTouchDeviceMedia(mobileCtx);
            mobilePage = await mobileCtx.newPage();
            mobilePage.setDefaultTimeout(HUB_MS);
            mobilePage.setDefaultNavigationTimeout(HUB_MS);

            const mobileTurnLayout = await loadHubForTurnCheck(mobilePage, true);
            assertTurnLayoutParity(desktopTurnLayout, mobileTurnLayout);
        } finally {
            await mobileCtx?.close().catch(() => {});
            await desktopCtx.close().catch(() => {});
        }
    }
};

if (require.main === module) {
    runComponent(spec).then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = spec;
