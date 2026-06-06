/**
 * Dump spawn checks — RTDB board state, local hand, DOM visibility on the real canvas,
 * stability across sync/render (catches tiles that flash then disappear on mobile).
 */
const { assertDealStable: assertStartingRackStable } = require('../lib/mp-state');

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

/** @param {import('playwright').Frame} frame */
async function evalDumpTileVisibility(frame, addedIds, label, mobile) {
    return frame.evaluate(({ addedIds: aids, label: lbl, mobile: mob }) => {
    const g = window.game;
    const addedIds = aids;
    const label = lbl;
    const mobile = mob;
    const added = g.tiles.filter((t) => addedIds.includes(t.id));
    if (added.length !== 3) {
        return {
            ok: false,
            label,
            phase: 'local-hand',
            reason: 'added-count',
            expected: 3,
            got: added.length,
            addedIds
        };
    }

    // Pan/zoom: clip to #game-container, not #board-canvas (see shared/platform/viewport.js).
    const hostRect = document.getElementById('game-container')?.getBoundingClientRect();
    const clip = hostRect && hostRect.width > 0
        ? hostRect
        : {
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
            width: window.innerWidth,
            height: window.innerHeight
        };
    if (!clip || clip.width < 8 || clip.height < 8) {
        return { ok: false, label, phase: 'dom', reason: 'no-viewport-clip', clip: clip || null };
    }

    const minVisibleRatio = mobile ? 0.25 : 0.28;
    const minDim = mobile ? 10 : 8;
    const borderIns = (typeof BananaRules !== 'undefined'
        && typeof BananaRules.viewportSpawnBorderInsets === 'function')
        ? BananaRules.viewportSpawnBorderInsets({ game: g, mobile })
        : (mobile
            ? { top: 30, right: 30, bottom: 30, left: 30 }
            : { top: 32, right: 64, bottom: 32, left: 64 });
    const clipInset = {
        left: clip.left + borderIns.left,
        top: clip.top + borderIns.top,
        right: clip.right - borderIns.right,
        bottom: clip.bottom - borderIns.bottom,
        width: Math.max(0, clip.width - borderIns.left - borderIns.right),
        height: Math.max(0, clip.height - borderIns.top - borderIns.bottom)
    };
    const uiFails = [];

    const intersectArea = (a, b) => {
        const left = Math.max(a.left, b.left);
        const top = Math.max(a.top, b.top);
        const right = Math.min(a.right, b.right);
        const bottom = Math.min(a.bottom, b.bottom);
        if (right <= left || bottom <= top) return 0;
        return (right - left) * (bottom - top);
    };

    for (const t of added) {
        const el = document.querySelector(`[data-tile-id="${t.id}"]`);
        if (!el) {
            uiFails.push({ id: t.id, reason: 'missing-dom' });
            continue;
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
            uiFails.push({
                id: t.id,
                reason: 'css-hidden',
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity
            });
            continue;
        }

        const r = el.getBoundingClientRect();
        const tileArea = Math.max(r.width * r.height, 1);
        if (r.width < minDim || r.height < minDim) {
            uiFails.push({
                id: t.id,
                reason: 'tiny-rect',
                rect: { left: r.left, top: r.top, width: r.width, height: r.height }
            });
            continue;
        }

        const visibleArea = intersectArea(r, clipInset);
        const ratio = visibleArea / tileArea;
        if (ratio < minVisibleRatio) {
            uiFails.push({
                id: t.id,
                reason: 'clipped-off-canvas',
                visibleRatio: Math.round(ratio * 100) / 100,
                need: minVisibleRatio,
                rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                clip: {
                    left: clipInset.left,
                    top: clipInset.top,
                    right: clipInset.right,
                    bottom: clipInset.bottom
                }
            });
            continue;
        }

        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < clipInset.left || cy < clipInset.top || cx > clipInset.right || cy > clipInset.bottom) {
            uiFails.push({
                id: t.id,
                reason: 'center-outside-canvas',
                center: { x: cx, y: cy },
                clip: {
                    left: clipInset.left,
                    top: clipInset.top,
                    right: clipInset.right,
                    bottom: clipInset.bottom
                }
            });
            continue;
        }

        const hit = document.elementFromPoint(cx, cy);
        const onTile = hit === el || el.contains(hit);
        if (!onTile) {
            uiFails.push({
                id: t.id,
                reason: 'hit-test-miss',
                hitTag: hit?.tagName,
                hitClass: hit?.className,
                center: { x: cx, y: cy }
            });
            continue;
        }

        const size = BananaRules.TILE_SIZE;
        const gap = BananaRules.TILE_GAP;
        const others = g.tiles.filter((ot) => !addedIds.includes(ot.id));
        if (typeof BananaRules.tilesSpawnBlocked === 'function') {
            for (const a of added) {
                for (const o of others) {
                    if (BananaRules.tilesSpawnBlocked(a.x, a.y, o.x, o.y, size, gap)) {
                        uiFails.push({
                            id: a.id,
                            reason: 'connected-to-existing',
                            added: { id: a.id, x: a.x, y: a.y },
                            existing: { id: o.id, x: o.x, y: o.y }
                        });
                    }
                }
            }
        }
        if (added.length === 3
            && typeof BananaRules.isDumpBatchPlacementValid === 'function'
            && !BananaRules.isDumpBatchPlacementValid(added, gap)) {
            uiFails.push({
                id: added[0]?.id,
                reason: 'dump-batch-invalid-placement',
                positions: added.map((t) => ({ id: t.id, x: t.x, y: t.y }))
            });
        }

        if (typeof g._getVisibleWorldBounds === 'function') {
            const vb = g._getVisibleWorldBounds({ forSpawn: true });
            const insideWorld = t.x >= vb.left
                && t.y >= vb.top
                && t.x + size <= vb.right
                && t.y + size <= vb.bottom;
            if (!insideWorld) {
                uiFails.push({
                    id: t.id,
                    reason: 'outside-visible-world-bounds',
                    world: { x: t.x, y: t.y },
                    visBounds: vb
                });
            }
        }
    }

    if (uiFails.length) {
        return {
            ok: false,
            label,
            phase: 'dom-visibility',
            uiFails,
            added: added.map((t) => ({ id: t.id, letter: t.letter, x: t.x, y: t.y }))
        };
    }

    return {
        ok: true,
        label,
        added: added.map((t) => ({ id: t.id, x: t.x, y: t.y }))
    };
    }, { addedIds, label, mobile });
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

module.exports = {
    assertStartingRackStable,
    assertDumpSpawnComplete,
    assertDumpSpawnQuick,
    assertDumpBoardState,
    assertDumpTilesVisible,
    assertDumpTilesStable,
    evalDumpTileVisibility,
    snapshotDumpSpawnState,
    waitForBoardDumpSeq,
    waitForDumpInventory,
    assertDumpSpawnSeparation,
    waitForDumpTilesReady,
    STABILITY_FULL_MS
};
