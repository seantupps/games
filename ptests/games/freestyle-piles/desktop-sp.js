const { STEP_MS } = require('../../shared/infra/timeouts');
const { runGameAudit } = require('../../shared/infra/audit_base');
const {
    assertGameBoardFitsViewport,
    assertPilesInGameColorPicker,
    assertFreestyleMobileLayoutStable
} = require('../../platform/mobile/lib/mobile_assertions');

async function beforeLoop(page, ctx = {}) {
    console.log('[TEST] Verifying Piles rendering...');
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        return frame && frame.contentWindow && frame.contentWindow.game && frame.contentWindow.game.piles;
    }, { timeout: STEP_MS });

    const pileCount = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        return Object.keys(frame.contentWindow.game.piles).length;
    });

    console.log(`[TEST] SUCCESS: Freestyle Piles initialized with ${pileCount} piles.`);

    if (ctx.isMobile) {
        await assertGameBoardFitsViewport(page);
        await assertPilesInGameColorPicker(page);
        await assertFreestyleMobileLayoutStable(page);
        console.log('[TEST] SUCCESS: Freestyle piles fit viewport, color picker, stable center anchor.');
    }
}

const config = {
    beforeLoop,
    gameMode: 'freestyle'
};

if (require.main === module) {
    runGameAudit('piles', config);
}

module.exports = config;
