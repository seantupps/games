import type { Color, Tile } from './types.js';
import type { Grid } from './grid.js';
/** One display slot: "." or colored number (1–13). */
export declare function renderCell(value: number | null, color: Color | null): string;
/** Joker on rack or board — J in black or red face. */
export declare function renderJoker(tile: Extract<Tile, {
    kind: 'joker';
}>): string;
/** Bananagrams-style lines: ". . 8 9 10 . . . ." */
export declare function renderGrid(grid: Grid, color?: boolean): string[];
export declare function renderRack(tiles: Tile[], color?: boolean): string;
export declare function colorLegend(): string;
