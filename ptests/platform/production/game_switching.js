/**
 * Production game/mode switching matrix (no move loop).
 */
const {
    RUN_ID, prodRoom, prodUid, ensureProdStack, launchBrowser,
    setupPlayerPage, waitForNetwork, seedRoom, joinRoom,
    waitForGameReady, waitForGameMode, cleanupRoom
} = require('./prod-utils');

async function getPilesState(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame').contentWindow.game;
        const piles = g.piles || {};
        return {
            mode: g.mode,
            turn: g.turn,
            bCount: (piles['B'] || []).length,
            rCount: (piles['R'] || []).length,
            gCount: (piles['G'] || []).length,
            pilesData: JSON.parse(JSON.stringify(piles))
        };
    });
}

async function getLineState(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame').contentWindow.game;
        return {
            mode: g.mode,
            turn: g.turn,
            nodesCount: (g.nodes || []).length,
            linesCount: (g.lines || []).length,
            pathLength: (g.path || []).length
        };
    });
}

async function runGameSwitchingTest() {
    console.log('\n[PROD:SWITCH] Starting game/mode switching test...');
    await ensureProdStack();

    const roomId = prodRoom('SWITCH');
    const hostUid = prodUid('SW_H');
    const guestUid = prodUid('SW_G');

    const browser = await launchBrowser();
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
        await setupPlayerPage(page1, hostUid, `PW Host ${RUN_ID}`, '#3b82f6', 'P1');
        await setupPlayerPage(page2, guestUid, `PW Guest ${RUN_ID}`, '#ef4444', 'P2');
        await waitForNetwork(page1);
        await seedRoom(page1, {
            roomId,
            gameId: 'piles',
            gameMode: 'classic',
            hostUid,
            guestUid,
            hostName: `PW Host ${RUN_ID}`,
            guestName: `PW Guest ${RUN_ID}`
        });
        await joinRoom(page1, page2, roomId, 'piles', 'classic');
        await Promise.all([
            waitForGameReady(page1, 'P1', roomId, 'piles'),
            waitForGameReady(page2, 'P2', roomId, 'piles')
        ]);

        // Step 1: Classic piles 5-5-5
        await waitForGameMode(page1, 'P1', 'piles', 'classic');
        await waitForGameMode(page2, 'P2', 'piles', 'classic');
        const c1 = await getPilesState(page1);
        const c2 = await getPilesState(page2);
        if (c1.bCount !== 5 || c2.bCount !== 5 || c1.rCount !== 5 || c2.rCount !== 5) {
            throw new Error(`Classic piles not 5-5-5: P1=${c1.bCount}/${c1.rCount}/${c1.gCount} P2=${c2.bCount}/${c2.rCount}/${c2.gCount}`);
        }
        console.log('[PROD:SWITCH] Step 1 OK: classic piles');

        // Step 2: Freestyle
        await page1.evaluate(() => setGameMode('freestyle'));
        await waitForGameMode(page1, 'P1', 'piles', 'freestyle');
        await waitForGameMode(page2, 'P2', 'piles', 'freestyle');
        const f1 = await getPilesState(page1);
        const f2 = await getPilesState(page2);
        if (f1.bCount !== f2.bCount || f1.rCount !== f2.rCount || f1.gCount !== f2.gCount) {
            throw new Error('Freestyle pile mismatch between clients');
        }
        const total = f1.bCount + f1.rCount + f1.gCount;
        if (total < 14 || total > 20) {
            throw new Error(`Freestyle piece count ${total} not in 14-20`);
        }
        console.log('[PROD:SWITCH] Step 2 OK: freestyle piles');

        // Step 3: Line
        await page1.evaluate(() => setGame('line'));
        await waitForGameMode(page1, 'P1', 'line', 'classic');
        await waitForGameMode(page2, 'P2', 'line', 'classic');
        const l1 = await getLineState(page1);
        const l2 = await getLineState(page2);
        if (l1.nodesCount !== 16 || l2.nodesCount !== 16 || l1.linesCount !== 0) {
            throw new Error(`Line init bad: P1 nodes=${l1.nodesCount} lines=${l1.linesCount}`);
        }
        console.log('[PROD:SWITCH] Step 3 OK: line');

        // Step 4: Back to piles freestyle
        await page1.evaluate(() => setGame('piles'));
        await waitForGameMode(page1, 'P1', 'piles', 'freestyle');
        await waitForGameMode(page2, 'P2', 'piles', 'freestyle');
        const b1 = await getPilesState(page1);
        const b2 = await getPilesState(page2);
        if (b1.bCount !== b2.bCount || b1.mode !== 'freestyle' || b2.mode !== 'freestyle') {
            throw new Error('Freestyle not preserved after line switch');
        }
        console.log('[PROD:SWITCH] SUCCESS');
    } finally {
        await cleanupRoom(page1, roomId);
        await browser.close();
    }
}

if (require.main === module) {
    runGameSwitchingTest().catch((e) => { console.error('[PROD:SWITCH] FAILURE:', e.message); process.exit(1); });
}

module.exports = { runGameSwitchingTest };
