const { runGameAudit } = require('../../shared/infra/audit_base');
const { capabilityBeforeLoop } = require('../../shared/platform/capability-audit');
const { composeBeforeLoop } = require('../../shared/infra/scenario-runner');
const { assertClassicPilesReady } = require('./scenarios/ready');

const beforeLoop = composeBeforeLoop(
    (page, ctx) => capabilityBeforeLoop(page, 'piles', ctx),
    (page) => assertClassicPilesReady(page)
);

const config = {
    beforeLoop,
    gameMode: 'classic'
};

if (require.main === module) {
    runGameAudit('piles', config);
}

module.exports = config;
