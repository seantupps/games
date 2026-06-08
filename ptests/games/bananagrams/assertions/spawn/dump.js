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

/** @param {import('playwright').Frame} frame */
async function waitForDumpInventory(frame, beforeIds, timeoutMs = 10000) {
    await frame.waitForFunction(({ ids }) => {
        const g = window.game;
        if (!g?.tiles?.length) return false;
        const added = g.tiles.filter((t) => !ids.includes(t.id));
        return added.length === 3;
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
    return frame.evaluate(({ ids, hostUid: hUid }) => {
        const g = window.game;
        const board = g.roomData?.global?.board || {};
        const myUid = g._myUid();
        const owned = board.tilesOwnedByPlayer?.[myUid] || board.hands?.[myUid] || [];
        const positionsList = board.tilePositionsByPlayer?.[myUid] || [];
        const positionsById = {};
        positionsList.forEach((p) => { positionsById[p.id] = { x: p.x, y: p.y }; });

        const added = g.tiles.filter((t) => !ids.includes(t.id));
        const removed = ids.filter((id) => !g.tiles.some((t) => t.id === id));

        let hostOwned = null;
        if (hUid) {
            hostOwned = board.tilesOwnedByPlayer?.[hUid] || [];
        }

        const visBounds = typeof g._getVisibleWorldBounds === 'function'
            ? g._getVisibleWorldBounds()
            : null;

        return {
            dumpSeq: board.dumpSeq || 0,
            dumpActorUid: board.dumpActorUid || null,
            inventorySeq: board.inventorySeq?.[myUid] ?? null,
            poolLen: board.tilePool?.length ?? g._tilePool?.length ?? -1,
            ownedCount: owned.length,
            localCount: g.tiles.length,
            ownedIds: owned.map((t) => t.id),
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
            isHost: !!g.isHost()
        };
    }, { ids: beforeIds, hostUid });
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

    if (snap.added.length !== 3) {
        return fail('local-added-not-3');
    }
    if (snap.removed.length !== 1) {
        return fail('local-removed-not-1');
    }
    if (snap.ownedCount !== snap.localCount) {
        return fail('owned-local-count-mismatch', {
            ownedCount: snap.ownedCount,
            localCount: snap.localCount
        });
    }
    const ownedSet = new Set(snap.ownedIds);
    for (const t of snap.added) {
        if (!ownedSet.has(t.id)) {
            return fail('added-id-missing-from-board-owned', { id: t.id });
        }
    }
    for (const id of snap.removed) {
        if (ownedSet.has(id)) {
            return fail('removed-id-still-on-board-owned', { id });
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

    const addedIds = await frame.evaluate(({ ids }) => (
        window.game.tiles.filter((t) => !ids.includes(t.id)).map((t) => t.id)
    ), { ids: beforeIds });

    return evalDumpTileVisibility(frame, addedIds, label, mobile);
}

/** Poll visibility — catches tiles that spawn then vanish after MP layout/sync. */
async function assertDumpTilesStable(frame, beforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    const delays = options.delaysMs || STABILITY_DELAYS_MS;
    const addedIds = await frame.evaluate(({ ids }) => (
        window.game.tiles.filter((t) => !ids.includes(t.id)).map((t) => t.id)
    ), { ids: beforeIds });

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

    const addedIds = await frame.evaluate(({ ids }) => (
        window.game.tiles.filter((t) => !ids.includes(t.id)).map((t) => t.id)
    ), { ids: beforeIds });

    await frame.waitForFunction(({ aids }) => aids.every((id) => {
        const el = document.querySelector(`[data-tile-id="${id}"]`);
        return el && el.getBoundingClientRect().width > 4;
    }), { aids: addedIds }, { timeout: 2000 }).catch(() => {});

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
    if (options.hostPage && options.dumpSeqBefore != null) {
        await waitForBoardDumpSeq(options.hostPage, options.dumpSeqBefore);
    }

    const board = await assertDumpBoardState(frame, beforeIds, {
        hostUid: options.hostUid,
        expectDumpSeq: options.dumpSeqBefore != null ? options.dumpSeqBefore + 1 : null
    });
    if (!board.ok) {
        return { ok: false, label, ...board };
    }

    const visible = await assertDumpTilesVisible(frame, beforeIds, label, { mobile, timeoutMs: options.timeoutMs });
    if (!visible.ok) {
        return { ok: false, label, ...visible };
    }

    const stable = await assertDumpTilesStable(frame, beforeIds, label, {
        mobile,
        delaysMs: options.delaysMs || STABILITY_FULL_MS
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
    assertDumpBoardState,
    assertDumpTilesVisible,
    assertDumpTilesStable,
    evalDumpTileVisibility,
    snapshotDumpSpawnState,
    captureSpawnState,
    compareSpawnBatch,
    assertSpawnBatch,
    waitForBoardDumpSeq,
    waitForDumpInventory,
    assertDumpSpawnSeparation,
    waitForDumpTilesReady,
    STABILITY_FULL_MS
};
