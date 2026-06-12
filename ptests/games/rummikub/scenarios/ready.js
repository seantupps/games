/**
 * Game-ready scenario — use in SP/MP beforeLoop for generic board shapes.
 */
const { waitForGameReady, logStep } = require('../../../shared/adapters/desktop-input');
const { runScenario } = require('../../../shared/infra/scenario-runner');

async function assertGameAuditReady(page, ctx = {}) {
    await runScenario('Game audit ready', async () => {
        await waitForGameReady(page, {
            predicate: 'return g && (typeof g.isAuditReady === "function" ? g.isAuditReady() : (g.piles || g.tiles || g.nodes));'
        });
        logStep('Audit ready', ctx.role || 'solo');
    });
}

module.exports = { assertGameAuditReady };
