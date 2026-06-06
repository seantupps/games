/**
 * Mobile MP audit — peel spawn sync (delegates to shared MP peel scenario).
 */
const { runMpPeelSpawnScenario } = require('../scenarios/mp/peel');

/** @deprecated Use runMpPeelSpawnScenario from scenarios/mp/peel.js */
async function runBananagramsMpMobilePeelSpawnSync(opts) {
    const log = opts.log || ((msg) => console.log(`[TEST] ${msg}`));
    log('MP mobile: peel spawn visible at same time on host + guest...');
    return runMpPeelSpawnScenario({ ...opts, mobile: true, log });
}

module.exports = {
    runBananagramsMpMobilePeelSpawnSync,
    runMpPeelSpawnScenario
};
