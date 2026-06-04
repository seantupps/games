/**
 * Production lobby smoke: two tabs see each other in settings player list.
 */
const {
    RUN_ID, prodUid, ensureProdStack, launchBrowser,
    setupPlayerPage, waitForNetwork, cleanupPresence
} = require('./prod-utils');

async function runLobbyTest() {
    console.log('\n[PROD:LOBBY] Starting lobby presence test...');
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
        await pageA.waitForTimeout(3000);

        const getNames = async (page) => page.evaluate(() => {
            const list = document.getElementById('player-list');
            if (!list) return [];
            return Array.from(list.querySelectorAll('.player-name')).map((el) => el.innerText.trim());
        });

        const [namesA, namesB] = await Promise.all([getNames(pageA), getNames(pageB)]);
        console.log(`[PROD:LOBBY] A sees: ${JSON.stringify(namesA)}`);
        console.log(`[PROD:LOBBY] B sees: ${JSON.stringify(namesB)}`);

        const aSeesB = namesA.some((n) => n.includes(nameB) || n.includes('PW Lobby B'));
        const bSeesA = namesB.some((n) => n.includes(nameA) || n.includes('PW Lobby A'));
        if (!aSeesB || !bSeesA) {
            throw new Error(`Lobby cross-visibility failed. A→B=${aSeesB} B→A=${bSeesA}`);
        }
        console.log('[PROD:LOBBY] SUCCESS');
    } finally {
        await cleanupPresence(pageA, [uidA, uidB]);
        await browser.close();
    }
}

if (require.main === module) {
    runLobbyTest().catch((e) => { console.error('[PROD:LOBBY] FAILURE:', e.message); process.exit(1); });
}

module.exports = { runLobbyTest };
