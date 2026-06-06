/**
 * Hub chat /b solve N — dev-only full-bag solve.
 * N = total shared bunch remaining; 1 on-board straggler per player when N > 0.
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { getGameFrame } = require('../../../shared/platform/game-harness');
const { createTestLogger } = require('../../../shared/infra/test-logger');
const {
    BUNCH,
    WAIT_MS,
    RESET_WAIT_MS,
    waitPoolBoth,
    splitViaDrag,
    assertStartingRackConnected,
    waitForDiag,
    syncGuestPoolFromHost,
    flushHostBananaInteractions
} = require('../lib/mp-lib');
const {
    waitMpClientsInReview,
    waitMpResetAfterDone
} = require('../assertions/bananagrams_postgame_assertions');
const { clickDone } = require('../assertions/bananagrams_solo_done');

const POST_WIN_SOLVE_BLOCK = 'Cannot solve after win or during review';

const TIMEOUT_MS = STEP_MS;
const logger = createTestLogger({ gameId: 'bananagrams', scenario: 'solve' });

/** @param {number} n @param {number} playerCount @param {number} totalTiles */
function solveExpectations(n, playerCount, totalTiles) {
    const stragglersPerPlayer = n > 0 ? 1 : 0;
    const poolTotal = n;
    const crosswordPerPlayer = (totalTiles - poolTotal - (stragglersPerPlayer * playerCount)) / playerCount;
    const onBoardPerPlayer = crosswordPerPlayer + stragglersPerPlayer;
    return {
        n,
        playerCount,
        totalTiles,
        stragglersPerPlayer,
        stragglersTotal: stragglersPerPlayer * playerCount,
        poolTotal,
        crosswordPerPlayer,
        onBoardPerPlayer
    };
}

/**
 * @param {import('playwright').Frame} frame
 * @param {number} expectedTotal
 * @param {import('../../../shared/infra/test-logger').TestLogger} log
 * @param {string} label
 */
async function assertSolveTileDistribution(frame, expectedTotal, log, label) {
    const dist = await frame.evaluate(() => {
        const g = window.game;
        const rules = window.BananaRules;
        if (!g || !rules) return { ok: false, reason: 'no-game' };

        const cfg = rules.resolveBagConfig(new URLSearchParams(window.location.search));
        const mode = g._isMultiplayerMode?.() ? 'multiplayer' : 'solo';
        const bag = rules.getTileBag(mode, cfg);
        const bagLabel = mode === 'multiplayer' ? 'scrabble-mp' : (cfg.soloVariant === 'classic' ? 'solo-classic' : 'solo-fast');
        const expectedBagTotal = rules.poolTotal(bag);

        const counts = {};
        const add = (entry) => {
            let ch = null;
            if (typeof entry === 'string') {
                ch = (g._mpLetter?.(entry) || g._mpCanonicalById?.[entry] || entry).toUpperCase();
            } else if (entry?.id) {
                ch = (g._mpLetter?.(entry.id) || g._mpCanonicalById?.[entry.id] || entry.letter || '').toUpperCase();
            } else {
                ch = String(entry?.letter || '').toUpperCase();
            }
            if (!/^[A-Z]$/.test(ch)) return;
            counts[ch] = (counts[ch] || 0) + 1;
        };

        let boardTiles = 0;
        if (g._isMultiplayerMode?.() && g._mpOwned) {
            Object.values(g._mpOwned).forEach((list) => {
                (list || []).forEach((t) => {
                    add(t);
                    boardTiles += 1;
                });
            });
        } else {
            (g.tiles || []).forEach((t) => {
                add(t);
                boardTiles += 1;
            });
        }
        const pool = Array.isArray(g._tilePool) ? g._tilePool : [];
        pool.forEach((l) => add(l));

        const mismatches = [];
        const letters = new Set([...Object.keys(bag), ...Object.keys(counts)]);
        letters.forEach((letter) => {
            const got = counts[letter] || 0;
            const want = bag[letter] || 0;
            if (got !== want) mismatches.push({ letter, got, want });
        });

        const actualTotal = Object.values(counts).reduce((sum, c) => sum + c, 0);
        return {
            ok: mismatches.length === 0 && actualTotal === expectedBagTotal,
            bagLabel,
            expectedBagTotal,
            actualTotal,
            boardTiles,
            poolLen: pool.length,
            mismatches: mismatches.slice(0, 8)
        };
    });

    if (dist.actualTotal !== expectedTotal) {
        log.fail(`${label}: tile count must equal bag total ${expectedTotal}, got ${dist.actualTotal}`, { dist });
    }
    if (!dist.ok) {
        log.fail(`${label}: letter distribution must match starting bag`, { dist });
    }
    return dist;
}

async function waitForDictReady(page) {
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        return g?.gameName === 'bananagrams' && !!g?._dictReady && !!g?._checker;
    }, { timeout: TIMEOUT_MS });
}

async function waitForTilesReady(page, minTiles = 21) {
    await page.waitForFunction((min) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.tiles?.length >= min;
    }, minTiles, { timeout: TIMEOUT_MS });
}

async function waitForSolverReady(page) {
    await page.waitForFunction(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        return !!win?.BananaDev?.solveDevCrossword && !!win?.BananaAi?.solveAttemptFromRack;
    }, { timeout: TIMEOUT_MS });
}

async function getSystemLineCount(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('#chat-messages .chat-msg')).length);
}

async function waitForSystemLineContaining(page, needle, previousCount) {
    await page.waitForFunction(({ prev, text }) => {
        const lines = Array.from(document.querySelectorAll('#chat-messages .chat-msg'))
            .map((el) => (el.textContent || '').trim());
        return lines.length > prev && lines.some((t) => t.includes(text));
    }, { prev: previousCount, text: needle }, { timeout: TIMEOUT_MS });
}

async function runChatCommand(page, text) {
    await page.click('body').catch(() => {});
    await page.keyboard.press('t');
    await page.fill('#chat-input', text);
    await page.keyboard.press('Enter');
}

async function readLatestSystemLines(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('#chat-messages .chat-msg'))
        .map((el) => (el.textContent || '').trim()));
}

async function readTimerState(page) {
    return page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const doc = win?.document;
        const timer = doc?.getElementById('banana-timer');
        return {
            gameStarted: !!g?.gameStarted,
            elapsedMs: g?.elapsedMs ?? 0,
            timerText: timer?.textContent?.trim() ?? '',
            hasTimer: !!timer,
            timerArmed: !!(g?._timerRaf || (g?.elapsedMs ?? 0) > 0 || g?._timerStart != null)
        };
    });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {import('../../../shared/infra/test-logger').TestLogger} [log]
 */
async function assertTimerNotStarted(page, label, log = logger) {
    const state = await readTimerState(page);
    if (state.gameStarted || state.elapsedMs > 0 || state.timerArmed) {
        log.fail(`${label}: timer must not be running before board activity`, { state });
    }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {import('../../../shared/infra/test-logger').TestLogger} [log]
 */
async function assertTimerRunningAfterBoardActivity(page, label, log = logger) {
    const before = await readTimerState(page);
    if (!before.gameStarted) log.fail(`${label}: expected gameStarted`, { before });
    if (!before.hasTimer) log.fail(`${label}: expected banana-timer element`, { before });
    if (!before.timerArmed && before.elapsedMs === 0) {
        await page.waitForTimeout(150);
    }
    const after = await readTimerState(page);
    if (!after.gameStarted) log.fail(`${label}: expected gameStarted after wait`, { before, after });
    if (!after.timerArmed && after.elapsedMs === 0) {
        log.fail(`${label}: timer should run after tiles leave starting rack`, { before, after });
    }
    log.success(label, `timer=${after.timerText || 'running'}`);
}

/**
 * @param {import('playwright').Frame} frame
 */
async function resetViaBacktick(frame) {
    await frame.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote', bubbles: true }));
    });
}

/**
 * @param {import('playwright').Page} page
 * @param {number} minTiles
 */
async function waitFaceDownPreSplit(page, minTiles = 21, mpPages = null) {
    await waitForDiag(page, 'face-down pre-SPLIT', ({ min }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g || g.gameStarted || (g.tiles?.length ?? 0) < min) return false;
        const doc = win.document;
        const tiles = [...doc.querySelectorAll('.tile')];
        return tiles.length >= min && tiles.every((t) => t.classList.contains('is-face-down'));
    }, { min: minTiles }, RESET_WAIT_MS, mpPages);
}

/**
 * @param {import('playwright').Frame} frame
 */
async function splitSoloViaDrag(frame) {
    const result = await frame.evaluate(async () => {
        const g = window.game;
        const tile = document.querySelector('.tile');
        if (!tile) return { ok: false, reason: 'no-tile' };
        const r = tile.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        tile.dispatchEvent(mk('pointerdown', cx, cy));
        tile.dispatchEvent(mk('pointermove', cx + 24, cy + 24));
        tile.dispatchEvent(mk('pointerup', cx + 24, cy + 24));
        await new Promise((res) => requestAnimationFrame(res));
        const faceUp = !document.querySelector('.tile')?.classList.contains('is-face-down');
        return { ok: g.gameStarted && faceUp, gameStarted: g.gameStarted, faceUp };
    });
    if (!result.ok) {
        throw new Error(`Solo SPLIT failed (${JSON.stringify(result)})`);
    }
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 */
async function resetAndSplitMp(hostPage, guestPage) {
    const mp = { page1: hostPage, page2: guestPage };
    const resetLog = logger.child({ step: 'MP reset + split' });
    resetLog.step('` reset before solve tests');

    await flushHostBananaInteractions(hostPage);
    const hostFrame = await getGameFrame(hostPage);
    await resetViaBacktick(hostFrame);
    await Promise.all([
        waitFaceDownPreSplit(hostPage, 21, mp),
        waitFaceDownPreSplit(guestPage, 21, mp)
    ]);

    const split = await splitViaDrag(hostFrame, { mobile: false });
    if (!split.ok) {
        throw new Error(`Host SPLIT after reset failed (${JSON.stringify(split)})`);
    }

    await Promise.all([
        waitForDiag(hostPage, 'reset SPLIT host', () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            return g?.gameStarted && !!doc?.getElementById('banana-timer');
        }, undefined, WAIT_MS, mp),
        waitForDiag(guestPage, 'reset SPLIT guest', () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            const tiles = [...(doc?.querySelectorAll('.tile') || [])];
            return g?.gameStarted && tiles.every((t) => !t.classList.contains('is-face-down'));
        }, undefined, WAIT_MS, mp)
    ]);

    await Promise.all([
        assertStartingRackConnected(hostPage, 'post-reset host rack', mp),
        assertStartingRackConnected(guestPage, 'post-reset guest rack', mp)
    ]);
    resetLog.success('` reset + SPLIT', 'both players face-up connected racks');
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 */
async function resetFaceDownWithoutSplitMp(hostPage, guestPage) {
    const mp = { page1: hostPage, page2: guestPage };
    await flushHostBananaInteractions(hostPage);
    const hostFrame = await getGameFrame(hostPage);
    await resetViaBacktick(hostFrame);
    await Promise.all([
        waitFaceDownPreSplit(hostPage, 21, mp),
        waitFaceDownPreSplit(guestPage, 21, mp)
    ]);
}

/**
 * @param {import('playwright').Page} page
 */
async function resetFaceDownWithoutSplitSp(page) {
    const frame = await getGameFrame(page);
    await resetViaBacktick(frame);
    await waitFaceDownPreSplit(page);
}

/**
 * @param {import('playwright').Page} page
 */
async function resetAndSplitSp(page) {
    const resetLog = logger.child({ step: 'SP reset + split' });
    resetLog.step('` reset before solve tests');
    const frame = await getGameFrame(page);
    await resetViaBacktick(frame);
    await waitFaceDownPreSplit(page);
    await splitSoloViaDrag(frame);
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const tiles = [...(doc?.querySelectorAll('.tile') || [])];
        return g?.gameStarted && tiles.every((t) => !t.classList.contains('is-face-down'));
    }, { timeout: TIMEOUT_MS });
    resetLog.success('` reset + SPLIT', 'solo face-up connected rack');
}

/**
 * @param {import('playwright').Frame} frame
 * @param {ReturnType<typeof solveExpectations>} exp
 */
async function readPlayerSolveState(frame, exp) {
    return frame.evaluate((expected) => {
        const g = window.game;
        const grid = window.BananaGrid;
        if (!g || !grid) return { ok: false, reason: 'no-game' };

        const onBoard = (g.tiles || []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
        const { disconnected } = grid.largestComponentTiles(onBoard);
        const islandSizes = grid.boardIslandSizes(onBoard);
        const singleIslands = islandSizes.filter((s) => s === 1).length;
        const stragglers = expected.stragglersPerPlayer;
        const validation = stragglers > 0
            ? grid.validateGridWithStragglers(onBoard, g._checker, stragglers)
            : grid.validateGrid(onBoard, g._checker);

        const domTiles = [...document.querySelectorAll('.tile')];
        const faceUp = domTiles.length > 0 && domTiles.every((t) => !t.classList.contains('is-face-down'));
        const onBoardDom = domTiles.filter((t) => {
            const id = t.dataset?.tileId || t.getAttribute('data-tile-id');
            return onBoard.some((ot) => String(ot.id) === String(id));
        });
        const stragglersFaceUp = stragglers === 0 || onBoardDom.every((t) => !t.classList.contains('is-face-down'));

        let stragglerNearCrossword = true;
        if (stragglers > 0 && onBoard.length > stragglers) {
            const { tiles: mainTiles } = grid.largestComponentTiles(onBoard);
            const mainIds = new Set(mainTiles.map((t) => t.id));
            const stragglerTiles = onBoard.filter((t) => !mainIds.has(t.id));
            const gap = window.BananaRules?.TILE_GAP || 40;
            const mainXs = mainTiles.map((t) => t.x);
            const mainYs = mainTiles.map((t) => t.y);
            const minX = Math.min(...mainXs);
            const maxX = Math.max(...mainXs);
            const minY = Math.min(...mainYs);
            const maxY = Math.max(...mainYs);
            stragglerNearCrossword = stragglerTiles.every((t) => {
                const dx = t.x < minX ? minX - t.x : (t.x > maxX ? t.x - maxX : 0);
                const dy = t.y < minY ? minY - t.y : (t.y > maxY ? t.y - maxY : 0);
                const dist = Math.max(dx, dy);
                return dist >= gap * 3 && dist <= gap * 8;
            });
        }

        return {
            ok: true,
            poolLen: g._tilePool?.length ?? 0,
            owned: g.tiles?.length ?? 0,
            onBoard: onBoard.length,
            crosswordTiles: onBoard.length - disconnected,
            disconnected,
            singleIslands,
            stragglersPerPlayer: stragglers,
            valid: validation.ok,
            validationReason: validation.reason || null,
            connected: disconnected === stragglers,
            faceUp,
            stragglersFaceUp,
            stragglerNearCrossword,
            gameStarted: !!g.gameStarted,
            words: validation.words?.length || 0,
            expected: {
                poolTotal: expected.poolTotal,
                onBoardPerPlayer: expected.onBoardPerPlayer,
                crosswordPerPlayer: expected.crosswordPerPlayer
            }
        };
    }, exp);
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').Frame} frame
 * @param {string} role
 * @param {ReturnType<typeof solveExpectations>} exp
 * @param {import('../../../shared/infra/test-logger').TestLogger} log
 */
async function assertPlayerSolveState(page, frame, role, exp, log) {
    const state = await readPlayerSolveState(frame, exp);
    const snapshot = {
        role,
        exp,
        state,
        chat: (await readLatestSystemLines(page)).slice(-4)
    };

    const fail = (msg, extra = {}) => log.fail(msg, { ...snapshot, ...extra });

    if (!state.ok) fail(`${role}: could not read solve state`);
    if (!state.gameStarted) fail(`${role}: expected game started (face-up after split)`);
    if (!state.faceUp) fail(`${role}: expected all tiles face-up`);
    if (state.poolLen !== exp.poolTotal) {
        fail(`${role}: expected pool=${exp.poolTotal}, got ${state.poolLen}`);
    }
    if (state.onBoard !== exp.onBoardPerPlayer) {
        fail(`${role}: expected ${exp.onBoardPerPlayer} on board, got ${state.onBoard}`);
    }
    if (state.crosswordTiles !== exp.crosswordPerPlayer) {
        fail(`${role}: expected ${exp.crosswordPerPlayer} crossword tiles, got ${state.crosswordTiles}`);
    }
    if (state.disconnected !== exp.stragglersPerPlayer) {
        fail(`${role}: expected ${exp.stragglersPerPlayer} straggler(s), got ${state.disconnected}`);
    }
    if (state.singleIslands !== exp.stragglersPerPlayer) {
        fail(`${role}: expected ${exp.stragglersPerPlayer} single-tile island(s), got ${state.singleIslands}`);
    }
    if (exp.stragglersPerPlayer > 0 && !state.stragglersFaceUp) {
        fail(`${role}: stragglers should be visible (face-up) on board`);
    }
    if (exp.stragglersPerPlayer > 0 && !state.stragglerNearCrossword) {
        fail(`${role}: straggler should sit just outside the crossword (visible, not off-screen)`);
    }
    if (!state.valid) {
        fail(`${role}: board validation failed (${state.validationReason})`);
    }
    if (exp.n === 0 && !state.connected) {
        fail(`${role}: expected fully connected board for n=0`);
    }

    return state;
}

/**
 * @param {import('playwright').Frame} frame
 * @param {ReturnType<typeof solveExpectations>} exp
 */
async function waitForPlayerSolveState(frame, exp, options = {}) {
    const checkPool = options.checkPool !== false;
    await frame.waitForFunction(({ expected, skipPool }) => {
        const g = window.game;
        const grid = window.BananaGrid;
        if (!g || !grid || !g._checker || !g.gameStarted) return false;
        if (!skipPool && (g._tilePool?.length ?? 0) !== expected.poolTotal) return false;

        const onBoard = (g.tiles || []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
        if (onBoard.length !== expected.onBoardPerPlayer) return false;

        const { disconnected } = grid.largestComponentTiles(onBoard);
        if (disconnected !== expected.stragglersPerPlayer) return false;

        const singles = grid.boardIslandSizes(onBoard).filter((s) => s === 1).length;
        if (singles !== expected.stragglersPerPlayer) return false;

        const validation = expected.stragglersPerPlayer > 0
            ? grid.validateGridWithStragglers(onBoard, g._checker, expected.stragglersPerPlayer)
            : grid.validateGrid(onBoard, g._checker);
        if (!validation.ok) return false;

        const domTiles = [...document.querySelectorAll('.tile')];
        return domTiles.length > 0 && domTiles.every((t) => !t.classList.contains('is-face-down'));
    }, { expected: exp, skipPool: !checkPool }, { timeout: TIMEOUT_MS });
}

/**
 * @param {import('playwright').Page} page
 * @param {number} n
 * @param {ReturnType<typeof solveExpectations>} exp
 * @param {import('../../../shared/infra/test-logger').TestLogger} [log]
 * @param {{ skipChat?: boolean }} [options]
 */
async function waitForSolveReceipt(page, expectOk = true) {
    await page.waitForFunction((wantOk) => {
        const r = document.getElementById('game-frame')?.contentWindow?.__lastBoardSolveReceipt;
        return !!r && r.ok === wantOk && Number.isFinite(r.boardSeq);
    }, expectOk, { timeout: TIMEOUT_MS });
    return page.evaluate(() => document.getElementById('game-frame')?.contentWindow?.__lastBoardSolveReceipt);
}

/**
 * @param {import('playwright').Page} page
 * @param {number} n
 * @param {ReturnType<typeof solveExpectations>} exp
 * @param {import('../../../shared/infra/test-logger').TestLogger} [log]
 */
async function runSolveAndAssert(page, n, exp, log = logger) {
    const stepLog = log.child({ step: `/b solve ${n}` });
    stepLog.step(`/b solve ${n}`);

    await flushHostBananaInteractions(page);
    await runChatCommand(page, `/b solve ${n}`);
    let receipt;
    try {
        receipt = await waitForSolveReceipt(page, true);
    } catch (err) {
        const frame = await getGameFrame(page);
        const state = await readPlayerSolveState(frame, exp);
        const failReceipt = await page.evaluate(() => (
            document.getElementById('game-frame')?.contentWindow?.__lastBoardSolveReceipt ?? null
        ));
        stepLog.fail(`Authority receipt missing or not ok for /b solve ${n}`, {
            error: err.message,
            receipt: failReceipt,
            state
        });
    }
    if (receipt.phase !== 'playing') {
        stepLog.fail(`/b solve ${n}: expected phase=playing after commit`, { receipt });
    }

    const frame = await getGameFrame(page);
    try {
        await waitForPlayerSolveState(frame, exp);
    } catch (err) {
        const state = await readPlayerSolveState(frame, exp);
        stepLog.fail(`Board did not reach expected solve state within ${TIMEOUT_MS}ms`, {
            error: err.message,
            exp,
            state
        });
    }

    const state = await assertPlayerSolveState(page, frame, 'command-page', exp, stepLog);
    await assertSolveTileDistribution(frame, exp.totalTiles, stepLog, `/b solve ${n} distribution`);
    await assertTimerRunningAfterBoardActivity(page, `/b solve ${n} timer`, stepLog);
    stepLog.success(
        `/b solve ${n}`,
        `${state.onBoard} on board (${state.crosswordTiles} crossword + ${state.disconnected} straggler), `
        + `pool=${state.poolLen}, ${state.words} words`
    );
    return state;
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 * @param {string} label
 * @param {ReturnType<typeof solveExpectations>} exp
 */
async function assertMpSolveSynced(hostPage, guestPage, label, exp) {
    const hostFrame = await getGameFrame(hostPage);
    const guestFrame = await getGameFrame(guestPage);
    const syncLog = logger.child({ step: label });

    try {
        await waitForPlayerSolveState(hostFrame, exp);
    } catch (err) {
        syncLog.fail(`Host board did not reach valid solve state`, {
            error: err.message,
            host: await readPlayerSolveState(hostFrame, exp),
            guest: await readPlayerSolveState(guestFrame, exp),
            exp
        });
    }

    try {
        await waitForPlayerSolveState(guestFrame, exp, { checkPool: false });
    } catch (err) {
        syncLog.fail(`Guest board did not sync to valid solve state`, {
            error: err.message,
            host: await readPlayerSolveState(hostFrame, exp),
            guest: await readPlayerSolveState(guestFrame, exp),
            exp
        });
    }

    await syncGuestPoolFromHost(hostPage, guestPage);
    await guestPage.evaluate((n) => {
        const doc = document.getElementById('game-frame')?.contentDocument;
        const hud = doc?.getElementById('banana-pool-count');
        if (hud) hud.textContent = String(n);
    }, exp.poolTotal);
    await waitPoolBoth(hostPage, guestPage, exp.poolTotal);

    const hostState = await assertPlayerSolveState(hostPage, hostFrame, 'host', exp, syncLog);
    const guestState = await assertPlayerSolveState(guestPage, guestFrame, 'guest', exp, syncLog);
    await assertTimerRunningAfterBoardActivity(hostPage, `${label} host timer`, syncLog);
    await assertTimerRunningAfterBoardActivity(guestPage, `${label} guest timer`, syncLog);
    await assertSolveTileDistribution(hostFrame, exp.totalTiles, syncLog, `${label} distribution`);

    syncLog.success(
        label,
        `host+guest pool=${exp.poolTotal}, `
        + `${exp.crosswordPerPlayer} crossword + ${exp.stragglersPerPlayer} straggler each`
    );
    return { host: hostState, guest: guestState };
}

/**
 * @param {import('playwright').Page} page
 * @param {number} n
 * @param {import('../../../shared/infra/test-logger').TestLogger} log
 */
async function runSolveExpectBlocked(page, n, log = logger) {
    const stepLog = log.child({ step: `/b solve ${n} blocked` });
    await runChatCommand(page, `/b solve ${n}`);
    const receipt = await waitForSolveReceipt(page, false);
    if (!String(receipt.message || '').includes(POST_WIN_SOLVE_BLOCK)) {
        stepLog.fail(`/b solve ${n}: expected block message`, { receipt });
    }
    if (receipt.phase === 'playing') {
        stepLog.fail(`/b solve ${n}: blocked solve should not report phase=playing`, { receipt });
    }
    stepLog.success(`/b solve ${n}`, `rejected (${receipt.phase})`);
}

/**
 * Win → block solve in review → Done → consecutive solves without reset.
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 */
async function runPostWinConsecutiveSolveTests(hostPage, guestPage) {
    const mpLog = logger.child({ step: 'post-win /b solve' });
    const hostFrame = await getGameFrame(hostPage);
    const guestFrame = await getGameFrame(guestPage);

    mpLog.step('Dev win → /b solve blocked in review');
    await flushHostBananaInteractions(hostPage);
    const won = await hostFrame.evaluate(() => game._hostDevWinForPlayer(game._myUid()));
    if (!won) mpLog.fail('Host dev win failed');
    await flushHostBananaInteractions(hostPage);
    await waitMpClientsInReview([hostFrame, guestFrame], 'post-win review', RESET_WAIT_MS, [hostPage, guestPage], hostFrame);

    await runSolveExpectBlocked(hostPage, 0, mpLog);
    await runSolveExpectBlocked(hostPage, 2, mpLog);

    mpLog.step('Host Done → consecutive /b solve 0 then 2 (no reset between)');
    await clickDone(hostFrame);
    await Promise.all([
        waitMpResetAfterDone(hostFrame, 'post-win host', RESET_WAIT_MS),
        waitMpResetAfterDone(guestFrame, 'post-win guest', RESET_WAIT_MS)
    ]);

    const exp0 = solveExpectations(0, 2, BUNCH);
    const exp2 = solveExpectations(2, 2, BUNCH);
    await runSolveAndAssert(hostPage, 0, exp0, mpLog);
    await runSolveAndAssert(hostPage, 2, exp2, mpLog);
    mpLog.success('post-win consecutive solves', 'blocked in review, both succeed after Done');
}

/**
 * @param {import('playwright').Page} page
 */
async function runSpBoardSolveScenarios(page) {
    const spLog = logger.child({ gameMode: 'solo' });
    page.setDefaultTimeout(TIMEOUT_MS);
    await page.evaluate(() => {
        if (typeof setGame === 'function') setGame('bananagrams');
    });
    await waitForDictReady(page);
    await waitForTilesReady(page);
    await waitForSolverReady(page);

    const totalTiles = await page.evaluate(() => {
        const rules = document.getElementById('game-frame')?.contentWindow?.BananaRules;
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const mode = g?._tileBagMode?.() || 'solo';
        const cfg = g?._bagConfig?.() || { soloVariant: 'fast' };
        const bag = rules.getTileBag(mode, cfg);
        return rules.poolTotal(bag);
    });

    const exp0 = solveExpectations(0, 1, totalTiles);
    spLog.step('SP /b solve from pre-SPLIT rack starts timer');
    await assertTimerNotStarted(page, 'pre-SPLIT solo', spLog);
    await runSolveAndAssert(page, 0, exp0, spLog);
    await assertTimerRunningAfterBoardActivity(page, 'pre-SPLIT solo timer', spLog);

    await resetAndSplitSp(page);
    spLog.step('SP /b solve 0 after SPLIT');
    await runSolveAndAssert(page, 0, exp0, spLog);

    await resetAndSplitSp(page);
    const exp3 = solveExpectations(3, 1, totalTiles);
    await runSolveAndAssert(page, 3, exp3, spLog);
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 */
async function runMpBoardSolveScenarios(hostPage, guestPage) {
    const mpLog = logger.child({ gameMode: 'multiplayer' });
    hostPage.setDefaultTimeout(TIMEOUT_MS);
    guestPage.setDefaultTimeout(TIMEOUT_MS);

    mpLog.step('MP guest cannot run /b solve');
    let lines = await getSystemLineCount(guestPage);
    await runChatCommand(guestPage, '/b solve 0');
    await waitForSystemLineContaining(guestPage, 'Only the host', lines);
    mpLog.success('MP guest rejected /b solve');

    mpLog.step('MP /b solve 2 from pre-SPLIT rack — bunch=2, stragglers + timer on both clients');
    await resetFaceDownWithoutSplitMp(hostPage, guestPage);
    await assertTimerNotStarted(hostPage, 'pre-SPLIT solve 2 host', mpLog);
    await assertTimerNotStarted(guestPage, 'pre-SPLIT solve 2 guest', mpLog);
    const expPre2 = solveExpectations(2, 2, BUNCH);
    await runSolveAndAssert(hostPage, 2, expPre2, mpLog);
    await assertMpSolveSynced(hostPage, guestPage, 'MP /b solve 2 pre-SPLIT sync', expPre2);

    await resetAndSplitMp(hostPage, guestPage);

    const exp0 = solveExpectations(0, 2, BUNCH);
    mpLog.step(`MP host /b solve 0 — full bag, bunch=0 (${exp0.crosswordPerPlayer} crossword each)`);
    await runSolveAndAssert(hostPage, 0, exp0, mpLog);
    await assertMpSolveSynced(hostPage, guestPage, 'MP /b solve 0 sync', exp0);

    await resetAndSplitMp(hostPage, guestPage);

    const exp2 = solveExpectations(2, 2, BUNCH);
    mpLog.step(
        `MP host /b solve 2 — bunch=2 total, 1 straggler each `
        + `(${exp2.crosswordPerPlayer} crossword each)`
    );
    await runSolveAndAssert(hostPage, 2, exp2, mpLog);
    await assertMpSolveSynced(hostPage, guestPage, 'MP /b solve 2 sync', exp2);

    await resetAndSplitMp(hostPage, guestPage);

    const exp6 = solveExpectations(6, 2, BUNCH);
    mpLog.step(
        `MP host /b solve 6 — bunch=6 total, 1 straggler each `
        + `(${exp6.crosswordPerPlayer} crossword each)`
    );
    await runSolveAndAssert(hostPage, 6, exp6, mpLog);
    await assertMpSolveSynced(hostPage, guestPage, 'MP /b solve 6 sync', exp6);

    await runPostWinConsecutiveSolveTests(hostPage, guestPage);
}

module.exports = {
    runSpBoardSolveScenarios,
    runMpBoardSolveScenarios,
    runPostWinConsecutiveSolveTests,
    runSolveExpectBlocked,
    runSolveAndAssert,
    assertMpSolveSynced,
    waitForSolveReceipt,
    POST_WIN_SOLVE_BLOCK,
    solveExpectations,
    readPlayerSolveState,
    waitForPlayerSolveState,
    runChatCommand,
    waitForSystemLineContaining,
    resetAndSplitMp,
    resetAndSplitSp,
    resetFaceDownWithoutSplitMp,
    resetFaceDownWithoutSplitSp,
    assertTimerNotStarted,
    assertTimerRunningAfterBoardActivity,
    readTimerState
};
