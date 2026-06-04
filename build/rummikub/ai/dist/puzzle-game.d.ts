import type { PuzzleTranscriptLike, Tile, Meld } from './types.js';
import { Grid } from './grid.js';
import type { Rng } from './rng.js';
export interface SolveResult {
    solved: boolean;
    attempts: number;
    elapsedMs: number;
    grid: Grid;
    rack: Tile[];
    fragments: number;
    orphanTiles: number;
    boardTiles: number;
    meldedTiles: number;
    /** True when audit used step-1 melds after partition miss. */
    usedKnownLayout?: boolean;
}
export interface SolveBoardOptions {
    deadlineMs?: number;
    /** Original step-1 melds; solver favors breaking up long runs from this layout. */
    originalMelds?: Meld[];
}
/**
 * Step 3: repartition board tiles only; unmelded tiles move to the rack.
 */
export declare function solveBoardLayout(grid: Grid, rack: Tile[], rng: Rng, opts?: SolveBoardOptions): SolveResult;
/**
 * Step 4 audit: partition board + rack together; win = all tiles on board, rack empty.
 */
export declare function solveFullPool(grid: Grid, rack: Tile[], rng: Rng, opts?: SolveBoardOptions): SolveResult;
export interface BoardSolveLogOptions {
    originalMelds?: Meld[];
}
/** Step 3 — build player start (mini board melds + rack). */
export declare function runBoardSolve(grid: Grid, rack: Tile[], rng: Rng, log: PuzzleTranscriptLike | null, opts?: BoardSolveLogOptions): SolveResult;
/** Step 4 — verify player start can reach a full solved board (any valid layout). */
export declare function runAuditSolve(grid: Grid, rack: Tile[], rng: Rng, log: PuzzleTranscriptLike | null, opts?: BoardSolveLogOptions): SolveResult;
