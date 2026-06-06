/**
 * Template scenario — replace with real game checks.
 */
const { waitForGameReady, logStep } = require('../../../shared/adapters/desktop-input');
const { runScenario } = require('../../../shared/infra/scenario-runner');

async function runExampleScenario(page, ctx = {}) {
    await runScenario('Example game ready', async () => {
        await waitForGameReady(page, {
            predicate: 'return g && (g.piles || g.tiles || g.nodes);'
        });
        logStep('Game ready', ctx.role || 'solo');
    });
}

module.exports = { runExampleScenario };
