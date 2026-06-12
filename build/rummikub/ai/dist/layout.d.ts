import type { Meld } from './types.js';
import { Grid } from './grid.js';
/**

 * Minimal solver grid — one meld per row.

 * Player-visible spacing is applied in games/rummikub/grid.js from rules.js.

 */
export declare function layoutMelds(grid: Grid, melds: Meld[]): void;
