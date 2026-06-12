/**
 * Rummikub playthrough snapshots — runner diagnostics (SP).
 * Shape mirrors universal failure snapshots where possible.
 */
const { captureMpClientFailureDiag } = require('../../../shared/infra/failure-snapshot');

/**
 * @param {import('playwright').Frame} frame
 */
async function snapshotRummikubState(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const WL = window.RummikubWinLog;
        const G = window.RummikubGrid;
        const tiles = g?.tiles || [];
        const rack = tiles.filter((t) => t.zone === 'rack');
        const table = tiles.filter((t) => t.zone === 'table');
        const brief = (t) => (WL?.tileBrief ? WL.tileBrief(g._coreTile(t)) : t.id);
        const diag = typeof g?._evaluateWinCondition === 'function'
            ? g._evaluateWinCondition('snapshot')
            : null;
        const overlaps = G?.handHasOverlaps ? G.handHasOverlaps(tiles) : false;
        const tableSpatial = typeof g?._verifyTableSpatial === 'function'
            ? g._verifyTableSpatial(table)
            : null;
        const plan = g?.__rummiAiPlan || [];
        const planIndex = g?.__rummiAiPlanIndex ?? 0;
        return {
            gameId: 'rummikub',
            puzzleSeed: g?._puzzleSeed ?? null,
            totalTiles: tiles.length,
            rackCount: rack.length,
            tableCount: table.length,
            rackBriefs: rack.map(brief),
            tableSolved: !!tableSpatial?.solved,
            tableSpatialReason: tableSpatial?.reason || null,
            unmatched: tableSpatial?.unmatchedTileBriefs || diag?.partition?.unmatchedTileBriefs || [],
            invalidClusters: tableSpatial?.invalidClusters || [],
            overlaps,
            planRemaining: Math.max(0, plan.length - planIndex),
            planExecuted: planIndex,
            planTotal: plan.length
        };
    });
}

/**
 * Rich in-frame diagnostic bundle for playthrough failures.
 * @param {import('playwright').Frame} frame
 * @param {string} tag
 * @param {object} [ctx]
 */
async function captureFramePlaythroughDiag(frame, tag, ctx = {}) {
    return frame.evaluate(({ t, extra }) => {
        const g = window.game;
        const WL = window.RummikubWinLog;
        const G = window.RummikubGrid;
        const tiles = g?.tiles || [];
        const rack = tiles.filter((tile) => tile.zone === 'rack');
        const table = tiles.filter((tile) => tile.zone === 'table');
        const brief = (tile) => (WL?.tileBrief ? WL.tileBrief(g._coreTile(tile)) : tile.id);
        const diag = typeof g?._evaluateWinCondition === 'function'
            ? g._evaluateWinCondition('snapshot')
            : null;
        const partition = diag?.partition;
        const plan = g?.__rummiAiPlan || [];
        const planIndex = g?.__rummiAiPlanIndex ?? 0;
        const rackIds = new Set(rack.map((tile) => tile.id));
        const plannedIds = new Set(plan.map((p) => p.tileId));
        const unplannedRack = rack.filter((tile) => !plannedIds.has(tile.id));

        const overlapPairs = [];
        for (let i = 0; i < tiles.length; i++) {
            for (let j = i + 1; j < tiles.length; j++) {
                const a = tiles[i];
                const b = tiles[j];
                if (G?.tilesOverlapAt?.(a.x, a.y, b.x, b.y)) {
                    overlapPairs.push({ a: brief(a), b: brief(b), ids: [a.id, b.id] });
                }
            }
        }

        const pendingPlan = plan.slice(planIndex).map((p) => {
            const tile = tiles.find((x) => x.id === p.tileId);
            const anchor = p.anchorId ? tiles.find((x) => x.id === p.anchorId) : null;
            return {
                tileId: p.tileId,
                tile: tile ? brief(tile) : p.tileId,
                anchorId: p.anchorId,
                anchor: anchor ? brief(anchor) : (p.isolated ? '(isolated)' : '?'),
                side: p.side,
                meldKind: p.meldKind,
                isolated: !!p.isolated
            };
        });

        const tableLayout = table.slice(0, 20).map((tile) => ({
            id: tile.id,
            brief: brief(tile),
            x: Math.round(tile.x),
            y: Math.round(tile.y),
            grid: tile.gridX != null ? `${tile.gridX},${tile.gridY}` : null
        }));

        return {
            tag: t,
            puzzleSeed: g?._puzzleSeed ?? null,
            solverMethod: g?.__rummiAiSolverMethod ?? extra.solverMethod ?? null,
            gameId: 'rummikub',
            totalTiles: tiles.length,
            rackCount: rack.length,
            tableCount: table.length,
            rackBriefs: rack.map(brief),
            unplannedRackBriefs: unplannedRack.map(brief),
            tableSpatial: typeof g?._verifyTableSpatial === 'function'
                ? g._verifyTableSpatial(table)
                : null,
            tableSolved: !!g?._verifyTableSpatial?.(table)?.solved,
            unmatched: g?._verifyTableSpatial?.(table)?.unmatchedTileBriefs
                || partition?.unmatchedTileBriefs || [],
            overlaps: G?.handHasOverlaps ? G.handHasOverlaps(tiles) : false,
            overlapPairs: overlapPairs.slice(0, 8),
            invalidClusters: (g?._verifyTableSpatial?.(table)?.invalidClusters
                || partition?.invalidClusters || []).map((c) => ({
                reason: c.reason,
                size: c.size,
                tiles: c.tiles
            })),
            meldLabels: (partition?.meldLabels || []).slice(0, 8),
            inReview: !!g?._postGameReview,
            isOver: !!g?.isOver,
            victoryRegistered: !!g?._victoryRegistered,
            planExecuted: planIndex,
            planTotal: plan.length,
            planRemaining: Math.max(0, plan.length - planIndex),
            pendingPlanBriefs: pendingPlan,
            tableLayout,
            lastStep: extra.lastStep || null,
            moveHistory: extra.moveHistory || [],
            winDiag: window.__lastRummikubWinCheck ?? null,
            capturedAt: new Date().toISOString()
        };
    }, { t: tag, extra: ctx });
}

/**
 * SP playthrough failure — frame game diag + hub/page context (universal snapshot shape).
 * @param {import('playwright').Page} page
 * @param {import('playwright').Frame} frame
 * @param {string} tag
 * @param {object} [ctx]
 */
async function captureRichPlaythroughFailure(page, frame, tag, ctx = {}) {
    const frameDiag = await captureFramePlaythroughDiag(frame, tag, ctx);
    let hub = null;
    try {
        hub = await captureMpClientFailureDiag(page, 'sp-playthrough');
    } catch (err) {
        hub = { error: String(err?.message || err) };
    }
    return {
        platform: 'desktop',
        topology: 'sp',
        scenario: 'playthrough',
        gameId: 'rummikub',
        tag,
        capturedAt: frameDiag.capturedAt,
        frame: frameDiag,
        hub,
        // flat aliases for formatPlaythroughFailureLines
        ...frameDiag,
        hubContext: hub
    };
}

/** @deprecated use captureRichPlaythroughFailure */
async function capturePlaythroughFailureSnapshot(frame, tag = 'playthrough-fail') {
    return captureFramePlaythroughDiag(frame, tag, {});
}

module.exports = {
    snapshotRummikubState,
    captureFramePlaythroughDiag,
    captureRichPlaythroughFailure,
    capturePlaythroughFailureSnapshot
};
