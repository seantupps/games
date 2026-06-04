/**
 * Production piles simulation: play to completion, verify winner banner + scores.
 * No refresh tests, capped moves for quota safety.
 */
const {
    RUN_ID, prodRoom, prodUid, ensureProdStack, launchBrowser,
    setupPlayerPage, waitForNetwork, seedRoom, joinRoom,
    waitForGameReady, cleanupRoom
} = require('./prod-utils');

const MAX_MOVES = Number(process.env.FIVE_PROD_MAX_MOVES || 45);
const SYNC_MS = Number(process.env.FIVE_PROD_SYNC_MS || 250);

async function runPilesSimTest(gameMode = 'classic') {
    console.log(`\n[PROD:PILES] Starting ${gameMode} piles simulation (max ${MAX_MOVES} moves)...`);
    await ensureProdStack();

    const roomId = prodRoom(`PILES_${gameMode.toUpperCase()}`);
    const hostUid = prodUid('PH');
    const guestUid = prodUid('PG');

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
            gameMode,
            hostUid,
            guestUid,
            hostName: `PW Host ${RUN_ID}`,
            guestName: `PW Guest ${RUN_ID}`
        });
        await joinRoom(page1, page2, roomId, 'piles', gameMode);
        await Promise.all([
            waitForGameReady(page1, 'P1', roomId, 'piles'),
            waitForGameReady(page2, 'P2', roomId, 'piles')
        ]);

        let isOver = false;
        let moveCount = 0;

        while (!isOver && moveCount < MAX_MOVES) {
            const snap = await page1.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                if (!g) return null;
                return { turn: g.turn, isOver: g.isOver };
            });
            if (!snap) throw new Error('Game instance lost');
            if (snap.isOver) { isOver = true; break; }

            const activePage = snap.turn === 'P1' ? page1 : page2;
            const moveResult = await activePage.evaluate(() => {
                const g = document.getElementById('game-frame').contentWindow.game;
                if (g.isOver) return { isOver: true };
                const moves = g.getValidMoves();
                if (moves.length === 0) {
                    g.setGameOver(g.turn === 'P1' ? 'P2' : 'P1');
                    return { isOver: true, noMoves: true };
                }
                const move = moves[Math.floor(Math.random() * moves.length)];
                g.submitMove(move);
                return { isOver: g.isOver, move };
            });

            if (moveResult.isOver) {
                isOver = true;
                console.log(`[PROD:PILES] Game over after ${moveCount} moves${moveResult.noMoves ? ' (no moves)' : ''}`);
            } else {
                moveCount++;
                if (moveCount % 5 === 0) {
                    console.log(`[PROD:PILES] Move ${moveCount}: ${JSON.stringify(moveResult.move)}`);
                }
                await page1.waitForTimeout(SYNC_MS);
            }
        }

        if (!isOver) {
            throw new Error(`Game did not finish within ${MAX_MOVES} moves`);
        }

        await page1.waitForTimeout(1500);

        const winner = await page1.evaluate(() => {
            return document.getElementById('game-frame')?.contentWindow?.game?.winner;
        });
        console.log(`[PROD:PILES] Winner: ${winner}`);

        await page1.waitForSelector('#global-win-banner.visible', { timeout: 10000 }).catch(() => {
            throw new Error('Victory banner did not appear on P1');
        });
        await page2.waitForSelector('#global-win-banner.visible', { timeout: 10000 }).catch(() => {
            throw new Error('Victory banner did not appear on P2');
        });

        const [banner1, banner2, scores1, scores2] = await Promise.all([
            page1.evaluate(() => ({
                text: document.getElementById('global-win-banner')?.innerText,
                visible: document.getElementById('global-win-banner')?.classList.contains('visible')
            })),
            page2.evaluate(() => ({
                text: document.getElementById('global-win-banner')?.innerText,
                visible: document.getElementById('global-win-banner')?.classList.contains('visible')
            })),
            page1.evaluate(() => document.getElementById('game-frame')?.contentWindow?.game?.scores),
            page2.evaluate(() => document.getElementById('game-frame')?.contentWindow?.game?.scores)
        ]);

        console.log(`[PROD:PILES] Banner P1: "${banner1.text}" | P2: "${banner2.text}"`);
        console.log(`[PROD:PILES] Scores P1: ${JSON.stringify(scores1)} | P2: ${JSON.stringify(scores2)}`);

        if (!banner1.visible || !banner2.visible || !banner1.text.includes('WINS')) {
            throw new Error('Invalid victory banner state');
        }
        if (banner1.text !== banner2.text) {
            throw new Error(`Banner mismatch: "${banner1.text}" vs "${banner2.text}"`);
        }
        if (JSON.stringify(scores1) !== JSON.stringify(scores2)) {
            throw new Error(`Score desync: ${JSON.stringify(scores1)} vs ${JSON.stringify(scores2)}`);
        }
        if (!winner || scores1[winner] !== 1) {
            throw new Error(`Expected winner ${winner} to have score 1, got ${JSON.stringify(scores1)}`);
        }

        console.log('[PROD:PILES] SUCCESS');
    } finally {
        await cleanupRoom(page1, roomId);
        await browser.close();
    }
}

if (require.main === module) {
    const mode = process.argv[2] || 'classic';
    runPilesSimTest(mode).catch((e) => { console.error('[PROD:PILES] FAILURE:', e.message); process.exit(1); });
}

module.exports = { runPilesSimTest };
