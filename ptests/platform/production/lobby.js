/**
 * Production lobby smoke: two tabs see each other in settings player list.
 */
const {
    RUN_ID, prodUid, ensureProdStack, launchBrowser,
    setupPlayerPage, waitForNetwork, cleanupPresence,
    assertLobbyPlayerCrossVisibility
} = require('./prod-utils');

async function runLobbyVisibilityTest() {
    console.log('\n[PROD:LOBBY] Lobby player cross-visibility (desktop)...');
    await ensureProdStack();

    const uidA = prodUid('LOBBY_A');
    const uidB = prodUid('LOBBY_B');
    const nameA = `PW Lobby A ${RUN_ID}`;
    const nameB = `PW Lobby B ${RUN_ID}`;

    const browser = await launchBrowser();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
        await setupPlayerPage(pageA, uidA, nameA, '#3b82f6', 'A');
        await setupPlayerPage(pageB, uidB, nameB, '#ef4444', 'B');
        await Promise.all([waitForNetwork(pageA), waitForNetwork(pageB)]);

        const { namesA, namesB } = await assertLobbyPlayerCrossVisibility(
            pageA,
            pageB,
            nameA,
            nameB
        );
        console.log(`[PROD:LOBBY] A sees: ${JSON.stringify(namesA)}`);
        console.log(`[PROD:LOBBY] B sees: ${JSON.stringify(namesB)}`);
        console.log('[PROD:LOBBY] SUCCESS');
    } finally {
        await cleanupPresence(pageA, [uidA, uidB]);
        await browser.close();
    }
}

/** @deprecated use runLobbyVisibilityTest */
const runLobbyTest = runLobbyVisibilityTest;

if (require.main === module) {
    runLobbyVisibilityTest().catch((e) => { console.error('[PROD:LOBBY] FAILURE:', e.message); process.exit(1); });
}

module.exports = { runLobbyVisibilityTest, runLobbyTest };
