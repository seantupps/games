/**
 * Bananagrams solo desktop audit.
 * Run: npm run sp:banana:desktop  (all = UI + AI solver + dev /win Done)
 * Slices: npm run sp:banana:actions  |  --scenario=placement,dump,peel
 */
const { runGameAudit } = require('../../shared/infra/audit_base');
const { capabilityBeforeLoop } = require('../../shared/platform/capability-audit');
const {
    parseSpScenarioSlices,
    resolveSpActionSlices,
    isSpActionsPlaythrough,
    isSpActionScenario,
    listScenarios
} = require('./scenarios/registry');
const { runHubScenarios } = require('./scenarios/hub');
const { runSoloUiAudit } = require('./scenarios/solo-ui');
const { runSoloActionsAudit, runSoloFullGameAudit } = require('./scenarios/solo-ui-actions');

async function beforeLoop(page, ctx = {}) {
    const slices = parseSpScenarioSlices(process.argv, 'all');

    if (slices.length === 1 && slices[0] === 'hub') {
        await runHubScenarios(page);
        return;
    }

    if (isSpActionsPlaythrough(slices)) {
        await runSoloFullGameAudit(page);
        return;
    }

    if (!slices.includes('hub')) {
        await capabilityBeforeLoop(page, 'bananagrams', { ...ctx, gameMode: 'solo' });
    }

    if (isSpActionScenario(slices)) {
        const actionSlices = resolveSpActionSlices(slices);
        await runSoloActionsAudit(page, actionSlices);
        return;
    }

    if (slices.includes('hub')) {
        await runHubScenarios(page);
    }

    if (slices.includes('ui') || slices.includes('all')) {
        await runSoloUiAudit(page, { includeAiSolver: slices.includes('all') });
    }
}

const config = {
    beforeLoop,
    skipGameLoop: true,
    gameMode: 'solo',
    fastStart: true
};

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--list-scenarios')) {
        console.log('SP scenarios:', listScenarios('sp').join(', '));
        process.exit(0);
    }
    runGameAudit('bananagrams', config);
}

module.exports = config;
