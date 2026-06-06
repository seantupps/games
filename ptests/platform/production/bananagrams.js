/**
 * Production Bananagrams MP audit (live RTDB, PW_PROD_* room only).
 *
 * This runs the same core 2P flow as desktop MP audit:
 * - deal + split
 * - host/guest dump
 * - host/guest peel
 * - post-game win review + Done reset
 *
 *   Terminal 1: npm run serve
 *   Terminal 2: npm run test:prod:bananagrams
 *
 * Optional: FIVE_HEADED=1, FIVE_BASE_URL=...
 */
process.env.FIVE_FIREBASE_TARGET = 'production';

const {
    RUN_ID,
    prodRoom,
    ensureProdStack,
    launchBrowser,
    cleanupRoom,
    cleanupPresence
} = require('./prod-utils');
const { runBananagramsMpAudit } = require('../../games/bananagrams/runners/mp');

async function runBananagramsProdTest() {
    console.log('\n[PROD:BANANA] Bananagrams MP full audit (dump + peel + win review)...');
    await ensureProdStack();

    const roomId = prodRoom('BANANA');
    const hostUid = 'u_banana_host';
    const guestUid = 'u_banana_guest';

    const browser = await launchBrowser();
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
        await runBananagramsMpAudit(page1, page2, {
            roomId,
            mp: { page1, page2 },
            mobile: false
        });
        console.log(`[PROD:BANANA] Full audit OK in room ${roomId} (${RUN_ID})`);
        console.log('[PROD:BANANA] SUCCESS');
    } finally {
        await cleanupRoom(page1, roomId);
        await cleanupPresence(page1, [hostUid, guestUid]);
        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
        await browser.close();
    }
}

if (require.main === module) {
    runBananagramsProdTest().catch((e) => {
        console.error('[PROD:BANANA] FAILURE:', e.message);
        process.exit(1);
    });
}

module.exports = { runBananagramsProdTest };
