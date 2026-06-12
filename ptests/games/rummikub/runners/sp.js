/**
 * Rummikub solo desktop audit.
 * Run: npm run sp:rummikub  (default = AI playthrough)
 * Slices: npm run sp:rummikub:ui  |  --scenario=all  |  --scenario=solve
 */
const { runGameAudit } = require('../../../shared/infra/audit_base');
const { capabilityBeforeLoop } = require('../../../shared/platform/capability-audit');
const { isSmokeScenario } = require('../../../shared/scenarios/registry');
const {
    parseSpScenarioSlices,
    isSpPlaythrough,
    listScenarios
} = require('../scenarios/registry');
const { runSpUiAudit } = require('../scenarios/sp/ui');
const { runSpPlaythrough } = require('../scenarios/sp/playthrough');
const { runSpBoardSolveScenarios } = require('../scenarios/sp/solve');

async function beforeLoop(page, ctx = {}) {
    const slices = parseSpScenarioSlices(process.argv, 'playthrough');

    if (slices.length === 1 && slices[0] === 'solve') {
        await waitForGameOnly(page);
        await runSpBoardSolveScenarios(page);
        return;
    }

    if (isSpPlaythrough(slices)) {
        await runSpPlaythrough(page, ctx);
        return;
    }

    if (isSmokeScenario(slices)) {
        await capabilityBeforeLoop(page, 'rummikub', {
            ...ctx,
            gameMode: 'puzzle',
            viewportDeep: false
        });
        return;
    }

    if (slices.includes('ui') || slices.includes('all')) {
        await capabilityBeforeLoop(page, 'rummikub', {
            ...ctx,
            gameMode: 'puzzle',
            viewportDeep: true
        });
    }

    if (slices.includes('ui') || slices.includes('all')) {
        await runSpUiAudit(page, ctx);
    }

    if (slices.includes('all')) {
        await runSpPlaythrough(page, ctx);
    }
}

async function waitForGameOnly(page) {
    const { waitForRummikubReady } = require('../lib/session');
    await waitForRummikubReady(page);
}

const config = {
    beforeLoop,
    skipGameLoop: true,
    gameMode: 'puzzle',
    fastStart: true
};

if (require.main === module) {
    require('../../../shared/infra/bootstrap');
    const { ensureRunConfig } = require('../../../shared/infra/run-config');
    const args = process.argv.slice(2);
    ensureRunConfig(args);
    if (args.includes('--list-scenarios')) {
        console.log('SP scenarios:', listScenarios('sp').join(', '));
        process.exit(0);
    }
    const { endPlaywrightRun } = require('../../../shared/infra/env-defaults');
    runGameAudit('rummikub', config)
        .catch((err) => {
            console.error(err.message || err);
            process.exitCode = 1;
        })
        .finally(() => endPlaywrightRun());
}

module.exports = config;
