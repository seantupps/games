/**
 * MP rematch / resetCount audits — required for all multiplayer games.
 * Catches stale event batches and epoch drift after victory auto-reset.
 */
const { STEP_MS } = require('../infra/timeouts');
const { runScenario } = require('../infra/scenario-runner');
const GameRegistry = require('../../../shared/games/registry');

function readResetEpoch(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData || window.NetworkEngine?.roomData;
        const resetCount = room?.global?.resetCount ?? room?.meta?.resetCount ?? null;
        const boardSeq = room?.global?.board?.seq ?? room?.state?.board?.seq ?? null;
        return {
            resetCount,
            boardSeq,
            isOver: !!g?.isOver,
            eventsLen: Array.isArray(g?.gameEvents) ? g.gameEvents.length : null,
            role: g?.playerRole || null
        };
    });
}

/**
 * Both clients agree on resetCount at MP join (before move loop).
 */
async function assertResetEpochSynced(page1, page2, ctx = {}) {
    await runScenario('MP resetCount synced at join', async () => {
        const [p1, p2] = await Promise.all([readResetEpoch(page1), readResetEpoch(page2)]);
        if (p1.resetCount == null || p2.resetCount == null) {
            throw new Error(`resetCount missing at join: P1=${JSON.stringify(p1)} P2=${JSON.stringify(p2)}`);
        }
        if (p1.resetCount !== p2.resetCount) {
            throw new Error(`resetCount mismatch at join: P1=${p1.resetCount} P2=${p2.resetCount}`);
        }
        if (p1.isOver || p2.isOver) {
            throw new Error(`Expected fresh game at join, isOver P1=${p1.isOver} P2=${p2.isOver}`);
        }
        ctx.baselineResetCount = p1.resetCount;
    });
}

/**
 * After victory auto-reset: resetCount advanced, both clients agree, game live.
 * @param {number} baselineResetCount — from assertResetEpochSynced or room start
 */
async function assertRematchResetEpoch(page1, page2, ctx = {}) {
    const baseline = ctx.baselineResetCount ?? 1;
    const syncMs = ctx.resetSyncMs ?? Math.max(STEP_MS, 5000);
    const { gameId, gameMode } = ctx;
    const caps = gameId
        ? GameRegistry.getCapabilities(gameId, gameMode || GameRegistry.defaultModeFor(gameId))
        : {};

    await runScenario('MP rematch resetCount advanced', async () => {
        const deadline = Date.now() + syncMs;
        let p1;
        let p2;
        while (Date.now() < deadline) {
            [p1, p2] = await Promise.all([readResetEpoch(page1), readResetEpoch(page2)]);
            if (
                p1.resetCount != null
                && p1.resetCount === p2.resetCount
                && p1.resetCount > baseline
                && !p1.isOver
                && !p2.isOver
            ) {
                break;
            }
            await page1.waitForTimeout(100);
        }

        if (!p1 || !p2) {
            throw new Error('Could not read reset epoch after rematch');
        }
        if (p1.resetCount !== p2.resetCount) {
            throw new Error(
                `resetCount mismatch after rematch: P1=${p1.resetCount} P2=${p2.resetCount} (baseline=${baseline})`
            );
        }
        if (p1.resetCount <= baseline) {
            throw new Error(
                `resetCount did not advance after rematch: ${p1.resetCount} (baseline=${baseline})`
            );
        }
        if (p1.isOver || p2.isOver) {
            throw new Error(`Game still isOver after rematch: P1=${p1.isOver} P2=${p2.isOver}`);
        }

        if (caps.syncStyle === 'hybrid' || caps.syncStyle === 'event-log') {
            const staleEvents = await page1.evaluate((round) => {
                const events = document.getElementById('game-frame')?.contentWindow?.game?.gameEvents || [];
                return events.filter((ev) => Number(ev.resetCount ?? round) !== round).length;
            }, p1.resetCount);
            if (staleEvents > 0) {
                throw new Error(`${staleEvents} event(s) tagged with stale resetCount after rematch`);
            }
        }

        if (caps.mpBoardAuthoritative) {
            const boardOk = await page1.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const board = g?.roomData?.global?.board;
                return !!(board && board.version >= 2);
            });
            if (!boardOk) {
                throw new Error('Expected board.version >= 2 after board-authoritative rematch');
            }
        }
    });
}

module.exports = {
    readResetEpoch,
    assertResetEpochSynced,
    assertRematchResetEpoch
};
