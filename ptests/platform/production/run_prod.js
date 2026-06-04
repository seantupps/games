/**
 * Production RTDB test runner (opt-in, not the full emulator suite).
 *
 *   Terminal 1: npm run serve
 *   Terminal 2: npm run test:prod
 *
 * Optional:
 *   FIVE_HEADED=1              — visible browser
 *   FIVE_BASE_URL=...          — test deployed GitHub Pages build
 *   FIVE_PROD_MAX_MOVES=45     — piles sim move cap
 *   FIVE_PROD_SYNC_MS=250      — delay between moves (prod latency)
 */
process.env.FIVE_FIREBASE_TARGET = 'production';
process.env.FIVE_PROFILE = process.env.FIVE_PROFILE || 'prod';
require('../../shared/infra/bootstrap');

const { RUN_ID } = require('./prod-utils');
const { runLobbyTest } = require('./lobby');
const { runGameSwitchingTest } = require('./game_switching');
const { runPilesSimTest } = require('./piles_sim');

const STEPS = [
    { name: 'Lobby presence', fn: runLobbyTest },
    { name: 'Game/mode switching', fn: runGameSwitchingTest },
    { name: 'Classic piles simulation', fn: () => runPilesSimTest('classic') },
    { name: 'Party chat', fn: () => require('./chat').runChatTest() }
];

async function main() {
    console.log('==================================================');
    console.log('  PRODUCTION RTDB TESTS (PW_PROD_* rooms only)');
    console.log(`  Run ID: ${RUN_ID}`);
    console.log('==================================================');

    const only = process.env.FIVE_PROD_ONLY;
    const toRun = only
        ? STEPS.filter((s) => s.name.toLowerCase().includes(only.toLowerCase()))
        : STEPS;

    if (toRun.length === 0) {
        console.error('No tests matched FIVE_PROD_ONLY filter');
        process.exit(1);
    }

    const start = Date.now();
    for (const step of toRun) {
        console.log(`\n>>> ${step.name}`);
        await step.fn();
    }

    const sec = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n==================================================`);
    console.log(`  ALL PRODUCTION TESTS PASSED (${sec}s)`);
    console.log('==================================================');
}

main().catch((err) => {
    console.error('\n[PROD] RUN FAILED:', err.message);
    process.exit(1);
});
