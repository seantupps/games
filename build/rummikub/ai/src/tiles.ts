import type { Color, Tile, Variant } from './types.js';
import { COLORS } from './types.js';

export const STANDARD_POOL_SIZE = 106;
export const XP_POOL_SIZE = 160;
export function defaultPlacedCount(variant: Variant = 'standard'): number {
  return buildPool(variant).length;
}
export const JOKER_RACK_PENALTY = 30;
export const OPENING_THRESHOLD = 30;
export const DEFAULT_HAND_SIZE = 14;

/** Copies per (color, value) for each variant. */
export function copiesPerFace(variant: Variant): number {
  return variant === 'xp' ? 3 : 2;
}

export function jokerCount(variant: Variant): number {
  return variant === 'xp' ? 4 : 2;
}

let nextId = 0;

function resetIds(): void {
  nextId = 0;
}

function makeNumberTile(color: Color, value: number): Tile {
  return { kind: 'number', color, value, id: `t${nextId++}` };
}

function makeJoker(display: 'B' | 'R'): Tile {
  return { kind: 'joker', id: `t${nextId++}`, display };
}

/** Build an unshuffled pool matching distribution.txt (104 numbered + 2 jokers). */
export function buildPool(variant: Variant = 'standard'): Tile[] {
  resetIds();
  const pool: Tile[] = [];
  const copies = copiesPerFace(variant);
  for (const color of COLORS) {
    for (let value = 1; value <= 13; value++) {
      for (let c = 0; c < copies; c++) {
        pool.push(makeNumberTile(color, value));
      }
    }
  }
  const jokers = jokerCount(variant);
  const displays: ('B' | 'R')[] = variant === 'xp' ? ['B', 'R', 'B', 'R'] : ['B', 'R'];
  for (let j = 0; j < jokers; j++) {
    pool.push(makeJoker(displays[j]!));
  }
  return pool;
}

export function expectedPoolSize(variant: Variant): number {
  return variant === 'xp' ? XP_POOL_SIZE : STANDARD_POOL_SIZE;
}

/** Verify multiset matches spec (all tiles accounted for). */
export function verifyPool(tiles: Tile[], variant: Variant = 'standard'): boolean {
  if (tiles.length !== expectedPoolSize(variant)) return false;
  const copies = copiesPerFace(variant);
  const counts = new Map<string, number>();
  let jokers = 0;
  for (const t of tiles) {
    if (t.kind === 'joker') {
      jokers++;
      continue;
    }
    const key = `${t.color}:${t.value}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (jokers !== jokerCount(variant)) return false;
  for (const color of COLORS) {
    for (let value = 1; value <= 13; value++) {
      if ((counts.get(`${color}:${value}`) ?? 0) !== copies) return false;
    }
  }
  return true;
}

export function tileLabel(tile: Tile): string {
  if (tile.kind === 'joker') {
    if (tile.as) return `J(${tile.as.color}${tile.as.value})`;
    return `${tile.display}J`;
  }
  return `${tile.color}${tile.value}`;
}

export function tilePoints(tile: Tile): number {
  if (tile.kind === 'joker') {
    return tile.as ? tile.as.value : JOKER_RACK_PENALTY;
  }
  return tile.value;
}

export function sortRack(tiles: Tile[]): Tile[] {
  return [...tiles].sort((a, b) => {
    if (a.kind === 'joker' && b.kind !== 'joker') return 1;
    if (b.kind === 'joker' && a.kind !== 'joker') return -1;
    if (a.kind === 'joker' && b.kind === 'joker') {
      if (a.display !== b.display) return a.display.localeCompare(b.display);
      return a.id.localeCompare(b.id);
    }
    const an = a as Extract<Tile, { kind: 'number' }>;
    const bn = b as Extract<Tile, { kind: 'number' }>;
    if (an.color !== bn.color) return an.color.localeCompare(bn.color);
    return an.value - bn.value;
  });
}

export function rackPoints(tiles: Tile[]): number {
  return tiles.reduce((s, t) => s + (t.kind === 'joker' ? JOKER_RACK_PENALTY : t.value), 0);
}
