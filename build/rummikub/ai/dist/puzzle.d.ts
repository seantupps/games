import type { Meld, Tile, Variant } from './types.js';
import type { Rng } from './rng.js';
import { Grid } from './grid.js';
export interface Puzzle {
    grid: Grid;
    rack: Tile[];
    melds: Meld[];
    placedCount: number;
    rackCount: number;
    placedRatio: number;
    targetCount: number;
}
export interface GenerateResult {
    ok: boolean;
    timedOut: boolean;
    elapsedMs: number;
    puzzle: Puzzle | null;
    /** Set when timedOut or failed after deadline. */
    partial: {
        target: number;
        placed: number;
        meldCount: number;
        attempts: number;
        melds: Meld[];
        grid: Grid;
        rack: Tile[];
    } | null;
}
/**
 * Build a fully solved board: exactly `placedCount` tiles on the table in valid melds.
 * Retries with new shuffles until success or timeoutMs (default 3s).
 */
export declare function generateSolvedBoard(rng: Rng, placedCount?: number, variant?: Variant, timeoutMs?: number): GenerateResult;
export declare function demoPuzzle(): Puzzle;
export declare function demoResult(): GenerateResult;
