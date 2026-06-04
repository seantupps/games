import { COLORS } from './types.js';
import { tilePoints } from './tiles.js';
/** Assign jokers in a candidate meld; returns null if unsatisfiable. */
export function assignJokersToMeld(meld) {
    return assignJokers(meld.tiles, meld.kind);
}
function assignJokers(tiles, kind) {
    const resolved = new Array(tiles.length);
    const jokerIdx = [];
    for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (t.kind === 'joker') {
            jokerIdx.push(i);
            continue;
        }
        resolved[i] = { color: t.color, value: t.value };
    }
    if (!jokerIdx.length) {
        const ok = kind === 'group' ? validateGroupResolved(resolved) : validateRunResolved(resolved);
        return ok ? resolved : null;
    }
    if (kind === 'group') {
        const nums = resolved.filter((r) => r?.value != null).map((r) => r.value);
        if (!nums.length)
            return null;
        const n = nums[0];
        if (nums.some((v) => v !== n))
            return null;
        const usedColors = new Set(resolved.filter((r) => r?.color).map((r) => r.color));
        if (usedColors.size !== nums.length)
            return null;
        const freeColors = COLORS.filter((c) => !usedColors.has(c));
        if (freeColors.length < jokerIdx.length)
            return null;
        let fi = 0;
        for (const ji of jokerIdx) {
            resolved[ji] = { color: freeColors[fi++], value: n };
        }
        return validateGroupResolved(resolved) ? resolved : null;
    }
    // run
    const anchors = resolved
        .map((r, i) => (r?.color && r.value != null ? { i, color: r.color, value: r.value } : null))
        .filter(Boolean);
    if (!anchors.length)
        return null;
    const color = anchors[0].color;
    if (anchors.some((a) => a.color !== color))
        return null;
    const minAnchor = anchors.reduce((m, a) => (a.value < m.value ? a : m), anchors[0]);
    const start = minAnchor.value - minAnchor.i;
    if (start < 1 || start + tiles.length - 1 > 13)
        return null;
    for (let i = 0; i < tiles.length; i++) {
        const need = start + i;
        const existing = resolved[i];
        if (existing?.value != null) {
            if (existing.value !== need || existing.color !== color)
                return null;
        }
        else {
            resolved[i] = { color, value: need };
        }
    }
    return validateRunResolved(resolved) ? resolved : null;
}
function validateGroupResolved(resolved) {
    if (resolved.length < 3 || resolved.length > 4)
        return false;
    const values = resolved.map((r) => r.value);
    if (values.some((v) => v == null))
        return false;
    const n = values[0];
    if (!values.every((v) => v === n))
        return false;
    const colors = resolved.map((r) => r.color);
    if (colors.some((c) => !c))
        return false;
    return new Set(colors).size === colors.length;
}
function validateRunResolved(resolved) {
    if (resolved.length < 3)
        return false;
    const color = resolved[0]?.color;
    if (!color || resolved.some((r) => r.color !== color))
        return false;
    for (let i = 1; i < resolved.length; i++) {
        const prev = resolved[i - 1]?.value;
        const cur = resolved[i]?.value;
        if (prev == null || cur == null || cur !== prev + 1)
            return false;
    }
    return true;
}
export function isValidMeld(meld) {
    if (meld.tiles.length < 3)
        return false;
    const kind = meld.kind;
    return assignJokers(meld.tiles, kind) !== null;
}
export function meldPoints(meld) {
    const assigned = assignJokers(meld.tiles, meld.kind);
    if (!assigned)
        return 0;
    return assigned.reduce((s, r) => s + (r.value ?? 0), 0);
}
export function meldLabel(meld) {
    const assigned = assignJokers(meld.tiles, meld.kind);
    if (!assigned)
        return '(invalid)';
    const parts = assigned.map((r) => `${r.color}${r.value}`);
    const tag = meld.kind === 'group' ? 'GRP' : 'RUN';
    return `${tag}[${parts.join(' ')}]`;
}
/** Deep-clone tiles with joker assignments filled for display. */
export function materializeMeld(meld) {
    const assigned = assignJokers(meld.tiles, meld.kind);
    if (!assigned)
        return meld;
    const tiles = meld.tiles.map((t, i) => {
        if (t.kind === 'joker') {
            const a = assigned[i];
            return { kind: 'joker', id: t.id, display: t.display, as: { color: a.color, value: a.value } };
        }
        return t;
    });
    return { kind: meld.kind, tiles };
}
export function scoreTilesFromRack(tiles) {
    return tiles.reduce((s, t) => s + tilePoints(t), 0);
}
//# sourceMappingURL=validate.js.map