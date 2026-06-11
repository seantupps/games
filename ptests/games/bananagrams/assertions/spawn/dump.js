/**
 * Dump spawn checks — RTDB board state, local hand, DOM visibility on the real canvas,
 * stability across sync/render (catches tiles that flash then disappear on mobile).
 */
const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');
const { compareField } = require('../core/compare');
const { assertDealStable: assertStartingRackStable } = require('../mp/deal');

const { flushHostBananaInteractions } = require('../../../../shared/adapters/mp-client');
const { STEP_MS, POLL_INTERVAL_MS } = require('../../../../shared/infra/timeouts');

const STABILITY_DELAYS_MS = [0, 120];
const STABILITY_FULL_MS = [0, 200, 500];
/** Guest LAN repro — catch flash-then-vanish (phone RTDB stale echo + jitter). */
const GUEST_DUMP_STABILITY_MS = [0, 16, 50, 100, 200, 350];
const GUEST_DUMP_JITTER_PX = 8;
/** Post-dump watch window — catch a second dump landing after the first. */
const SINGLE_DUMP_SETTLE_MS = 400;
const SINGLE_DUMP_SETTLE_FAST_MS = 80;
const MIN_DUMP_POOL = 3;

/** @param {import('playwright').Frame} frame */
async function readGuestBunchLen(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        if (typeof g._bunchLenForDump === 'function') return g._bunchLenForDump();
        const min = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
        const pool = g._tilePool?.length ?? g.roomData?.global?.board?.tilePool?.length ?? 0;
        return pool;
    });
}

/** @param {import('playwright').Page} hostPage */
async function readHostDumpSeq(hostPage) {
    return hostPage.evaluate(() => (
        document.getElementById('game-frame')?.contentWindow?.game?.roomData?.global?.board?.dumpSeq || 0
    ));
}

/** Resolve the 3 drawn tiles for dump visibility (handles draw-back from pool). */
async function resolveDumpSpawnIds(frame, beforeIds) {
    return frame.evaluate(({ ids }) => {
        const g = window.game;
        const handIds = (g?.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const beforeSet = new Set(ids);
        const byDiff = handIds.filter((id) => !beforeSet.has(id));
        if (byDiff.length === 3) return byDiff;
        const removed = ids.filter((id) => !handSet.has(id));
        if (byDiff.length === 2 && removed.length === 0 && handIds.length === ids.length + 2) {
            const dumpedId = ids[ids.length - 1];
            if (handSet.has(dumpedId)) return [...byDiff, dumpedId];
        }
        if (byDiff.length === 2 && removed.length === 1 && handSet.has(removed[0])) {
            return [...byDiff, removed[0]];
        }
        return byDiff;
    }, { ids: beforeIds });
}

/**
 * Wait until dump authority applied (+2 hand). Host flush optional for guest dumps.
 * @param {import('playwright').Frame} frame
 * @param {import('playwright').Page} [hostPage]
 */
async function waitForDumpAuthority(frame, beforeIds, hostPage = null, timeoutMs = STEP_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (hostPage) await flushHostBananaInteractions(hostPage);
        const ready = await frame.evaluate(({ ids }) => (
            (window.game?.tiles?.length || 0) === ids.length + 2
        ), { ids: beforeIds });
        if (ready) return true;
        await frame.waitForTimeout(POLL_INTERVAL_MS);
    }
    return false;
}

/** @param {import('playwright').Frame} frame */
async function waitForDumpInventory(frame, beforeIds, timeoutMs = STEP_MS) {
    await frame.waitForFunction(({ ids }) => {
        const g = window.game;
        if (!g?.tiles?.length) return false;
        return g.tiles.length === ids.length + 2;
    }, { ids: beforeIds }, { timeout: timeoutMs });
}

/** @param {import('playwright').Page} [hostPage] host hub page (guest dumps) */
async function waitForBoardDumpSeq(hostPage, dumpSeqBefore, timeoutMs = STEP_MS) {
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
            handBeforeCount: ids.length,
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
    const spawnIds = await resolveDumpSpawnIds(frame, beforeIds);
    const fail = (reason, extra = {}) => ({
        ok: false,
        phase: 'board',
        reason,
        spawnIds,
        ...snap,
        ...extra
    });

    const expectedHand = (snap.handBeforeCount ?? beforeIds.length) + 2;
    if (snap.localCount !== expectedHand) {
        return fail('hand-count-not-plus-2', { expectedHand, localCount: snap.localCount });
    }
    if (spawnIds.length !== 3) {
        return fail('spawn-batch-not-3', { spawnIds, addedByDiff: snap.added.length });
    }
    if (snap.ownedCount !== snap.localCount) {
        return fail('owned-local-count-mismatch', {
            ownedCount: snap.ownedCount,
            localCount: snap.localCount
        });
    }
    const ownedSet = new Set(snap.ownedIds);
    for (const id of spawnIds) {
        if (!ownedSet.has(id)) {
            return fail('spawn-id-missing-from-board-owned', { id });
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
    await waitForDumpInventory(frame, beforeIds, options.timeoutMs ?? STEP_MS);
    await frame.evaluate(() => {
        window.game?.requestRender?.();
        return new Promise((r) => {
            requestAnimationFrame(() => requestAnimationFrame(r));
        });
    });

    const addedIds = await resolveDumpSpawnIds(frame, beforeIds);

    return evalDumpTileVisibility(frame, addedIds, label, mobile);
}

/** Poll visibility — catches tiles that spawn then vanish after MP layout/sync. */
async function assertDumpTilesStable(frame, beforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    const delays = options.delaysMs || STABILITY_DELAYS_MS;
    const addedIds = await resolveDumpSpawnIds(frame, beforeIds);

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
 * In-frame: resolve spawn ids + DOM visibility in the same turn hand hits +2.
 * No test render nudge — catches tiles in model but not painted yet.
 */
async function probeDumpSpawnImmediate(frame, beforeIds, label, mobile) {
    return frame.evaluate(({ ids, lbl, mob }) => {
        const g = window.game;
        const handCount = g?.tiles?.length || 0;
        if (handCount !== ids.length + 2) {
            return { kind: 'wait', handCount, expected: ids.length + 2 };
        }

        const handIds = (g.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const beforeSet = new Set(ids);
        const byDiff = handIds.filter((id) => !beforeSet.has(id));
        let spawnIds = byDiff;
        if (byDiff.length === 2 && handIds.length === ids.length + 2) {
            const removed = ids.filter((id) => !handSet.has(id));
            if (removed.length === 0) spawnIds = [...byDiff, ids[ids.length - 1]];
            else if (removed.length === 1 && handSet.has(removed[0])) spawnIds = [...byDiff, removed[0]];
        }
        if (spawnIds.length !== 3) {
            return { kind: 'ready', ok: false, label: lbl, reason: 'spawn-ids-not-3', spawnIds };
        }

        const renderTiles = typeof g._tilesForRender === 'function' ? g._tilesForRender() : (g.tiles || []);
        const renderIds = new Set(renderTiles.map((t) => t.id));
        const hostRect = document.getElementById('game-container')?.getBoundingClientRect();
        const clip = hostRect && hostRect.width > 0
            ? hostRect
            : {
                left: 0, top: 0,
                right: window.innerWidth,
                bottom: window.innerHeight,
                width: window.innerWidth,
                height: window.innerHeight
            };
        const minDim = mob ? 10 : 8;
        const minRatio = mob ? 0.25 : 0.28;
        const fails = [];
        const domDiag = [];

        for (const id of spawnIds) {
            const model = (g.tiles || []).find((t) => t.id === id);
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            const entry = {
                id,
                inModel: !!model,
                inRender: renderIds.has(id),
                domPresent: !!el,
                rect: null
            };
            if (!el) {
                fails.push({ id, reason: 'missing-dom' });
                domDiag.push(entry);
                continue;
            }
            const style = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            entry.rect = { w: r.width, h: r.height };
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
                fails.push({ id, reason: 'css-hidden' });
                domDiag.push(entry);
                continue;
            }
            if (r.width < minDim || r.height < minDim) {
                fails.push({ id, reason: 'tiny-rect', w: r.width, h: r.height });
                domDiag.push(entry);
                continue;
            }
            const tileArea = Math.max(r.width * r.height, 1);
            const visLeft = Math.max(r.left, clip.left);
            const visTop = Math.max(r.top, clip.top);
            const visRight = Math.min(r.right, clip.right);
            const visBottom = Math.min(r.bottom, clip.bottom);
            const visArea = Math.max(0, visRight - visLeft) * Math.max(0, visBottom - visTop);
            if (visArea / tileArea < minRatio) {
                fails.push({ id, reason: 'clipped-off-canvas', ratio: visArea / tileArea });
                domDiag.push(entry);
                continue;
            }
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            if (hit !== el && !el.contains(hit)) {
                fails.push({ id, reason: 'hit-test-miss' });
            }
            domDiag.push(entry);
        }

        return {
            kind: 'ready',
            ok: fails.length === 0,
            label: lbl,
            spawnIds,
            fails,
            domDiag,
            handCount
        };
    }, { ids: beforeIds, lbl: label, mob: mobile });
}

/**
 * Probe: dumped tile no longer visible at hold position (same-id redraw must move).
 * @param {import('playwright').Frame} frame
 */
async function probeDumpTileRemoved(frame, beforeIds, heldTileId, label, mobile, heldWorldPos = null, heldScreenPos = null) {
    return frame.evaluate(({ ids, heldId, heldPos, heldScreen, lbl, mob }) => {
        const g = window.game;
        const handIds = (g?.tiles || []).map((t) => t.id);
        const handCount = handIds.length;

        const tileVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
                return false;
            }
            const r = el.getBoundingClientRect();
            return r.width >= (mob ? 10 : 8) && r.height >= (mob ? 10 : 8);
        };

        if (handCount !== ids.length + 2) {
            return { kind: 'wait', handCount, expected: ids.length + 2 };
        }

        const handSet = new Set(handIds);
        const dumpedIds = ids.filter((id) => !handSet.has(id));
        const dumpedCheck = heldId ? [heldId] : dumpedIds;
        const renderTiles = typeof g._tilesForRender === 'function' ? g._tilesForRender() : (g.tiles || []);
        const renderIds = new Set(renderTiles.map((t) => t.id));
        const fails = [];

        for (const id of dumpedCheck) {
            if (!id) continue;
            const model = (g.tiles || []).find((t) => t.id === id);
            const sameIdRedraw = handSet.has(id);
            if (sameIdRedraw && id === heldId && heldPos && model) {
                const modelAtHold = Math.abs(model.x - heldPos.x) < 8 && Math.abs(model.y - heldPos.y) < 8;
                const el = document.querySelector(`[data-tile-id="${id}"]`);
                let screenAtHold = false;
                if (heldScreen && el && tileVisible(el)) {
                    const r = el.getBoundingClientRect();
                    const sx = r.left + r.width / 2;
                    const sy = r.top + r.height / 2;
                    screenAtHold = Math.hypot(sx - heldScreen.x, sy - heldScreen.y) < 12;
                }
                if (modelAtHold && screenAtHold) {
                    return { kind: 'wait', handCount, expected: ids.length + 2, reason: 'same-id-at-hold' };
                }
                continue;
            }
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            if (tileVisible(el)) {
                if (!sameIdRedraw && !renderIds.has(id)) {
                    return { kind: 'wait', handCount, expected: ids.length + 2, reason: 'stale-dom' };
                }
                fails.push({ id, reason: 'dumped-tile-still-visible' });
            }
            if (!sameIdRedraw && renderIds.has(id)) {
                fails.push({ id, reason: 'dumped-tile-in-render-list' });
            }
        }

        return {
            kind: 'ready',
            ok: fails.length === 0,
            label: lbl,
            dumpedIds: dumpedCheck,
            fails,
            handCount
        };
    }, { ids: beforeIds, heldId: heldTileId, heldPos: heldWorldPos, heldScreen: heldScreenPos, lbl: label, mob: mobile });
}

const DUMP_REMOVE_STABILITY_MS = [0, 50, 200];

/**
 * Assert the dumped tile is removed from its hold position after authority applies.
 * Does not check spawn visibility — see assertDumpVisible (dump-lan-visible).
 */
async function assertDumpTileRemoved(frame, beforeIds, heldTileId, label, options = {}) {
    const mobile = !!options.mobile;
    const heldWorldPos = options.heldWorldPos || null;
    const heldScreenPos = options.heldScreenPos || null;
    const timeoutMs = options.timeoutMs ?? STEP_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const probe = await probeDumpTileRemoved(
            frame, beforeIds, heldTileId, label, mobile, heldWorldPos, heldScreenPos
        );
        if (probe.kind === 'wait') {
            await frame.waitForTimeout(POLL_INTERVAL_MS);
            continue;
        }
        if (!probe.ok) {
            const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
            return {
                ok: false,
                label,
                phase: 'removed',
                reason: probe.fails?.[0]?.reason || 'dumped-tile-still-present',
                fails: probe.fails,
                snap
            };
        }

        for (const delay of DUMP_REMOVE_STABILITY_MS) {
            if (delay > 0) await frame.waitForTimeout(delay);
            const stable = await probeDumpTileRemoved(
                frame, beforeIds, heldTileId, label, mobile, heldWorldPos, heldScreenPos
            );
            if (stable.kind !== 'ready' || !stable.ok) {
                const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
                return {
                    ok: false,
                    label,
                    phase: 'stability',
                    failedAtMs: delay,
                    reason: stable.fails?.[0]?.reason || 'dumped-tile-reappeared',
                    fails: stable.fails,
                    snap
                };
            }
        }

        return { ok: true, label, phase: 'removed', dumpedIds: probe.dumpedIds };
    }

    const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
    return { ok: false, label, phase: 'removed', reason: 'authority-timeout', snap };
}

/**
 * Guest dump repro probe: hand +2, held tile gone, 3 spawns in model+render+DOM.
 * @param {import('playwright').Frame} frame
 */
async function probeGuestDumpRepro(frame, beforeIds, heldTileId, label, mobile, heldWorldPos = null) {
    return frame.evaluate(({ ids, heldId, heldPos, lbl, mob }) => {
        const g = window.game;
        const handIds = (g?.tiles || []).map((t) => t.id);
        const handCount = handIds.length;

        const tileVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
                return false;
            }
            const r = el.getBoundingClientRect();
            return r.width >= (mob ? 10 : 8) && r.height >= (mob ? 10 : 8);
        };

        if (handCount !== ids.length + 2) {
            return { kind: 'wait', handCount, expected: ids.length + 2 };
        }

        const handSet = new Set(handIds);
        const beforeSet = new Set(ids);
        const byDiff = handIds.filter((id) => !beforeSet.has(id));
        let spawnIds = byDiff;
        if (byDiff.length === 2 && handIds.length === ids.length + 2) {
            const removed = ids.filter((id) => !handSet.has(id));
            if (removed.length === 0) spawnIds = [...byDiff, ids[ids.length - 1]];
            else if (removed.length === 1 && handSet.has(removed[0])) spawnIds = [...byDiff, removed[0]];
        }
        if (spawnIds.length !== 3) {
            return { kind: 'ready', ok: false, label: lbl, reason: 'spawn-ids-not-3', spawnIds };
        }

        const dumpedIds = ids.filter((id) => !handSet.has(id));
        const dumpedCheck = heldId ? [heldId] : dumpedIds;
        const renderTiles = typeof g._tilesForRender === 'function' ? g._tilesForRender() : (g.tiles || []);
        const renderIds = new Set(renderTiles.map((t) => t.id));

        const hostRect = document.getElementById('game-container')?.getBoundingClientRect();
        const clip = hostRect && hostRect.width > 0
            ? hostRect
            : {
                left: 0, top: 0,
                right: window.innerWidth,
                bottom: window.innerHeight,
                width: window.innerWidth,
                height: window.innerHeight
            };
        const minDim = mob ? 10 : 8;
        const minRatio = mob ? 0.25 : 0.28;
        const fails = [];
        const domDiag = [];
        const positions = {};

        for (const id of dumpedCheck) {
            if (!id) continue;
            const sameIdRedraw = spawnIds.includes(id);
            if (sameIdRedraw && id === heldId && heldPos) {
                const model = (g.tiles || []).find((t) => t.id === id);
                if (model
                    && Math.abs(model.x - heldPos.x) < 8
                    && Math.abs(model.y - heldPos.y) < 8) {
                    fails.push({ id, reason: 'same-id-redraw-same-position' });
                }
                continue;
            }
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            if (tileVisible(el)) {
                fails.push({ id, reason: 'dumped-tile-still-visible' });
            }
            if (renderIds.has(id)) {
                fails.push({ id, reason: 'dumped-tile-in-render-list' });
            }
        }

        for (const id of spawnIds) {
            const model = (g.tiles || []).find((t) => t.id === id);
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            const entry = {
                id,
                inModel: !!model,
                inRender: renderIds.has(id),
                domPresent: !!el,
                rect: null
            };
            if (!model) {
                fails.push({ id, reason: 'missing-model' });
                domDiag.push(entry);
                continue;
            }
            if (!renderIds.has(id)) {
                fails.push({ id, reason: 'missing-render-list' });
            }
            if (!el) {
                fails.push({ id, reason: 'missing-dom' });
                domDiag.push(entry);
                continue;
            }
            const style = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            entry.rect = { w: r.width, h: r.height, x: r.left, y: r.top };
            positions[id] = { x: r.left, y: r.top };
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
                fails.push({ id, reason: 'css-hidden' });
                domDiag.push(entry);
                continue;
            }
            if (r.width < minDim || r.height < minDim) {
                fails.push({ id, reason: 'tiny-rect', w: r.width, h: r.height });
                domDiag.push(entry);
                continue;
            }
            const tileArea = Math.max(r.width * r.height, 1);
            const visLeft = Math.max(r.left, clip.left);
            const visTop = Math.max(r.top, clip.top);
            const visRight = Math.min(r.right, clip.right);
            const visBottom = Math.min(r.bottom, clip.bottom);
            const visArea = Math.max(0, visRight - visLeft) * Math.max(0, visBottom - visTop);
            if (visArea / tileArea < minRatio) {
                fails.push({ id, reason: 'clipped-off-canvas', ratio: visArea / tileArea });
                domDiag.push(entry);
                continue;
            }
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            if (hit !== el && !el.contains(hit)) {
                fails.push({ id, reason: 'hit-test-miss' });
            }
            domDiag.push(entry);
        }

        return {
            kind: 'ready',
            ok: fails.length === 0,
            label: lbl,
            spawnIds,
            dumpedIds: dumpedCheck,
            fails,
            domDiag,
            positions,
            handCount
        };
    }, { ids: beforeIds, heldId: heldTileId, heldPos: heldWorldPos, lbl: label, mob: mobile });
}

/**
 * Phone guest dump visibility — 3 spawns paint immediately, no flash/jitter.
 * Used by dump-lan-visible only (LAN phone + stale RTDB echo repro).
 */
async function assertDumpVisible(frame, beforeIds, heldTileId, label, options = {}) {
    const mobile = options.mobile !== false;
    const heldWorldPos = options.heldWorldPos || null;
    const timeoutMs = options.timeoutMs ?? STEP_MS;
    const deadline = Date.now() + timeoutMs;
    let baselinePositions = null;

    while (Date.now() < deadline) {
        const probe = await probeGuestDumpRepro(
            frame, beforeIds, heldTileId, label, mobile, heldWorldPos
        );
        if (probe.kind === 'wait') {
            await frame.waitForTimeout(POLL_INTERVAL_MS);
            continue;
        }
        if (!probe.ok) {
            const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
            return {
                ok: false,
                label,
                phase: 'immediate',
                reason: probe.fails?.[0]?.reason || 'not-visible',
                fails: probe.fails,
                domDiag: probe.domDiag,
                spawnIds: probe.spawnIds,
                snap
            };
        }

        baselinePositions = probe.positions;
        for (const delay of GUEST_DUMP_STABILITY_MS) {
            await frame.waitForTimeout(delay);
            const stable = await probeGuestDumpRepro(
                frame, beforeIds, heldTileId, label, mobile, heldWorldPos
            );
            if (stable.kind !== 'ready' || !stable.ok) {
                const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
                return {
                    ok: false,
                    label,
                    phase: 'stability',
                    failedAtMs: delay,
                    reason: stable.fails?.[0]?.reason || stable.reason || 'vanished-after-spawn',
                    fails: stable.fails,
                    domDiag: stable.domDiag,
                    snap
                };
            }
            for (const id of stable.spawnIds || []) {
                const a = baselinePositions?.[id];
                const b = stable.positions?.[id];
                if (!a || !b) continue;
                const jitter = Math.hypot(b.x - a.x, b.y - a.y);
                if (jitter > GUEST_DUMP_JITTER_PX) {
                    const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
                    return {
                        ok: false,
                        label,
                        phase: 'stability',
                        failedAtMs: delay,
                        reason: 'jitter',
                        id,
                        jitterPx: jitter,
                        from: a,
                        to: b,
                        snap
                    };
                }
            }
            baselinePositions = stable.positions;
        }

        return { ok: true, label, phase: 'guest-repro', spawnIds: probe.spawnIds };
    }

    const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
    return { ok: false, label, phase: 'guest-repro', reason: 'authority-timeout', snap };
}

/**
 * Immediate spawn visibility — authority + DOM checked in one in-frame turn (no paint gap).
 * @param {import('playwright').Frame} frame
 * @param {import('playwright').Page} [options.hostPage]
 */
async function assertDumpSpawnImmediate(frame, beforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    const timeoutMs = options.timeoutMs ?? STEP_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const probe = await probeDumpSpawnImmediate(frame, beforeIds, label, mobile);
        if (probe.kind === 'ready') {
            if (probe.ok) {
                return { ok: true, label, phase: 'immediate', spawnIds: probe.spawnIds };
            }
            const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
            return {
                ok: false,
                label,
                phase: 'immediate',
                reason: probe.fails?.[0]?.reason || 'not-dom-visible',
                fails: probe.fails,
                domDiag: probe.domDiag,
                spawnIds: probe.spawnIds,
                snap
            };
        }
        await frame.waitForTimeout(POLL_INTERVAL_MS);
    }

    const snap = await snapshotDumpSpawnState(frame, beforeIds, options);
    return {
        ok: false,
        label,
        phase: 'immediate',
        reason: 'authority-timeout',
        snap
    };
}

/**
 * One hold-dump must advance dumpSeq by exactly 1 and hand by exactly +2.
 * Watches through a settle window for a late second dump (flake ~1/15–1/20).
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Frame} guestFrame
 */
async function assertExactlyOneGuestDump(hostPage, guestFrame, beforeIds, dumpSeqBefore, label, options = {}) {
    const expectedHand = beforeIds.length + 2;
    const expectedDumpSeq = dumpSeqBefore + 1;
    const guestUid = options.guestUid || null;
    const fast = !!options.fast;
    const timeoutMs = options.timeoutMs ?? STEP_MS;
    const settleMs = options.settleMs ?? (fast ? SINGLE_DUMP_SETTLE_FAST_MS : SINGLE_DUMP_SETTLE_MS);
    const pollMs = fast ? Math.min(20, POLL_INTERVAL_MS) : POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    const fail = (reason, snap, dumpSeqNow) => ({
        ok: false,
        label,
        phase: 'single-dump',
        reason,
        dumpSeqBefore,
        dumpSeqNow,
        expectedDumpSeq,
        expectedHand,
        snap
    });

    const readState = async () => {
        const [snap, dumpSeqNow] = await Promise.all([
            snapshotDumpSpawnState(guestFrame, beforeIds, options),
            readHostDumpSeq(hostPage)
        ]);
        return { snap, dumpSeqNow };
    };

    let ready = false;
    while (Date.now() < deadline) {
        if (fast) await flushHostBananaInteractions(hostPage);
        const { snap, dumpSeqNow } = await readState();

        if (dumpSeqNow >= dumpSeqBefore + 2 || snap.localCount >= beforeIds.length + 4) {
            return fail('double-dump', snap, dumpSeqNow);
        }
        if (snap.localCount === expectedHand && dumpSeqNow >= expectedDumpSeq) {
            ready = true;
            break;
        }
        await guestFrame.waitForTimeout(pollMs);
    }

    if (!ready) {
        const { snap, dumpSeqNow } = await readState();
        return fail('authority-timeout', snap, dumpSeqNow);
    }

    const settleEnd = Date.now() + settleMs;
    while (Date.now() < settleEnd) {
        const { snap, dumpSeqNow } = await readState();
        if (dumpSeqNow > expectedDumpSeq || snap.localCount > expectedHand) {
            return fail('double-dump-after-settle', snap, dumpSeqNow);
        }
        await guestFrame.waitForTimeout(pollMs);
    }

    const { snap, dumpSeqNow } = await readState();

    if (dumpSeqNow !== expectedDumpSeq) {
        const reason = dumpSeqNow > expectedDumpSeq ? 'double-dump-seq' : 'dump-seq-not-advanced';
        return fail(reason, snap, dumpSeqNow);
    }
    if (snap.localCount !== expectedHand) {
        return fail('hand-count-wrong', snap, dumpSeqNow);
    }
    if (guestUid && snap.dumpActorUid !== guestUid) {
        return fail('wrong-dump-actor', snap, dumpSeqNow);
    }

    return {
        ok: true,
        label,
        phase: 'single-dump',
        dumpSeq: dumpSeqNow,
        handCount: snap.localCount,
        removedId: snap.removed[0]
    };
}

/**
 * Fast path: board + visible (+ optional short in-page stability). One round-trip.
 * @param {import('playwright').Frame} frame
 */
async function assertDumpSpawnQuick(frame, beforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    const timeoutMs = options.timeoutMs ?? STEP_MS;
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

    const addedIds = await resolveDumpSpawnIds(frame, beforeIds);

    await frame.waitForFunction(({ aids }) => aids.every((id) => {
        const el = document.querySelector(`[data-tile-id="${id}"]`);
        return el && el.getBoundingClientRect().width > 4;
    }), { aids: addedIds }, { timeout: timeoutMs }).catch(() => {});

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
async function waitForDumpTilesReady(frame, beforeIds, timeoutMs = STEP_MS) {
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
    assertDumpSpawnImmediate,
    assertDumpTileRemoved,
    assertDumpVisible,
    /** @deprecated use assertDumpVisible */
    assertGuestDumpSpawnRepro: assertDumpVisible,
    assertExactlyOneGuestDump,
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
    waitForDumpAuthority,
    resolveDumpSpawnIds,
    assertDumpSpawnSeparation,
    waitForDumpTilesReady,
    STABILITY_FULL_MS,
    MIN_DUMP_POOL,
    SINGLE_DUMP_SETTLE_FAST_MS,
    readGuestBunchLen
};
