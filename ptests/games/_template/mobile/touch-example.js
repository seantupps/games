/**
 * Optional touch-only checks — import from mobile/sp.js or desktop-sp when ctx.isMobile.
 * Delete this file if your game has no touch-specific regressions.
 */
const { runScenario } = require('../../../shared/platform/scenario-runner');
const { assertGameBoardFitsViewport } = require('../../../platform/mobile/lib/mobile_assertions');

async function runTouchSmoke(page, ctx = {}) {
    if (!ctx.isMobile) return;

    await runScenario('Touch smoke', async () => {
        await assertGameBoardFitsViewport(page, { ms: ctx.mobileMs });
        // Add: tap drag, settings edge swipe, pinch — see ptests/platform/mobile/lib/mobile_assertions.js
    });
}

module.exports = { runTouchSmoke };
