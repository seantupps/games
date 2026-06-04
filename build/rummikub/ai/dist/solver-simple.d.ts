import type { Meld, Tile } from './types.js';
export interface FindMeldOptions {
    /** Puzzle boards read better with horizontal runs (Bananagrams-style rows). */
    prefer?: 'run' | 'group';
}
/** Find a single group or run wholly on the rack (no table manipulation yet). */
export declare function findSimpleMeldFromRack(rack: Tile[], opts?: FindMeldOptions): Meld | null;
/** Greedy opening: combine simple melds until >= OPENING_THRESHOLD or give best single. */
export declare function findOpeningMelds(rack: Tile[]): Meld[];
export declare function openingPoints(melds: Meld[]): number;
/** Try to extend an existing run on table with one rack tile (after opened). */
export declare function findExtension(table: Meld[], rack: Tile[]): {
    meldIndex: number;
    tile: Tile;
    side: 'left' | 'right';
} | null;
export declare function removeTilesFromRack(rack: Tile[], ids: Set<string>): Tile[];
export declare function applyMeldToTable(table: Meld[], meld: Meld): void;
export declare function applyExtension(table: Meld[], hit: {
    meldIndex: number;
    tile: Tile;
    side: 'left' | 'right';
}): void;
