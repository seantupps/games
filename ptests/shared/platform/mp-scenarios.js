/**
 * Reusable MP audit scenarios — compose from registry capabilities, not game ids.
 */
const { STEP_MS } = require('../infra/timeouts');
const { evalGame } = require('./game-harness');
const { runScenario } = require('./scenario-runner');
const { capsFor } = require('./capability-audit');

async function readPilesCounts(page) {
    return evalGame(page, () => {
        const piles = window.game.piles;
        return {
            pileKeys: Object.keys(piles),
            bCount: (piles.B || []).length,
            rCount: (piles.R || []).length,
            gCount: (piles.G || []).length
        };
    });
}

/**
 * Host/guest pile counts match (boardKind piles).
 */
async function assertPilesBoardSync(page1, page2, ctx = {}) {
    const { caps } = capsFor('piles', ctx);
    if (caps.boardKind !== 'piles') {
        throw new Error('assertPilesBoardSync requires boardKind piles');
    }
    await runScenario('MP piles board sync', async () => {
        const p1 = await readPilesCounts(page1);
        await page2.waitForFunction(
            ({ b, r, g }) => {
                const piles = document.getElementById('game-frame')?.contentWindow?.game?.piles;
                if (!piles) return false;
                return (piles.B || []).length === b
                    && (piles.R || []).length === r
                    && (piles.G || []).length === g;
            },
            { b: p1.bCount, r: p1.rCount, g: p1.gCount },
            { timeout: STEP_MS }
        );
        const p2 = await readPilesCounts(page2);
        if (p1.pileKeys.length !== p2.pileKeys.length) {
            throw new Error('Unexpected pile key count between clients');
        }
        if (p1.bCount !== p2.bCount || p1.rCount !== p2.rCount || p1.gCount !== p2.gCount) {
            throw new Error('Pile counts mismatch between host and guest');
        }
    });
}

/**
 * P1 selects a pile piece; P2 sees selected-opponent, then clear.
 */
async function assertPilesSelectionSync(page1, page2, { pieceId = '#B-0' } = {}) {
    await runScenario('MP piles selection sync', async () => {
        const { ensureHubSettingsClosed } = require('../../platform/mobile/lib/mobile_assertions');
        await Promise.all([ensureHubSettingsClosed(page1), ensureHubSettingsClosed(page2)]);

        const p1Frame = page1.frameLocator('#game-frame');
        const p2Frame = page2.frameLocator('#game-frame');
        await p1Frame.locator(pieceId).click();
        const p1Selected = await p1Frame.locator(pieceId).evaluate((el) => el.classList.contains('selected'));
        if (!p1Selected) throw new Error(`P1 did not select ${pieceId}`);
        await p2Frame.locator(pieceId).waitFor({ state: 'attached' });
        await page2.waitForFunction((sel) => {
            const el = document.getElementById('game-frame')?.contentWindow?.document?.querySelector(sel);
            return el && el.classList.contains('selected-opponent');
        }, pieceId, { timeout: STEP_MS });
        await p1Frame.locator(pieceId).click();
        await page2.waitForFunction((sel) => {
            const el = document.getElementById('game-frame')?.contentWindow?.document?.querySelector(sel);
            return el && !el.classList.contains('selected-opponent');
        }, pieceId, { timeout: STEP_MS });
    });
}

function boardSnapshotFn(boardKind) {
    if (boardKind === 'piles') {
        return () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g?.piles) return null;
            return JSON.stringify(g.piles);
        };
    }
    if (boardKind === 'line') {
        return () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g) return null;
            return JSON.stringify({
                path: (g.path || []).slice(),
                nodeCount: g.nodes?.length ?? 0
            });
        };
    }
    return () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g ? JSON.stringify({ turn: g.turn, events: g.gameEvents?.length ?? 0 }) : null;
    };
}

async function waitMpRoleReady(page, role, ctx = {}) {
    const attempts = ctx.isMobile ? 3 : 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            await page.waitForFunction((r) => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                return g && g.isMultiplayer && g.playerRole === r && g._eventsLoaded;
            }, role, { timeout: STEP_MS });
            return await page.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                return g ? { turn: g.turn, playerRole: g.playerRole } : null;
            });
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await page.waitForTimeout(200);
        }
    }
    throw lastErr;
}

/**
 * Submit host move, refresh both clients, turn stays on guest.
 */
async function assertRefreshPreservesTurn(page1, page2, ctx = {}) {
    const { caps } = capsFor(ctx.gameId || 'piles', ctx);
    if (!caps.supportsTurnIndicator || caps.syncStyle !== 'hybrid') return;

    const boardKind = caps.boardKind || 'generic';
    const snapFn = boardSnapshotFn(boardKind);

    await runScenario('MP refresh preserves turn', async () => {
        const s1 = await waitMpRoleReady(page1, 'P1', ctx);
        const s2 = await waitMpRoleReady(page2, 'P2', ctx);
        if (s1.turn !== 'P1' || s2.turn !== 'P1') {
            throw new Error(`Expected initial turn P1, got P1=${s1.turn} P2=${s2.turn}`);
        }

        await page1.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const moves = g.getValidMoves();
            if (moves.length) g.submitMove(moves[0]);
        });

        await page1.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g && g.turn === 'P2';
        }, { timeout: STEP_MS });
        await page2.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g && g.turn === 'P2';
        }, { timeout: STEP_MS });

        const snapAfter = await Promise.all([page1, page2].map((p) => p.evaluate(snapFn)));
        if (snapAfter[0] !== snapAfter[1]) {
            throw new Error('Board mismatch after first host move');
        }

        for (const [page, role, label] of [[page1, 'P1', 'Host'], [page2, 'P2', 'Guest']]) {
            await page.reload();
            const after = await waitMpRoleReady(page, role, ctx);
            const otherTurn = await (page === page1 ? page2 : page1).evaluate(() => {
                return document.getElementById('game-frame')?.contentWindow?.game?.turn;
            });
            if (after.turn !== 'P2' || otherTurn !== 'P2') {
                throw new Error(`Turn not preserved after ${label} refresh`);
            }
        }
    });
}

/**
 * Line drag from node A→B with opponent preview (supportsRealtimePreviews).
 * Desktop only; mobile uses line-drag-utils in game file.
 */
async function assertLineDragPreviewSync(page1, page2, { fromId = '1', toId = '5' } = {}) {
    const {
        waitForOpponentPreviewLine,
        waitForOpponentPreviewGone
    } = require('../../platform/mobile/lib/mobile-waits');
    const { assertDragPreviewAtHalfway } = require('../../games/line/desktop-line-drag-utils');

    await runScenario('MP line drag preview sync', async () => {
        const fl = page1.frameLocator('#game-frame');
        const b1 = await fl.locator(`.node[data-id="${fromId}"]`).boundingBox();
        const b5 = await fl.locator(`.node[data-id="${toId}"]`).boundingBox();
        if (!b1 || !b5) throw new Error(`Nodes ${fromId}/${toId} not found`);

        const n1 = { x: b1.x + b1.width / 2, y: b1.y + b1.height / 2 };
        const n5 = { x: b5.x + b5.width / 2, y: b5.y + b5.height / 2 };
        const mid = { x: (n1.x + n5.x) / 2, y: (n1.y + n5.y) / 2 };

        await page1.mouse.move(n1.x, n1.y);
        await page1.mouse.down();
        await page1.mouse.move(mid.x, mid.y, { steps: 4 });
        await assertDragPreviewAtHalfway(page1);
        await waitForOpponentPreviewLine(page2, STEP_MS);
        await page1.mouse.move(n5.x, n5.y, { steps: 4 });
        await page1.mouse.up();
        await waitForOpponentPreviewGone(page2, STEP_MS);

        await page1.evaluate(({ a, b }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g || g.path?.length > 0) return;
            const moves = g.getValidMoves?.() || [];
            const m = moves.find((mv) => mv.a == a && mv.b == b) || moves[0];
            if (m && typeof g.makeMove === 'function') g.makeMove(m.a, m.b);
            g.rebuildState?.();
        }, { a: Number(fromId), b: Number(toId) });

        await page2.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g && g.path && g.path.length > 0;
        }, { timeout: STEP_MS });
    });
}

function normalizeColor(c) {
    if (!c) return null;
    c = c.replace(/\s/g, '').toLowerCase();
    if (c.startsWith('#')) {
        const r = parseInt(c.slice(1, 3), 16);
        const g = parseInt(c.slice(3, 5), 16);
        const b = parseInt(c.slice(5, 7), 16);
        return `rgb(${r},${g},${b})`;
    }
    return c;
}

/** After drag sync — scoreboard + line stroke colors match theme (line game). */
async function assertLineColorConsistency(page1, page2) {
    await runScenario('MP line color consistency', async () => {
        const themeColor = await page1.evaluate(() => {
            const hubTheme = getComputedStyle(document.documentElement)
                .getPropertyValue('--theme-color').trim();
            const frameRoot = document.getElementById('game-frame')?.contentDocument?.documentElement;
            const iframeTheme = frameRoot
                ? getComputedStyle(frameRoot).getPropertyValue('--theme-color').trim()
                : '';
            return iframeTheme || hubTheme;
        });
        const expected = normalizeColor(themeColor);

        const colorResults = await page1.evaluate(() => {
            const frame = document.getElementById('game-frame');
            const gameDoc = frame.contentWindow.document;
            const scoreUser = gameDoc.querySelector('.score-user');
            const scoreColor = scoreUser ? getComputedStyle(scoreUser).color : null;
            const line = gameDoc.querySelector('line.mine:not(.preview)');
            const lineStroke = line ? getComputedStyle(line).stroke : null;
            const pathLen = frame.contentWindow.game?.path?.length ?? 0;
            return { scoreColor, lineStroke, pathLen };
        });

        const scoreNorm = normalizeColor(colorResults.scoreColor);
        const lineNorm = normalizeColor(colorResults.lineStroke);
        if (scoreNorm !== expected) {
            throw new Error(`Scoreboard color mismatch on P1 (theme=${expected}, score=${scoreNorm})`);
        }
        if (colorResults.pathLen > 0 && lineNorm && lineNorm !== scoreNorm) {
            throw new Error(`Own line color mismatch on P1 (score=${scoreNorm}, line=${lineNorm})`);
        }

        const oppStroke = await page2.evaluate(() => {
            const gameDoc = document.getElementById('game-frame')?.contentWindow?.document;
            const line = gameDoc?.querySelector('line.opponent:not(.preview)');
            return line ? getComputedStyle(line).stroke : null;
        });
        const oppTheme = await page2.evaluate(() => {
            const hubOpp = getComputedStyle(document.documentElement)
                .getPropertyValue('--opponent-color').trim();
            const frameRoot = document.getElementById('game-frame')?.contentDocument?.documentElement;
            const iframeOpp = frameRoot
                ? getComputedStyle(frameRoot).getPropertyValue('--opponent-color').trim()
                : '';
            return iframeOpp || hubOpp;
        });
        if (normalizeColor(oppStroke) !== normalizeColor(oppTheme)) {
            throw new Error(`Opponent line color mismatch on P2 (stroke=${oppStroke}, theme=${oppTheme})`);
        }
    });
}

function mobilePagesFromCtx(page1, page2, ctx) {
    const slots = [page1, page2];
    const flags = ctx.isMobileSlot;
    if (Array.isArray(flags) && flags.length) {
        return slots.filter((_, i) => flags[i]);
    }
    if (ctx.anyMobile || ctx.isMobile) return slots;
    return [];
}

async function pageHasMyTurn(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return !!(g?.isMyTurn?.());
    });
}

/** Pick a mobile client that can act on the current turn (passes turn first in mixed topology). */
async function resolveMobilePageForPilesLongPress(page1, page2, ctx) {
    const candidates = mobilePagesFromCtx(page1, page2, ctx);
    if (!candidates.length) return page2;

    for (const page of candidates) {
        if (await pageHasMyTurn(page)) return page;
    }

    const active = (await pageHasMyTurn(page1)) ? page1
        : ((await pageHasMyTurn(page2)) ? page2 : null);
    if (active && !candidates.includes(active)) {
        await active.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const moves = g?.getValidMoves?.() || [];
            if (moves.length) g.submitMove(moves[0]);
        });
        const nextTurnPage = active === page1 ? page2 : page1;
        await nextTurnPage.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.isMyTurn?.();
        }, { timeout: STEP_MS });
    }

    for (const page of candidates) {
        if (await pageHasMyTurn(page)) return page;
    }
    throw new Error('Long-press: no mobile client has the active turn');
}

/**
 * Run MP scenarios implied by GameRegistry capabilities (not game id branches in game files).
 * @param {string} gameId
 * @param {import('playwright').Page} page1
 * @param {import('playwright').Page} page2
 * @param {object} ctx
 * @param {object} [options]
 */
async function runCapabilityMpScenarios(gameId, page1, page2, ctx = {}, options = {}) {
    const { capabilityMpBeforeLoop } = require('./capability-audit');
    const { runRegistryMobileMpExtras } = require('../infra/mp-player-utils');
    const {
        skipPilesSync = false,
        skipPilesSelection = false,
        skipRefresh = false,
        skipLineDrag = false,
        runMobileExtras = true
    } = options;

    const merged = { ...ctx, gameId, gameMode: options.gameMode || ctx.gameMode };
    const { caps } = capsFor(gameId, merged);

    const lineMobileOnly = caps.supportsRealtimePreviews && caps.boardKind === 'line' && !skipLineDrag
        && (merged.anyMobile || merged.isMobileSlot?.some(Boolean));

    if (!lineMobileOnly) {
        await capabilityMpBeforeLoop(page1, page2, gameId, merged);
    }

    const { assertResetEpochSynced } = require('./mp-reset-audit');
    await assertResetEpochSynced(page1, page2, merged);

    if (caps.boardKind === 'piles' && !skipPilesSync) {
        await assertPilesBoardSync(page1, page2, merged);
    }
    if (caps.boardKind === 'piles' && caps.supportsTurnIndicator && !skipPilesSelection
        && merged.gameMode === 'classic') {
        await assertPilesSelectionSync(page1, page2);
    }
    if (caps.syncStyle === 'hybrid' && caps.supportsTurnIndicator && !skipRefresh
        && merged.gameMode === 'classic' && caps.boardKind === 'piles') {
        await assertRefreshPreservesTurn(page1, page2, merged);
    }
    if (caps.supportsRealtimePreviews && caps.boardKind === 'line' && !skipLineDrag) {
        if (merged.anyMobile || merged.isMobileSlot?.some(Boolean)) {
            const { lineMobileDrag } = require('../../games/line/desktop-mp');
            await capabilityMpBeforeLoop(page1, page2, gameId, merged);
            await lineMobileDrag(page1, page2, merged);
        } else {
            await assertLineDragPreviewSync(page1, page2);
        }
    }

    if (runMobileExtras && (merged.anyMobile || merged.isMobile)) {
        if (caps.boardKind === 'piles' && merged.gameMode === 'classic') {
            const { assertPilesLongPressEndTurn } = require('../../platform/mobile/lib/mobile_assertions');
            const mobilePage = await resolveMobilePageForPilesLongPress(page1, page2, merged);
            await assertPilesLongPressEndTurn(mobilePage);
        }
        await runRegistryMobileMpExtras(page1, page2, gameId, merged);
    }
}

module.exports = {
    assertPilesBoardSync,
    assertPilesSelectionSync,
    assertRefreshPreservesTurn,
    assertLineDragPreviewSync,
    assertLineColorConsistency,
    runCapabilityMpScenarios,
    readPilesCounts,
    boardSnapshotFn,
    waitMpRoleReady,
    normalizeColor
};
