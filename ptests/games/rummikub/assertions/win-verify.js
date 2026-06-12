/**
 * Spatial win verification — catches false "unmatched" on known-good boards.
 */

/**
 * @param {import('playwright').Frame} frame
 */
async function readSpatialVerifyDiag(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const Core = RummikubCore;
        const table = (g?.tiles || []).filter((t) => t.zone === 'table');
        const spatial = typeof g?._verifyTableSpatial === 'function'
            ? g._verifyTableSpatial(table)
            : null;
        const orig = g?._originalMelds || [];
        const logicalOk = orig.length > 0 && orig.every((m) => Core.isValidMeld(m));
        const rackCount = (g?.tiles || []).filter((t) => t.zone === 'rack').length;
        return {
            tableCount: table.length,
            rackCount,
            spatialSolved: !!spatial?.solved,
            spatialReason: spatial?.reason || null,
            unmatched: spatial?.unmatchedTileBriefs || [],
            meldCount: spatial?.meldCount ?? 0,
            logicalOk,
            originalMeldCount: orig.length
        };
    });
}

/**
 * Fail when step-1 melds are logically valid and rack is empty but spatial verify disagrees.
 * @param {import('playwright').Frame} frame
 */
async function assertSpatialMatchesKnownSolution(frame) {
    const diag = await readSpatialVerifyDiag(frame);
    const falseNegative = diag.logicalOk
        && diag.rackCount === 0
        && diag.tableCount > 0
        && !diag.spatialSolved;
    if (falseNegative) {
        const unmatched = diag.unmatched.length
            ? diag.unmatched.join(', ')
            : '(none listed)';
        throw new Error(
            `spatial verify false negative: board matches original melds but `
            + `verify reported ${diag.spatialReason || 'unsolved'} `
            + `(unmatched: ${unmatched})`
        );
    }
    if (!diag.spatialSolved) {
        const unmatched = diag.unmatched.length
            ? diag.unmatched.join(', ')
            : '(none listed)';
        throw new Error(
            `table not spatially solved (${diag.spatialReason || 'unknown'}, `
            + `unmatched: ${unmatched})`
        );
    }
    return diag;
}

module.exports = {
    readSpatialVerifyDiag,
    assertSpatialMatchesKnownSolution
};
