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
const { runSpBoardSolveScenarios } = require('./scenarios/board-solve');
const { runSoloUiAudit } = require('./scenarios/solo-ui');
const { runSoloActionsAudit, runSoloActionsSession } = require('./scenarios/solo-ui-actions');

async function beforeLoop(page, ctx = {}) {
    const slices = parseSpScenarioSlices(process.argv, 'all');

    if (slices.length === 1 && slices[0] === 'hub') {
        await runHubScenarios(page);
        return;
    }

    if (slices.length === 1 && slices[0] === 'solve') {
        await runSpBoardSolveScenarios(page);
        return;
    }

    if (isSpActionsPlaythrough(slices)) {
        await runSoloActionsSession(page);
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
    require('../../shared/infra/bootstrap');
    const { ensureRunConfig } = require('../../shared/infra/run-config');
    const args = process.argv.slice(2);
    ensureRunConfig(args);
    if (args.includes('--list-scenarios')) {
        console.log('SP scenarios:', listScenarios('sp').join(', '));
        process.exit(0);
    }
    const { endPlaywrightRun } = require('../../shared/infra/env-defaults');
    runGameAudit('bananagrams', config)
        .catch((err) => {
            console.error(err.message || err);
            process.exitCode = 1;
        })
        .finally(() => endPlaywrightRun());
}

module.exports = config;
