import type { Rng } from './rng.js';
import type { Meld, Tile } from './types.js';
import { Grid } from './grid.js';
export interface RemoveResult {
    grid: Grid;
    rack: Tile[];
    removed: number;
}
/** Move `percent`% of board tiles (rounded) from grid to player rack. */
export declare function removePercentFromBoard(grid: Grid, rack: Tile[], melds: Meld[], percent: number, rng: Rng): RemoveResult;
export declare function gridTileCount(grid: Grid): number;
