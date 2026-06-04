import type { Color, Meld, Tile } from './types.js';
import type { Grid } from './grid.js';
/** Every occupied cell belongs to at least one valid meld (group or run). */
export declare function gridIsValid(grid: Grid): boolean;
export declare function resolvedCell(tile: Tile, color: Color, value: number): {
    tile: Tile;
    color: Color;
    value: number;
};
export declare function jokerAssignmentForRun(tile: Extract<Tile, {
    kind: 'joker';
}>, color: Color, value: number): Extract<Tile, {
    kind: 'joker';
}>;
/** Validate a candidate meld including joker assignment. */
export declare function meldValid(meld: Meld): boolean;
