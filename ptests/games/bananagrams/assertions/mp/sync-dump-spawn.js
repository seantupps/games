const { failWithSnapshot } = require('../core/format-failure');
const { logDumpSpawnFailure } = require('../spawn/dump');

/** MP dump spawn — guest pending UI + 3 tiles visible together on host/guest. */

const DEFAULT_MAX_SKEW_MS = Number(process.env.FIVE_MP_DUMP_SPAWN_MAX_SKEW_MS || 300);
const DEFAULT_MAX_BATCH_SPREAD_MS = Number(process.env.FIVE_MP_DUMP_SPAWN_MAX_BATCH_SPREAD_MS || 50);
const DEFAULT_GUEST_REMOVE_MS = Number(process.env.FIVE_MP_DUMP_GUEST_REMOVE_MS || 80);
const DEFAULT_TIMEOUT_MS = Number(process.env.FIVE_MP_DUMP_SPAWN_TIMEOUT_MS || 4000);
const DUMP_DRAW_COUNT = 3;
const POLL_MS = 16;

/** @param {import('playwright').Page} page */
async function snapshotDumpSpawnDom(page, beforeIds, expectedCount = DUMP_DRAW_COUNT) {
    return page.evaluate(({ ids, exp }) => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        const doc = frame?.contentDocument;
        if (!g || !doc) {
            return { ok: false, reason: 'no-frame', visibleIds: [], addedCount: 0 };
        }

        const drawCount = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
        const handIds = (g.tiles || []).map((t) => t.id);
        const handReady = handIds.length === ids.length + 2;
        const txn = g.roomData?.global?.board?.lastDumpTxn;
        let spawnIds = Array.isArray(txn?.addedTileIds) && txn.addedTileIds.length === drawCount
            ? txn.addedTileIds.filter((id) => handIds.includes(id))
            : handIds.filter((id) => !ids.includes(id));
        if (spawnIds.length === drawCount - 1 && txn?.dumpedTileId && handIds.includes(txn.dumpedTileId)) {
            spawnIds = [...spawnIds, txn.dumpedTileId];
        }
        const added = spawnIds.map((id) => g.tiles.find((t) => t.id === id)).filter(Boolean);
        const visibleIds = [];
        const fails = [];

        for (const t of added) {
            const el = doc.querySelector(`[data-tile-id="${t.id}"]`);
            if (!el) {
                fails.push({ id: t.id, reason: 'no-dom' });
                continue;
            }
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
                fails.push({ id: t.id, reason: 'css-hidden' });
                continue;
            }
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) {
                fails.push({ id: t.id, reason: 'tiny-rect', w: r.width, h: r.height });
                continue;
            }
            visibleIds.push(t.id);
        }

        return {
            ok: handReady && visibleIds.length === exp && added.length >= exp,
            visibleIds,
            addedCount: added.length,
            handReady,
            fails,
            modelHasDumped: ids.length > 0
        };
    }, { ids: beforeIds, exp: expectedCount });
}

/** Guest dump before authority: tile stays in model+DOM (pending UI only — no optimistic hide). */
async function assertGuestDumpRemovedImmediate(frame, dumpedTileId, label, maxMs = DEFAULT_GUEST_REMOVE_MS, guestBeforeIds = null) {
    if (Array.isArray(guestBeforeIds) && guestBeforeIds.length) {
        const authorityApplied = await frame.evaluate(({ ids }) => (
            (window.game?.tiles?.length || 0) === ids.length + 2
        ), { ids: guestBeforeIds });
        if (authorityApplied) {
            return { skipped: true, reason: 'authority-applied' };
        }
    }

    const result = await frame.evaluate(async ({ tileId, maxMs: limit, guestBeforeIds: ids }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const t0 = performance.now();
        let sawPending = false;

        while (performance.now() - t0 < limit) {
            const g = window.game;
            const pendingId = g?._guestDumpPendingTileId || null;
            if (pendingId === tileId) sawPending = true;
            const el = document.querySelector(`.tile[data-tile-id="${tileId}"]`);
            const inModel = (g?.tiles || []).some((t) => t.id === tileId);
            const authorityApplied = ids?.length
                ? (g?.tiles?.length || 0) === ids.length + 2
                : false;
            if (authorityApplied || (sawPending && inModel && el)) break;
            await sleep(8);
        }

        const el = document.querySelector(`.tile[data-tile-id="${tileId}"]`);
        return {
            dumpPendingTileId: window.game?._guestDumpPendingTileId || null,
            stillInModel: (window.game?.tiles || []).some((t) => t.id === tileId),
            stillInDom: !!el,
            hasPendingClass: el?.classList.contains('is-dump-pending') ?? false,
            sawPending
        };
    }, { tileId: dumpedTileId, maxMs, guestBeforeIds: guestBeforeIds || [] });

    const problems = [];
    const authorityApplied = Array.isArray(guestBeforeIds) && guestBeforeIds.length
        ? await frame.evaluate(({ ids }) => (
            (window.game?.tiles?.length || 0) === ids.length + 2
        ), { ids: guestBeforeIds })
        : false;

    if (!authorityApplied) {
        if (!result.stillInModel) {
            problems.push(`dumped tile ${dumpedTileId} removed from model before authority`);
        }
        if (!result.stillInDom) {
            problems.push(`dumped tile ${dumpedTileId} missing from DOM before authority (render must match model)`);
        }
        if (result.sawPending && result.stillInDom && !result.hasPendingClass) {
            problems.push(`dumped tile ${dumpedTileId} pending but missing is-dump-pending class`);
        }
    }

    if (problems.length) {
        logDumpSpawnFailure(label, { dumpedTileId, maxMs, ...result }, { problems });
        failWithSnapshot(label, problems, { dumpedTileId, maxMs, ...result });
    }
    return result;
}

/**
 * Poll dump spawn DOM on one page; returns ms when each tile appears + when batch complete.
 * @param {import('playwright').Page} page
 */
async function measureDumpSpawnDomMs(page, beforeIds, t0, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const expectedCount = options.expectedCount ?? DUMP_DRAW_COUNT;
    const perTileMs = {};
    let allVisibleMs = null;
    const deadline = t0 + timeoutMs;

    while (Date.now() < deadline) {
        if (page.isClosed()) break;
        const snap = await snapshotDumpSpawnDom(page, beforeIds, expectedCount);
        for (const id of snap.visibleIds || []) {
            if (perTileMs[id] == null) perTileMs[id] = Date.now() - t0;
        }
        if (snap.ok && allVisibleMs == null) {
            allVisibleMs = Date.now() - t0;
            break;
        }
        try {
            await page.waitForTimeout(POLL_MS);
        } catch (err) {
            if (page.isClosed() || /closed|destroyed/i.test(String(err?.message || ''))) break;
            throw err;
        }
    }

    const times = Object.values(perTileMs);
    const spread = times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0;
    return { allVisibleMs, perTileMs, spread, visibleCount: times.length };
}

function batchSpread(perTileMs) {
    const times = Object.values(perTileMs || {});
    if (times.length < 2) return 0;
    return Math.max(...times) - Math.min(...times);
}

/** @param {import('playwright').Page} hostPage */
async function measureDumpAuthorityMs(hostPage, dumpSeqBefore, actorUid, t0, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = t0 + timeoutMs;
    while (Date.now() < deadline) {
        if (hostPage.isClosed()) return null;
        const applied = await hostPage.evaluate(({ seq, uid }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return (board?.dumpSeq || 0) > seq && board?.dumpActorUid === uid;
        }, { seq: dumpSeqBefore, uid: actorUid });
        if (applied) return Date.now() - t0;
        try {
            await hostPage.waitForTimeout(POLL_MS);
        } catch (err) {
            if (hostPage.isClosed() || /closed|destroyed/i.test(String(err?.message || ''))) return null;
            throw err;
        }
    }
    return null;
}

/**
 * Fire guest dump and assert:
 * 1) dumped tile stays in model+DOM while pending (SSOT — no optimistic hide)
 * 2) all 3 spawn tiles DOM-visible together on guest (batch spread)
 * 3) guest DOM batch vs host authority apply within maxSkewMs
 */
async function assertDumpSpawnVisibleSameTime(opts) {
    const {
        page1,
        page2,
        dumpFrame,
        guestBeforeIds,
        label,
        dumpSeqBefore,
        actorUid,
        maxSkewMs = DEFAULT_MAX_SKEW_MS,
        maxBatchSpreadMs = DEFAULT_MAX_BATCH_SPREAD_MS,
        guestRemoveMs = DEFAULT_GUEST_REMOVE_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS
    } = opts;

    const dumpRes = await opts.dumpEvaluate();
    if (!dumpRes?.ok) {
        failWithSnapshot(label, ['dump trigger failed'], { dumpRes });
    }

    await assertGuestDumpRemovedImmediate(
        dumpFrame,
        dumpRes.dumpedTileId,
        `${label} guest dump pending visible`,
        guestRemoveMs,
        guestBeforeIds
    );

    const flushHost = opts.flushHost;
    if (flushHost) await flushHost();

    const t0 = Date.now();
    let authorityMs = null;
    let guestAllVisibleMs = null;
    const guestPerTileMs = {};
    const deadline = t0 + timeoutMs;

    while (Date.now() < deadline) {
        if (page1.isClosed() || page2.isClosed()) break;
        if (flushHost) await flushHost();

        if (authorityMs == null && dumpSeqBefore != null && actorUid) {
            const applied = await page1.evaluate(({ seq, uid }) => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const room = g?.roomData;
                const board = (typeof RtdbSchema !== 'undefined' && room)
                    ? RtdbSchema.readBoardFromRoom(room)
                    : room?.global?.board;
                return (board?.dumpSeq || 0) > seq && board?.dumpActorUid === uid;
            }, { seq: dumpSeqBefore, uid: actorUid });
            if (applied) authorityMs = Date.now() - t0;
        }

        const guestSnap = await snapshotDumpSpawnDom(page2, guestBeforeIds);
        const elapsed = Date.now() - t0;
        for (const id of guestSnap.visibleIds || []) {
            if (guestPerTileMs[id] == null) guestPerTileMs[id] = elapsed;
        }
        if (guestSnap.ok && guestAllVisibleMs == null) guestAllVisibleMs = elapsed;

        if (authorityMs != null && guestAllVisibleMs != null) break;

        try {
            await page1.waitForTimeout(POLL_MS);
        } catch (err) {
            if (page1.isClosed() || page2.isClosed() || /closed|destroyed/i.test(String(err?.message || ''))) break;
            throw err;
        }
    }

    const guestSpread = batchSpread(guestPerTileMs);
    const guestTiming = { allVisibleMs: guestAllVisibleMs, perTileMs: guestPerTileMs, spread: guestSpread };

    if (authorityMs == null || guestAllVisibleMs == null) {
        const guestSnap = await snapshotDumpSpawnDom(page2, guestBeforeIds);
        logDumpSpawnFailure(label, guestSnap, { authorityMs, guestTiming, reason: 'visibility-timeout' });
        failWithSnapshot(label, ['dump spawn visibility timeout'], {
            authorityMs,
            guestTiming,
            guestSnap
        });
    }

    if (guestSpread > maxBatchSpreadMs) {
        logDumpSpawnFailure(label, { guestSpread, maxBatchSpreadMs }, { authorityMs, guestTiming });
        failWithSnapshot(label, [
            `guest dump batch spread ${guestSpread}ms exceeds ${maxBatchSpreadMs}ms`
        ], { authorityMs, guestTiming });
    }

    const skew = Math.abs(authorityMs - guestAllVisibleMs);
    if (skew > maxSkewMs) {
        logDumpSpawnFailure(label, { skew, maxSkewMs }, { authorityMs, guestTiming });
        failWithSnapshot(label, [`dump spawn skew ${skew}ms exceeds ${maxSkewMs}ms`], {
            authorityMs,
            guestTiming
        });
    }

    return {
        authorityMs,
        guestMs: guestAllVisibleMs,
        guestSpread,
        skew,
        maxSkewMs,
        maxBatchSpreadMs,
        guestPerTileMs
    };
}

module.exports = {
    assertDumpSpawnVisibleSameTime,
    assertGuestDumpRemovedImmediate,
    snapshotDumpSpawnDom,
    measureDumpSpawnDomMs,
    DEFAULT_MAX_SKEW_MS,
    DEFAULT_MAX_BATCH_SPREAD_MS,
    DEFAULT_GUEST_REMOVE_MS
};
