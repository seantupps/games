/**
 * Rich MP failure snapshot — attach to runner catch blocks for faster debugging.
 * Client diag is tiered: summary / coherence / seq / deep (see failure-snapshot-normalize.js).
 */
const {
    captureAuditFailure,
    formatAssertionDetails,
    stringifyDetails,
    stripEmbeddedDiagBlocks
} = require('./test-logger');
const { normalizeMpFailureSnapshot } = require('./failure-snapshot-normalize');
const {
    formatTargetedAssertionFailure,
    formatSlimSyncContext,
    captureRecentConsoleDiag
} = require('./targeted-failure-format');

/**
 * @param {import('playwright').Page} page
 * @param {string} tag
 */
async function captureMpClientFailureDiag(page, tag) {
    try {
        return await page.evaluate(({ t }) => {
            const frame = document.getElementById('game-frame');
            const g = frame?.contentWindow?.game;
            const doc = frame?.contentDocument;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            const me = g?._myUid?.() || null;
            const owned = board?.tilesOwnedByPlayer || board?.hands || {};
            const ownedCounts = {};
            Object.entries(owned).forEach(([uid, list]) => {
                ownedCounts[uid] = Array.isArray(list) ? list.length : 0;
            });
            const visibleButtons = [];
            if (doc) {
                doc.querySelectorAll('button').forEach((btn) => {
                    if (btn.offsetParent == null) return;
                    const label = (btn.id || btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
                    if (label) visibleButtons.push(label);
                });
            }
            const hubDone = document.querySelector(
                'button#done-button,[data-action="done"],.done-button,#global-win-banner button'
            );
            const coherence = frame?.contentWindow?.__bananaMpDebug?.coherence?.()
                ?? g?._mpCoherenceSnapshot?.(board, me, t)
                ?? null;
            const mpDebugRaw = frame?.contentWindow?.__bananaMpDebug?.snapshot?.() ?? null;
            const clientState = mpDebugRaw?.clientState
                ?? frame?.contentWindow?.__bananaMpDebug?.clientState?.()
                ?? g?._mpDebugClientState?.()
                ?? null;
            return {
                tag: t,
                role: g?.playerRole ?? null,
                uid: me,
                phase: board?.phase ?? null,
                tiles: g?.tiles?.length ?? 0,
                pool: clientState?.localPoolLen ?? g?._tilePool?.length ?? -1,
                boardPool: clientState?.boardPoolLen ?? (Array.isArray(board?.pool) ? board.pool.length : -1),
                displayPoolLen: clientState?.displayPoolLen ?? g?._mpDisplayPoolLen?.() ?? null,
                cachePoolLen: g?._tilePool?.length ?? -1,
                boardSeq: board?.seq ?? null,
                boardRevision: board?.boardRevision ?? null,
                appliedRevision: clientState?.appliedRevision ?? g?._mpAppliedBoardRevision ?? null,
                structuralApplyKey: clientState?.structuralApplyKey ?? g?._mpGuestAppliedStructuralKey ?? null,
                revisionPending: clientState?.revisionPending ?? !!g?._mpPendingRevisionBoard,
                peelSeq: board?.peelSeq ?? null,
                dumpSeq: board?.dumpSeq ?? null,
                lastPeelSeq: clientState?.lastPeelSeq ?? g?._lastPeelSeq ?? null,
                lastDumpSeq: clientState?.lastDumpSeq ?? g?._lastDumpSeq ?? null,
                clientInventorySeq: clientState?.clientInventorySeq ?? g?._mpClientInventorySeq?.(me) ?? null,
                boardInventorySeq: clientState?.boardInventorySeq ?? (me != null ? (board?.inventorySeq?.[me] ?? null) : null),
                dumpUiPending: clientState?.dumpUiPending ?? g?._mpGuestDumpUiPending?.() ?? null,
                guestDumpPendingTileId: clientState?.dumpPendingTileId ?? g?._guestDumpPendingTileId ?? null,
                mpAwaitReset: clientState?.mpAwaitReset ?? !!g?._mpAwaitReset,
                mpAppliedResetCount: clientState?.mpAppliedResetCount ?? g?._mpAppliedResetCount ?? null,
                localBoardSeq: g?._boardSeq ?? null,
                coherence,
                mpDebug: mpDebugRaw,
                clientState,
                requireCoherent: frame?.contentWindow?.__bananaMpDebug?.requireCoherent?.('inventory-apply')
                    ?? g?._mpRequireCoherent?.(board, 'inventory-apply', { log: false })
                    ?? null,
                ownedCounts,
                visibleButtons,
                doneVisible: !!(hubDone && hubDone.offsetParent !== null),
                winnerUid: board?.winnerUid ?? g?._winnerUid ?? null,
                gameStarted: !!g?.gameStarted,
                canMutatePlayingBoard: g?.canMutatePlayingBoard?.() ?? null,
                canMutateHand: g?._canMutatePlayingHand?.() ?? null,
                guestAuthorityReady: g?._mpGuestAuthorityReadyForPlay?.() ?? null,
                boardGameStarted: board?.gameStarted ?? null,
                isOver: !!g?.isOver,
                resetCount: g?.lastResetCount ?? room?.global?.resetCount ?? null,
                lastResetCount: g?.lastResetCount ?? null,
                roomResetCount: clientState?.roomResetCount
                    ?? (typeof RtdbSchema !== 'undefined' && room
                        ? RtdbSchema.readResetCount(room)
                        : (room?.global?.resetCount ?? null))
            };
        }, { t: tag });
    } catch (err) {
        return { tag, error: String(err?.message || err) };
    }
}

/**
 * @param {object} opts
 * @param {import('playwright').Page} [opts.page1]
 * @param {import('playwright').Page} [opts.page2]
 * @param {boolean} [opts.mobile]
 * @param {string} [opts.topology]
 * @param {string} [opts.scenario]
 * @param {string} [opts.testName]
 * @param {string} [opts.gameId]
 */
async function captureMpFailureSnapshot(opts = {}) {
    const {
        page1 = null,
        page2 = null,
        mobile = false,
        topology = null,
        scenario = null,
        testName = null,
        gameId = null
    } = opts;

    let resolvedScenario = scenario;
    let resolvedTopology = topology;
    try {
        const { getActiveRunConfig } = require('./run-config');
        const cfg = getActiveRunConfig();
        if (!resolvedScenario && cfg?.scenario) resolvedScenario = cfg.scenario;
        if (!resolvedTopology && cfg?.topology) resolvedTopology = cfg.topology;
    } catch (_) { /* optional */ }

    const platform = mobile || resolvedTopology === 'mobile' ? 'mobile' : 'desktop';
    const viewports = {};
    if (page1) {
        const vp = page1.viewportSize();
        viewports.host = vp || null;
    }
    if (page2) {
        const vp = page2.viewportSize();
        viewports.guest = vp || null;
    }

    const [host, guest] = await Promise.all([
        page1 ? captureMpClientFailureDiag(page1, 'host') : null,
        page2 ? captureMpClientFailureDiag(page2, 'guest') : null
    ]);

    return normalizeMpFailureSnapshot({
        platform,
        topology: resolvedTopology || platform,
        scenario: resolvedScenario || 'default',
        testName: testName || null,
        gameId: gameId || null,
        viewport: viewports,
        host,
        guest,
        capturedAt: new Date().toISOString()
    });
}

/**
 * @param {Error} err
 * @param {object} snapshotOpts
 * @returns {Promise<{ error: string, details: string|null, stack: string|null, snapshot?: object }>}
 */
async function captureAuditFailureWithMpSnapshot(err, snapshotOpts = {}) {
    const base = captureAuditFailure(err);

    // Already enriched (re-throw / nested catch) — do not append another snapshot block.
    if (typeof err?.details === 'string' && err.details.includes('--- failure snapshot ---')) {
        return { ...base, snapshot: err.snapshot ?? null };
    }

    const detailsObj = typeof err?.details === 'object' && err.details != null ? err.details : null;
    const isTargeted = !!(detailsObj?.targeted && (detailsObj.targetedText || detailsObj.targetedDiag));
    const pages = [snapshotOpts.page1, snapshotOpts.page2].filter(Boolean);

    let snapshot = null;
    if (!isTargeted) {
        try {
            snapshot = await captureMpFailureSnapshot(snapshotOpts);
        } catch (snapErr) {
            snapshot = { snapshotError: String(snapErr?.message || snapErr) };
        }
    } else {
        try {
            snapshot = await captureMpFailureSnapshot(snapshotOpts);
        } catch (_) { /* slim context optional */ }
    }

    const messageHasWaitState = typeof err?.message === 'string'
        && err.message.includes('--- state ---');

    const chunks = [];
    if (!messageHasWaitState) {
        if (isTargeted) {
            const targetedBlock = formatTargetedAssertionFailure(detailsObj, { pages });
            if (targetedBlock) chunks.push(targetedBlock);
            const slim = formatSlimSyncContext(snapshot);
            if (slim) {
                chunks.push('--- sync context ---');
                chunks.push(slim);
            }
        } else {
            const assertionDetails = formatAssertionDetails(err, { skipProblemsInMessage: true });
            if (assertionDetails) chunks.push(assertionDetails);
            else if (base.details && typeof base.details === 'object') {
                chunks.push(stringifyDetails(base.details));
            }
            chunks.push('--- failure snapshot ---');
            chunks.push(JSON.stringify(snapshot, null, 2));
        }
    } else if (isTargeted) {
        const consoleLines = captureRecentConsoleDiag(pages);
        if (consoleLines.length) {
            chunks.push('Recent console:');
            consoleLines.forEach((line) => chunks.push(`  ${line}`));
        }
    }

    const errorOut = messageHasWaitState
        ? stripEmbeddedDiagBlocks(base.error)
        : base.error;

    return {
        ...base,
        error: errorOut,
        snapshot: isTargeted ? null : snapshot,
        details: chunks.filter(Boolean).join('\n\n')
    };
}

module.exports = {
    captureMpClientFailureDiag,
    captureMpFailureSnapshot,
    captureAuditFailureWithMpSnapshot,
    normalizeMpFailureSnapshot
};
