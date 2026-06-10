/**
 * Dump spawn checks — RTDB board state, local hand, DOM visibility on the real canvas,
 * stability across sync/render (catches tiles that flash then disappear on mobile).
 */
const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');
const { compareField } = require('../core/compare');
const { assertDealStable: assertStartingRackStable } = require('../mp/deal');

const STABILITY_DELAYS_MS = [0, 120];
const STABILITY_FULL_MS = [0, 200, 500];
const DUMP_DRAW_COUNT = 3;

function expectedHandAfterDump(beforeCount) {
    return beforeCount + 2;
}

/**
 * Resolve the 3 tiles drawn on dump for visibility checks.
 * When the dumped tile is redrawn from the pool it stays in hand (id-diff misses it).
 * @param {import('playwright').Frame} frame
 */
async function resolveDumpSpawnTileIds(frame, beforeIds, dumpSeqBefore = null) {
    return frame.evaluate(({ ids, dumpSeqBefore: seqBefore }) => {
        const g = window.game;
        const drawCount = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : DUMP_DRAW_COUNT;
        const board = g.roomData?.global?.board || {};
        const handIds = (g.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const txn = board.lastDumpTxn;
        const seqOk = seqBefore == null || (board.dumpSeq || 0) > seqBefore;

        if (txn && seqOk && Array.isArray(txn.addedTileIds) && txn.addedTileIds.length === drawCount
            && txn.addedTileIds.every((id) => handSet.has(id))) {
            return { ids: txn.addedTileIds.slice(), source: 'lastDumpTxn', drawBack: !!txn.dumpedTileId
                && txn.addedTileIds.includes(txn.dumpedTileId) };
        }

        const byDiff = handIds.filter((id) => !ids.includes(id));
        if (byDiff.length === drawCount) {
            return { ids: byDiff, source: 'hand-diff', drawBack: false };
        }
        const dumpedId = txn?.dumpedTileId || ids[ids.length - 1] || null;
        if (byDiff.length === drawCount - 1 && dumpedId && handSet.has(dumpedId)) {
            return { ids: [...byDiff, dumpedId], source: 'draw-back', drawBack: true };
        }
        return { ids: byDiff, source: 'partial', drawBack: false };
    }, { ids: beforeIds, dumpSeqBefore });
}

/** @param {import('playwright').Frame} frame */
async function waitForDumpInventory(frame, beforeIds, timeoutMs = 10000) {
    await frame.waitForFunction(({ ids }) => {
        const g = window.game;
        if (!g?.tiles?.length) return false;
        return g.tiles.length === ids.length + 2;
    }, { ids: beforeIds }, { timeout: timeoutMs });
}

/** @param {import('playwright').Page} [hostPage] host hub page (guest dumps) */
async function waitForBoardDumpSeq(hostPage, dumpSeqBefore, timeoutMs = 10000) {
    if (!hostPage) return dumpSeqBefore;
    await hostPage.waitForFunction(({ seq }) => {
        const board = document.getElementById('game-frame')?.contentWindow?.game?.roomData?.global?.board;
        return (board?.dumpSeq || 0) > seq;
    }, { seq: dumpSeqBefore }, { timeout: timeoutMs });
    return hostPage.evaluate(() => (
        document.getElementById('game-frame')?.contentWindow?.game?.roomData?.global?.board?.dumpSeq || 0
    ));
}

/**
 * Snapshot board + local hand for one dump (runs in game iframe).
 * @param {import('playwright').Frame} frame
 */
async function snapshotDumpSpawnState(frame, beforeIds, options = {}) {
    const hostUid = options.hostUid || null;
    const dumpedTileId = options.dumpedTileId ?? beforeIds[beforeIds.length - 1] ?? null;
    return frame.evaluate(({ ids, hostUid: hUid, dumpedId }) => {
        const g = window.game;
        const board = g.roomData?.global?.board || {};
        const myUid = g._myUid();
        const owned = board.tilesOwnedByPlayer?.[myUid] || board.hands?.[myUid] || [];
        const positionsList = board.tilePositionsByPlayer?.[myUid] || [];
        const positionsById = {};
        positionsList.forEach((p) => { positionsById[p.id] = { x: p.x, y: p.y }; });

        const localIds = (g.tiles || []).map((t) => t.id);
        const ownedIds = owned.map((t) => t.id);
        const localSet = new Set(localIds);
        const ownedSet = new Set(ownedIds);
        const beforeSet = new Set(ids);

        const added = g.tiles.filter((t) => !ids.includes(t.id));
        const removed = ids.filter((id) => !g.tiles.some((t) => t.id === id));

        let hostOwned = null;
        if (hUid) {
            hostOwned = board.tilesOwnedByPlayer?.[hUid] || [];
        }

        const visBounds = typeof g._getVisibleWorldBounds === 'function'
            ? g._getVisibleWorldBounds()
            : null;

        const drawBack = !!(dumpedId && localSet.has(dumpedId) && removed.length === 0);
        const txnSpawnIds = board.lastDumpTxn?.addedTileIds || null;
        const coherence = typeof __bananaMpDebug?.coherence === 'function'
            ? __bananaMpDebug.coherence()
            : (g?._mpCoherenceSnapshot?.(
                g?._mpBoardFromRoom?.(g.roomData) ?? board,
                myUid,
                'dump-spawn'
            ) ?? null);

        return {
            dumpSeq: board.dumpSeq || 0,
            dumpActorUid: board.dumpActorUid || null,
            dumpedTileId: dumpedId,
            drawBack,
            txnSpawnIds,
            dumpedStillLocal: dumpedId ? localSet.has(dumpedId) : null,
            dumpedStillOnBoardOwned: dumpedId ? ownedSet.has(dumpedId) : null,
            inventorySeq: board.inventorySeq?.[myUid] ?? null,
            localInventorySeq: g._localInventorySeq ?? null,
            lastDumpSeq: g._lastDumpSeq ?? null,
            lastPeelSeq: g._lastPeelSeq ?? null,
            poolLen: board.tilePool?.length ?? g._tilePool?.length ?? -1,
            ownedCount: owned.length,
            localCount: g.tiles.length,
            ownedIds,
            localIds,
            missingFromLocal: ownedIds.filter((id) => !localSet.has(id)),
            extraInLocal: localIds.filter((id) => !ownedSet.has(id)),
            added: added.map((t) => ({
                id: t.id,
                letter: t.letter,
                x: t.x,
                y: t.y,
                faceUp: !!t.faceUp
            })),
            removed,
            positionsForAdded: added.map((t) => positionsById[t.id] || null),
            hostOwnedCount: hostOwned?.length ?? null,
            visBounds,
            gameStarted: !!g.gameStarted,
            isHost: !!g.isHost(),
            handBeforeCount: ids.length,
            expectedHandCount: ids.length + 2,
            expectedAdded: 3,
            expectedRemoved: 1,
            coherence,
            coherenceFailed: coherence?.failed?.length ? coherence.failed : null
        };
    }, { ids: beforeIds, hostUid, dumpedId: dumpedTileId });
}

/**
 * Always emit full dump diagnostics (bypasses FIVE_RUNNER_QUIET).
 * @param {string} label
 * @param {object} snap
 * @param {object} [extra]
 */
function logDumpSpawnFailure(label, snap, extra = {}) {
    const { spawnDiag, spawnPipelineSummary } = require('../../../../shared/infra/test-logger');
    const problems = Array.isArray(extra.problems) ? extra.problems : [];
    const headline = problems.length ? `${label} — ${problems.join('; ')}` : label;
    const payload = {
        label,
        ...extra,
        snap
    };
    spawnDiag(headline, payload);
    if (snap && typeof snap === 'object' && Array.isArray(snap.spawnDetails)) {
        spawnPipelineSummary(label, snap);
    }
}

const { evalSpawnTilesVisibility } = require('./spawn-visibility');

/** @param {import('playwright').Frame} frame */
async function evalDumpTileVisibility(frame, addedIds, label, mobile) {
    return evalSpawnTilesVisibility(frame, {
        addedIds,
        expectedCount: 3,
        label,
        mobile,
        mode: 'dump'
    });
}

/** @param {import('playwright').Frame} frame */
async function assertDumpBoardState(frame, beforeIds, options = {}) {
    const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
    const fail = (reason, extra = {}) => ({
        ok: false,
        phase: 'board',
        reason,
        ...snap,
        ...extra
    });

    if (snap.localCount !== expectedHandAfterDump(snap.handBeforeCount)) {
        return fail('hand-count-not-plus-2', {
            expected: expectedHandAfterDump(snap.handBeforeCount),
            got: snap.localCount
        });
    }
    if (snap.ownedCount !== snap.localCount) {
        return fail('owned-local-count-mismatch', {
            ownedCount: snap.ownedCount,
            localCount: snap.localCount
        });
    }
    const ownedSet = new Set(snap.ownedIds);
    const spawnIds = Array.isArray(snap.txnSpawnIds) && snap.txnSpawnIds.length === DUMP_DRAW_COUNT
        ? snap.txnSpawnIds
        : (snap.drawBack && snap.dumpedTileId
            ? [...snap.added.map((t) => t.id), snap.dumpedTileId]
            : snap.added.map((t) => t.id));
    const uniqueSpawn = [...new Set(spawnIds)];
    if (uniqueSpawn.length !== DUMP_DRAW_COUNT) {
        return fail('spawn-batch-not-3', { spawnIds: uniqueSpawn, drawBack: snap.drawBack });
    }
    for (const id of uniqueSpawn) {
        if (!ownedSet.has(id)) {
            return fail('spawn-id-missing-from-board-owned', { id });
        }
        if (!snap.localIds.includes(id)) {
            return fail('spawn-id-missing-from-local', { id });
        }
    }
    if (!snap.drawBack) {
        if (snap.added.length !== DUMP_DRAW_COUNT) {
            return fail('local-added-not-3');
        }
        if (snap.removed.length !== 1) {
            return fail('local-removed-not-1');
        }
        for (const id of snap.removed) {
            if (ownedSet.has(id)) {
                return fail('removed-id-still-on-board-owned', { id });
            }
        }
    }
    if (!snap.gameStarted) {
        return fail('not-game-started');
    }
    if (options.expectDumpSeq != null && snap.dumpSeq < options.expectDumpSeq) {
        return fail('dump-seq-not-advanced', { expectDumpSeq: options.expectDumpSeq });
    }

    return { ok: true, phase: 'board', ...snap };
}

/**
 * Strict 1-for-3 dump trade — catches "dumped tile stays + only 2 pool draws visible".
 * Hand count can still be +2 while membership/DOM are wrong (~1/20 dumps).
 * No test-side game hooks; polls until model authority (+2 hand) then audits model + DOM.
 * @param {import('playwright').Frame} frame
 */
async function assertDumpTradeIntegrity(frame, beforeIds, dumpedTileId, label, options = {}) {
    const timeoutMs = options.timeoutMs ?? 6000;
    const mobile = !!options.mobile;
    const dumpSeqBefore = options.dumpSeqBefore ?? null;

    if (!dumpedTileId) {
        failWithSnapshot(label, ['missing dumpedTileId for trade-integrity check'], {});
    }

    await waitForDumpInventory(frame, beforeIds, timeoutMs);
    if (options.hostPage && dumpSeqBefore != null) {
        await waitForBoardDumpSeq(options.hostPage, dumpSeqBefore, timeoutMs);
    }

    const board = await assertDumpBoardState(frame, beforeIds, {
        hostUid: options.hostUid,
        dumpedTileId,
        expectDumpSeq: dumpSeqBefore != null ? dumpSeqBefore + 1 : null
    });
    if (!board.ok) {
        logDumpSpawnFailure(label, board, { problems: [board.reason || 'board-state'] });
        failWithSnapshot(label, [board.reason || 'dump board state failed'], board);
    }

    const audit = await frame.evaluate(({ ids, dumpedId, seqBefore, isMobile }) => {
        const g = window.game;
        const board = g.roomData?.global?.board || {};
        const txn = board.lastDumpTxn;
        const drawCount = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
        const handIds = (g.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const seqOk = seqBefore == null || (board.dumpSeq || 0) > seqBefore;

        const isDomVisible = (id) => {
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity) >= 0.05
                && rect.width > 4
                && rect.height > 4;
        };

        const removed = ids.filter((id) => !handSet.has(id));
        const added = handIds.filter((id) => !ids.includes(id));

        const txnDrawBack = !!(txn && seqOk && txn.dumpedTileId === dumpedId
            && Array.isArray(txn.addedTileIds)
            && txn.addedTileIds.includes(dumpedId));
        const drawBack = txnDrawBack
            || (removed.length === 0 && handSet.has(dumpedId) && added.length >= drawCount - 1);

        let spawnIds = [];
        if (txn && seqOk && Array.isArray(txn.addedTileIds) && txn.addedTileIds.length === drawCount
            && txn.addedTileIds.every((id) => handSet.has(id))) {
            spawnIds = txn.addedTileIds.slice();
        } else {
            spawnIds = added.slice();
            if (spawnIds.length === drawCount - 1 && drawBack && handSet.has(dumpedId)) {
                spawnIds = [...spawnIds, dumpedId];
            }
        }

        const renderTiles = typeof g._tilesForRender === 'function'
            ? g._tilesForRender()
            : (g.tiles || []);
        const renderIds = new Set(renderTiles.map((t) => t.id));

        const dumpedInModel = handSet.has(dumpedId);
        const dumpedInRender = renderIds.has(dumpedId);
        const dumpedDomVisible = isDomVisible(dumpedId);
        const spawnDomVisible = spawnIds.filter(isDomVisible);
        const addedDomVisible = added.filter(isDomVisible);

        const problems = [];

        if (!drawBack) {
            if (removed.length !== 1 || removed[0] !== dumpedId) {
                problems.push(
                    `model: expected dumped ${dumpedId} removed, got removed=${JSON.stringify(removed)}`
                );
            }
            if (dumpedInModel) {
                problems.push(`model: dumped tile ${dumpedId} still in hand after authority`);
            }
            if (dumpedDomVisible) {
                problems.push(`DOM: dumped tile ${dumpedId} still visible after authority`);
            }
            if (dumpedInModel !== dumpedInRender) {
                problems.push(
                    `render/model mismatch for ${dumpedId} (model=${dumpedInModel} render=${dumpedInRender})`
                );
            }
            if (spawnDomVisible.length !== drawCount) {
                problems.push(
                    `DOM: ${spawnDomVisible.length}/${drawCount} spawn tiles visible `
                    + `(spawn=${spawnIds.join(', ')}, visible=${spawnDomVisible.join(', ')})`
                );
            }
            if ((dumpedInModel || dumpedDomVisible) && spawnDomVisible.length === 2) {
                problems.push(
                    '1-for-3 trade broken: dumped tile retained + only 2 spawn tiles visible '
                    + `(dumped model=${dumpedInModel} dom=${dumpedDomVisible})`
                );
            }
            if ((dumpedInModel || dumpedDomVisible) && addedDomVisible.length === 2) {
                problems.push(
                    '1-for-3 trade broken: dumped tile retained + only 2 new hand tiles visible '
                    + `(added=${added.join(', ')})`
                );
            }
        } else if (spawnDomVisible.length !== drawCount) {
            problems.push(
                `draw-back dump: ${spawnDomVisible.length}/${drawCount} spawn tiles visible`
            );
        }

        return {
            ok: problems.length === 0,
            problems,
            drawBack,
            dumpedInModel,
            dumpedInRender,
            dumpedDomVisible,
            spawnIds,
            spawnDomVisible,
            added,
            addedDomVisible,
            removed,
            dumpPendingTileId: g._guestDumpPendingTileId || null,
            txnDumpedId: txn?.dumpedTileId ?? null,
            txnAddedIds: txn?.addedTileIds ?? null,
            mobile: isMobile,
            isHost: !!g.isHost?.()
        };
    }, {
        ids: beforeIds,
        dumpedId: dumpedTileId,
        seqBefore: dumpSeqBefore,
        isMobile: mobile
    });

    if (!audit.ok) {
        logDumpSpawnFailure(label, { ...board, ...audit }, { problems: audit.problems });
        failWithSnapshot(label, audit.problems, { board, audit, dumpedTileId });
    }

    return { ok: true, label, ...audit, board };
}

/** @param {import('playwright').Frame} frame */
async function assertDumpTilesVisible(frame, beforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    await waitForDumpInventory(frame, beforeIds, options.timeoutMs);
    await frame.evaluate(() => {
        window.game?.requestRender?.();
        return new Promise((r) => {
            requestAnimationFrame(() => requestAnimationFrame(r));
        });
    });

    const { ids: addedIds } = await resolveDumpSpawnTileIds(frame, beforeIds, options.dumpSeqBefore);

    return evalDumpTileVisibility(frame, addedIds, label, mobile);
}

/** Poll visibility — catches tiles that spawn then vanish after MP layout/sync. */
async function assertDumpTilesStable(frame, beforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    const delays = options.delaysMs || STABILITY_DELAYS_MS;
    const { ids: addedIds } = await resolveDumpSpawnTileIds(frame, beforeIds, options.dumpSeqBefore);

    const history = [];
    for (const delay of delays) {
        if (delay > 0) {
            await frame.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), delay);
            await frame.evaluate(() => {
                window.game?.requestRender?.();
                return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            });
        }
        const snap = await evalDumpTileVisibility(frame, addedIds, label, mobile);
        snap.delay = delay;
        history.push(snap);
        if (!snap.ok) {
            return {
                ok: false,
                phase: 'stability',
                failedAtMs: delay,
                history,
                ...snap
            };
        }
    }

    const idsGone = await frame.evaluate(({ aids }) => {
        const present = new Set(window.game.tiles.map((t) => t.id));
        return aids.filter((id) => !present.has(id));
    }, { aids: addedIds });
    if (idsGone.length) {
        return {
            ok: false,
            phase: 'stability',
            reason: 'added-tiles-removed-from-hand',
            idsGone,
            history
        };
    }

    return { ok: true, phase: 'stability', history, addedIds };
}

/**
 * Fast path: board + visible (+ optional short in-page stability). One round-trip.
 * @param {import('playwright').Frame} frame
 */
async function assertDumpSpawnQuick(frame, beforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    const timeoutMs = options.timeoutMs ?? 6000;
    const stableMs = options.stableMs ?? 100;
    const noRenderNudge = options.noRenderNudge === true;

    await waitForDumpInventory(frame, beforeIds, timeoutMs);
    if (options.hostPage && options.dumpSeqBefore != null) {
        await waitForBoardDumpSeq(options.hostPage, options.dumpSeqBefore, timeoutMs);
    }

    const board = await assertDumpBoardState(frame, beforeIds, {
        hostUid: options.hostUid,
        expectDumpSeq: options.dumpSeqBefore != null ? options.dumpSeqBefore + 1 : null
    });
    if (!board.ok) {
        return { ok: false, label, ...board };
    }

    const { ids: addedIds } = await resolveDumpSpawnTileIds(
        frame,
        beforeIds,
        options.dumpSeqBefore
    );
    if (addedIds.length !== DUMP_DRAW_COUNT) {
        return { ok: false, label, phase: 'board', reason: 'spawn-ids-not-3', spawnIds: addedIds };
    }

    await frame.waitForFunction(({ aids, nudge }) => {
        if (nudge) window.game?.requestRender?.();
        return aids.every((id) => {
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 4 && r.height > 4;
        });
    }, { aids: addedIds, nudge: !noRenderNudge }, { timeout: timeoutMs });

    let vis = await evalDumpTileVisibility(frame, addedIds, label, mobile);
    if (!vis.ok) {
        return { ok: false, label, ...vis };
    }

    if (stableMs > 0) {
        await frame.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), stableMs);
        vis = await evalDumpTileVisibility(frame, addedIds, label, mobile);
        if (!vis.ok) {
            return { ok: false, label, phase: 'stability', failedAtMs: stableMs, ...vis };
        }
        const idsGone = await frame.evaluate(({ aids }) => {
            const present = new Set(window.game.tiles.map((t) => t.id));
            return aids.filter((id) => !present.has(id));
        }, { aids: addedIds });
        if (idsGone.length) {
            return {
                ok: false,
                label,
                phase: 'stability',
                reason: 'added-tiles-removed-from-hand',
                idsGone
            };
        }
    }

    return { ok: true, label, phase: 'quick' };
}

/**
 * Full dump assert: board RTDB/hand sync + visible on canvas + stable across delays.
 * @param {import('playwright').Frame} frame
 * @param {import('playwright').Page} [hostPage]
 */
async function assertDumpSpawnComplete(frame, beforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    const timeoutMs = options.timeoutMs ?? 10000;
    if (options.hostPage && options.dumpSeqBefore != null) {
        await waitForBoardDumpSeq(options.hostPage, options.dumpSeqBefore, timeoutMs);
    }
    await waitForDumpInventory(frame, beforeIds, timeoutMs);

    const board = await assertDumpBoardState(frame, beforeIds, {
        hostUid: options.hostUid,
        expectDumpSeq: options.dumpSeqBefore != null ? options.dumpSeqBefore + 1 : null
    });
    if (!board.ok) {
        return { ok: false, label, ...board };
    }

    const visible = await assertDumpTilesVisible(frame, beforeIds, label, {
        mobile,
        timeoutMs,
        dumpSeqBefore: options.dumpSeqBefore
    });
    if (!visible.ok) {
        return { ok: false, label, ...visible };
    }

    const stable = await assertDumpTilesStable(frame, beforeIds, label, {
        mobile,
        delaysMs: options.delaysMs || STABILITY_FULL_MS,
        dumpSeqBefore: options.dumpSeqBefore
    });
    if (!stable.ok) {
        return { ok: false, label, ...stable };
    }

    if (options.checkRules) {
        const rules = await frame.evaluate(({ ids, lbl }) => {
            const g = window.game;
            const existing = g.tiles.filter((t) => ids.includes(t.id));
            const added = g.tiles.filter((t) => !ids.includes(t.id));
            if (typeof BananaRules?.validateDumpSpawns !== 'function') {
                return { ok: true, skipped: true };
            }
            const r = BananaRules.validateDumpSpawns(existing, added, {
                minAnchorGap: 0,
                minBatchGap: 1
            });
            return r.ok ? { ok: true } : { ok: false, label: lbl, phase: 'rules', ...r };
        }, { ids: beforeIds, lbl: label });
        if (!rules.ok) {
            return { ok: false, label, ...rules };
        }
    }

    return {
        ok: true,
        label,
        board,
        visible,
        stable
    };
}

/** @deprecated use assertDumpSpawnComplete */
async function waitForDumpTilesReady(frame, beforeIds, timeoutMs = 8000) {
    await waitForDumpInventory(frame, beforeIds, timeoutMs);
    await frame.evaluate(() => new Promise((r) => {
        requestAnimationFrame(() => requestAnimationFrame(r));
    }));
}

/** @deprecated use assertDumpSpawnComplete */
async function assertDumpSpawnSeparation(frame, beforeIds, label, options = {}) {
    return assertDumpSpawnComplete(frame, beforeIds, label, options);
}

/** Alias for capture → compare → assert pipeline. */
const captureSpawnState = snapshotDumpSpawnState;

/**
 * @param {object} snap — captureSpawnState result
 * @param {{ addedCount?: number, poolDelta?: number }} [expect]
 */
function compareSpawnBatch(snap, expect = {}) {
    const problems = [];
    const wantAdded = expect.addedCount ?? 3;
    const addedN = snap?.added?.length ?? -1;
    if (addedN !== wantAdded) {
        problems.push(`spawn added expected ${wantAdded}, got ${addedN}`);
    }
    if (expect.poolDelta != null && snap?.poolLen != null) {
        const c = compareField(expect.poolDelta, snap.poolLen, 'poolLen');
        if (!c.ok && c.message) problems.push(c.message);
    }
    return { ok: problems.length === 0, problems, snap };
}

function assertSpawnBatch(label, snap, expect = {}) {
    const cmp = compareSpawnBatch(snap, expect);
    if (!cmp.ok) failWithSnapshot(label, cmp.problems, { snap });
    return cmp;
}

module.exports = {
    assertStartingRackStable,
    assertDumpSpawnComplete,
    assertDumpSpawnQuick,
    assertDumpTradeIntegrity,
    assertDumpBoardState,
    assertDumpTilesVisible,
    assertDumpTilesStable,
    evalDumpTileVisibility,
    snapshotDumpSpawnState,
    captureSpawnState,
    logDumpSpawnFailure,
    compareSpawnBatch,
    assertSpawnBatch,
    waitForBoardDumpSeq,
    waitForDumpInventory,
    resolveDumpSpawnTileIds,
    expectedHandAfterDump,
    assertDumpSpawnSeparation,
    waitForDumpTilesReady,
    STABILITY_FULL_MS,
    DUMP_DRAW_COUNT
};
