/**
 * Solo victory / Done / dev-win scenarios.
 */
const { testBananasVictoryDone, testBananasDevWinDoneTwice } = require('../assertions/bananagrams_solo_done');
const { runScenario } = require('../../../shared/platform/scenario-runner');

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
