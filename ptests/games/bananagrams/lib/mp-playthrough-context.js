/**
 * Per-audit playthrough trail — attached to review/stall failures for full root-cause chains.
 * Reset at the start of each AI playthrough; record guest snapshots each round.
 */

/** @type {object|null} */
let active = null;

function reset() {
    active = {
        auditSteps: [],
        aiReset: null,
        guestRounds: [],
        hostRounds: [],
        preWinGuest: null,
        preWinHost: null,
        winRound: null
    };
}

function ensure() {
    if (!active) reset();
    return active;
}

/** @param {'refresh'|'split'|'drag'|'snap'|'no-peel-rack'} step */
function markAuditStep(step) {
    const ctx = ensure();
    if (!ctx.auditSteps.includes(step)) ctx.auditSteps.push(step);
}

/**
 * @param {object} diag — host reset diag from frame evaluate
 */
function recordAiReset(diag) {
    ensure().aiReset = diag || null;
}

/**
 * Compact per-round snapshot for failure chains (no full board dump).
 * @param {'guest'|'host'} side
 * @param {number} round
 * @param {object} snap — snapshotMpAiState output
 * @param {object} [meta]
 */
function recordRound(side, round, snap, meta = {}) {
    const ctx = ensure();
    const row = {
        round,
        rack: snap?.rack?.length ?? 0,
        board: snap?.boardCells?.length ?? 0,
        tiles: snap?.tileCount ?? ((snap?.rack?.length ?? 0) + (snap?.boardCells?.length ?? 0)),
        pool: snap?.poolLen ?? null,
        gridOk: snap?.gridOk ?? null,
        gridInvalidWord: snap?.gridInvalidWord || null,
        action: meta.action || null,
        idleWhy: meta.idleWhy || null
    };
    if (side === 'guest') ctx.guestRounds.push(row);
    else ctx.hostRounds.push(row);
}

/**
 * @param {Record<string, { tiles?: object[] }>} preWinByUid
 * @param {string} hostUid
 * @param {string} guestUid
 */
function recordPreWinBoards(preWinByUid, hostUid, guestUid) {
    const ctx = ensure();
    const summarize = (tiles) => {
        const list = tiles || [];
        return {
            tileCount: list.length,
            sampleIds: list.slice(0, 3).map((t) => t.id)
        };
    };
    if (preWinByUid?.[hostUid]) {
        ctx.preWinHost = summarize(preWinByUid[hostUid].tiles);
    }
    if (preWinByUid?.[guestUid]) {
        ctx.preWinGuest = summarize(preWinByUid[guestUid].tiles);
    }
}

function recordWinRound(round, side) {
    ensure().winRound = { round, side };
}

function getPlaythroughContext() {
    return active ? { ...active } : null;
}

function clearPlaythroughContext() {
    active = null;
}

module.exports = {
    reset,
    markAuditStep,
    recordAiReset,
    recordRound,
    recordPreWinBoards,
    recordWinRound,
    getPlaythroughContext,
    clearPlaythroughContext
};
