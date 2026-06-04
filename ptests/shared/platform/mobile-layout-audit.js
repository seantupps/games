/**
 * Mobile layout policy checks — registry mobileLayoutPolicy drives which fit test runs.
 */
const GameRegistry = require('../../../shared/games/registry');
const { runScenario } = require('./scenario-runner');
const { STEP_MS } = require('../infra/timeouts');

function capsFor(gameId, ctx = {}) {
    const mode = ctx.gameMode || GameRegistry.defaultModeFor(gameId);
    return { mode, caps: GameRegistry.getCapabilities(gameId, mode) };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} gameId
 * @param {object} [ctx]
 */
async function runMobileLayoutPolicyChecks(page, gameId, ctx = {}) {
    if (!ctx.isMobile) return;

    const { caps } = capsFor(gameId, ctx);
    const policy = caps.mobileLayoutPolicy || 'none';
    if (policy === 'none') return;

    const mobile = require('../../platform/mobile/lib/mobile_assertions');
    const ms = ctx.mobileMs ?? STEP_MS;

    await runScenario(`Mobile layout (${policy})`, async () => {
        switch (policy) {
            case 'fit-square':
                await mobile.assertGameBoardFitsViewport(page, { ms });
                await mobile.assertLineBoardCenteredInLandscape(page, ms);
                break;
            case 'piles-dynamic':
                await mobile.assertGameBoardFitsViewport(page, { ms });
                await mobile.assertClassicPilesOrientationLayout(page, ms);
                break;
            case 'fixed-spiral-anchor':
                await mobile.assertGameBoardFitsViewport(page, { ms, margin: 96 });
                await mobile.assertFreestyleMobileLayoutStable(page, ms);
                break;
            case 'pan-zoom-board':
                await mobile.assertGameBoardFitsViewport(page, { ms });
                break;
            default:
                await mobile.assertGameBoardFitsViewport(page, { ms });
        }
    });
}

module.exports = { runMobileLayoutPolicyChecks };
