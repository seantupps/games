/**
 * Production mobile smoke: one emulated phone loads hub + classic piles (no party, no moves).
 */
const {
    RUN_ID,
    prodUid,
    ensureProdStack,
    launchBrowser,
    setupPlayerPage,
    waitForNetworkMobile,
    assertMobileShell,
    assertClassicPilesReady,
    createProdMobileContext,
    cleanupPresence
} = require('./prod-mobile-utils');

async function runMobileSmokeTest() {
    console.log('\n[PROD:MOBILE:SMOKE] Hub + classic piles on mobile viewport...');
    await ensureProdStack();

    const uid = prodUid('M1');
    const name = `PW Mobile ${RUN_ID}`;
    const browser = await launchBrowser();
    const { context, page } = await createProdMobileContext(browser);

    try {
        await setupPlayerPage(page, uid, name, '#3b82f6', 'mobile');
        await waitForNetworkMobile(page);
        await assertMobileShell(page);

        await page.evaluate(() => {
            if (typeof setGame !== 'function') throw new Error('setGame missing');
            setGame('piles', true);
        });
        await page.waitForFunction(
            () => (document.getElementById('game-frame')?.src || '').includes('games/piles'),
            { timeout: 15000 }
        );
        await page.evaluate((m) => {
            if (typeof setGameMode === 'function') setGameMode(m, true);
        }, 'classic');

        await assertClassicPilesReady(page, 'solo');
        console.log('[PROD:MOBILE:SMOKE] SUCCESS');
    } finally {
        await cleanupPresence(page, [uid]);
        await context.close().catch(() => {});
        await browser.close();
    }
}

if (require.main === module) {
    runMobileSmokeTest().catch((e) => {
        console.error('[PROD:MOBILE:SMOKE] FAILURE:', e.message);
        process.exit(1);
    });
}

module.exports = { runMobileSmokeTest };
