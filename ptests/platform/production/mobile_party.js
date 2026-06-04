/**
 * Production mobile party: two phones join seeded room, verify classic piles sync (no moves).
 */
const {
    RUN_ID,
    prodRoom,
    prodUid,
    ensureProdStack,
    launchBrowser,
    setupPlayerPage,
    waitForNetworkMobile,
    assertMobileShell,
    assertClassicPilesReady,
    createProdMobilePair,
    seedRoom,
    joinRoom,
    waitForGameReady,
    cleanupRoom,
    cleanupPresence
} = require('./prod-mobile-utils');

async function runMobilePartyTest() {
    console.log('\n[PROD:MOBILE:PARTY] Two-player classic piles sync (no move loop)...');
    await ensureProdStack();

    const roomId = prodRoom('MOB');
    const hostUid = prodUid('MH');
    const guestUid = prodUid('MG');

    const browser = await launchBrowser();
    const { context1, context2, page1, page2 } = await createProdMobilePair(browser);

    try {
        await setupPlayerPage(page1, hostUid, `PW MHost ${RUN_ID}`, '#3b82f6', 'P1');
        await setupPlayerPage(page2, guestUid, `PW MGuest ${RUN_ID}`, '#ef4444', 'P2');

        await waitForNetworkMobile(page1);
        await assertMobileShell(page1);
        await waitForNetworkMobile(page2);
        await assertMobileShell(page2);

        await seedRoom(page1, {
            roomId,
            gameId: 'piles',
            gameMode: 'classic',
            hostUid,
            guestUid,
            hostName: `PW MHost ${RUN_ID}`,
            guestName: `PW MGuest ${RUN_ID}`
        });

        await joinRoom(page1, page2, roomId, 'piles', 'classic');
        await waitForGameReady(page1, 'P1', roomId, 'piles');
        await waitForGameReady(page2, 'P2', roomId, 'piles');

        await assertClassicPilesReady(page1, 'P1');
        await assertClassicPilesReady(page2, 'P2');

        const turn = await page1.evaluate(() =>
            document.getElementById('game-frame')?.contentWindow?.game?.turn
        );
        if (turn !== 'P1' && turn !== 'P2') {
            throw new Error(`Unexpected turn after sync: ${turn}`);
        }
        console.log(`[PROD:MOBILE:PARTY] SUCCESS (turn=${turn})`);
    } finally {
        await cleanupRoom(page1, roomId);
        await cleanupPresence(page1, [hostUid, guestUid]);
        await context1.close().catch(() => {});
        await context2.close().catch(() => {});
        await browser.close();
    }
}

if (require.main === module) {
    runMobilePartyTest().catch((e) => {
        console.error('[PROD:MOBILE:PARTY] FAILURE:', e.message);
        process.exit(1);
    });
}

module.exports = { runMobilePartyTest };
