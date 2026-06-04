/**
 * Party limit on mobile — same flow as desktop (max 8, leave/rejoin).
 */
const { runPartyLimitTest } = require('../../desktop/mp/mp_party_limit');

async function runPartyLimitMobile(browser) {
    await runPartyLimitTest(browser);
}

module.exports = { runPartyLimitMobile };
