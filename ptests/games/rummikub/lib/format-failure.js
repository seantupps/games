/**
 * Rummikub assertion / playthrough failure formatting — structured snapshots in errors.
 */

/**
 * @param {string} label
 * @param {string[]} problems
 * @param {object} [extra]
 */
function formatFailure(label, problems, extra = {}) {
    const message = problems.length === 1
        ? `${label}: ${problems[0]}`
        : `${label}: ${problems.join('; ')}`;
    return { message, problems, ...extra };
}

/**
 * Human-readable lines for runner output (rummikub-tagged).
 * @param {object} snapshot
 * @returns {string[]}
 */
function formatPlaythroughFailureLines(snapshot) {
    if (!snapshot) return ['(no snapshot)'];
    const lines = [
        `── rummikub playthrough [${snapshot.tag || '?'}] ──`
    ];
    if (snapshot.puzzleSeed != null) lines.push(`puzzle seed: ${snapshot.puzzleSeed}`);
    if (snapshot.solverMethod) lines.push(`solver: ${snapshot.solverMethod}`);
    lines.push(
        `tiles: ${snapshot.totalTiles ?? '?'} (rack ${snapshot.rackCount ?? '?'}, table ${snapshot.tableCount ?? '?'})`
    );
    if (snapshot.planTotal != null) {
        lines.push(
            `plan: ${snapshot.planExecuted ?? 0}/${snapshot.planTotal} executed`
            + `, ${snapshot.planRemaining ?? '?'} remaining`
        );
    }
    if (snapshot.unplannedRackBriefs?.length) {
        lines.push(`unplanned rack (${snapshot.unplannedRackBriefs.length}): ${snapshot.unplannedRackBriefs.join(', ')}`);
    }
    if (snapshot.rackBriefs?.length) {
        lines.push(`rack: ${snapshot.rackBriefs.join(', ')}`);
    }
    if (snapshot.unmatched?.length) {
        lines.push(`unmatched (${snapshot.unmatched.length}): ${snapshot.unmatched.join(', ')}`);
    }
    if (snapshot.tableSolved != null) {
        lines.push(
            `table: solved=${snapshot.tableSolved ? 'yes' : 'no'}`
            + (snapshot.tableSpatialReason ? ` (${snapshot.tableSpatialReason})` : '')
        );
    }
    lines.push(`overlaps: ${snapshot.overlaps ? 'yes' : 'no'}`);
    if (snapshot.overlapPairs?.length) {
        snapshot.overlapPairs.forEach((p) => {
            lines.push(`  overlap: ${p.a} ↔ ${p.b}`);
        });
    }
    if (snapshot.invalidClusters?.length) {
        lines.push(`invalid clusters (${snapshot.invalidClusters.length}):`);
        snapshot.invalidClusters.slice(0, 6).forEach((c) => {
            lines.push(`  ✗ ${c.reason} (${c.size}): ${(c.tiles || []).join(' ')}`);
        });
        if (snapshot.invalidClusters.length > 6) {
            lines.push(`  … +${snapshot.invalidClusters.length - 6} more`);
        }
    }
    if (snapshot.pendingPlanBriefs?.length) {
        lines.push(`pending plan (${snapshot.pendingPlanBriefs.length}):`);
        snapshot.pendingPlanBriefs.slice(0, 8).forEach((p) => {
            lines.push(`  → ${p.tile} ${p.side} of ${p.anchor}`);
        });
    }
    if (snapshot.lastStep) {
        const s = snapshot.lastStep;
        lines.push(
            `last step: #${s.move || '?'} ${s.tileBrief || '?'} ${s.side || '?'} of ${s.anchorBrief || '?'}`
            + ` rack→${s.rackLeft ?? '?'}`
        );
    }
    if (snapshot.moveHistory?.length) {
        const tail = snapshot.moveHistory.slice(-5);
        lines.push(`recent moves: ${tail.map((m) => m.label).join(' | ')}`);
    }
    if (snapshot.hub) {
        lines.push(`hub: gameStarted=${snapshot.hub.gameStarted} isOver=${snapshot.hub.isOver}`);
    }
    return lines;
}

/**
 * @param {string} label
 * @param {string[]} problems
 * @param {object} snapshot
 * @returns {{ message: string, problems: string[], snapshot: object, summary: string[] }}
 */
function packPlaythroughFailure(label, problems, snapshot) {
    const { message } = formatFailure(label, problems);
    const summary = formatPlaythroughFailureLines(snapshot);
    return { message, problems, snapshot, summary };
}

module.exports = {
    formatFailure,
    formatPlaythroughFailureLines,
    packPlaythroughFailure
};
