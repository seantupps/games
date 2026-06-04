import type { Meld, Tile } from './types.js';
import type { Rng } from './rng.js';
/** Sets (groups): 3–4 tiles. Runs: 3–6 tiles. */
export declare const GROUP_SIZES: readonly [3, 4];
export declare const RUN_SIZES: readonly [3, 4, 5, 6];
export declare const MELD_SIZES: readonly [3, 4, 5, 6];
/** True if n is a sum of meld sizes {3,4,5,6}. */
export declare function isAchievableTarget(n: number): boolean;
/** Random partition of n into meld sizes {3,4,5,6}. */
export declare function randomSizePlan(n: number, rng: Rng): number[];
export declare function meldSizeValid(meld: Meld): boolean;
/** Any valid meld from rack (no exact-count budget), for full-board partition. */
export declare function findFastMeldLoose(rack: Tile[], rng: Rng, onBoard?: Meld[], allowConnectable?: boolean): Meld | null;
/** First valid meld (run 3–6, set 3–4). Skips connect check when allowConnectable. */
export declare function findFastMeld(rack: Tile[], maxLen: number, rng: Rng, onBoard?: Meld[], allowConnectable?: boolean, skipBudgetCheck?: boolean): Meld | null;
export interface GreedyFillResult {
    melds: Meld[];
    placed: number;
    remaining: Tile[];
}
/** Greedily pack melds until exactly `target` tiles or stuck. */
export declare function greedyFill(pool: Tile[], target: number, rng: Rng, deadlineMs: number, allowConnectable?: boolean): GreedyFillResult;
/** Use every tile in melds (remainder empty). One fast attempt — caller retries. */
export declare function greedyFillComplete(pool: Tile[], rng: Rng, _deadlineMs: number, allowConnectable?: boolean): GreedyFillResult;
/** Exhaustive partition for full pool (slow — use with deadline and retries). */
export declare function partitionAllTiles(pool: Tile[], rng: Rng, deadlineMs: number, allowConnectable?: boolean): GreedyFillResult | null;
export declare function nearestAchievableTarget(n: number, poolSize: number): number[];
