/** Shared wait helpers for Bananagrams audits. */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const mpWaits = require('../../../shared/platform/mp-waits');
module.exports = { STEP_MS, ...mpWaits };
