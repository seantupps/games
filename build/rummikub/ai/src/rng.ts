/** Deterministic RNG — same interface as build/bananagrams Mulberry32 helper. */
export interface Rng {
  randrange(n: number): number;
  shuffle<T>(arr: T[]): void;
}

export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    randrange(n: number): number {
      return Math.floor(next() * n);
    },
    shuffle<T>(arr: T[]): void {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }
  };
}
