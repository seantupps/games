import { COLORS } from './types.js';
export const STANDARD_POOL_SIZE = 106;
export const XP_POOL_SIZE = 160;
export function defaultPlacedCount(variant = 'standard') {
    return buildPool(variant).length;
}
export const JOKER_RACK_PENALTY = 30;
export const OPENING_THRESHOLD = 30;
export const DEFAULT_HAND_SIZE = 14;
/** Copies per (color, value) for each variant. */
export function copiesPerFace(variant) {
    return variant === 'xp' ? 3 : 2;
}
export function jokerCount(variant) {
    return variant === 'xp' ? 4 : 2;
}
let nextId = 0;
function resetIds() {
    nextId = 0;
}
function makeNumberTile(color, value) {
    return { kind: 'number', color, value, id: `t${nextId++}` };
}
function makeJoker(display) {
    return { kind: 'joker', id: `t${nextId++}`, display };
}
/** Build an unshuffled pool matching distribution.txt (104 numbered + 2 jokers). */
export function buildPool(variant = 'standard') {
    resetIds();
    const pool = [];
    const copies = copiesPerFace(variant);
    for (const color of COLORS) {
        for (let value = 1; value <= 13; value++) {
            for (let c = 0; c < copies; c++) {
                pool.push(makeNumberTile(color, value));
            }
        }
    }
    const jokers = jokerCount(variant);
    const displays = variant === 'xp' ? ['B', 'R', 'B', 'R'] : ['B', 'R'];
    for (let j = 0; j < jokers; j++) {
        pool.push(makeJoker(displays[j]));
    }
    return pool;
}
export function expectedPoolSize(variant) {
    return variant === 'xp' ? XP_POOL_SIZE : STANDARD_POOL_SIZE;
}
/** Verify multiset matches spec (all tiles accounted for). */
export function verifyPool(tiles, variant = 'standard') {
    if (tiles.length !== expectedPoolSize(variant))
        return false;
    const copies = copiesPerFace(variant);
    const counts = new Map();
    let jokers = 0;
    for (const t of tiles) {
        if (t.kind === 'joker') {
            jokers++;
            continue;
        }
        const key = `${t.color}:${t.value}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (jokers !== jokerCount(variant))
        return false;
    for (const color of COLORS) {
        for (let value = 1; value <= 13; value++) {
            if ((counts.get(`${color}:${value}`) ?? 0) !== copies)
                return false;
        }
    }
    return true;
}
export function tileLabel(tile) {
    if (tile.kind === 'joker') {
        if (tile.as)
            return `J(${tile.as.color}${tile.as.value})`;
        return `${tile.display}J`;
    }
    return `${tile.color}${tile.value}`;
}
export function tilePoints(tile) {
    if (tile.kind === 'joker') {
        return tile.as ? tile.as.value : JOKER_RACK_PENALTY;
    }
    return tile.value;
}
export function sortRack(tiles) {
    return [...tiles].sort((a, b) => {
        if (a.kind === 'joker' && b.kind !== 'joker')
            return 1;
        if (b.kind === 'joker' && a.kind !== 'joker')
            return -1;
        if (a.kind === 'joker' && b.kind === 'joker') {
            if (a.display !== b.display)
                return a.display.localeCompare(b.display);
            return a.id.localeCompare(b.id);
        }
        const an = a;
        const bn = b;
        if (an.color !== bn.color)
            return an.color.localeCompare(bn.color);
        return an.value - bn.value;
    });
}
export function rackPoints(tiles) {
    return tiles.reduce((s, t) => s + (t.kind === 'joker' ? JOKER_RACK_PENALTY : t.value), 0);
}
//# sourceMappingURL=tiles.js.map