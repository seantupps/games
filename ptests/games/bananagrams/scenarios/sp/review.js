/**
 * Solo victory / Done / dev-win scenarios.
 */
const { sp } = require('../../assertions');
const { testBananasVictoryDone, testBananasDevWinDoneTwice } = sp;
const { runScenario } = require('../../../../shared/infra/scenario-runner');

async function runVictoryScenarios(page, gameFrame, options = {}) {
    const log = (msg) => console.log(msg.startsWith('[TEST]') ? msg : `[TEST] ${msg}`);
    if (!options.skipPeelWinFixture) {
        await runScenario('Victory Done flow', async () => {
            await testBananasVictoryDone(page, gameFrame, { log });
        });
    }
    await runScenario('Dev /win twice', async () => {
        await testBananasDevWinDoneTwice(page, gameFrame, { log });
    });
}

module.exports = { runVictoryScenarios };
