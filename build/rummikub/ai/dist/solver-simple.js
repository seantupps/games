import { COLORS } from './types.js';
import { isValidMeld, meldPoints } from './validate.js';
import { OPENING_THRESHOLD } from './tiles.js';
function findGroupMeld(numbers, jokers) {
    const byValue = new Map();
    for (const t of numbers) {
        const list = byValue.get(t.value) ?? [];
        list.push(t);
        byValue.set(t.value, list);
    }
    for (const tiles of byValue.values()) {
        const colors = new Set(tiles.map((t) => t.color));
        if (colors.size >= 3) {
            const pick = COLORS.filter((c) => colors.has(c)).slice(0, 3).map((c) => tiles.find((t) => t.color === c));
            const meld = { kind: 'group', tiles: pick };
            if (isValidMeld(meld))
                return meld;
        }
        if (colors.size === 2 && jokers.length) {
            const pick = [...tiles.slice(0, 2), jokers[0]];
            const meld = { kind: 'group', tiles: pick };
            if (isValidMeld(meld))
                return meld;
        }
    }
    return null;
}
function findRunMeld(numbers, jokers) {
    for (const color of COLORS) {
        const seq = numbers.filter((t) => t.color === color).sort((a, b) => a.value - b.value);
        for (let len = 3; len <= 13; len++) {
            for (let start = 1; start + len - 1 <= 13; start++) {
                const need = Array.from({ length: len }, (_, i) => start + i);
                const picked = [];
                let ji = 0;
                for (const v of need) {
                    const hit = seq.find((t) => t.value === v && !picked.includes(t));
                    if (hit) {
                        picked.push(hit);
                    }
                    else if (ji < jokers.length) {
                        picked.push(jokers[ji++]);
                    }
                    else {
                        picked.length = 0;
                        break;
                    }
                }
                if (picked.length === len) {
                    const meld = { kind: 'run', tiles: picked };
                    if (isValidMeld(meld))
                        return meld;
                }
            }
        }
    }
    return null;
}
/** Find a single group or run wholly on the rack (no table manipulation yet). */
export function findSimpleMeldFromRack(rack, opts = {}) {
    const numbers = rack.filter((t) => t.kind === 'number');
    const jokers = rack.filter((t) => t.kind === 'joker');
    const prefer = opts.prefer ?? 'group';
    const run = findRunMeld(numbers, jokers);
    const group = findGroupMeld(numbers, jokers);
    if (prefer === 'run')
        return run ?? group;
    return group ?? run;
}
/** Greedy opening: combine simple melds until >= OPENING_THRESHOLD or give best single. */
export function findOpeningMelds(rack) {
    const used = new Set();
    const melds = [];
    let points = 0;
    while (points < OPENING_THRESHOLD) {
        const remaining = rack.filter((t) => !used.has(t.id));
        const one = findSimpleMeldFromRack(remaining);
        if (!one)
            break;
        for (const t of one.tiles)
            used.add(t.id);
        melds.push(one);
        points += meldPoints(one);
    }
    if (points >= OPENING_THRESHOLD)
        return melds;
    // fallback: best single meld by points
    const single = findSimpleMeldFromRack(rack);
    return single ? [single] : [];
}
export function openingPoints(melds) {
    return melds.reduce((s, m) => s + meldPoints(m), 0);
}
/** Try to extend an existing run on table with one rack tile (after opened). */
export function findExtension(table, rack) {
    for (let mi = 0; mi < table.length; mi++) {
        const m = table[mi];
        if (m.kind !== 'run' || rack.length === 0)
            continue;
        const mat = m;
        for (const tile of rack) {
            if (tile.kind === 'joker')
                continue;
            const extendedL = { kind: 'run', tiles: [tile, ...mat.tiles] };
            const extendedR = { kind: 'run', tiles: [...mat.tiles, tile] };
            if (isValidMeld(extendedL))
                return { meldIndex: mi, tile, side: 'left' };
            if (isValidMeld(extendedR))
                return { meldIndex: mi, tile, side: 'right' };
        }
    }
    return null;
}
export function removeTilesFromRack(rack, ids) {
    return rack.filter((t) => !ids.has(t.id));
}
export function applyMeldToTable(table, meld) {
    table.push(meld);
}
export function applyExtension(table, hit) {
    const m = table[hit.meldIndex];
    if (hit.side === 'left') {
        m.tiles.unshift(hit.tile);
    }
    else {
        m.tiles.push(hit.tile);
    }
}
//# sourceMappingURL=solver-simple.js.map