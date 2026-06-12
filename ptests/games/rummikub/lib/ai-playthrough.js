/**
 * Rummikub SP AI playthrough — one rack tile per step through snap commit + win.
 */
const { getGameFrame } = require('../../../shared/adapters/desktop-input');
const { TIMEOUT_MS } = require('../../../shared/adapters/chat-commands');
const { createTestLogger } = require('../../../shared/infra/test-logger');
const { delayBetweenActions, playwrightSlowMo } = require('../../../shared/infra/env-defaults');
const { assertSpatialMatchesKnownSolution } = require('../assertions/win-verify');
const { waitForRummikubReady, EXPECTED_TILES } = require('./session');
const {
    snapshotRummikubState,
    captureRichPlaythroughFailure
} = require('./ai-snapshot');
const {
    formatPlaythroughFailureLines,
    packPlaythroughFailure
} = require('./format-failure');

const AI_BROWSER_BUNDLE = String.raw`() => {
    const COLORS = ['B', 'R', 'U', 'O'];
    const APPROACH_PX = 8;

    function tileBrief(g, t) {
        const WL = window.RummikubWinLog;
        return WL?.tileBrief ? WL.tileBrief(g._coreTile(t)) : (t?.id || '?');
    }

    function sortMeldTiles(meld) {
        const tiles = [...(meld.tiles || [])];
        if (meld.kind === 'run') {
            return tiles.sort((a, b) => {
                const av = a.kind === 'joker' ? -1 : a.value;
                const bv = b.kind === 'joker' ? -1 : b.value;
                return av - bv;
            });
        }
        return tiles.sort((a, b) => {
            const ac = a.kind === 'joker' ? 'Z' : a.color;
            const bc = b.kind === 'joker' ? 'Z' : b.color;
            return COLORS.indexOf(ac) - COLORS.indexOf(bc);
        });
    }

    function poolMatchesMelds(pool, melds) {
        const poolIds = new Set(pool.map((t) => t.id));
        const meldTiles = (melds || []).flatMap((m) => m.tiles);
        if (meldTiles.length !== pool.length) return false;
        return meldTiles.every((t) => poolIds.has(t.id));
    }

    function solveMelds(g) {
        const Core = RummikubCore;
        const pool = (g.tiles || []).map((t) => {
            const c = g._coreTile(t);
            return { ...c, id: t.id };
        });
        const deadline = Date.now() + (RummikubRules.WIN_VERIFY_DEADLINE_MS || 5000);
        const originalMelds = g._originalMelds;

        if (originalMelds?.length && poolMatchesMelds(pool, originalMelds)) {
            return { ok: true, melds: originalMelds, attempts: 0, method: 'original-melds' };
        }

        if (typeof Core.verifyBoardPartition === 'function') {
            const verified = Core.verifyBoardPartition(pool, deadline);
            if (verified.solved) {
                return {
                    ok: true,
                    melds: verified.result.melds,
                    attempts: verified.partitionAttempts,
                    method: verified.method
                };
            }
        }

        const seeds = [g._puzzleSeed, 0, 1, 7, 13, 42].filter((s) => s != null);
        for (const seed of seeds) {
            const rng = Core.makeRng(seed >>> 0);
            const { result, attempts } = Core.partitionBoardTiles(pool, rng, Date.now() + 1200, {
                originalMelds
            });
            if (Core.partitionIsSolved(result)) {
                return { ok: true, melds: result.melds, attempts, method: 'partition-seed' };
            }
        }

        return {
            ok: false,
            reason: 'partition-unsolved',
            remaining: pool.length
        };
    }

    function meldKey(meld, idx) {
        const head = sortMeldTiles(meld)[0];
        const tag = head?.kind === 'joker'
            ? 'J'
            : (head?.color || '?') + (head?.value ?? '?');
        return idx + ':' + meld.kind + ':' + tag;
    }

    /** Step-1 layout: meldsToGrid → world coords (reverse target for each tile). */
    function buildTargetLayout(g, melds) {
        const Core = RummikubCore;
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const grid = Core.meldsToGrid(melds);
        const layout = RummikubGrid.tilesFromCoreGrid(grid, origin);
        const out = {};
        layout.forEach((t) => {
            out[t.id] = { x: t.x, y: t.y, gx: t.gridX, gy: t.gridY };
        });
        return out;
    }

    function getTarget(targets, id) {
        return targets ? targets[id] : null;
    }

    function sideFromTargets(anchorPos, tilePos) {
        const dx = tilePos.x - anchorPos.x;
        const dy = tilePos.y - anchorPos.y;
        if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
        return dy >= 0 ? 'down' : 'up';
    }

    /** Move tiles to step-1 coords; skip rack tiles not yet placed this playthrough. */
    function alignSolvedExceptRack(g, targets, skipRackIds) {
        const skip = skipRackIds || new Set();
        let moved = false;
        (g.tiles || []).forEach((t) => {
            if (skip.has(t.id)) return;
            const tgt = getTarget(targets, t.id);
            if (!tgt) return;
            if (t.zone === 'table' && t.x === tgt.x && t.y === tgt.y
                && t.gridX === tgt.gx && t.gridY === tgt.gy) return;
            t.x = tgt.x;
            t.y = tgt.y;
            t.zone = 'table';
            t.gridX = tgt.gx;
            t.gridY = tgt.gy;
            moved = true;
        });
        if (moved) {
            g._syncTableTileElements?.();
            g.requestRender?.();
        }
        return moved;
    }

    function rackIdsFromPlan(plan) {
        return new Set((plan || []).map((p) => p.tileId));
    }

    function remainingRackIds(plan, fromIndex) {
        const out = new Set();
        for (let i = fromIndex; i < (plan || []).length; i++) {
            out.add(plan[i].tileId);
        }
        return out;
    }

    /**
     * Reverse step-2 peel: one rack tile per move, anchored to in-meld neighbors at step-1 positions.
     */
    function plansForMeldReverse(meld, meldIdx, rackIds, tableById, targets) {
        const ordered = sortMeldTiles(meld);
        const rackInMeld = ordered.filter((t) => rackIds.has(t.id));
        if (!rackInMeld.length) return [];

        const idList = ordered.map((t) => t.id);
        const key = meldKey(meld, meldIdx);
        const placed = new Set([...tableById.keys()]);
        const plans = [];

        rackInMeld.forEach((tile) => {
            const ti = ordered.findIndex((t) => t.id === tile.id);
            const target = getTarget(targets, tile.id);
            if (!target) return;

            let anchorId = null;
            let side = null;
            for (let i = ti - 1; i >= 0; i--) {
                if (placed.has(ordered[i].id)) {
                    anchorId = ordered[i].id;
                    side = sideFromTargets(getTarget(targets, anchorId), target);
                    break;
                }
            }
            if (!anchorId) {
                for (let i = ti + 1; i < ordered.length; i++) {
                    if (placed.has(ordered[i].id)) {
                        anchorId = ordered[i].id;
                        side = sideFromTargets(getTarget(targets, anchorId), target);
                        break;
                    }
                }
            }

            if (anchorId && side) {
                plans.push({
                    tileId: tile.id,
                    anchorId,
                    side,
                    meldKind: meld.kind,
                    meldKey: key,
                    meldTileIds: idList,
                    targetX: target.x,
                    targetY: target.y
                });
            } else {
                plans.push({
                    tileId: tile.id,
                    anchorId: null,
                    side: null,
                    meldKind: meld.kind,
                    meldKey: key,
                    meldTileIds: idList,
                    isolated: true,
                    targetX: target.x,
                    targetY: target.y
                });
            }
            placed.add(tile.id);
        });
        return plans;
    }

    function buildReversePlan(g, originalMelds) {
        const tableById = new Map();
        const rackIds = new Set();
        for (const t of g.tiles || []) {
            if (t.zone === 'table') tableById.set(t.id, t);
            else if (t.zone === 'rack') rackIds.add(t.id);
        }
        const targets = buildTargetLayout(g, originalMelds);
        const all = [];
        originalMelds.forEach((meld, idx) => {
            all.push(...plansForMeldReverse(meld, idx, rackIds, tableById, targets));
        });
        return { plan: orderPlans(all, tableById), targets };
    }

    function orderPlans(plans, tableById) {
        const done = new Set([...tableById.keys()]);
        const out = [];
        const pending = [...plans];
        let guard = 0;
        while (pending.length && guard++ < pending.length * pending.length + 2) {
            let progressed = false;
            for (let i = 0; i < pending.length; i++) {
                const p = pending[i];
                if (p.isolated || p.anchorId == null) {
                    out.push(p);
                    done.add(p.tileId);
                    pending.splice(i, 1);
                    progressed = true;
                    break;
                }
                if (!done.has(p.anchorId)) continue;
                out.push(p);
                done.add(p.tileId);
                pending.splice(i, 1);
                progressed = true;
                break;
            }
            if (!progressed) break;
        }
        return out.concat(pending);
    }

    function buildPlan(g, melds) {
        const pool = (g.tiles || []).map((t) => {
            const c = g._coreTile(t);
            return { ...c, id: t.id };
        });
        const originalMelds = g._originalMelds;
        if (originalMelds?.length && poolMatchesMelds(pool, originalMelds)) {
            return buildReversePlan(g, originalMelds);
        }
        return { plan: [], targets: null };
    }

    function validatePlan(g, plan) {
        const rackIds = new Set((g.tiles || []).filter((t) => t.zone === 'rack').map((t) => t.id));
        const planned = new Set(plan.map((p) => p.tileId));
        const unplanned = [...rackIds].filter((id) => !planned.has(id));
        const WL = window.RummikubWinLog;
        const brief = (id) => {
            const t = g.tiles.find((x) => x.id === id);
            return t && WL?.tileBrief ? WL.tileBrief(g._coreTile(t)) : id;
        };
        return {
            rackCount: rackIds.size,
            planCount: plan.length,
            unplannedIds: unplanned,
            unplannedBriefs: unplanned.map(brief)
        };
    }

    function approachDrop(slot, side) {
        const x = slot.x;
        const y = slot.y;
        switch (side) {
            case 'right': return { x: x - APPROACH_PX, y: y + 3 };
            case 'left': return { x: x + APPROACH_PX, y: y + 3 };
            case 'down': return { x: x + 3, y: y - APPROACH_PX };
            case 'up': return { x: x + 3, y: y + APPROACH_PX };
            default: return { x: x + APPROACH_PX, y: y + 3 };
        }
    }

    function initPlan() {
        const g = window.game;
        const solved = solveMelds(g);
        if (!solved.ok) return { ok: false, ...solved };
        const built = buildPlan(g, solved.melds);
        const plan = built.plan || [];
        const validation = validatePlan(g, plan);
        g.__rummiAiPlan = plan;
        g.__rummiAiPlanIndex = 0;
        g.__rummiAiMelds = solved.melds;
        g.__rummiAiTargets = built.targets || null;
        g.__rummiAiSolverMethod = solved.method;
        if (built.targets) {
            alignSolvedExceptRack(g, built.targets, new Set(rackIdsFromPlan(plan)));
        }
        const reverse = !!built.targets;
        console.info('[rummikub:ai] plan ready', {
            moves: plan.length,
            rack: validation.rackCount,
            unplanned: validation.unplannedIds.length,
            attempts: solved.attempts,
            method: solved.method,
            reverse
        });
        if (!reverse) {
            return {
                ok: false,
                reason: 'no-original-melds',
                ...validation,
                attempts: solved.attempts,
                method: solved.method
            };
        }
        if (validation.unplannedIds.length) {
            return {
                ok: false,
                reason: 'incomplete-plan',
                ...validation,
                attempts: solved.attempts,
                method: solved.method
            };
        }
        return {
            ok: true,
            moveCount: plan.length,
            rackStart: validation.rackCount,
            attempts: solved.attempts,
            method: solved.method,
            reverse
        };
    }

    function step() {
        const g = window.game;
        const plan = g.__rummiAiPlan || [];
        const idx = g.__rummiAiPlanIndex || 0;
        if (idx >= plan.length) {
            const rackLeft = g.tiles.filter((t) => t.zone === 'rack').length;
            return {
                done: true,
                rackLeft,
                overlaps: RummikubGrid.handHasOverlaps(g.tiles)
            };
        }

        const move = plan[idx];
        const tile = g.tiles.find((t) => t.id === move.tileId);
        let anchor = move.anchorId ? g.tiles.find((t) => t.id === move.anchorId) : null;
        if (!tile || (!move.isolated && !anchor)) {
            return { error: 'missing-tile', move, idx };
        }

        let probeX;
        let probeY;
        if (move.targetX != null && move.isolated) {
            probeX = move.targetX + APPROACH_PX;
            probeY = move.targetY + 3;
        } else if (move.anchorId) {
            anchor = g.tiles.find((t) => t.id === move.anchorId) || anchor;
            if (!anchor) return { error: 'missing-anchor', move, idx };
            const slot = RummikubGrid.alignedSnapPos(anchor, move.side);
            const drop = approachDrop(slot, move.side);
            probeX = drop.x;
            probeY = drop.y;
        } else {
            return { error: 'bad-move', move, idx };
        }

        tile.x = probeX;
        tile.y = probeY;
        tile.zone = 'table';

        g.beginGame?.();
        g._commitTilePositions([{ tile, el: null }]);

        if (g.__rummiAiTargets) {
            alignSolvedExceptRack(g, g.__rummiAiTargets, remainingRackIds(plan, idx + 1));
        }
        const live = g.tiles.find((t) => t.id === move.tileId);
        if (!live) {
            return { error: 'missing-after-commit', move, idx };
        }
        if (live.zone === 'rack') {
            return { error: 'stayed-on-rack', move, idx, tileId: live.id };
        }

        const overlaps = RummikubGrid.handHasOverlaps(g.tiles);
        const table = g.tiles.filter((t) => t.zone === 'table');
        const spatial = g._verifyTableSpatial?.(table);
        g.requestRender?.();

        g.__rummiAiPlanIndex = idx + 1;
        const rackLeft = g.tiles.filter((t) => t.zone === 'rack').length;
        const out = {
            done: false,
            move: idx + 1,
            tileId: tile.id,
            tileBrief: tileBrief(g, tile),
            anchorId: anchor?.id ?? null,
            anchorBrief: anchor ? tileBrief(g, anchor) : null,
            side: move.side,
            isolated: !!move.isolated,
            meldKind: move.meldKind,
            pos: { x: tile.x, y: tile.y },
            overlaps,
            rackLeft,
            tableUnmatched: spatial?.unmatchedTileBriefs?.length ?? 0
        };
        console.info('[rummikub:ai] place', {
            move: out.move,
            tile: out.tileBrief,
            anchor: out.isolated ? '(isolated)' : out.anchorBrief,
            side: out.side,
            rackLeft: out.rackLeft,
            overlaps: out.overlaps
        });
        return out;
    }

    window.__rummiAi = { initPlan, step, buildPlan, solveMelds, validatePlan };
}`;

/**
 * @param {import('playwright').Frame} frame
 */
async function injectAiPlaythrough(frame) {
    await frame.evaluate((fnBody) => {
        // eslint-disable-next-line no-eval
        const fn = eval(fnBody);
        fn();
    }, `(${AI_BROWSER_BUNDLE})`);
}

/**
 * @param {import('playwright').Frame} frame
 */
async function initPlaythroughPlan(frame) {
    return frame.evaluate(() => window.__rummiAi.initPlan());
}

/**
 * @param {import('playwright').Frame} frame
 */
async function stepPlaythrough(frame) {
    return frame.evaluate(() => window.__rummiAi.step());
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').Frame} frame
 * @param {import('../../../shared/infra/test-logger').TestLogger} log
 * @param {string} tag
 * @param {string} message
 * @param {object} ctx
 * @param {object} [extra]
 */
async function failPlaythrough(page, frame, log, tag, message, ctx, extra = {}) {
    const snapshot = await captureRichPlaythroughFailure(page, frame, tag, {
        ...ctx,
        ...extra
    });
    const packed = packPlaythroughFailure(tag, [message], snapshot);
    const summary = formatPlaythroughFailureLines(snapshot);
    summary.forEach((line) => console.error(`[rummikub:ai] ${line}`));
    const detailText = [
        ...summary,
        '',
        '--- failure snapshot (frame) ---',
        JSON.stringify(snapshot.frame || snapshot, null, 2),
        '',
        '--- hub context ---',
        JSON.stringify(snapshot.hubContext || snapshot.hub || {}, null, 2)
    ].join('\n');
    log.fail(packed.message, detailText);
}

/**
 * @param {import('playwright').Page} page
 * @param {{ isMobile?: boolean }} [ctx]
 */
async function runSpPlaythrough(page, ctx = {}) {
    const log = createTestLogger({
        gameId: 'rummikub',
        scenario: 'playthrough',
        gameMode: 'puzzle'
    });
    page.setDefaultTimeout(TIMEOUT_MS);

    log.step(`Rummikub AI playthrough (${ctx.isMobile ? 'mobile' : 'desktop'})`);
    const slowMs = playwrightSlowMo();
    if (slowMs > 0) log.step(`slow mode: ${slowMs}ms between placements`);
    await waitForRummikubReady(page);
    const frame = await getGameFrame(page);

    await injectAiPlaythrough(frame);

    const failCtx = { moveHistory: [], lastStep: null, solverMethod: null };

    const boot = await snapshotRummikubState(frame);
    if (boot.totalTiles !== EXPECTED_TILES) {
        await failPlaythrough(page, frame, log, 'bad-tile-count',
            `expected ${EXPECTED_TILES} tiles, got ${boot.totalTiles}`, failCtx, { boot });
    }

    const plan = await initPlaythroughPlan(frame);
    failCtx.solverMethod = plan?.method || null;
    if (!plan?.ok) {
        const reason = plan?.reason === 'incomplete-plan'
            ? `incomplete plan: ${plan.unplannedBriefs?.length ?? '?'} rack tile(s) unplanned`
            : `partition plan failed (${plan?.reason || 'unknown'})`;
        await failPlaythrough(page, frame, log, 'plan-failed', reason, failCtx, { plan });
    }
    if (!plan.moveCount) {
        await failPlaythrough(page, frame, log, 'empty-plan',
            'no rack placements in plan', failCtx, { plan });
    }

    log.step(`plan ready — ${plan.moveCount} placement(s) from rack ${plan.rackStart} (${plan.method || 'solver'})`);

    const maxMoves = plan.moveCount + 4;
    for (let i = 0; i < maxMoves; i++) {
        const before = await snapshotRummikubState(frame);
        if (before.inReview && before.isOver) break;

        const step = await stepPlaythrough(frame);
        failCtx.lastStep = step;

        if (step.error) {
            await failPlaythrough(page, frame, log, 'step-error',
                `move ${step.move || i + 1}: ${step.error}`, failCtx, { step, before });
        }
        if (step.overlaps) {
            await failPlaythrough(page, frame, log, 'overlap',
                `move ${step.move}: overlap after snap`, failCtx, { step, before });
        }

        if (step.done) {
            failCtx.lastStep = {
                move: plan.moveCount,
                tileBrief: '(plan complete)',
                rackLeft: step.rackLeft
            };
            if (step.overlaps) {
                await failPlaythrough(page, frame, log, 'overlap-end',
                    'plan finished with overlaps', failCtx, { step, before });
            }
            if (step.rackLeft > 0) {
                await failPlaythrough(page, frame, log, 'rack-left',
                    `plan finished but ${step.rackLeft} tile(s) still on rack`, failCtx, { step, before });
            }
            break;
        }

        if (step.tileBrief) {
            const label = step.isolated
                ? `${step.tileBrief} → target`
                : `${step.tileBrief} ${step.side} of ${step.anchorBrief}`;
            failCtx.moveHistory.push({
                move: step.move,
                label,
                rackLeft: step.rackLeft
            });
            log.step(
                `place ${label} (rack ${before.rackCount ?? '?'}→${step.rackLeft})`
            );
        }

        await delayBetweenActions(page);
    }

    const finalSnap = await snapshotRummikubState(frame);
    if (finalSnap.planRemaining > 0) {
        await failPlaythrough(page, frame, log, 'plan-incomplete',
            `plan incomplete: ${finalSnap.planRemaining} move(s) remaining`, failCtx, { finalSnap });
    }
    if (finalSnap.rackCount > 0) {
        await failPlaythrough(page, frame, log, 'rack-left',
            `${finalSnap.rackCount} tile(s) still on rack`, failCtx, { finalSnap });
    }
    if (finalSnap.overlaps) {
        await failPlaythrough(page, frame, log, 'overlap',
            'overlapping tiles after playthrough', failCtx, { finalSnap });
    }
    try {
        await assertSpatialMatchesKnownSolution(frame);
    } catch (err) {
        await failPlaythrough(page, frame, log, 'table-unsolved',
            err.message, failCtx, { finalSnap });
    }

    log.success(
        'AI playthrough',
        `${plan.moveCount} placement(s), rack empty, table spatially solved`
    );
}

module.exports = {
    injectAiPlaythrough,
    initPlaythroughPlan,
    stepPlaythrough,
    runSpPlaythrough,
    failPlaythrough,
    captureRichPlaythroughFailure
};
