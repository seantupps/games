import type { Tile, Variant } from './types.js';
export declare const STANDARD_POOL_SIZE = 106;
export declare const XP_POOL_SIZE = 160;
export declare function defaultPlacedCount(variant?: Variant): number;
export declare const JOKER_RACK_PENALTY = 30;
export declare const OPENING_THRESHOLD = 30;
export declare const DEFAULT_HAND_SIZE = 14;
/** Copies per (color, value) for each variant. */
export declare function copiesPerFace(variant: Variant): number;
export declare function jokerCount(variant: Variant): number;
/** Build an unshuffled pool matching distribution.txt (104 numbered + 2 jokers). */
export declare function buildPool(variant?: Variant): Tile[];
export declare function expectedPoolSize(variant: Variant): number;
/** Verify multiset matches spec (all tiles accounted for). */
export declare function verifyPool(tiles: Tile[], variant?: Variant): boolean;
export declare function tileLabel(tile: Tile): string;
export declare function tilePoints(tile: Tile): number;
export declare function sortRack(tiles: Tile[]): Tile[];
export declare function rackPoints(tiles: Tile[]): number;
