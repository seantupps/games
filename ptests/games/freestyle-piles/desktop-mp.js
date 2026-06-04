const { runMultiplayerAudit } = require('../../shared/infra/multiplayer_base');
const { mpConfig } = require('../../shared/platform/capability-audit');

async function freestyleMobileExtras(page1, page2, ctx) {
    if (!ctx.anyMobile && !ctx.isMobile) return;
    const { assertGameBoardFitsViewport, assertPilesInGameColorPicker } = require('../../platform/mobile/lib/mobile_assertions');

    const relayout = async (page) => {
        await page.evaluate(() => {
            const win = document.getElementById('game-frame')?.contentWindow;
            const g = win?.game;
            if (!g) return;
            win.FiveViewport?.applyMobileClass?.(true);
            g._fitZoomInitialized = false;
            g.refreshMobileLayout?.();
            g.requestRender?.();
        });
        await page.waitForTimeout(150);
    };
    await relayout(page1);
    await relayout(page2);
    await assertGameBoardFitsViewport(page1);
    await assertGameBoardFitsViewport(page2);
    await assertPilesInGameColorPicker(page1);
    console.log('[TEST] SUCCESS: Freestyle mobile layout + color picker.');
}

const config = mpConfig('piles', {
    gameMode: 'freestyle',
    extra: [freestyleMobileExtras]
});

if (require.main === module) {
    runMultiplayerAudit('piles', config);
}

module.exports = config;
