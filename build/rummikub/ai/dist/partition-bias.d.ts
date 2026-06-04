import type { Color, Meld } from './types.js';
/** Original runs this long (or longer) are targets for rearrangement bias. */
export declare const LONG_RUN_MIN = 4;
export interface OriginalLongRun {
    color: Color;
    start: number;
    len: number;
    tileIds: string[];
}
export declare function buildOriginalLongRuns(melds: Meld[], minLen?: number): OriginalLongRun[];
/** Pick weight: higher = more likely. Favors breaking original long runs (not guaranteed). */
export declare function meldPickWeight(meld: Meld, runs: OriginalLongRun[]): number;
/** Lower = less of the original long-run structure preserved (preferred). */
export declare function partitionPreservationScore(melds: Meld[], runs: OriginalLongRun[]): number;
export declare function weightedPickMelds<T extends Meld>(items: T[], weightFn: (m: T) => number, rng: {
    randrange(n: number): number;
}): T;
