/**
 * Barebones production tests on emulated mobile (live RTDB, PW_PROD_* rooms only).
 *
 * Quota-conscious: no move loops, no full game-switch matrix, no chat flood.
 *
 *   Terminal 1: npm run serve
 *   Terminal 2: npm run test:prod:mobile
 *
 * Optional:
 *   FIVE_HEADED=1
 *   FIVE_BASE_URL=https://seantupps.github.io/games/   (or local serve)
 *   FIVE_PROD_MOBILE_ONLY=lobby|smoke|party
 *   FIVE_PROD_MOBILE_MS=20000
 */
process.env.FIVE_FIREBASE_TARGET = 'production';
process.env.FIVE_PROFILE = process.env.FIVE_PROFILE || 'prod';
require('../../shared/infra/bootstrap');

const { RUN_ID } = require('./prod-mobile-utils');
const { runMobileSmokeTest } = require('./mobile_smoke');
const { runMobilePartyTest } = require('./mobile_party');
const { runMobileLobbyVisibilityTest } = require('./lobby_mobile');

const STEPS = [
    { name: 'Mobile lobby player visibility', fn: runMobileLobbyVisibilityTest, tag: 'lobby' },
    { name: 'Mobile smoke (hub + piles)', fn: runMobileSmokeTest, tag: 'smoke' },
    { name: 'Mobile party sync', fn: runMobilePartyTest, tag: 'party' }
];

async function main() {
    console.log('==================================================');
    console.log('  PRODUCTION MOBILE (barebones, PW_PROD_* only)');
    console.log(`  Run ID: ${RUN_ID}`);
    console.log('==================================================');

    const only = (process.env.FIVE_PROD_MOBILE_ONLY || '').trim().toLowerCase();
    const toRun = only
        ? STEPS.filter((s) => s.tag.includes(only) || s.name.toLowerCase().includes(only))
        : STEPS;

    if (toRun.length === 0) {
        console.error('No tests matched FIVE_PROD_MOBILE_ONLY');
        process.exit(1);
    }

    const start = Date.now();
    for (const step of toRun) {
        console.log(`\n>>> ${step.name}`);
        await step.fn();
    }

    const sec = ((Date.now() - start) / 1000).toFixed(1);
    console.log('\n==================================================');
    console.log(`  PRODUCTION MOBILE PASSED (${sec}s, ${toRun.length} step(s))`);
    console.log('==================================================');
}

main().catch((err) => {
    console.error('\n[PROD:MOBILE] RUN FAILED:', err.message);
    process.exit(1);
});
