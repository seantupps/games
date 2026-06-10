/**
 * Tier MP failure client diag — summary / coherence / seq / deep (no nested duplicates).
 */

/**
 * Count object keys named `key` anywhere in a JSON tree (property names only).
 * @param {unknown} node
 * @param {string} key
 * @returns {number}
 */
function countJsonKeyOccurrences(node, key) {
    let n = 0;
    const walk = (v) => {
        if (v == null || typeof v !== 'object') return;
        if (Array.isArray(v)) {
            v.forEach(walk);
            return;
        }
        for (const [k, val] of Object.entries(v)) {
            if (k === key) n += 1;
            walk(val);
        }
    };
    walk(node);
    return n;
}

/** @param {Record<string, unknown>} obj */
function pruneEmpty(obj) {
    const out = {};
    Object.entries(obj || {}).forEach(([k, v]) => {
        if (v == null) return;
        if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return;
        out[k] = v;
    });
    return out;
}

/**
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function pickSeq(raw) {
    if (!raw) return null;
    const seq = raw.coherence?.seq ?? raw.mpDebug?.seq ?? null;
    if (seq) {
        const {
            lifecycle,
            inventory,
            actions,
            pool,
            boardApply,
            reconcileAttempts,
            inventoryApplyGen,
            lastInventoryApply,
            dumpBundle,
            peelBundle,
            splitBundle
        } = seq;
        const out = pruneEmpty({
            lifecycle,
            inventory,
            actions,
            pool,
            boardApply,
            reconcileAttempts,
            inventoryApplyGen,
            lastInventoryApply
        });
        if (!coherenceBundleCoherent(raw.coherence, 'split') && splitBundle) out.splitBundle = splitBundle;
        if (!coherenceBundleCoherent(raw.coherence, 'dump') && dumpBundle) out.dumpBundle = dumpBundle;
        if (!coherenceBundleCoherent(raw.coherence, 'peel') && peelBundle) out.peelBundle = peelBundle;
        return Object.keys(out).length ? out : null;
    }
    return pruneEmpty({
        lifecycle: {
            boardSeq: raw.boardSeq ?? null,
            localBoardSeq: raw.localBoardSeq ?? null,
            boardRevision: raw.boardRevision ?? null,
            appliedRevision: raw.appliedRevision ?? null
        },
        inventory: {
            board: raw.boardInventorySeq ?? null,
            local: raw.clientInventorySeq ?? null
        },
        actions: {
            peelBoard: raw.peelSeq ?? null,
            dumpBoard: raw.dumpSeq ?? null,
            peelLast: raw.lastPeelSeq ?? null,
            dumpLast: raw.lastDumpSeq ?? null
        },
        pool: {
            board: raw.boardPool ?? null,
            local: raw.pool ?? null
        }
    });
}

/**
 * @param {object|null|undefined} coherence
 * @param {'split'|'dump'|'peel'} kind
 */
function coherenceBundleCoherent(coherence, kind) {
    if (!coherence) return true;
    if (kind === 'split') return coherence.splitBundleCoherent !== false;
    if (kind === 'dump') return coherence.dumpBundleCoherent !== false;
    return coherence.peelBundleCoherent !== false;
}

/**
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function pickCoherence(raw) {
    const c = raw?.coherence;
    if (!c) return null;
    return pruneEmpty({
        ok: c.ok,
        coherent: c.coherent,
        failed: Array.isArray(c.failed) ? c.failed : [],
        inventorySynced: c.inventorySynced,
        poolSynced: c.poolSynced,
        epochSynced: c.epochSynced,
        revisionSynced: c.revisionSynced,
        actionSeqAcked: c.actionSeqAcked,
        inventorySnapshotConsistent: c.inventorySnapshotConsistent,
        peelPending: c.peelPending,
        dumpPending: c.dumpPending,
        inventoryLag: c.inventoryLag,
        revisionPending: c.revisionPending,
        splitBundleCoherent: c.splitBundleCoherent,
        dumpBundleCoherent: c.dumpBundleCoherent,
        peelBundleCoherent: c.peelBundleCoherent
    });
}

/**
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function pickRequireCoherent(raw) {
    const r = raw?.requireCoherent;
    if (!r) return null;
    return pruneEmpty({
        ok: r.ok,
        failed: Array.isArray(r.failed) ? r.failed : [],
        ctx: r.ctx
    });
}

/**
 * @param {object|null|undefined} raw
 * @param {object|null} coherence
 * @param {object|null} seq
 */
function epochDriftDetected(raw, coherence, seq, clientState) {
    if (coherence?.splitBundleCoherent === false || coherence?.epochSynced === false) {
        return true;
    }
    const roomEpoch = clientState?.roomResetCount
        ?? raw.coherence?.epoch?.roomEpoch
        ?? seq?.lifecycle?.resetCount
        ?? null;
    const appliedEpoch = raw.mpAppliedResetCount
        ?? clientState?.mpAppliedResetCount
        ?? seq?.lifecycle?.mpAppliedResetCount
        ?? null;
    return roomEpoch != null && appliedEpoch != null && roomEpoch !== appliedEpoch;
}

function buildSummary(raw, coherence, seq) {
    if (!raw) return null;
    const clientState = raw.mpDebug?.clientState ?? raw.clientState ?? null;
    const pool = raw.pool ?? clientState?.localPoolLen ?? clientState?.displayPoolLen ?? null;
    const epochDrift = epochDriftDetected(raw, coherence, seq, clientState);
    return pruneEmpty({
        phase: raw.phase ?? clientState?.phase ?? null,
        boardRevision: seq?.lifecycle?.boardRevision ?? raw.boardRevision ?? clientState?.boardRevision ?? null,
        appliedRevision: seq?.lifecycle?.appliedRevision ?? raw.appliedRevision ?? clientState?.appliedRevision ?? null,
        boardInventorySeq: seq?.inventory?.board ?? raw.boardInventorySeq ?? clientState?.boardInventorySeq ?? null,
        clientInventorySeq: seq?.inventory?.local ?? raw.clientInventorySeq ?? clientState?.clientInventorySeq ?? null,
        tiles: raw.tiles ?? clientState?.handCount ?? null,
        pool,
        boardPool: raw.boardPool ?? clientState?.boardPoolLen ?? seq?.pool?.board ?? null,
        coherenceOk: coherence?.ok ?? null,
        coherenceFailed: coherence?.failed?.length ? coherence.failed : [],
        gameStarted: raw.gameStarted ?? clientState?.gameStarted ?? null,
        boardGameStarted: raw.boardGameStarted ?? null,
        peelSeq: seq?.actions?.peelBoard ?? raw.peelSeq ?? null,
        dumpSeq: seq?.actions?.dumpBoard ?? raw.dumpSeq ?? null,
        resetCount: raw.resetCount ?? clientState?.roomResetCount ?? null,
        mpAwaitReset: raw.mpAwaitReset ?? clientState?.mpAwaitReset ?? null,
        ...(epochDrift ? {
            roomResetCount: clientState?.roomResetCount
                ?? raw.coherence?.epoch?.roomEpoch
                ?? seq?.lifecycle?.resetCount
                ?? null,
            lastResetCount: raw.resetCount ?? null,
            mpAppliedResetCount: raw.mpAppliedResetCount
                ?? clientState?.mpAppliedResetCount
                ?? seq?.lifecycle?.mpAppliedResetCount
                ?? null
        } : {})
    });
}

/**
 * @param {object|null|undefined} raw
 * @param {object|null} coherence
 * @param {object|null} seq
 */
function buildDeep(raw, coherence, seq) {
    if (!raw) return null;
    const rev = raw.mpDebug?.revision;
    const clientState = raw.mpDebug?.clientState ?? raw.clientState ?? null;
    const splitIncoherent = coherence?.splitBundleCoherent === false;
    const epochDrift = epochDriftDetected(raw, coherence, seq, clientState);
    const phaseDrift = raw.gameStarted != null && raw.boardGameStarted != null
        && raw.gameStarted !== raw.boardGameStarted;
    const deep = pruneEmpty({
        requireCoherent: pickRequireCoherent(raw),
        ownedCounts: raw.ownedCounts,
        visibleButtons: raw.visibleButtons?.length ? raw.visibleButtons : null,
        doneVisible: raw.doneVisible,
        winnerUid: raw.winnerUid,
        canMutatePlayingBoard: raw.canMutatePlayingBoard,
        canMutateHand: raw.canMutateHand,
        guestAuthorityReady: raw.guestAuthorityReady ?? clientState?.guestAuthorityReady,
        structuralApplyKey: raw.structuralApplyKey ?? clientState?.structuralApplyKey,
        localBoardSeq: seq?.lifecycle?.localBoardSeq ?? raw.localBoardSeq ?? clientState?.boardSeq,
        inventoryProjectionFailed: clientState?.inventoryProjectionFailed,
        layoutEpochMismatch: clientState?.layoutEpochMismatch,
        layoutEpoch: clientState?.layoutEpoch,
        dumpUiPending: raw.dumpUiPending ?? clientState?.dumpUiPending,
        guestDumpPendingTileId: raw.guestDumpPendingTileId ?? clientState?.dumpPendingTileId,
        mpAppliedResetCount: raw.mpAppliedResetCount ?? clientState?.mpAppliedResetCount,
        isOver: raw.isOver
    });
    if (rev && (rev.pending || rev.inventoryLagAfterRevision || rev.guestInventoryLag || rev.coherent === false)) {
        deep.revision = pruneEmpty({
            pending: rev.pending,
            inventoryLagAfterRevision: rev.inventoryLagAfterRevision,
            guestInventoryLag: rev.guestInventoryLag,
            structuralApplyKey: rev.structuralApplyKey,
            appliedStructuralKey: rev.appliedStructuralKey,
            coherent: rev.coherent,
            legacyBundleComplete: rev.legacyBundleComplete
        });
    }
    if (epochDrift || (raw.coherence?.epoch && coherence && !coherence.epochSynced)) {
        deep.epoch = pruneEmpty({
            ...(raw.coherence?.epoch || {}),
            roomEpoch: clientState?.roomResetCount
                ?? raw.coherence?.epoch?.roomEpoch
                ?? seq?.lifecycle?.resetCount
                ?? null,
            mpAppliedResetCount: raw.mpAppliedResetCount
                ?? clientState?.mpAppliedResetCount
                ?? seq?.lifecycle?.mpAppliedResetCount
                ?? null,
            lastResetCount: raw.resetCount ?? null,
            mpAwaitReset: raw.mpAwaitReset ?? clientState?.mpAwaitReset ?? null,
            layoutEpoch: clientState?.layoutEpoch ?? raw.coherence?.epoch?.layoutEpoch ?? null,
            layoutEpochMismatch: clientState?.layoutEpochMismatch ?? null
        });
    }
    if (splitIncoherent) {
        deep.split = pruneEmpty({
            authority: raw.mpDebug?.split ?? null,
            wireBundle: seq?.splitBundle ?? raw.mpDebug?.seq?.splitBundle ?? null
        });
    }
    const gamePhase = raw.mpDebug?.gamePhase ?? null;
    if (gamePhase && (splitIncoherent || phaseDrift || epochDrift)) {
        deep.gamePhase = gamePhase;
    }
    const lastApply = seq?.lastInventoryApply ?? raw.mpDebug?.seq?.lastInventoryApply ?? null;
    if (lastApply && (splitIncoherent || coherence?.inventorySynced === false)) {
        deep.lastInventoryApply = lastApply;
    }
    return Object.keys(deep).length ? deep : null;
}

/**
 * Normalize one client capture into summary / coherence / seq / deep tiers.
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeMpClientDiag(raw) {
    if (!raw) return null;
    if (raw.error) return { tag: raw.tag, error: raw.error };
    const coherence = pickCoherence(raw);
    const seq = pickSeq(raw);
    const summary = buildSummary(raw, coherence, seq);
    const deep = buildDeep(raw, coherence, seq);
    return pruneEmpty({
        tag: raw.tag,
        role: raw.role,
        uid: raw.uid,
        summary,
        coherence,
        seq,
        deep
    });
}

/**
 * @param {object} snapshot — output of captureMpFailureSnapshot
 * @returns {object}
 */
function normalizeMpFailureSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    return {
        ...snapshot,
        host: normalizeMpClientDiag(snapshot.host),
        guest: normalizeMpClientDiag(snapshot.guest)
    };
}

/**
 * Assert normalized snapshot does not repeat canonical fields across tiers.
 * @param {object} client — normalized host or guest
 * @param {{ boardRevision?: number, appliedRevision?: number }} limits
 * @returns {string[]}
 */
function findSnapshotFieldDupes(client, limits = {}) {
    const maxBoardRevision = limits.boardRevision ?? 2;
    const maxAppliedRevision = limits.appliedRevision ?? 2;
    const failures = [];
    if (!client) return failures;

    const banned = ['mpDebug', 'clientState', 'requireCoherent.snap'];
    const json = JSON.stringify(client);
    if (json.includes('"mpDebug"')) failures.push('mpDebug tier must be removed');
    if (json.includes('"clientState"')) failures.push('clientState tier must be folded into summary/deep');
    if (json.includes('"snap"')) failures.push('requireCoherent.snap must be stripped');

    const boardRevision = countJsonKeyOccurrences(client, 'boardRevision');
    const appliedRevision = countJsonKeyOccurrences(client, 'appliedRevision');
    if (boardRevision > maxBoardRevision) {
        failures.push(`boardRevision appears ${boardRevision} times (max ${maxBoardRevision})`);
    }
    if (appliedRevision > maxAppliedRevision) {
        failures.push(`appliedRevision appears ${appliedRevision} times (max ${maxAppliedRevision})`);
    }
    if (client.coherence?.seq) failures.push('coherence must not embed seq');
    if (client.summary && client.coherence?.failed && client.summary.coherenceFailed) {
        const a = JSON.stringify(client.summary.coherenceFailed);
        const b = JSON.stringify(client.coherence.failed);
        if (a !== b) failures.push('summary.coherenceFailed must mirror coherence.failed');
    }
    return failures;
}

/** Fixture mimicking pre-normalize bloated capture (AI-reset timeout case). */
function bloatedMpClientFixture() {
    const lifecycle = {
        boardSeq: 2,
        localBoardSeq: 1,
        boardRevision: 2,
        appliedRevision: 0,
        resetCount: 4,
        mpAppliedResetCount: 5
    };
    const inventory = { board: 1, local: 1, lag: false };
    const seq = { lifecycle, inventory, actions: { peelBoard: 0, dumpBoard: 0 }, pool: { board: 58, local: 58 } };
    const coherence = {
        ok: false,
        coherent: false,
        failed: ['inventorySynced', 'splitBundleCoherent', 'revisionSynced'],
        splitBundleCoherent: false,
        epochSynced: true,
        seq,
        epoch: { roomEpoch: 5, layoutEpoch: 5, boardDealEpoch: 4 }
    };
    return {
        tag: 'host',
        role: 'P1',
        uid: 'u_banana_host',
        phase: 'playing',
        tiles: 21,
        pool: 58,
        boardPool: 58,
        boardRevision: 2,
        appliedRevision: 0,
        boardInventorySeq: 1,
        clientInventorySeq: 1,
        gameStarted: false,
        boardGameStarted: true,
        coherence,
        mpDebug: {
            revision: { boardRevision: 2, appliedRevision: 0, pending: false, coherent: false },
            seq: {
                lifecycle,
                inventory,
                actions: seq.actions,
                pool: seq.pool,
                splitBundle: {
                    resetCount: 4,
                    afterBoardSeq: 2,
                    boardGameStarted: true,
                    coherent: false
                },
                lastInventoryApply: { source: 'pipeline-bundle', result: 'no-op', remote: 1, local: 0 }
            },
            split: {
                gameStarted: false,
                boardGameStarted: true,
                resetCount: 4,
                lastSplitTxn: { resetCount: 4, afterBoardSeq: 2 },
                coherent: false
            },
            gamePhase: {
                phase: 'playing',
                boardGameStarted: true,
                canMutateHand: true,
                guestAuthorityReady: false
            },
            inventoryCounters: { wire: 1, local: 1, client: 1 }
        },
        clientState: {
            boardRevision: 2,
            appliedRevision: 0,
            clientInventorySeq: 1,
            boardInventorySeq: 1,
            handCount: 21,
            gameStarted: false,
            roomResetCount: 5,
            mpAppliedResetCount: 5
        },
        requireCoherent: {
            ok: false,
            failed: ['inventorySynced', 'splitBundleCoherent', 'revisionSynced'],
            snap: { ...coherence, seq }
        },
        ownedCounts: { u_banana_host: 21 },
        resetCount: 5
    };
}

module.exports = {
    countJsonKeyOccurrences,
    normalizeMpClientDiag,
    normalizeMpFailureSnapshot,
    findSnapshotFieldDupes,
    bloatedMpClientFixture
};
