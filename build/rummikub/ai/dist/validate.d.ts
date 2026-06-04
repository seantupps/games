import type { Color, Meld, Tile } from './types.js';
/** Assign jokers in a candidate meld; returns null if unsatisfiable. */
export declare function assignJokersToMeld(meld: Meld): {
    color: Color;
    value: number;
}[] | null;
export declare function isValidMeld(meld: Meld): boolean;
export declare function meldPoints(meld: Meld): number;
export declare function meldLabel(meld: Meld): string;
/** Deep-clone tiles with joker assignments filled for display. */
export declare function materializeMeld(meld: Meld): Meld;
export declare function scoreTilesFromRack(tiles: Tile[]): number;
