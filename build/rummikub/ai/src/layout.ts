import type { Meld } from './types.js';
import { Grid } from './grid.js';

/** Lay melds horizontally, one per row (Bananagrams-style). */
export function layoutMelds(grid: Grid, melds: Meld[]): void {
  let rowY = 0;
  for (const meld of melds) {
    grid.placeMeldHorizontal(meld, 2, rowY);
    rowY += 1;
  }
}
