/**
 * Production mobile lobby: two emulated phones see each other in player list.
 */
const {
    RUN_ID,
    prodUid,
    ensureProdStack,
    launchBrowser,
    setupPlayerPage,
    waitForNetworkMobile,
    assertMobileShell,
    createProdMobilePair,
    cleanupPresence
} = require('./prod-mobile-utils');
const { assertLobbyPlayerCrossVisibility } = require('./prod-utils');

async function runMobileLobbyVisibilityTest() {
    console.log('\n[PROD:MOBILE:LOBBY] Lobby player cross-visibility (two phones)...');
    await ensureProdStack();

    const uidA = prodUid('MLA');
    const uidB = prodUid('MLB');
    const nameA = `PW MobLobby A ${RUN_ID}`;
    const nameB = `PW MobLobby B ${RUN_ID}`;

    const browser = await launchBrowser();
    const { context1, context2, page1, page2 } = await createProdMobilePair(browser);

    try {
        await setupPlayerPage(page1, uidA, nameA, '#3b82f6', 'A');
        await setupPlayerPage(page2, uidB, nameB, '#ef4444', 'B');

        await Promise.all([waitForNetworkMobile(page1), waitForNetworkMobile(page2)]);
        await assertMobileShell(page1);
        await assertMobileShell(page2);

        const { namesA, namesB } = await assertLobbyPlayerCrossVisibility(
            page1,
            page2,
            nameA,
            nameB,
            { timeoutMs: 20000, settleMs: 0 }
        );
        console.log(`[PROD:MOBILE:LOBBY] A sees: ${JSON.stringify(namesA)}`);
        console.log(`[PROD:MOBILE:LOBBY] B sees: ${JSON.stringify(namesB)}`);
        console.log('[PROD:MOBILE:LOBBY] SUCCESS');
    } finally {
        await cleanupPresence(page1, [uidA, uidB]);
        await context1.close().catch(() => {});
        await context2.close().catch(() => {});
        await browser.close();
    }
}

if (require.main === module) {
    runMobileLobbyVisibilityTest().catch((e) => {
        console.error('[PROD:MOBILE:LOBBY] FAILURE:', e.message);
        process.exit(1);
    });
}

module.exports = { runMobileLobbyVisibilityTest };
