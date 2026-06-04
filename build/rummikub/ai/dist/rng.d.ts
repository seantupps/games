/** Deterministic RNG — same interface as build/bananagrams Mulberry32 helper. */
export interface Rng {
    randrange(n: number): number;
    shuffle<T>(arr: T[]): void;
}
export declare function makeRng(seed: number): Rng;
