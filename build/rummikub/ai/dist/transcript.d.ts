import type { Tile } from './types.js';
import type { PuzzleTranscriptLike } from './types.js';
import { renderGrid, renderRack } from './display.js';
import type { Grid } from './grid.js';
export declare function tileCounts(board: number, rack: Tile[]): {
    board: number;
    rack: number;
    total: number;
};
export declare function formatCounts(board: number, rack: Tile[]): string;
export declare class Transcript implements PuzzleTranscriptLike {
    private readonly echo;
    readonly lines: string[];
    constructor(echo?: boolean);
    private out;
    separator(): void;
    sessionStart(meta: {
        seed: number;
        placed: string;
        rack: number;
        board: number;
        genMs?: number;
    }): void;
    solvedBoard(grid: Grid, rack: Tile[]): void;
    removed(percent: number, count: number, grid: Grid, rack: Tile[]): void;
    /** Step 3 — player-facing start (mini melds on board + rack). */
    playerStart(grid: Grid, rack: Tile[]): void;
    private rackLine;
    solved(attempts: number, elapsedMs: number): void;
    partialSolve(attempts: number, elapsedMs: number, stats: {
        fragments: number;
        orphanTiles: number;
        boardTiles: number;
        meldedTiles?: number;
    }): void;
    stuck(attempts: number, reason: string): void;
    timeout(meta: {
        elapsedMs: number;
        target: number;
        placed: number;
        meldCount: number;
        attempts: number;
    }): void;
    note(msg: string): void;
}
export { renderGrid, renderRack };
