import type { Meld, Tile } from './types.js';
import type { Rng } from './rng.js';
import { Grid } from './grid.js';
export interface PartitionOptions {
    /** Step-1 melds; solver prefers partitions that break up original long runs. */
    originalMelds?: Meld[];
}
export interface PartitionResult {
    melds: Meld[];
    remaining: Tile[];
    placed: number;
}
/** Partition board tiles into valid melds; rack is not used. */
export declare function partitionBoardTiles(pool: Tile[], rng: Rng, deadlineMs: number, opts?: PartitionOptions): {
    result: PartitionResult;
    grid: Grid;
    attempts: number;
};
/** True when every board tile is in a valid meld on the laid-out grid. */
export declare function partitionIsSolved(result: PartitionResult): boolean;
export declare function meldsToGrid(melds: Meld[]): Grid;
/** Fragment/orphan stats after layout. */
export declare function layoutStats(melds: Meld[], remaining: Tile[]): {
    melded: number;
    orphans: number;
    fragments: number;
    meldCount: number;
};
