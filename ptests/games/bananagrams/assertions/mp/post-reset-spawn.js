/**
 * Post-reset / second-game spawn — guest client seq hygiene + immediate peel/dump visibility.
 * Reproduces missing spawn tiles after reset when stale _lastPeelSeq/_lastDumpSeq block renders.
 */
const { failWithSnapshot } = require('../core/format-failure');
const { logDumpSpawnFailure } = require('../spawn/dump');
const { flushHostBananaInteractions } = require('../../../../shared/adapters/mp-client');
const { spawnDebug, spawnPipelineSummary } = require('../../../../shared/infra/test-logger');
const { evalSpawnTilesVisibility } = require('../spawn/spawn-visibility');
const { assertGuestDumpSpawnVisual } = require('./guest-dump-visible');
const { readGuestSpawnClientState } = require('../../lib/mp-debug-bridge');

const DEFAULT_IMMEDIATE_MS = Number(process.env.FIVE_MP_SPAWN_IMMEDIATE_MS || 120);

/** Fail if spawn tile not DOM-visible within maxMs (no requestRender — matches real play). */
async function assertGuestSpawnImmediateVisible(guestFrame, spawnIds, label, options = {}) {
    const maxMs = options.maxMs ?? DEFAULT_IMMEDIATE_MS;
    const allowRenderNudge = options.allowRenderNudge === true;
    const result = await guestFrame.evaluate(async ({ ids, maxMs: limit, allowRenderNudge: nudge }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const t0 = performance.now();
        let firstVisibleMs = null;
        while (performance.now() - t0 < limit) {
            if (nudge) window.game?.requestRender?.();
            let allVisible = true;
            for (const id of ids) {
                const el = document.querySelector(`[data-tile-id="${id}"]`);
                if (!el) {
                    allVisible = false;
                    break;
                }
                const style = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                const ok = style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity) >= 0.05
                    && r.width > 4
                    && r.height > 4;
                if (!ok) {
                    allVisible = false;
                    break;
                }
            }
            if (allVisible) {
                firstVisibleMs = Math.round(performance.now() - t0);
                break;
            }
            await sleep(8);
        }
        const g = window.game;
        const handIds = (g?.tiles || []).map((t) => t.id);
        const inModel = ids.every((id) => handIds.includes(id));
        return {
            firstVisibleMs,
            inModel,
            spawnIds: ids,
            lastPeelSeq: g?._lastPeelSeq ?? 0,
            lastDumpSeq: g?._lastDumpSeq ?? 0,
            boardPeelSeq: g?.roomData?.global?.board?.peelSeq || 0,
            boardDumpSeq: g?.roomData?.global?.board?.dumpSeq || 0
        };
    }, { ids: spawnIds, maxMs, allowRenderNudge });

    if (result.firstVisibleMs == null) {
        logDumpSpawnFailure(`${label} immediate`, result, { maxMs });
        failWithSnapshot(label, [
            `spawn not DOM-visible within ${maxMs}ms (immediate window, no host flush)`
        ], { result, maxMs });
    }
    return result;
}
const DEFAULT_PEEL_STABILITY_MS = [0, 50, 150];
const DEFAULT_POLL_MS = 8;

/** @param {import('playwright').Frame} frame */
async function snapshotGuestClientSeqState(frame) {
    const snap = await readGuestSpawnClientState(frame);
    return snap || {};
}

function collectPostResetClientProblems(snap, label) {
    const problems = [];
    if (!snap.gameStarted) {
        problems.push('game not started after reset');
    }
    const coh = snap.coherence;
    if (coh) {
        if (snap.boardPeelSeq !== 0 || snap.boardDumpSeq !== 0) {
            problems.push(`board action seq not zero (peel=${snap.boardPeelSeq}, dump=${snap.boardDumpSeq})`);
        }
        if (!coh.epochSynced) {
            problems.push('epoch not synced after reset');
        }
        if (!coh.actionSeqAcked && snap.boardPeelSeq === 0 && snap.boardDumpSeq === 0) {
            problems.push(`action seq not acked (${coh.failed?.join(', ') || 'stale peel/dump seq'})`);
        }
        const req = snap.requireCoherent;
        if (req && !req.ok && snap.gameStarted) {
            problems.push(`coherence blocked (${req.failed?.join(', ') || 'inventory-apply'})`);
        } else if (!req && coh && !coh.ok && snap.gameStarted) {
            problems.push(`coherence failed (${coh.failed?.join(', ') || 'coherence'})`);
        }
    } else {
        if (snap.boardPeelSeq !== 0 || snap.boardDumpSeq !== 0) {
            problems.push(`board action seq not zero (peel=${snap.boardPeelSeq}, dump=${snap.boardDumpSeq})`);
        }
        if (snap.lastPeelSeq !== 0) {
            problems.push(`stale guest _lastPeelSeq=${snap.lastPeelSeq} after reset (blocks first peel spawn)`);
        }
        if (snap.lastDumpSeq !== 0) {
            problems.push(`stale guest _lastDumpSeq=${snap.lastDumpSeq} after reset (blocks first dump spawn)`);
        }
    }
    if (snap.guestDumpPendingTileId || snap.dumpUiPending?.tileId) {
        const id = snap.dumpUiPending?.tileId ?? snap.guestDumpPendingTileId;
        problems.push(`stale dump UI pending tile=${id} after reset`);
    }
    if (snap.mpAwaitReset) {
        problems.push('guest still _mpAwaitReset after reset settled');
    }
    if (snap.layoutEpochMismatch) {
        problems.push(`stale local layout epoch ${snap.layoutEpoch} vs room reset`);
    }
    return problems;
}

/** Log guest spawn client state — FIVE_MP_SPAWN_DEBUG=1 or FIVE_LOG_VERBOSE=1. */
async function logGuestSpawnDebug(guestFrame, label) {
    const snap = await snapshotGuestClientSeqState(guestFrame);
    spawnDebug(label, snap);
    const { spawnSeqSummary } = require('../../../../shared/infra/test-logger');
    if (process.env.FIVE_MP_SPAWN_DEBUG === '1' || process.env.FIVE_LOG_VERBOSE === '1') {
        spawnSeqSummary(label, snap);
    }
    return snap;
}

/** Log guest render pipeline after model authority. */
async function logGuestSpawnPipeline(guestFrame, beforeIds, label, opts = {}) {
    const { snapshotGuestDumpRenderPipeline } = require('./guest-dump-visible');
    const pipeline = opts.mode === 'peel'
        ? await guestFrame.evaluate(({ ids }) => {
            const g = window.game;
            const handIds = (g?.tiles || []).map((t) => t.id);
            const renderIds = new Set(
                (typeof g._tilesForRender === 'function' ? g._tilesForRender() : g?.tiles || [])
                    .map((t) => t.id)
            );
            const spawnIds = handIds.filter((id) => !ids.includes(id));
            return {
                handCount: handIds.length,
                expectedHandCount: ids.length + 1,
                spawnIds,
                spawnDetails: spawnIds.map((id) => ({
                    id,
                    inModel: true,
                    inRender: renderIds.has(id),
                    domVisible: !!document.querySelector(`[data-tile-id="${id}"]`)
                })),
                lastPeelSeq: g?._lastPeelSeq ?? 0,
                lastDumpSeq: g?._lastDumpSeq ?? 0,
                boardPeelSeq: g?.roomData?.global?.board?.peelSeq || 0,
                boardDumpSeq: g?.roomData?.global?.board?.dumpSeq || 0
            };
        }, { ids: beforeIds })
        : await snapshotGuestDumpRenderPipeline(guestFrame, beforeIds, {
            dumpSeqBefore: opts.dumpSeqBefore ?? null
        });
    spawnPipelineSummary(label, pipeline);
    return pipeline;
}

/** Log stale seq after reset; does not fail unless caller uses assertGuestResetClientReady with env flag. */
async function warnGuestResetClientSeq(guestFrame, label) {
    const snap = await snapshotGuestClientSeqState(guestFrame);
    const problems = collectPostResetClientProblems(snap, label);
    if (problems.length) {
        logDumpSpawnFailure(`${label} (stale-seq warning)`, snap, { problems, warnOnly: true });
    }
    return { snap, problems };
}

/** Fail on stale seq only when FIVE_MP_DUMP_FAIL_STALE_SEQ=1; otherwise warn and continue to visibility asserts. */
async function assertGuestResetClientReady(guestFrame, label) {
    const { snap, problems } = await warnGuestResetClientSeq(guestFrame, label);
    if (problems.length && process.env.FIVE_MP_DUMP_FAIL_STALE_SEQ === '1') {
        failWithSnapshot(label, problems, { snap });
    }
    return snap;
}

/** Warn when stale local seq will block spawn renders. */
async function warnGuestActionSeqBeforeSpawn(guestFrame, label) {
    const snap = await snapshotGuestClientSeqState(guestFrame);
    const problems = [];
    const coh = snap.coherence;
    if (coh && !coh.actionSeqAcked && snap.boardPeelSeq === 0 && snap.boardDumpSeq === 0) {
        problems.push(`action seq not acked before spawn (${coh.failed?.join(', ') || 'actionSeqAcked'})`);
    } else if (!coh) {
        if (snap.boardPeelSeq === 0 && snap.lastPeelSeq > 0) {
            problems.push(`_lastPeelSeq=${snap.lastPeelSeq} with board peelSeq=0 (first peel will not render)`);
        }
        if (snap.boardDumpSeq === 0 && snap.lastDumpSeq > 0) {
            problems.push(`_lastDumpSeq=${snap.lastDumpSeq} with board dumpSeq=0 (first dump will not render)`);
        }
    }
    if (problems.length) {
        logDumpSpawnFailure(`${label} (pre-spawn warning)`, snap, { problems, warnOnly: true });
    }
    return { snap, problems };
}

/** Fail on pre-spawn stale seq only when FIVE_MP_DUMP_FAIL_STALE_SEQ=1. */
async function assertGuestActionSeqReadyForSpawn(guestFrame, label) {
    const { snap, problems } = await warnGuestActionSeqBeforeSpawn(guestFrame, label);
    if (problems.length && process.env.FIVE_MP_DUMP_FAIL_STALE_SEQ === '1') {
        failWithSnapshot(label, problems, { snap });
    }
    return snap;
}

/** @param {import('playwright').Frame} frame */
async function runGuestPeelVisualInFrame(frame, beforeIds, options = {}) {
    return frame.evaluate(async ({
        ids,
        peelSeqBefore,
        stabilityMs,
        timeoutMs,
        requireInventorySync,
        pollMs,
        mobile,
        noRenderNudge
    }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const deadline = performance.now() + timeoutMs;

        const authorityReady = () => {
            const g = window.game;
            const board = g?.roomData?.global?.board || {};
            const handOk = (g?.tiles?.length || 0) === ids.length + 1;
            const seqOk = peelSeqBefore == null || (board.peelSeq || 0) > peelSeqBefore;
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

        while (performance.now() < deadline) {
            if (authorityReady()) break;
            await sleep(pollMs);
        }
        if (!authorityReady()) {
            return { ok: false, phase: 'authority-wait', reason: 'timeout' };
        }

        const buildSnap = (phase) => {
            const g = window.game;
            const board = g?.roomData?.global?.board || {};
            const handIds = (g?.tiles || []).map((t) => t.id);
            const handSet = new Set(handIds);
            const renderTiles = typeof g._tilesForRender === 'function'
                ? g._tilesForRender()
                : (g?.tiles || []);
            const renderIds = new Set(renderTiles.map((t) => t.id));
            const spawnIds = handIds.filter((id) => !ids.includes(id));
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
                    domVisible
                };
            });
            const modelMissingFromDom = handIds.filter((id) => !document.querySelector(`[data-tile-id="${id}"]`));
            const peelSeq = board.peelSeq || 0;
            const lastPeelSeq = g?._lastPeelSeq ?? 0;
            const peelActionBlocked = peelSeq > 0 && lastPeelSeq > peelSeq;

            return {
                phase,
                spawnIds,
                spawnDetails,
                handCount: handIds.length,
                peelSeq,
                lastPeelSeq,
                peelActionBlocked,
                modelMissingFromDom,
                expectedHandCount: ids.length + 1
            };
        };

        const collectProblems = (snap) => {
            const problems = [];
            if (snap.handCount !== snap.expectedHandCount) {
                problems.push(`hand expected +1 (${snap.expectedHandCount}), got ${snap.handCount}`);
            }
            if (snap.peelActionBlocked) {
                problems.push(`_lastPeelSeq ${snap.lastPeelSeq} > board peelSeq ${snap.peelSeq} (spawn render blocked)`);
            }
            if (snap.spawnIds.length !== 1) {
                problems.push(`peel spawn batch size ${snap.spawnIds.length}, expected 1`);
            }
            for (const d of snap.spawnDetails || []) {
                if (d.inModel && !d.inRender) {
                    problems.push(`peel spawn ${d.id} in model but excluded from _tilesForRender()`);
                }
                if (d.inModel && !d.domVisible) {
                    problems.push(`peel spawn ${d.id} not DOM-visible (${snap.phase})`);
                }
            }
            if (snap.modelMissingFromDom?.length) {
                problems.push(`model tiles missing from DOM: ${snap.modelMissingFromDom.join(', ')}`);
            }
            return problems;
        };

        const history = [];
        let prevDelay = 0;
        for (const delay of stabilityMs) {
            const step = Math.max(0, delay - prevDelay);
            prevDelay = delay;
            if (step > 0) await sleep(step);
            if (!noRenderNudge) {
                window.game?.requestRender?.();
            }
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

            const snap = buildSnap(`${delay}ms`);
            const problems = collectProblems(snap);
            history.push({ delay, problemCount: problems.length });
            if (problems.length) {
                return { ok: false, phase: 'stability', delay, problems, snap, history };
            }
        }

        return { ok: true, snap: buildSnap('final'), spawnIds: buildSnap('final').spawnIds, history };
    }, {
        ids: beforeIds,
        peelSeqBefore: options.peelSeqBefore ?? null,
        stabilityMs: options.stabilityMs || DEFAULT_PEEL_STABILITY_MS,
        timeoutMs: options.timeoutMs ?? 8000,
        requireInventorySync: options.requireInventorySync !== false,
        pollMs: options.pollMs ?? DEFAULT_POLL_MS,
        mobile: !!options.mobile,
        noRenderNudge: !!options.noRenderNudge
    });
}

/** Wait until guest hand reflects peel authority (+1). Host flush allowed here only. */
async function waitForGuestPeelModelAuthority(guestFrame, beforeIds, opts = {}) {
    const {
        hostPage = null,
        peelSeqBefore = null,
        timeoutMs = 8000,
        label = 'guest peel model authority',
        pollMs = DEFAULT_POLL_MS
    } = opts;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (hostPage) await flushHostBananaInteractions(hostPage);
        const ready = await guestFrame.evaluate(({ ids, seqBefore }) => {
            const g = window.game;
            const board = g?.roomData?.global?.board || {};
            const handOk = (g?.tiles?.length || 0) === ids.length + 1;
            const seqOk = seqBefore == null || (board.peelSeq || 0) > seqBefore;
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
        }, { ids: beforeIds, seqBefore: peelSeqBefore });
        if (ready.handOk && ready.seqOk && ready.invOk) return ready;
        await guestFrame.waitForTimeout(pollMs);
    }
    const snap = await snapshotGuestClientSeqState(guestFrame);
    failWithSnapshot(label, ['guest peel model authority timeout (hand not +1)'], { snap });
}

/**
 * Hook guest inventory apply — capture spawn DOM state synchronously at apply time
 * (before reconcile rAF can call requestRender).
 * @param {import('playwright').Frame} frame
 * @param {string} tag
 */
async function installGuestSpawnImmediateProbe(frame, tag) {
    await frame.evaluate(({ t }) => {
        const g = window.game;
        if (g.__spawnImmediateProbeInstalled) return;
        g.__spawnImmediateProbes = [];
        let renderCalls = 0;
        const origRender = g.requestRender?.bind(g);
        if (origRender) {
            g.requestRender = function spawnProbeRender(...args) {
                renderCalls++;
                return origRender(...args);
            };
        }
        const domVisible = (id) => {
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
        const origReplace = g._replaceInventoryFromAuthority?.bind(g);
        if (origReplace) {
            g._replaceInventoryFromAuthority = function probeReplaceInventory(board, uid, options) {
                const beforeIds = (g.tiles || []).map((tile) => tile.id);
                const peelSeq = board?.peelSeq || 0;
                const dumpSeq = board?.dumpSeq || 0;
                const lastPeelBefore = g._lastPeelSeq || 0;
                const lastDumpBefore = g._lastDumpSeq || 0;
                const renderBefore = renderCalls;
                const applied = origReplace(board, uid, options);
                const afterIds = (g.tiles || []).map((tile) => tile.id);
                const spawnIds = afterIds.filter((id) => !beforeIds.includes(id));
                if (spawnIds.length > 0) {
                    const peelAdvanced = peelSeq > lastPeelBefore;
                    const dumpAdvanced = dumpSeq > lastDumpBefore;
                    const peelBlocked = peelSeq > 0 && lastPeelBefore >= peelSeq;
                    const dumpBlocked = dumpSeq > 0 && lastDumpBefore >= dumpSeq;
                    let actionSeqBlocked = false;
                    if (spawnIds.length === 1 && peelAdvanced) {
                        actionSeqBlocked = peelBlocked;
                    } else if (spawnIds.length >= 2 && dumpAdvanced) {
                        actionSeqBlocked = dumpBlocked;
                    } else if (spawnIds.length >= 2 && dumpBlocked) {
                        actionSeqBlocked = true;
                    } else if (spawnIds.length === 1 && peelBlocked) {
                        actionSeqBlocked = true;
                    }
                    g.__spawnImmediateProbes.push({
                        tag: t,
                        spawnIds,
                        peelSeq,
                        dumpSeq,
                        lastPeelBefore,
                        lastDumpBefore,
                        actionSeqBlocked,
                        renderCallsAtApply: renderCalls - renderBefore,
                        spawnDetails: spawnIds.map((id) => ({
                            id,
                            inModel: true,
                            domVisible: domVisible(id)
                        }))
                    });
                }
                return applied;
            };
        }
        g.__spawnImmediateProbeInstalled = true;
    }, { t: tag });
}

/** @param {import('playwright').Frame} frame */
async function readGuestSpawnImmediateProbes(frame) {
    return frame.evaluate(() => window.game?.__spawnImmediateProbes || []);
}

/** @param {import('playwright').Frame} frame */
async function removeGuestSpawnImmediateProbe(frame) {
    await frame.evaluate(() => {
        const g = window.game;
        if (!g?.__spawnImmediateProbeInstalled) return;
        delete g.__spawnImmediateProbeInstalled;
        delete g.__spawnImmediateProbes;
    });
}

/** Fail when synchronous apply-time probe shows model spawn without DOM (stale seq path). */
async function assertGuestSpawnProbeImmediate(guestFrame, label, opts = {}) {
    const { minSpawns = 1, action = 'spawn', beforeCount = 0, tag = null } = opts;
    const probes = await readGuestSpawnImmediateProbes(guestFrame);
    const relevant = probes.filter((p) => {
        if (tag && p.tag !== tag) return false;
        return (p.spawnIds?.length || 0) >= minSpawns;
    });
    if (!relevant.length) return null;

    const last = relevant[relevant.length - 1];
    if (!last.actionSeqBlocked) {
        spawnDebug(`${label} apply-time probe skipped`, 'action seq not blocked (render may be async)');
        return last;
    }
    const problems = [];
    for (const d of last.spawnDetails || []) {
        if (d.inModel && !d.domVisible) {
            problems.push(`${action} ${d.id} in model but not DOM-visible at inventory apply (sync)`);
        }
    }
    if (last.actionSeqBlocked && last.renderCallsAtApply === 0 && problems.length) {
        problems.push(`action seq blocked with zero requestRender at apply (lastPeel=${last.lastPeelBefore} boardPeel=${last.peelSeq})`);
    }
    if (problems.length) {
        logDumpSpawnFailure(`${label} apply-time probe`, last, { problems, probes: relevant });
        failWithSnapshot(label, problems, { pipeline: last, problems });
    }
    spawnPipelineSummary(`${label} apply-time probe ok`, {
        ...last,
        handCount: (last.spawnIds?.length || 0) + (opts.beforeCount ?? 0),
        expectedHandCount: (opts.beforeCount ?? 0) + minSpawns,
        spawnIds: last.spawnIds,
        spawnDetails: last.spawnDetails
    });
    return last;
}

/** Strict immediate peel spawn — model +1, no requestRender nudge. */
async function assertGuestPeelSpawnImmediateStrict(guestFrame, beforeIds, opts = {}) {
    const {
        label,
        peelSeqBefore = null,
        immediateMs = DEFAULT_IMMEDIATE_MS
    } = opts;

    const pipeline = await guestFrame.evaluate(({ ids, seqBefore }) => {
        const g = window.game;
        const board = g?.roomData?.global?.board || {};
        const handIds = (g?.tiles || []).map((t) => t.id);
        const handSet = new Set(handIds);
        const renderTiles = typeof g._tilesForRender === 'function'
            ? g._tilesForRender()
            : (g?.tiles || []);
        const renderIds = new Set(renderTiles.map((t) => t.id));
        const spawnIds = handIds.filter((id) => !ids.includes(id));
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
            return { id, inModel: handSet.has(id), inRender: renderIds.has(id), domVisible };
        });
        const peelSeq = board.peelSeq || 0;
        const lastPeelSeq = g?._lastPeelSeq ?? 0;
        return {
            authorityApplied: handIds.length === ids.length + 1,
            spawnIds,
            spawnDetails,
            lastPeelSeq,
            boardPeelSeq: peelSeq,
            actionSeqBlocked: peelSeq > (seqBefore ?? 0) && lastPeelSeq >= peelSeq,
            expectedHandCount: ids.length + 1,
            handCount: handIds.length
        };
    }, { ids: beforeIds, seqBefore: peelSeqBefore });

    if (!pipeline.authorityApplied) {
        failWithSnapshot(label, [
            `model not at +1 (${pipeline.handCount} vs ${pipeline.expectedHandCount}) before immediate check`
        ], { pipeline });
    }

    const problems = [];
    if (pipeline.actionSeqBlocked) {
        spawnDebug(`${label} action-seq note`, `lastPeel=${pipeline.lastPeelSeq} boardPeel=${pipeline.boardPeelSeq} (requestRender may be skipped)`);
    }
    for (const d of pipeline.spawnDetails || []) {
        if (d.inModel && !d.inRender) {
            problems.push(`peel spawn ${d.id} in model but excluded from _tilesForRender()`);
        }
        if (d.inModel && !d.domVisible) {
            problems.push(`peel spawn ${d.id} in model but not DOM-visible (immediate-0ms)`);
        }
    }
    if (pipeline.spawnIds.length !== 1) {
        problems.push(`peel spawn batch size ${pipeline.spawnIds.length}, expected 1`);
    }
    if (problems.length) {
        logDumpSpawnFailure(`${label} immediate-strict`, pipeline, { problems });
        failWithSnapshot(label, problems, { pipeline, problems });
    }

    spawnPipelineSummary(`${label} immediate-strict ok`, pipeline);

    await assertGuestSpawnImmediateVisible(guestFrame, pipeline.spawnIds, `${label} dom`, {
        maxMs: immediateMs,
        allowRenderNudge: false
    });

    return { ok: true, pipeline, spawnIds: pipeline.spawnIds };
}

/**
 * Guest peel spawn after reset — strict render/DOM, no test-side fixes.
 * @param {import('playwright').Page} [opts.hostPage]
 */
async function assertGuestPeelSpawnVisual(opts) {
    const {
        guestFrame,
        hostPage = null,
        beforeIds,
        label,
        peelSeqBefore = null,
        mobile = false,
        stabilityMs = DEFAULT_PEEL_STABILITY_MS,
        timeoutMs = 8000,
        immediateMs = DEFAULT_IMMEDIATE_MS
    } = opts;

    const deadline = Date.now() + timeoutMs;
    let authorityReady = false;
    while (Date.now() < deadline && !authorityReady) {
        if (hostPage) await flushHostBananaInteractions(hostPage);
        const probe = await guestFrame.evaluate(({ ids, seqBefore }) => {
            const g = window.game;
            const board = g?.roomData?.global?.board || {};
            const handOk = (g?.tiles?.length || 0) === ids.length + 1;
            const seqOk = seqBefore == null || (board.peelSeq || 0) > seqBefore;
            const uid = g?._myUid?.();
            const coh = typeof __bananaMpDebug?.coherence === 'function'
                ? __bananaMpDebug.coherence()
                : null;
            const req = typeof __bananaMpDebug?.requireCoherent === 'function'
                ? __bananaMpDebug.requireCoherent('inventory-apply')
                : null;
            const remote = uid != null ? (board.inventorySeq?.[uid] ?? 0) : 0;
            const local = g?._localInventorySeq ?? 0;
            const invOk = req ? req.ok : (coh ? coh.ok : (uid && local >= remote && remote > 0));
            return { handOk, seqOk, invOk, peelSeq: board.peelSeq || 0, lastPeelSeq: g?._lastPeelSeq ?? 0, coherence: coh };
        }, { ids: beforeIds, seqBefore: peelSeqBefore });
        if (probe.handOk && probe.seqOk && probe.invOk) {
            authorityReady = true;
            break;
        }
        await guestFrame.waitForTimeout(DEFAULT_POLL_MS);
    }
    if (!authorityReady) {
        const snap = await snapshotGuestClientSeqState(guestFrame);
        failWithSnapshot(label, ['guest peel authority timeout after reset'], { snap });
    }

    const result = await runGuestPeelVisualInFrame(guestFrame, beforeIds, {
        peelSeqBefore,
        mobile,
        stabilityMs,
        timeoutMs: Math.max(600, stabilityMs[stabilityMs.length - 1] + 200),
        skipAuthorityWait: true
    });

    if (!result.ok) {
        const snap = result.snap || await snapshotGuestClientSeqState(guestFrame);
        logDumpSpawnFailure(`${label} peel visual`, snap, { result });
        failWithSnapshot(label, result.problems || [result.reason || 'peel visual failed'], { result, snap });
    }

    const vis = await evalSpawnTilesVisibility(guestFrame, {
        addedIds: result.spawnIds,
        expectedCount: 1,
        label: `${label} peel-viewport`,
        mobile,
        mode: 'peel'
    });
    if (!vis.ok) {
        logDumpSpawnFailure(`${label} peel viewport`, result.snap, { vis });
        failWithSnapshot(label, [`peel viewport visibility failed: ${vis.reason || 'uiFails'}`], { vis, snap: result.snap });
    }

    await assertGuestSpawnImmediateVisible(guestFrame, result.spawnIds, `${label} immediate`, {
        maxMs: immediateMs
    });

    return { ok: true, label, spawnIds: result.spawnIds, snap: result.snap };
}

/** Re-export dump visual for second-game dump repro. */
async function assertGuestDumpSpawnAfterReset(opts) {
    const result = await assertGuestDumpSpawnVisual({
        ...opts,
        stabilityMs: opts.stabilityMs || [0, 50, 150, 300]
    });
    const spawnIds = result.spawnIds || result.lastSnap?.spawnIds;
    if (spawnIds?.length) {
        await assertGuestSpawnImmediateVisible(opts.guestFrame, spawnIds, `${opts.label} immediate`, {
            maxMs: opts.immediateMs ?? DEFAULT_IMMEDIATE_MS
        });
    }
    return result;
}

module.exports = {
    snapshotGuestClientSeqState,
    logGuestSpawnDebug,
    logGuestSpawnPipeline,
    warnGuestResetClientSeq,
    warnGuestActionSeqBeforeSpawn,
    assertGuestResetClientReady,
    assertGuestActionSeqReadyForSpawn,
    assertGuestPeelSpawnVisual,
    assertGuestPeelSpawnImmediateStrict,
    waitForGuestPeelModelAuthority,
    installGuestSpawnImmediateProbe,
    removeGuestSpawnImmediateProbe,
    assertGuestSpawnProbeImmediate,
    assertGuestDumpSpawnAfterReset,
    assertGuestSpawnImmediateVisible,
    runGuestPeelVisualInFrame,
    DEFAULT_PEEL_STABILITY_MS,
    DEFAULT_IMMEDIATE_MS
};
