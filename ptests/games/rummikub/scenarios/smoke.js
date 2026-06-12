/**
 * Minimal smoke scenario — keep fast for CI (`applySpeedProfile` maps smoke → ci).
 */
async function runSmokeScenario(page, ctx) {
    // Add one cheap invariant check unique to your game.
    await page.waitForFunction(() => !!document.getElementById('game-frame'));
}

module.exports = { runSmokeScenario };