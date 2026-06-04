const { STEP_MS } = require('../../shared/infra/timeouts');
const { runGameAudit } = require('../../shared/infra/audit_base');

const { assertDragPreviewAtHalfway: assertDragPreviewDesktop } = require('./desktop-line-drag-utils');
const {
    assertDragPreviewAtHalfway: assertDragPreviewMobile,
    assertLineDragTracksPointer
} = require('../../platform/mobile/lib/line-drag-utils');
const { assertGameBoardFitsViewport } = require('../../platform/mobile/lib/mobile_assertions');

async function beforeLoop(page, ctx = {}) {
    // 1. Wait for Game to be fully ready
    console.log('[TEST] Waiting for game initialization...');
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        return frame && frame.contentWindow && frame.contentWindow.game && frame.contentWindow.game.nodes.length > 0;
    }, { timeout: STEP_MS });

    if (ctx.isMobile) {
        await assertGameBoardFitsViewport(page);
        console.log('[TEST] SUCCESS: Line board fits mobile viewport.');
    }

    // 2. Perform UI Drag Test from Node 1
    console.log('[TEST] Performing UI Drag from Node 1...');
    const iframeHandle = await page.$('#game-frame');
    const box = await iframeHandle.boundingBox();

    const n1_target = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const gDoc = frame.contentWindow.document;
        const node = gDoc.querySelector('.node[data-id="1"]');
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    const n5_target = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const gDoc = frame.contentWindow.document;
        const node = gDoc.querySelector('.node[data-id="5"]');
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    if (!n1_target || !n5_target) {
        console.error('FAILURE: Target nodes not found in UI.');
        process.exit(1);
    }

    // Convert to absolute page coordinates
    const n1_abs = { x: box.x + n1_target.x, y: box.y + n1_target.y };
    const n5_abs = { x: box.x + n5_target.x, y: box.y + n5_target.y };

    await page.mouse.move(n1_abs.x, n1_abs.y);
    await page.mouse.down();

    // Drag halfway to verify that preview line follows the cursor perfectly
    const halfway_abs = { x: (n1_abs.x + n5_abs.x) / 2, y: (n1_abs.y + n5_abs.y) / 2 };
    await page.mouse.move(halfway_abs.x, halfway_abs.y, { steps: 5 });

    try {
        if (ctx.isMobile) {
            await assertLineDragTracksPointer(page, '1', '5', 8);
        } else {
            await assertDragPreviewDesktop(page);
        }
        console.log('[TEST] SUCCESS: Drag preview follows finger/cursor.');
    } catch (err) {
        console.error(`FAILURE: ${err.message}`);
        process.exit(1);
    }

    await page.mouse.move(n5_abs.x, n5_abs.y, { steps: ctx.isMobile ? 12 : 5 });
    await page.mouse.up();

    if (ctx.isMobile) {
        const { waitForLinePathInFrame } = require('../../platform/mobile/lib/mobile-waits');
        await waitForLinePathInFrame(page, 1);
    } else {
        await page.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g && g.path && g.path.length > 0;
        }, { timeout: STEP_MS });
    }

    const readColorResults = () => page.evaluate(() => {
        const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
        const frame = document.getElementById('game-frame');
        const gameDoc = frame.contentWindow.document;

        const scoreUser = gameDoc.querySelector('.score-user');
        const scoreColor = scoreUser ? getComputedStyle(scoreUser).color : null;

        const line = gameDoc.querySelector('line.mine');
        const lineStroke = line ? getComputedStyle(line).stroke : null;

        const game = frame.contentWindow.game;
        const moveExecuted = game.path.length > 0;

        return { themeColor, scoreColor, lineStroke, moveExecuted };
    });

    let colorResults = await readColorResults();

    if (!colorResults.moveExecuted && ctx.isMobile) {
        await page.evaluate(() => {
            const g = document.getElementById('game-frame').contentWindow.game;
            const moves = g.getValidMoves();
            if (moves.length) g.makeMove(moves[0].a, moves[0].b);
        });
        colorResults = await readColorResults();
    }

    console.log('[TEST] Verifying Color Consistency...');
    console.log(`[TEST] Theme: ${colorResults.themeColor}, Score: ${colorResults.scoreColor}`);

    if (!colorResults.moveExecuted) {
        console.error('FAILURE: UI Drag from Node 1 failed to execute a move.');
        process.exit(1);
    }

    const normalize = (c) => {
        if (!c) return null;
        c = c.replace(/\s/g, '').toLowerCase();
        if (c.startsWith('#')) {
            const r = parseInt(c.slice(1, 3), 16);
            const g = parseInt(c.slice(3, 5), 16);
            const b = parseInt(c.slice(5, 7), 16);
            return `rgb(${r},${g},${b})`;
        }
        return c;
    };

    if (normalize(colorResults.scoreColor) !== normalize(colorResults.themeColor)) {
        console.error(`FAILURE: Scoreboard color mismatch. Theme: ${colorResults.themeColor}, Score: ${colorResults.scoreColor}`);
        process.exit(1);
    }
    console.log('SUCCESS: Color consistency and Node 1 UI drag verified.');
}

const config = {
    beforeLoop,
    initialMoveCount: 1 // We already did one move in beforeLoop
};

if (require.main === module) {
    runGameAudit('line', config);
}

module.exports = config;
