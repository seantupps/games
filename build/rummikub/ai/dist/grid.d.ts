import type { Color, Tile } from './types.js';
export interface GridCell {
    tile: Tile;
    /** Resolved color/value for display and validation. */
    color: Color;
    value: number;
}
/** Sparse 2D board — same role as Bananagrams grid cells map. */
export declare class Grid {
    readonly cells: Map<string, GridCell>;
    static key(x: number, y: number): string;
    get(x: number, y: number): GridCell | undefined;
    set(x: number, y: number, cell: GridCell): void;
    clone(): Grid;
    bounds(padX?: number, padY?: number): {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
    };
    /** Place a meld horizontally starting at (startX, y). */
    placeMeldHorizontal(meld: {
        kind: 'group' | 'run';
        tiles: Tile[];
    }, startX: number, y: number): void;
}
