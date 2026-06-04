const { STEP_MS } = require('../../../shared/infra/timeouts');
const { runMultiplayerAudit } = require('../../../shared/infra/multiplayer_base');

async function beforeLoop(page1, page2) {
    console.log('[TEST] Starting Game/Mode Switching Matrix Audit...');

    // Helper to wait for a clean game/mode initialization
    const waitForGame = async (page, name, gameName, mode) => {
        console.log(`[TEST] [${name}] Waiting for ${gameName} (${mode}) to load and initialize...`);
        await page.waitForFunction(({ gName, m }) => {
            const frame = document.getElementById('game-frame');
            if (!frame || !frame.contentWindow) return false;
            const game = frame.contentWindow.game;
            if (!game) return false;
            if (game.gameName !== gName || game.mode !== m) return false;
            
            // Wait for warmup / data initialization to complete
            if (gName === 'piles') {
                return game.piles && Object.keys(game.piles).length > 0 && game.piles['B'] && game.piles['B'].length > 0;
            } else if (gName === 'line') {
                return game.nodes && game.nodes.length > 0;
            }
            return true;
        }, { gName: gameName, m: mode }, { timeout: STEP_MS }).catch(err => {
            console.error(`[TEST] Timeout waiting for ${gameName} (${mode}) on ${name}`);
            throw err;
        });

        // Small timeout to allow Firebase sync and rendering to fully stabilize
        await page.waitForTimeout(400);
    };

    // Helper to fetch details about Piles state
    const getPilesState = async (page) => {
        return await page.evaluate(() => {
            const frame = document.getElementById('game-frame');
            const game = frame.contentWindow.game;
            const piles = game.piles || {};
            return {
                gameName: game.gameName,
                mode: game.mode,
                turn: game.turn,
                bCount: (piles['B'] || []).length,
                rCount: (piles['R'] || []).length,
                gCount: (piles['G'] || []).length,
                pilesData: JSON.parse(JSON.stringify(piles))
            };
        });
    };

    // Helper to fetch details about Line state
    const getLineState = async (page) => {
        return await page.evaluate(() => {
            const frame = document.getElementById('game-frame');
            const game = frame.contentWindow.game;
            return {
                gameName: game.gameName,
                mode: game.mode,
                turn: game.turn,
                nodesCount: (game.nodes || []).length,
                linesCount: (game.lines || []).length,
                pathLength: (game.path || []).length
            };
        });
    };

    // ==========================================
    // MATRIX STEP 1: VERIFY INITIAL CLASSIC PILES
    // ==========================================
    await waitForGame(page1, 'P1', 'piles', 'classic');
    await waitForGame(page2, 'P2', 'piles', 'classic');

    const p1Classic = await getPilesState(page1);
    const p2Classic = await getPilesState(page2);

    console.log(`[TEST] Step 1: Verifying Piles Classic. P1: Blue=${p1Classic.bCount}, Red=${p1Classic.rCount}, Green=${p1Classic.gCount}. P2: Blue=${p2Classic.bCount}, Red=${p2Classic.rCount}, Green=${p2Classic.gCount}`);

    if (p1Classic.bCount !== 5 || p1Classic.rCount !== 5 || p1Classic.gCount !== 5 ||
        p2Classic.bCount !== 5 || p2Classic.rCount !== 5 || p2Classic.gCount !== 5) {
        console.error('FAILURE: Classic Piles counts are not default 5-5-5.');
        process.exit(1);
    }

    if (p1Classic.turn !== 'P1' || p2Classic.turn !== 'P1') {
        console.error(`FAILURE: Default turn is not P1. Got P1=${p1Classic.turn}, P2=${p2Classic.turn}`);
        process.exit(1);
    }

    // Verify Y piece at R-1 (slot 1)
    const p1Yellow = p1Classic.pilesData['R'].find(p => p.slot === 1);
    const p2Yellow = p2Classic.pilesData['R'].find(p => p.slot === 1);
    if (!p1Yellow || p1Yellow.type !== 'Y' || !p2Yellow || p2Yellow.type !== 'Y') {
        console.error('FAILURE: Yellow piece "Y" is missing or in wrong slot in Classic Piles.');
        process.exit(1);
    }

    console.log('SUCCESS: Initial Classic Piles default state verified.');

    // ==========================================
    // MATRIX STEP 2: SWITCH PILES TO FREESTYLE
    // ==========================================
    console.log('[TEST] Step 2: Host (P1) switching Piles mode to Freestyle...');
    await page1.evaluate(() => {
        setGameMode('freestyle');
    });

    await waitForGame(page1, 'P1', 'piles', 'freestyle');
    await waitForGame(page2, 'P2', 'piles', 'freestyle');

    const p1Free = await getPilesState(page1);
    const p2Free = await getPilesState(page2);

    console.log(`[TEST] P1 Freestyle: Blue=${p1Free.bCount}, Red=${p1Free.rCount}, Green=${p1Free.gCount}`);
    console.log(`[TEST] P2 Freestyle: Blue=${p2Free.bCount}, Red=${p2Free.rCount}, Green=${p2Free.gCount}`);

    if (p1Free.bCount !== p2Free.bCount || p1Free.rCount !== p2Free.rCount || p1Free.gCount !== p2Free.gCount) {
        console.error('FAILURE: Freestyle Piles configuration mismatch between clients.');
        process.exit(1);
    }

    const totalPieces = p1Free.bCount + p1Free.rCount + p1Free.gCount;
    if (totalPieces < 14 || totalPieces > 20) {
        console.error(`FAILURE: Freestyle Piles piece count is out of bounds (14-20). Got ${totalPieces}`);
        process.exit(1);
    }

    if (p1Free.turn !== 'P1' || p2Free.turn !== 'P1') {
        console.error(`FAILURE: Freestyle Piles starting turn was not reset to P1. Got P1=${p1Free.turn}, P2=${p2Free.turn}`);
        process.exit(1);
    }

    console.log('SUCCESS: Freestyle Piles starting state verified on both clients.');

    // ==========================================
    // MATRIX STEP 3: SWITCH GAME TO LINE
    // ==========================================
    console.log('[TEST] Step 3: Host (P1) switching game to Line (Classic)...');
    await page1.evaluate(() => {
        setGame('line');
    });

    await waitForGame(page1, 'P1', 'line', 'classic');
    await waitForGame(page2, 'P2', 'line', 'classic');

    const p1Line = await getLineState(page1);
    const p2Line = await getLineState(page2);

    console.log(`[TEST] P1 Line: nodes=${p1Line.nodesCount}, lines=${p1Line.linesCount}, path=${p1Line.pathLength}`);
    console.log(`[TEST] P2 Line: nodes=${p2Line.nodesCount}, lines=${p2Line.linesCount}, path=${p2Line.pathLength}`);

    if (p1Line.nodesCount !== 16 || p2Line.nodesCount !== 16) {
        console.error(`FAILURE: Unexpected default Line nodes count. Expected 16, got P1=${p1Line.nodesCount}, P2=${p2Line.nodesCount}`);
        process.exit(1);
    }

    if (p1Line.linesCount !== 0 || p2Line.linesCount !== 0 || p1Line.pathLength !== 0 || p2Line.pathLength !== 0) {
        console.error(`FAILURE: New Line game is not empty. lines=${p1Line.linesCount}, path=${p1Line.pathLength}`);
        process.exit(1);
    }

    if (p1Line.turn !== 'P1' || p2Line.turn !== 'P1') {
        console.error(`FAILURE: Line starting turn was not reset to P1. Got P1=${p1Line.turn}, P2=${p2Line.turn}`);
        process.exit(1);
    }

    console.log('SUCCESS: Line default state verified on both clients.');

    // ==========================================
    // MATRIX STEP 4: SWITCH BACK TO PILES (freestyle mode should persist via localStorage)
    // ==========================================
    console.log('[TEST] Step 4: Host switching back to Piles (freestyle mode should persist)...');
    await page1.evaluate(() => setGame('piles'));
    await waitForGame(page1, 'P1', 'piles', 'freestyle');
    await waitForGame(page2, 'P2', 'piles', 'freestyle');

    const p1FreeBack = await getPilesState(page1);
    const p2FreeBack = await getPilesState(page2);
    if (p1FreeBack.bCount !== p2FreeBack.bCount || p1FreeBack.rCount !== p2FreeBack.rCount || p1FreeBack.gCount !== p2FreeBack.gCount) {
        console.error('FAILURE: Freestyle piles mismatch after switching back from Line.');
        process.exit(1);
    }
    console.log('SUCCESS: Switched back to Piles with freestyle mode preserved.');

    // Complete the test audit safely without executing moves
    console.log('SUCCESS: Game/Mode Switching Matrix Audit COMPLETED PERFECTLY.');
    process.exit(0);
}

const config = {
    beforeLoop,
    gameMode: 'classic'
};

if (require.main === module) {
    runMultiplayerAudit('piles', config);
}

module.exports = config;
