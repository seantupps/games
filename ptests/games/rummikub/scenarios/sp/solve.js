/**
 * Hub chat /solve N — dev board solve from current tiles.
 * N = tiles left on the rack (Rummikub).
 */
const { getGameFrame } = require('../../../../shared/adapters/desktop-input');
const { createTestLogger } = require('../../../../shared/infra/test-logger');
const { TIMEOUT_MS } = require('../../../../shared/adapters/chat-commands');
const { waitForRummikubReady, EXPECTED_TILES } = require('../../lib/session');

const logger = createTestLogger({ gameId: 'rummikub', scenario: 'solve' });

/**
 * @param {import('playwright').Page} page
 * @param {number} n
 */
async function invokeBoardSolve(page, n) {
    const receipt = await page.evaluate((stragglers) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (typeof g?.applyDevBoardSolve !== 'function') {
            return { ok: false, reason: 'no-applyDevBoardSolve' };
        }
        g.applyDevBoardSolve(stragglers);
        return { ok: true, receipt: win.__lastBoardSolveReceipt || null };
    }, n);
    if (!receipt?.ok) {
        throw new Error(`/solve ${n}: ${receipt?.reason || 'invoke failed'}`);
    }
    return receipt.receipt;
}

/**
 * @param {import('playwright').Frame} frame
 * @param {number} rackCount
 */
async function readSolveState(frame, rackCount) {
    return frame.evaluate((wantRack) => {
        const g = window.game;
        const tiles = g?.tiles || [];
        const rack = tiles.filter((t) => t.zone === 'rack');
        const table = tiles.filter((t) => t.zone === 'table');
        const tableOnly = typeof g._verifyTableSpatial === 'function'
            ? g._verifyTableSpatial(table)
            : null;
        const allTiles = typeof g._verifySpatial === 'function'
            ? g._verifySpatial(tiles)
            : tableOnly;
        return {
            total: tiles.length,
            rack: rack.length,
            table: table.length,
            tableSolved: !!tableOnly?.solved,
            tableOrphans: tableOnly?.remaining ?? 0,
            unmatched: allTiles?.unmatchedTileBriefs?.length ?? 0,
            winDiag: typeof g._evaluateWinCondition === 'function'
                ? g._evaluateWinCondition('test')
                : null,
            inReview: !!g._postGameReview,
            isOver: !!g.isOver,
            victoryRegistered: !!g._victoryRegistered,
            wantRack
        };
    }, rackCount);
}

/**
 * @param {import('playwright').Page} page
 * @param {number} n
 * @param {{ expectWin?: boolean }} [opts]
 */
async function runSolveAndAssert(page, n, opts = {}) {
    const stepLog = logger.child({ step: `/solve ${n}` });
    stepLog.step(`/solve ${n}`);

    const receipt = await invokeBoardSolve(page, n);
    if (!receipt?.ok) {
        const winDiag = await page.evaluate(() => (
            document.getElementById('game-frame')?.contentWindow?.__lastRummikubWinCheck ?? null
        ));
        stepLog.fail(`/solve ${n}: solve failed`, { receipt, winDiag });
    }
    if (!receipt.message) {
        stepLog.fail(`/solve ${n}: missing receipt message`, { receipt });
    }

    const frame = await getGameFrame(page);
    if (opts.expectWin) {
        await frame.waitForFunction(() => {
            const g = window.game;
            return !!g?._postGameReview && !!g?.isOver && !!g?._victoryRegistered;
        }, { timeout: TIMEOUT_MS });
    } else {
        await frame.waitForFunction((wantRack) => {
            const g = window.game;
            if (!g?.tiles?.length) return false;
            const rack = g.tiles.filter((t) => t.zone === 'rack').length;
            return rack === wantRack;
        }, n, { timeout: TIMEOUT_MS });
    }

    const state = await readSolveState(frame, n);
    if (state.total !== EXPECTED_TILES) {
        stepLog.fail(`/solve ${n}: expected ${EXPECTED_TILES} tiles`, { state });
    }
    if (state.rack !== n) {
        stepLog.fail(`/solve ${n}: expected ${n} rack tile(s)`, { state });
    }
    if (!state.tableSolved) {
        stepLog.fail(`/solve ${n}: table melds not solved`, { state });
    }
    if (opts.expectWin) {
        if (!state.inReview || !state.isOver || !state.victoryRegistered) {
            stepLog.fail(`/solve ${n}: expected win / review`, { state, receipt });
        }
    } else if (state.inReview || state.isOver) {
        stepLog.fail(`/solve ${n}: unexpected win`, { state, receipt });
    }

    stepLog.success(
        `/solve ${n}`,
        `rack=${state.rack}, table=${state.table}, solved=${state.tableSolved}`
    );
    return { receipt, state };
}

/**
 * @param {import('playwright').Page} page
 */
async function runSpBoardSolveScenarios(page) {
    const log = logger.child({ gameMode: 'solo' });
    page.setDefaultTimeout(TIMEOUT_MS);

    await waitForRummikubReady(page);

    log.step('/solve 3 — partition table, leave 3 on rack');
    await runSolveAndAssert(page, 3);

    log.step('/solve 0 — full solve triggers win');
    await runSolveAndAssert(page, 0, { expectWin: true });
}

module.exports = {
    runSpBoardSolveScenarios,
    runSolveAndAssert,
    readSolveState
};
