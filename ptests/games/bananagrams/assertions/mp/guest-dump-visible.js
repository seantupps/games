/**
 * Guest dump spawn — strict visual/render pipeline checks (no test-side optimistic fixes).
 * Reproduces "dump tiles not appearing on screen" for non-host players.
 */
const { failWithSnapshot } = require('../core/format-failure');
const { logDumpSpawnFailure } = require('../spawn/dump');
const { flushHostBananaInteractions } = require('../../../../shared/adapters/mp-client');
const { spawnPipelineSummary } = require('../../../../shared/infra/test-logger');

const DUMP_DRAW_COUNT = 3;
const DEFAULT_STABILITY_MS = [0, 30, 100, 250];
const DEFAULT_POLL_MS = 8;
const DEFAULT_IMMEDIATE_MS = Number(process.env.FIVE_MP_SPAWN_IMMEDIATE_MS || 0);

function collectGuestVisualProblems(snap, phase) {
    const problems = [];
    if (!snap.authorityApplied) {
        problems.push(`hand not at +2 (${snap.handCount} vs ${snap.expectedHandCount})`);
    }
    if (snap.inventorySynced && (snap.dumpUiPending?.tileId || snap.dumpPendingTileId)) {
        const id = snap.dumpUiPending?.tileId ?? snap.dumpPendingTileId;
        problems.push(`stale dump UI pending tile=${id} after inventory sync`);
    }
    for (const d of snap.spawnDetails || []) {
        if (d.inModel && !d.inRender) {
            problems.push(`spawn ${d.id} in model but excluded from render set (${phase})`);
        }
        if (d.inModel && !d.domVisible) {
            problems.push(`spawn ${d.id} in model but not DOM-visible (${phase})`);
        }
    }
    if (snap.modelMissingFromDom?.length) {
        problems.push(`model tiles missing from DOM: ${snap.modelMissingFromDom.join(', ')}`);
    }
    if (snap.modelHiddenFromDom?.length) {
        problems.push(`model tiles CSS-hidden: ${snap.modelHiddenFromDom.join(', ')}`);
    }
    if (snap.spawnIds?.length !== DUMP_DRAW_COUNT) {
        problems.push(`spawn batch size ${snap.spawnIds?.length ?? 0}, expected ${DUMP_DRAW_COUNT}`);
    }
    if (snap.viewportFails?.length) {
        for (const f of snap.viewportFails) {
            problems.push(`spawn ${f.id} viewport: ${f.reason}`);
        }
    }
    return problems;
}

/** Wait until guest hand reflects dump authority (+2). Host flush allowed here only. */
async function waitForGuestDumpModelAuthority(guestFrame, beforeIds, opts = {}) {
    const {
        hostPage = null,
        dumpSeqBefore = null,
        timeoutMs = 8000,
        label = 'guest dump model authority',
        allowHostFlush = true
    } = opts;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (allowHostFlush && hostPage) await flushHostBananaInteractions(hostPage);
        const ready = await guestFrame.evaluate(({ ids, seqBefore }) => {
            const g = window.game;
            const board = g?.roomData?.global?.board || {};
            const handOk = (new Set((g?.tiles || []).map((t) => t.id))).size === (new Set(ids)).size + 2;
            const seqOk = seqBefore == null || (board.dumpSeq || 0) > seqBefore;
            const uid = g?._myUid?.();
            const remote = uid != null ? (board.inventorySeq?.[uid] ?? 0) : 0;
            const local = g?._localInventorySeq ?? 0;
            const coh = typeof __bananaMpDebug?.coherence === 'function'
                ? __bananaMpDebug.coherence()
                : null;
            const req = typeof __bananaMpDebug?.requireCoherent === 'function'
                ? __bananaMpDebug.requireCoherent('inventory-apply')
                : null;
            const invOk = req ? req.ok : (coh ? coh.ok : (uid && local >= remote && remote > 0));
            return { handOk, seqOk, invOk, coherence: coh };
        }, { ids: beforeIds, seqBefore: dumpSeqBefore });
        if (ready.handOk && ready.seqOk && ready.invOk) return ready;
        await guestFrame.waitForTimeout(DEFAULT_POLL_MS);
    }
    const snap = await snapshotGuestDumpRenderPipeline(guestFrame, beforeIds, { dumpSeqBefore });
    logDumpSpawnFailure(`${label} timeout`, snap, { dumpSeqBefore });
    failWithSnapshot(label, ['guest dump model authority timeout (hand not +2)'], { snap });
}

/**
 * Strict immediate spawn visibility — model authority confirmed, zero test-side render nudges.
 * Reproduces "dump happened but tiles not on screen yet" for non-host.
 */
async function assertGuestDumpSpawnImmediateStrict(guestFrame, beforeIds, opts = {}) {
    const {
        label,
        dumpSeqBefore = null,
        mobile = false,
        immediateMs = DEFAULT_IMMEDIATE_MS
    } = opts;

    const pipeline = await guestFrame.evaluate(({ ids, seqBefore, mobile: isMobile }) => {
        const g = window.game;
        const board = g?.roomData?.global?.board || {};
        const drawCount = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
        const handIds = (g?.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const renderTiles = typeof g._tilesForRender === 'function'
            ? g._tilesForRender()
            : (g?.tiles || []);
        const renderIds = new Set(renderTiles.map((t) => t.id));
        const dumpPendingTileId = g?._guestDumpPendingTileId || null;
        const txn = board.lastDumpTxn;
        const seqOk = seqBefore == null || (board.dumpSeq || 0) > seqBefore;

        let spawnIds = [];
        if (txn && seqOk && Array.isArray(txn.addedTileIds) && txn.addedTileIds.length === drawCount
            && txn.addedTileIds.every((id) => handSet.has(id))) {
            spawnIds = txn.addedTileIds.slice();
        } else {
            spawnIds = handIds.filter((id) => !ids.includes(id));
            const dumpedId = txn?.dumpedTileId || ids[ids.length - 1] || null;
            if (spawnIds.length === drawCount - 1 && dumpedId && handSet.has(dumpedId)) {
                spawnIds = [...spawnIds, dumpedId];
            }
        }

        const spawnDetails = spawnIds.map((id) => {
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            let domVisible = false;
            if (el) {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                domVisible = style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity) >= 0.05
                    && rect.width > 4
                    && rect.height > 4;
            }
            return {
                id,
                inModel: handSet.has(id),
                inRender: renderIds.has(id),
                domVisible,
                dumpPending: dumpPendingTileId === id
            };
        });

        return {
            authorityApplied: (new Set(handIds)).size === (new Set(ids)).size + 2,
            spawnIds,
            spawnDetails,
            dumpPendingTileId,
            lastPeelSeq: g?._lastPeelSeq ?? 0,
            lastDumpSeq: g?._lastDumpSeq ?? 0,
            boardPeelSeq: board.peelSeq || 0,
            boardDumpSeq: board.dumpSeq || 0,
            actionSeqBlocked: (board.dumpSeq || 0) > 0
                && (g?._lastDumpSeq ?? 0) >= (board.dumpSeq || 0),
            expectedHandCount: (new Set(ids)).size + 2,
            handCount: handIds.length,
            mobile: isMobile
        };
    }, { ids: beforeIds, seqBefore: dumpSeqBefore, mobile: !!mobile });

    if (!pipeline.authorityApplied) {
        failWithSnapshot(label, [
            `model not at +2 (${pipeline.handCount} vs ${pipeline.expectedHandCount}) before immediate check`
        ], { pipeline });
    }

    const problems = collectGuestVisualProblems(pipeline, 'immediate-0ms');
    if (problems.length) {
        logDumpSpawnFailure(`${label} immediate-strict`, pipeline, { problems });
        failWithSnapshot(label, problems, { pipeline, problems });
    }

    spawnPipelineSummary(`${label} immediate-strict ok`, pipeline);

    const { assertGuestSpawnImmediateVisible } = require('./post-reset-spawn');
    await assertGuestSpawnImmediateVisible(guestFrame, pipeline.spawnIds, `${label} dom`, {
        maxMs: immediateMs,
        allowRenderNudge: false
    });

    return { ok: true, pipeline, spawnIds: pipeline.spawnIds };
}

/** @param {import('playwright').Frame} frame */
async function snapshotGuestDumpRenderPipeline(frame, beforeIds, options = {}) {
    return frame.evaluate(({ ids, dumpSeqBefore: seqBefore }) => {
        const g = window.game;
        const board = g?.roomData?.global?.board || {};
        const drawCount = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
        const handIds = (g?.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const renderTiles = typeof g._tilesForRender === 'function'
            ? g._tilesForRender()
            : (g?.tiles || []);
        const renderIds = new Set(renderTiles.map((t) => t.id));
        const dumpPendingTileId = g?._guestDumpPendingTileId || null;
        const myUid = typeof g._myUid === 'function' ? g._myUid() : null;
        const txn = board.lastDumpTxn;
        const seqOk = seqBefore == null || (board.dumpSeq || 0) > seqBefore;

        let spawnIds = [];
        if (txn && seqOk && Array.isArray(txn.addedTileIds) && txn.addedTileIds.length === drawCount
            && txn.addedTileIds.every((id) => handSet.has(id))) {
            spawnIds = txn.addedTileIds.slice();
        } else {
            spawnIds = handIds.filter((id) => !ids.includes(id));
            const dumpedId = txn?.dumpedTileId || ids[ids.length - 1] || null;
            if (spawnIds.length === drawCount - 1 && dumpedId && handSet.has(dumpedId)) {
                spawnIds = [...spawnIds, dumpedId];
            }
        }

        const domNodes = [...document.querySelectorAll('.tile[data-tile-id]')];
        const domIdSet = new Set(domNodes.map((el) => el.dataset.tileId));

        const spawnDetails = spawnIds.map((id) => {
            const inModel = handSet.has(id);
            const inRender = renderIds.has(id);
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            let domVisible = false;
            if (el) {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                domVisible = style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity) >= 0.05
                    && rect.width > 4
                    && rect.height > 4;
            }
            return {
                id,
                inModel,
                inRender,
                domPresent: domIdSet.has(id),
                domVisible,
                dumpPending: dumpPendingTileId === id
            };
        });

        const modelMissingFromDom = [];
        const modelHiddenFromDom = [];
        for (const id of handIds) {
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            if (!el) {
                modelMissingFromDom.push(id);
                continue;
            }
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const visible = style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity) >= 0.05
                && rect.width > 0
                && rect.height > 0;
            if (!visible) modelHiddenFromDom.push(id);
        }

        const localSeq = g?._localInventorySeq ?? null;
        const boardSeq = myUid != null ? (board.inventorySeq?.[myUid] ?? null) : null;
        const coherence = typeof __bananaMpDebug?.coherence === 'function'
            ? __bananaMpDebug.coherence()
            : (g?._mpCoherenceSnapshot?.(
                g?._mpBoardFromRoom?.(g.roomData) ?? board,
                myUid,
                'guest-dump-pipeline'
            ) ?? null);

        return {
            dumpPendingTileId,
            authorityApplied: (new Set(handIds)).size === (new Set(ids)).size + 2,
            inventorySynced: coherence ? coherence.inventorySynced : (boardSeq != null && localSeq != null && localSeq >= boardSeq),
            coherence,
            coherenceFailed: coherence?.failed?.length ? coherence.failed : null,
            spawnIds,
            spawnDetails,
            handCount: handIds.length,
            modelMissingFromDom,
            modelHiddenFromDom,
            expectedHandCount: ids.length + 2
        };
    }, { ids: beforeIds, dumpSeqBefore: options.dumpSeqBefore ?? null });
}

/**
 * One in-frame trip: wait for authority, poll stability, pipeline + viewport checks.
 * @param {import('playwright').Frame} frame
 */
async function runGuestDumpVisualInFrame(frame, beforeIds, options = {}) {
    return frame.evaluate(async ({
        ids,
        dumpSeqBefore,
        mobile,
        stabilityMs,
        timeoutMs,
        requireInventorySync,
        pollMs,
        skipAuthorityWait,
        authorityOnly,
        noRenderNudge
    }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const drawCount = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
        const deadline = performance.now() + timeoutMs;

        const authorityReady = () => {
            const g = window.game;
            const board = g?.roomData?.global?.board || {};
            const handOk = (new Set((g?.tiles || []).map((t) => t.id))).size === (new Set(ids)).size + 2;
            const seqOk = dumpSeqBefore == null || (board.dumpSeq || 0) > dumpSeqBefore;
            if (!handOk || !seqOk) return false;
            if (!requireInventorySync) return true;
            const req = typeof __bananaMpDebug?.requireCoherent === 'function'
                ? __bananaMpDebug.requireCoherent('inventory-apply')
                : null;
            if (req) return req.ok;
            const coh = typeof __bananaMpDebug?.coherence === 'function'
                ? __bananaMpDebug.coherence()
                : null;
            if (coh) return coh.ok;
            const uid = g?._myUid?.();
            if (!uid || !board) return false;
            const remote = board.inventorySeq?.[uid] ?? 0;
            const local = g._localInventorySeq ?? 0;
            return local >= remote && remote > 0;
        };

        if (authorityOnly) {
            const coh = typeof __bananaMpDebug?.coherence === 'function'
                ? __bananaMpDebug.coherence()
                : null;
            const uid = window.game?._myUid?.();
            const board = window.game?.roomData?.global?.board || {};
            const remote = uid != null ? (board.inventorySeq?.[uid] ?? 0) : 0;
            const local = window.game?._localInventorySeq ?? 0;
            const req = typeof __bananaMpDebug?.requireCoherent === 'function'
                ? __bananaMpDebug.requireCoherent('inventory-apply')
                : null;
            const invOk = !requireInventorySync
                || (req ? req.ok : (coh ? coh.ok : (uid && local >= remote && remote > 0)));
            return {
                ok: false,
                phase: authorityReady() ? 'authority-ready' : 'authority-wait',
                snap: { authorityApplied: authorityReady(), inventorySynced: invOk, coherence: coh }
            };
        }

        if (!skipAuthorityWait) {
            while (performance.now() < deadline) {
                if (authorityReady()) break;
                await sleep(pollMs);
            }
            if (!authorityReady()) {
                return { ok: false, phase: 'authority-wait', reason: 'timeout' };
            }
        } else if (!authorityReady()) {
            const quickDeadline = performance.now() + Math.min(400, timeoutMs);
            while (performance.now() < quickDeadline) {
                if (authorityReady()) break;
                await sleep(pollMs);
            }
            if (!authorityReady()) {
                return { ok: false, phase: 'authority-wait', reason: 'not-ready-after-skip' };
            }
        }

        const buildSnap = (seqBefore) => {
            const g = window.game;
            const board = g?.roomData?.global?.board || {};
            const handIds = (g?.tiles || []).map((t) => t.id);
            const handSet = new Set(handIds);
            const renderTiles = typeof g._tilesForRender === 'function'
                ? g._tilesForRender()
                : (g?.tiles || []);
            const renderIds = new Set(renderTiles.map((t) => t.id));
            const dumpPendingTileId = g?._guestDumpPendingTileId || null;
            const myUid = typeof g._myUid === 'function' ? g._myUid() : null;
            const txn = board.lastDumpTxn;
            const seqOk = seqBefore == null || (board.dumpSeq || 0) > seqBefore;

            let spawnIds = [];
            if (txn && seqOk && Array.isArray(txn.addedTileIds) && txn.addedTileIds.length === drawCount
                && txn.addedTileIds.every((id) => handSet.has(id))) {
                spawnIds = txn.addedTileIds.slice();
            } else {
                spawnIds = handIds.filter((id) => !ids.includes(id));
                const dumpedId = txn?.dumpedTileId || ids[ids.length - 1] || null;
                if (spawnIds.length === drawCount - 1 && dumpedId && handSet.has(dumpedId)) {
                    spawnIds = [...spawnIds, dumpedId];
                }
            }

            const spawnDetails = spawnIds.map((id) => {
                const inModel = handSet.has(id);
                const inRender = renderIds.has(id);
                const el = document.querySelector(`[data-tile-id="${id}"]`);
                let domVisible = false;
                if (el) {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    domVisible = style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity) >= 0.05
                        && rect.width > 4
                        && rect.height > 4;
                }
                return {
                    id,
                    inModel,
                    inRender,
                    domVisible,
                    dumpPending: dumpPendingTileId === id
                };
            });

            const modelMissingFromDom = [];
            const modelHiddenFromDom = [];
            for (const id of handIds) {
                const el = document.querySelector(`[data-tile-id="${id}"]`);
                if (!el) {
                    modelMissingFromDom.push(id);
                    continue;
                }
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                const visible = style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity) >= 0.05
                    && rect.width > 0
                    && rect.height > 0;
                if (!visible) modelHiddenFromDom.push(id);
            }

            const localSeq = g?._localInventorySeq ?? null;
            const boardSeq = myUid != null ? (board.inventorySeq?.[myUid] ?? null) : null;
            const coh = typeof __bananaMpDebug?.coherence === 'function'
                ? __bananaMpDebug.coherence()
                : null;

            return {
                dumpPendingTileId,
                authorityApplied: (new Set(handIds)).size === (new Set(ids)).size + 2,
                inventorySynced: coh ? coh.inventorySynced : (boardSeq != null && localSeq != null && localSeq >= boardSeq),
                coherence: coh,
                coherenceFailed: coh?.failed?.length ? coh.failed : null,
                spawnIds,
                spawnDetails,
                handCount: handIds.length,
                modelMissingFromDom,
                modelHiddenFromDom,
                expectedHandCount: (new Set(ids)).size + 2,
                viewportFails: []
            };
        };

        const checkSpawnViewport = (spawnIds) => {
            const g = window.game;
            const added = (g?.tiles || []).filter((t) => spawnIds.includes(t.id));
            if (added.length !== drawCount) {
                return [{ id: null, reason: `added-count-${added.length}` }];
            }
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
                bottom: clip.bottom - borderIns.bottom
            };
            const intersectArea = (a, b) => {
                const left = Math.max(a.left, b.left);
                const top = Math.max(a.top, b.top);
                const right = Math.min(a.right, b.right);
                const bottom = Math.min(a.bottom, b.bottom);
                if (right <= left || bottom <= top) return 0;
                return (right - left) * (bottom - top);
            };

            const fails = [];
            for (const t of added) {
                const el = document.querySelector(`[data-tile-id="${t.id}"]`);
                if (!el) {
                    fails.push({ id: t.id, reason: 'missing-dom' });
                    continue;
                }
                const style = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
                    fails.push({ id: t.id, reason: 'css-hidden' });
                    continue;
                }
                if (r.width < minDim || r.height < minDim) {
                    fails.push({ id: t.id, reason: 'tiny-rect' });
                    continue;
                }
                const tileArea = Math.max(r.width * r.height, 1);
                const visibleArea = intersectArea(r, clipInset);
                if (visibleArea / tileArea < minVisibleRatio) {
                    fails.push({ id: t.id, reason: 'clipped-off-canvas' });
                }
            }
            return fails;
        };

        const collectProblems = (snap, phase) => collectGuestVisualProblems(snap, phase);

        const history = [];
        let lastSnap = null;
        let prevDelay = 0;
        for (const delay of stabilityMs) {
            const step = Math.max(0, delay - prevDelay);
            prevDelay = delay;
            if (step > 0) await sleep(step);
            if (!noRenderNudge) {
                window.game?.requestRender?.();
            }
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

            lastSnap = buildSnap(dumpSeqBefore);
            if (lastSnap.spawnIds.length !== drawCount) {
                return {
                    ok: false,
                    phase: 'spawn-resolve',
                    delay,
                    snap: lastSnap,
                    history
                };
            }
            lastSnap.viewportFails = checkSpawnViewport(lastSnap.spawnIds);
            const problems = collectProblems(lastSnap, `${delay}ms`);
            history.push({ delay, problemCount: problems.length });
            if (problems.length) {
                return {
                    ok: false,
                    phase: 'stability',
                    delay,
                    problems,
                    snap: lastSnap,
                    history
                };
            }
        }

        return {
            ok: true,
            snap: lastSnap,
            spawnIds: lastSnap.spawnIds,
            history
        };
    }, {
        ids: beforeIds,
        dumpSeqBefore: options.dumpSeqBefore ?? null,
        mobile: !!options.mobile,
        stabilityMs: options.stabilityMs || DEFAULT_STABILITY_MS,
        timeoutMs: options.timeoutMs ?? 8000,
        requireInventorySync: options.requireInventorySync !== false,
        pollMs: options.pollMs ?? DEFAULT_POLL_MS,
        skipAuthorityWait: !!options.skipAuthorityWait,
        authorityOnly: !!options.authorityOnly,
        noRenderNudge: !!options.noRenderNudge
    });
}

/**
 * Strict guest dump visual assert — host flush + single in-frame stability poll.
 * @param {import('playwright').Frame} opts.guestFrame
 * @param {import('playwright').Page} [opts.hostPage] flush host while waiting for authority
 */
async function assertGuestDumpSpawnVisual(opts) {
    const {
        guestFrame,
        hostPage = null,
        beforeIds,
        label,
        dumpSeqBefore = null,
        mobile = false,
        stabilityMs = DEFAULT_STABILITY_MS,
        timeoutMs = 8000,
        requireInventorySync = true,
        skipAuthorityProbe = false
    } = opts;

    if (!skipAuthorityProbe) {
        const deadline = Date.now() + timeoutMs;
        let authorityReady = false;
        while (Date.now() < deadline && !authorityReady) {
            if (hostPage) await flushHostBananaInteractions(hostPage);
            const probe = await runGuestDumpVisualInFrame(guestFrame, beforeIds, {
                dumpSeqBefore,
                mobile,
                timeoutMs: 200,
                requireInventorySync,
                authorityOnly: true
            });
            if (probe.phase === 'authority-ready' && probe.snap?.authorityApplied) {
                authorityReady = true;
                break;
            }
            await guestFrame.waitForTimeout(DEFAULT_POLL_MS);
        }

        if (!authorityReady) {
            const snap = await snapshotGuestDumpRenderPipeline(guestFrame, beforeIds, { dumpSeqBefore });
            logDumpSpawnFailure(label, snap, { reason: 'authority-timeout' });
            failWithSnapshot(label, ['guest dump authority timeout'], { snap });
        }
    }

    const result = await runGuestDumpVisualInFrame(guestFrame, beforeIds, {
        dumpSeqBefore,
        mobile,
        stabilityMs,
        timeoutMs: Math.max(600, stabilityMs[stabilityMs.length - 1] + 250),
        requireInventorySync,
        skipAuthorityWait: true
    });

    if (!result.ok) {
        const snap = result.snap || await snapshotGuestDumpRenderPipeline(guestFrame, beforeIds, { dumpSeqBefore });
        const problems = result.problems?.length
            ? result.problems
            : (result.reason ? [result.reason] : collectGuestVisualProblems(snap, `${result.delay ?? '?'}ms`));
        logDumpSpawnFailure(label, snap, { problems, result });
        failWithSnapshot(label, problems, { result, snap });
    }

    return {
        ok: true,
        label,
        spawnIds: result.spawnIds,
        history: result.history,
        lastSnap: result.snap
    };
}

/**
 * Install test probe: snapshot DOM the instant guest inventory projection completes.
 * Test-only hook via page.evaluate — does not modify game source files.
 */
async function installGuestInventoryApplyProbe(guestFrame) {
    return guestFrame.evaluate(() => {
        const g = window.game;
        if (!g || g.__dumpSpawnInvProbeInstalled) return { installed: false };
        g.__dumpSpawnInvProbe = { hits: [] };
        g.__dumpSpawnRenderProbe = { calls: 0 };
        g.__dumpSpawnInvProbeOrig = {};
        const origRender = typeof g.requestRender === 'function' ? g.requestRender.bind(g) : null;
        if (origRender) {
            g.__dumpSpawnInvProbeOrig.requestRender = origRender;
            g.requestRender = function dumpSpawnRenderProbe() {
                g.__dumpSpawnRenderProbe.calls += 1;
                return origRender();
            };
        }
        const wrap = (name, fn) => {
            if (typeof fn !== 'function') return;
            const orig = fn.bind(g);
            g.__dumpSpawnInvProbeOrig[name] = orig;
            g[name] = function dumpSpawnInvProbeWrap(...args) {
                const beforeHand = (g.tiles || []).length;
                const out = orig(...args);
                const afterHand = (g.tiles || []).length;
                if (out && afterHand > beforeHand) {
                    const renderTiles = typeof g._tilesForRender === 'function'
                        ? g._tilesForRender()
                        : (g.tiles || []);
                    const renderIds = new Set(renderTiles.map((t) => t.id));
                    const added = (g.tiles || []).slice(beforeHand);
                    g.__dumpSpawnInvProbe.hits.push({
                        at: performance.now(),
                        hook: name,
                        added: added.map((t) => ({
                            id: t.id,
                            inRender: renderIds.has(t.id),
                            domPresent: !!document.querySelector(`[data-tile-id="${t.id}"]`),
                            domVisible: (() => {
                                const el = document.querySelector(`[data-tile-id="${t.id}"]`);
                                if (!el) return false;
                                const style = window.getComputedStyle(el);
                                const rect = el.getBoundingClientRect();
                                return style.display !== 'none'
                                    && style.visibility !== 'hidden'
                                    && Number(style.opacity) >= 0.05
                                    && rect.width > 4
                                    && rect.height > 4;
                            })()
                        })),
                        lastDumpSeq: g._lastDumpSeq ?? 0,
                        boardDumpSeq: g.roomData?.global?.board?.dumpSeq || 0
                    });
                }
                return out;
            };
        };
        wrap('_replaceInventoryFromAuthority', g._replaceInventoryFromAuthority);
        wrap('_applyMpInventoryFromBoard', g._applyMpInventoryFromBoard);
        g.__dumpSpawnInvProbeInstalled = true;
        return { installed: true };
    });
}

async function removeGuestInventoryApplyProbe(guestFrame) {
    await guestFrame.evaluate(() => {
        const g = window.game;
        if (!g?.__dumpSpawnInvProbeInstalled) return;
        const orig = g.__dumpSpawnInvProbeOrig || {};
        if (orig.requestRender) g.requestRender = orig.requestRender;
        if (orig._replaceInventoryFromAuthority) {
            g._replaceInventoryFromAuthority = orig._replaceInventoryFromAuthority;
        }
        if (orig._applyMpInventoryFromBoard) {
            g._applyMpInventoryFromBoard = orig._applyMpInventoryFromBoard;
        }
        delete g.__dumpSpawnInvProbe;
        delete g.__dumpSpawnRenderProbe;
        delete g.__dumpSpawnInvProbeOrig;
        delete g.__dumpSpawnInvProbeInstalled;
    });
}

function formatActionableGuestDumpFailure(label, pipeline, problems, phase) {
    const actionable = [
        `NON-HOST dump spawn not visible (${phase})`,
        '',
        'Repro path: invite 2p → SPLIT → each dumps once → /win → Done → SPLIT → guest dumps.',
        `Symptom: ${problems.join('; ')}`,
        '',
        `Hand: ${pipeline.handCount} tiles (expected ${pipeline.expectedHandCount} after dump +3 −1)`,
        `Spawn batch: ${(pipeline.spawnIds || []).join(', ') || '(none resolved)'}`,
        '',
        'Guest client state:',
        JSON.stringify(pipeline.clientState, null, 2)
    ];
    if (pipeline.actionSeqBlocked) {
        actionable.push(
            '',
            `Stale dump seq: lastDumpSeq=${pipeline.lastDumpSeq} >= board.dumpSeq=${pipeline.boardDumpSeq}`,
            '→ inventory updated but requestRender may have been skipped on guest board apply.',
            '→ Check mp-board.js _applyMpActionBanners and board-seq skip path (test-only diagnosis).'
        );
    }
    if (pipeline.inventorySynced && pipeline.dumpPendingTileId) {
        actionable.push('', `Stale _guestDumpPendingTileId=${pipeline.dumpPendingTileId} after inventory sync.`);
    }
    if (pipeline.probeHit) {
        actionable.push('', 'Inventory apply probe (same frame as projection):');
        actionable.push(JSON.stringify(pipeline.probeHit, null, 2));
    }
    for (const d of pipeline.spawnDetails || []) {
        if (d.inModel && !d.domVisible) {
            actionable.push(`  ${d.id}: inModel inRender=${d.inRender} domPresent=${d.domPresent} domVisible=false`);
        }
    }
    return actionable;
}

/**
 * Wait for guest dump authority, then poll until spawn tiles are DOM-visible
 * (like a player watching their hand) — no host flush, no render nudge, no probe hooks.
 */
async function assertGuestDumpSpawnActionable(opts) {
    const {
        guestFrame,
        beforeIds,
        dumpSeqBefore = null,
        label,
        mobile = false,
        phase = 'second-game after win→Done',
        authorityWaitMs = Number(process.env.FIVE_MP_DUMP_AUTHORITY_MS || 8000),
        paintWaitMs = Number(process.env.FIVE_MP_DUMP_PAINT_MS || 8000)
    } = opts;

    const snapGuestDumpActionable = () => guestFrame.evaluate(({
        ids,
        seqBefore,
        isMobile
    }) => {
        const g = window.game;
        const board = g?.roomData?.global?.board || {};
        const drawCount = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
        const handIds = (g?.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const renderTiles = typeof g._tilesForRender === 'function'
            ? g._tilesForRender()
            : (g?.tiles || []);
        const renderIds = new Set(renderTiles.map((t) => t.id));
        const dumpPendingTileId = g?._guestDumpPendingTileId || null;
        const txn = board.lastDumpTxn;
        const seqOk = seqBefore == null || (board.dumpSeq || 0) > seqBefore;

        let spawnIds = [];
        if (txn && seqOk && Array.isArray(txn.addedTileIds) && txn.addedTileIds.length === drawCount
            && txn.addedTileIds.every((id) => handSet.has(id))) {
            spawnIds = txn.addedTileIds.slice();
        } else {
            spawnIds = handIds.filter((id) => !ids.includes(id));
            const dumpedId = txn?.dumpedTileId || ids[ids.length - 1] || null;
            if (spawnIds.length === drawCount - 1 && dumpedId && handSet.has(dumpedId)) {
                spawnIds = [...spawnIds, dumpedId];
            }
        }

        const spawnDetails = spawnIds.map((id) => {
            const el = document.querySelector(`[data-tile-id="${id}"]`);
            let domVisible = false;
            let domPresent = false;
            if (el) {
                domPresent = true;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                domVisible = style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity) >= 0.05
                    && rect.width > 4
                    && rect.height > 4;
            }
            return {
                id,
                inModel: handSet.has(id),
                inRender: renderIds.has(id),
                domPresent,
                domVisible,
                dumpPending: dumpPendingTileId === id
            };
        });

        const uid = g?._myUid?.();
        const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
        const resetCount = S && g?.roomData ? S.readResetCount(g.roomData) : (g?.roomData?.global?.resetCount ?? 0);
        const coherence = typeof __bananaMpDebug?.coherence === 'function'
            ? __bananaMpDebug.coherence()
            : (g?._mpCoherenceSnapshot?.(
                g?._mpBoardFromRoom?.(g.roomData) ?? board,
                uid,
                'guest-dump-actionable'
            ) ?? null);

        return {
            authorityApplied: (new Set(handIds)).size === (new Set(ids)).size + 2,
            spawnIds,
            spawnDetails,
            dumpPendingTileId,
            lastPeelSeq: g?._lastPeelSeq ?? 0,
            lastDumpSeq: g?._lastDumpSeq ?? 0,
            boardPeelSeq: board.peelSeq || 0,
            boardDumpSeq: board.dumpSeq || 0,
            actionSeqBlocked: coherence
                ? !coherence.actionSeqAcked && (board.dumpSeq || 0) > 0
                : ((board.dumpSeq || 0) > 0 && (g?._lastDumpSeq ?? 0) >= (board.dumpSeq || 0)),
            expectedHandCount: (new Set(ids)).size + 2,
            handCount: handIds.length,
            mobile: isMobile,
            coherence,
            coherenceFailed: coherence?.failed?.length ? coherence.failed : null,
            clientState: {
                lastPeelSeq: g?._lastPeelSeq ?? 0,
                lastDumpSeq: g?._lastDumpSeq ?? 0,
                boardPeelSeq: board.peelSeq || 0,
                boardDumpSeq: board.dumpSeq || 0,
                localInventorySeq: g?._localInventorySeq ?? 0,
                boardInventorySeq: uid != null ? (board.inventorySeq?.[uid] ?? 0) : 0,
                mpAppliedResetCount: g?._mpAppliedResetCount ?? 0,
                resetCount,
                guestDumpPendingTileId: g?._guestDumpPendingTileId ?? null,
                boardSeq: g?._boardSeq ?? 0,
                isHost: !!g?.isHost?.(),
                coherence,
                coherenceFailed: coherence?.failed?.length ? coherence.failed : null
            }
        };
    }, { ids: beforeIds, seqBefore: dumpSeqBefore, isMobile: !!mobile });

    const collectActionableProblems = (snap, tag) => {
        const problems = [];
        if (!snap.authorityApplied) {
            problems.push(`hand not at +2 (${snap.handCount} vs ${snap.expectedHandCount})`);
        }
        for (const d of snap.spawnDetails || []) {
            if (d.inModel && !d.inRender) {
                problems.push(`spawn ${d.id} in model but excluded from render (${tag})`);
            }
            if (d.inModel && !d.domVisible) {
                problems.push(`spawn ${d.id} in model but not DOM-visible (${tag})`);
            }
        }
        if (snap.spawnIds?.length !== 3) {
            problems.push(`spawn batch size ${snap.spawnIds?.length ?? 0}, expected 3 (${tag})`);
        }
        return problems;
    };

    const authDeadline = Date.now() + authorityWaitMs;
    let firstAuthority = null;
    while (Date.now() < authDeadline) {
        const snap = await snapGuestDumpActionable();
        const dumpSeqOk = dumpSeqBefore == null || snap.boardDumpSeq > dumpSeqBefore;
        if (snap.authorityApplied && dumpSeqOk) {
            firstAuthority = snap;
            break;
        }
        await guestFrame.waitForTimeout(DEFAULT_POLL_MS);
    }

    if (!firstAuthority) {
        const pipeline = await snapGuestDumpActionable();
        const problems = ['guest dump authority timeout'];
        const actionable = formatActionableGuestDumpFailure(label, pipeline, problems, phase);
        logDumpSpawnFailure(label, pipeline, { problems, actionable, phase, reason: 'authority-timeout' });
        failWithSnapshot(label, actionable, { pipeline, problems, actionable, phase, at: 'authority-timeout' });
    }

    for (const d of firstAuthority.spawnDetails || []) {
        if (d.inModel && !d.inRender) {
            const problems = [`spawn ${d.id} in model but excluded from render`];
            const actionable = formatActionableGuestDumpFailure(label, firstAuthority, problems, phase);
            logDumpSpawnFailure(label, firstAuthority, { problems, actionable, phase, at: 'first-authority-frame' });
            failWithSnapshot(label, actionable, { pipeline: firstAuthority, problems, actionable, phase, at: 'first-authority-frame' });
        }
    }

    const paintDeadline = Date.now() + paintWaitMs;
    let afterPaint = firstAuthority;
    while (Date.now() < paintDeadline) {
        afterPaint = await snapGuestDumpActionable();
        const problemsPaint = collectActionableProblems(afterPaint, 'paint-wait');
        if (!problemsPaint.length) {
            spawnPipelineSummary(`${label} actionable ok (paint-wait)`, afterPaint);
            return { ok: true, pipeline: afterPaint, spawnIds: afterPaint.spawnIds };
        }
        await guestFrame.waitForTimeout(DEFAULT_POLL_MS);
    }

    const problemsPaint = collectActionableProblems(afterPaint, 'paint-timeout');
    const actionable = formatActionableGuestDumpFailure(label, afterPaint, problemsPaint, phase);
    logDumpSpawnFailure(label, afterPaint, { problems: problemsPaint, actionable, phase, at: 'paint-timeout' });
    failWithSnapshot(label, actionable, { pipeline: afterPaint, problems: problemsPaint, actionable, phase, at: 'paint-timeout' });
}

/** @deprecated use runGuestDumpVisualInFrame — kept for diagnostics */
async function waitForGuestDumpAuthority(frame, beforeIds, options = {}) {
    const result = await runGuestDumpVisualInFrame(frame, beforeIds, {
        ...options,
        stabilityMs: [0],
        skipAuthorityWait: false
    });
    if (!result.ok) {
        failWithSnapshot('waitForGuestDumpAuthority', [result.reason || 'timeout'], { result });
    }
}

module.exports = {
    assertGuestDumpSpawnVisual,
    assertGuestDumpSpawnImmediateStrict,
    assertGuestDumpSpawnActionable,
    installGuestInventoryApplyProbe,
    removeGuestInventoryApplyProbe,
    waitForGuestDumpModelAuthority,
    snapshotGuestDumpRenderPipeline,
    runGuestDumpVisualInFrame,
    waitForGuestDumpAuthority,
    collectGuestVisualProblems,
    DEFAULT_STABILITY_MS,
    DEFAULT_IMMEDIATE_MS
};
