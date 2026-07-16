/**
 * Quoridor SP audit — board mounts, legal cells, theme colors, click opening move.
 * AI replies via Worker (same P1 human / P2 AI path as line/piles).
 */
const { runGameAudit } = require('../../shared/infra/audit_base');
const { spConfig } = require('../../shared/platform/capability-audit');
const { STEP_MS } = require('../../shared/infra/timeouts');

async function assertQuoridorBoard(page) {
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        const w = frame && frame.contentWindow;
        return w && w.game && w.game.boardEl && w.QuoridorEngine;
    }, { timeout: STEP_MS });

    const info = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const doc = frame.contentWindow.document;
        const g = frame.contentWindow.game;
        const cells = doc.querySelectorAll('.q-cell').length;
        const legal = doc.querySelectorAll('.q-cell.legal').length;
        const style = getComputedStyle(doc.documentElement);
        return {
            cells,
            legal,
            theme: style.getPropertyValue('--theme-color').trim(),
            opp: style.getPropertyValue('--opponent-color').trim(),
            turn: g.turn,
            auditReady: g.isAuditReady?.(),
            localSize: g.localSize,
        };
    });

    if (info.cells !== 81) {
        throw new Error(`Expected 81 cells, got ${info.cells}`);
    }
    if (!info.auditReady) {
        throw new Error('Game not audit-ready');
    }
    if (info.turn !== 'P1') {
        throw new Error(`Expected P1 turn, got ${info.turn}`);
    }
    if (info.localSize !== 800) {
        throw new Error(`Expected localSize 800 (fit-square), got ${info.localSize}`);
    }
    if (info.legal < 1) {
        throw new Error('Expected at least one legal pawn cell on opening');
    }
    if (!info.theme || !info.opp) {
        throw new Error('Missing theme CSS vars');
    }
    console.log(`[TEST] Quoridor SP ok — ${info.legal} legal cells, theme=${info.theme}`);
}

async function assertClickOpeningMove(page) {
    const clicked = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const doc = frame.contentWindow.document;
        const legal = doc.querySelector('.q-cell.legal');
        if (!legal) return false;
        legal.click();
        return true;
    });
    if (!clicked) throw new Error('No legal cell to click');

    // Human move applied immediately; AI follows via triggerAITurn (~1s) + worker.
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        const g = frame.contentWindow.game;
        const eng = g.engine;
        return eng.pawns[0].row !== 8 || eng.pawns[0].col !== 4 || eng.turn > 0;
    }, { timeout: STEP_MS });

    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        const g = frame.contentWindow.game;
        return g.turn === 'P1' && !g._busy && g.engine.turn >= 2;
    }, { timeout: STEP_MS * 3 });

    console.log('[TEST] Opening move + AI reply completed');
}

const config = spConfig('quoridor', {
    gameMode: 'classic',
    extra: [assertQuoridorBoard, assertClickOpeningMove],
});

if (require.main === module) {
    runGameAudit('quoridor', config);
}

module.exports = config;
