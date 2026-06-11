/**
 * Phone LAN dump flash-vanish repro helpers (test-only — no game source edits).
 *
 * Real phone path: hub RTDB snapshot → onNetworkUpdate → _applyMultiplayerBoard.
 * Emulator discrepancy: direct _applyMultiplayerBoard + same-machine RTDB skips the lag/ordering
 * that lets a stale pre-dump inventory echo land after spawns paint.
 */

/**
 * Deliver stale pre-dump guest inventory through the same path as a real RTDB snapshot.
 * @param {import('playwright').Frame} frame guest game iframe
 * @param {string[]} beforeIds hand tile ids before dump
 * @param {{ bypassStaleGuard?: boolean, lowerInventorySeq?: boolean }} [opts]
 */
async function deliverStaleDumpEchoViaNetworkUpdate(frame, beforeIds, opts = {}) {
    const { bypassStaleGuard = false, lowerInventorySeq = false } = opts;
    return frame.evaluate(({ ids, bypassGuard, lowerSeq }) => {
        const g = window.game;
        const uid = g._myUid();
        const board = g.roomData?.global?.board;
        if (!g || !uid || !board) return { ok: false, reason: 'no-board' };

        if (bypassGuard) {
            g.__dumpLanReproBypassStale = true;
            const orig = g._guestIsStalePreDumpBoard?.bind(g);
            g._guestIsStalePreDumpBoard = function (...args) {
                if (g.__dumpLanReproBypassStale) return false;
                return orig ? orig(...args) : false;
            };
        }

        const staleOwned = ids.map((id) => ({ id, faceUp: true }));
        const nextBoard = {
            ...JSON.parse(JSON.stringify(board)),
            tilesOwnedByPlayer: {
                ...(board.tilesOwnedByPlayer || {}),
                [uid]: staleOwned
            }
        };
        if (lowerSeq && nextBoard.inventorySeq) {
            nextBoard.inventorySeq = {
                ...nextBoard.inventorySeq,
                [uid]: Math.max(0, (nextBoard.inventorySeq[uid] ?? 1) - 1)
            };
        }

        const payload = {
            global: {
                ...(g.roomData?.global || {}),
                board: nextBoard
            },
            interactions: g.roomData?.interactions || {}
        };
        g.roomData = typeof g._mergeRoomSnapshot === 'function'
            ? g._mergeRoomSnapshot(g.roomData, payload)
            : payload;
        if (typeof g.onNetworkUpdate === 'function') {
            g.onNetworkUpdate(payload);
        } else {
            g._applyMultiplayerBoard?.(nextBoard);
        }
        if (typeof g._guestSyncBoardOwnedFromLocal === 'function') {
            g._guestSyncBoardOwnedFromLocal(uid);
        }
        g.requestRender?.();

        return {
            ok: true,
            bypassGuard,
            dumpSeq: nextBoard.dumpSeq,
            staleOwned: staleOwned.length,
            localCount: g.tiles?.length ?? 0
        };
    }, { ids: beforeIds, bypassGuard: bypassStaleGuard, lowerSeq: lowerInventorySeq });
}

/** Wait until 3 dump spawns are in the guest model and painted in the DOM. */
async function waitForDumpSpawnsPainted(frame, beforeIds, timeoutMs) {
    await frame.waitForFunction(({ ids }) => {
        const g = window.game;
        if ((g?.tiles?.length || 0) !== ids.length + 2) return false;
        const handIds = g.tiles.map((t) => t.id);
        const beforeSet = new Set(ids);
        const handSet = new Set(handIds);
        let spawnIds = handIds.filter((id) => !beforeSet.has(id));
        if (spawnIds.length === 2 && handIds.length === ids.length + 2) {
            const removed = ids.filter((id) => !handSet.has(id));
            if (removed.length === 0) spawnIds = [...spawnIds, ids[ids.length - 1]];
            else if (removed.length === 1 && handSet.has(removed[0])) spawnIds = [...spawnIds, removed[0]];
        }
        if (spawnIds.length !== 3) return false;
        return spawnIds.every((id) => {
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 10 && r.height >= 10;
        });
    }, { ids: beforeIds }, { timeout: timeoutMs });
}

const SPAWN_VANISH_WATCH_MS = [0, 16, 50, 100, 200, 350];

/**
 * After stale echo: spawn tiles must stay visible in the DOM (phone bug = they vanish).
 * Test failure here = bug reproduced.
 */
async function assertDumpSpawnsStayVisibleAfterStaleEcho(frame, beforeIds, label) {
    const probe = () => frame.evaluate(({ ids, lbl }) => {
        const g = window.game;
        const handIds = (g?.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const beforeSet = new Set(ids);
        let spawnIds = handIds.filter((id) => !beforeSet.has(id));
        if (spawnIds.length === 2 && handIds.length === ids.length + 2) {
            const removed = ids.filter((id) => !handSet.has(id));
            if (removed.length === 0) spawnIds = [...spawnIds, ids[ids.length - 1]];
            else if (removed.length === 1 && handSet.has(removed[0])) spawnIds = [...spawnIds, removed[0]];
        }
        const renderIds = new Set(
            (typeof g._tilesForRender === 'function' ? g._tilesForRender() : g.tiles || [])
                .map((t) => t.id)
        );
        const dom = spawnIds.map((id) => {
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            const r = el?.getBoundingClientRect();
            return {
                id,
                inModel: handIds.includes(id),
                inRender: renderIds.has(id),
                dom: !!el,
                w: r?.width ?? 0,
                h: r?.height ?? 0
            };
        });
        const bad = dom.filter((d) => !d.dom || d.w < 10 || d.h < 10);
        return {
            ok: spawnIds.length === 3 && bad.length === 0,
            label: lbl,
            spawnIds,
            dom,
            bad,
            handCount: handIds.length,
            boardOwned: g.roomData?.global?.board?.tilesOwnedByPlayer?.[g._myUid()]?.length ?? null
        };
    }, { ids: beforeIds, lbl: label });

    const history = [];
    for (const delay of SPAWN_VANISH_WATCH_MS) {
        if (delay > 0) await frame.waitForTimeout(delay);
        const snap = await probe();
        snap.delayMs = delay;
        history.push(snap);
        if (!snap.ok) {
            return {
                ok: false,
                label,
                phase: 'spawn-vanish',
                failedAtMs: delay,
                reason: snap.bad?.[0]
                    ? `${snap.bad[0].id}:${snap.bad[0].dom ? 'tiny' : 'missing-dom'}`
                    : 'spawn-not-visible',
                history,
                ...snap
            };
        }
    }
    return { ok: true, label, phase: 'spawn-stable', history };
}

module.exports = {
    deliverStaleDumpEchoViaNetworkUpdate,
    waitForDumpSpawnsPainted,
    assertDumpSpawnsStayVisibleAfterStaleEcho
};
