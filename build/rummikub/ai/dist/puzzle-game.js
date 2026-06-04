import { layoutStats, meldsToGrid, partitionBoardTiles, partitionIsSolved } from './board-solver.js';
import { sortRack } from './tiles.js';
function tilesFromGrid(grid) {
    return [...grid.cells.values()].map((c) => c.tile);
}
function poolMatchesMelds(pool, melds) {
    const poolIds = new Set(pool.map((t) => t.id));
    if (poolIds.size !== pool.length)
        return false;
    const meldIds = melds.flatMap((m) => m.tiles.map((t) => t.id));
    if (meldIds.length !== pool.length)
        return false;
    return meldIds.every((id) => poolIds.has(id));
}
/**
 * Step 3: repartition board tiles only; unmelded tiles move to the rack.
 */
export function solveBoardLayout(grid, rack, rng, opts = {}) {
    const { deadlineMs = 2000 } = opts;
    const t0 = Date.now();
    const pool = tilesFromGrid(grid);
    const { result, grid: meldedGrid, attempts } = partitionBoardTiles(pool, rng, t0 + deadlineMs, {
        originalMelds: opts.originalMelds
    });
    const stats = layoutStats(result.melds, result.remaining);
    const elapsedMs = Date.now() - t0;
    const solved = partitionIsSolved(result);
    const rackWithOrphans = sortRack([...rack, ...result.remaining]);
    return {
        solved,
        attempts,
        elapsedMs,
        grid: meldedGrid,
        rack: rackWithOrphans,
        fragments: stats.fragments,
        orphanTiles: stats.orphans,
        boardTiles: pool.length,
        meldedTiles: stats.melded
    };
}
/**
 * Step 4 audit: partition board + rack together; win = all tiles on board, rack empty.
 */
export function solveFullPool(grid, rack, rng, opts = {}) {
    const { deadlineMs = 2000 } = opts;
    const t0 = Date.now();
    const pool = [...tilesFromGrid(grid), ...rack];
    const { result, grid: solvedGrid, attempts } = partitionBoardTiles(pool, rng, t0 + deadlineMs, {
        originalMelds: opts.originalMelds
    });
    const stats = layoutStats(result.melds, result.remaining);
    const elapsedMs = Date.now() - t0;
    let solved = partitionIsSolved(result);
    let outGrid = solvedGrid;
    let outRack = sortRack([...result.remaining]);
    let usedKnownLayout = false;
    if (!solved && opts.originalMelds?.length && poolMatchesMelds(pool, opts.originalMelds)) {
        outGrid = meldsToGrid(opts.originalMelds);
        outRack = [];
        solved = true;
        usedKnownLayout = true;
    }
    return {
        solved,
        attempts,
        elapsedMs,
        grid: outGrid,
        rack: outRack,
        fragments: solved ? 0 : stats.fragments,
        orphanTiles: outRack.length,
        boardTiles: pool.length,
        meldedTiles: solved ? pool.length : stats.melded,
        usedKnownLayout
    };
}
/** Step 3 — build player start (mini board melds + rack). */
export function runBoardSolve(grid, rack, rng, log, opts = {}) {
    const result = solveBoardLayout(grid, rack, rng, { originalMelds: opts.originalMelds });
    if (result.solved) {
        log?.solved(result.attempts, result.elapsedMs);
    }
    else if (result.meldedTiles === 0) {
        log?.stuck(0, 'could not form any valid melds from board tiles');
    }
    else {
        log?.partialSolve?.(result.attempts, result.elapsedMs, {
            fragments: result.fragments,
            orphanTiles: result.orphanTiles,
            boardTiles: result.boardTiles,
            meldedTiles: result.meldedTiles
        });
    }
    log?.playerStart?.(result.grid, result.rack);
    return result;
}
/** Step 4 — verify player start can reach a full solved board (any valid layout). */
export function runAuditSolve(grid, rack, rng, log, opts = {}) {
    const result = solveFullPool(grid, rack, rng, { originalMelds: opts.originalMelds });
    if (result.solved) {
        const via = result.usedKnownLayout ? ' (known layout)' : '';
        log?.note?.(`AUDIT OK${via}`);
    }
    else {
        log?.note?.(`[FAIL] audit: no full layout for ${result.boardTiles} tiles (${result.orphanTiles} orphan(s))`);
    }
    return result;
}
//# sourceMappingURL=puzzle-game.js.map