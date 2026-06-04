import { sortRack } from './tiles.js';
/** Ends of a run get this weight; center approaches END + MIDDLE_BONUS. */
const RUN_END_WEIGHT = 1;
const RUN_MIDDLE_BONUS = 2;
/** Higher weight toward the center of a run (ends stay selectable). */
function runTileRemovalWeight(index, len) {
    if (len <= 2)
        return RUN_END_WEIGHT;
    const center = (len - 1) / 2;
    const dist = Math.abs(index - center);
    const maxDist = Math.max(center, 1);
    const middleScore = 1 - dist / maxDist;
    return RUN_END_WEIGHT + middleScore * RUN_MIDDLE_BONUS;
}
function tileRemovalWeights(melds) {
    const weights = new Map();
    for (const meld of melds) {
        if (meld.kind !== 'run')
            continue;
        const len = meld.tiles.length;
        meld.tiles.forEach((t, i) => {
            weights.set(t.id, runTileRemovalWeight(i, len));
        });
    }
    return weights;
}
function buildCandidates(grid, melds) {
    const weights = tileRemovalWeights(melds);
    const out = [];
    for (const [key, cell] of grid.cells) {
        out.push({
            key,
            weight: weights.get(cell.tile.id) ?? RUN_END_WEIGHT
        });
    }
    return out;
}
function weightedPickIndex(candidates, rng) {
    let total = 0;
    for (const c of candidates)
        total += c.weight;
    let pick = rng.randrange(total);
    for (let i = 0; i < candidates.length; i++) {
        pick -= candidates[i].weight;
        if (pick < 0)
            return i;
    }
    return candidates.length - 1;
}
/** Move `percent`% of board tiles (rounded) from grid to player rack. */
export function removePercentFromBoard(grid, rack, melds, percent, rng) {
    const g = grid.clone();
    const r = [...rack];
    const keys = [...g.cells.keys()];
    if (!keys.length || percent <= 0) {
        return { grid: g, rack: r, removed: 0 };
    }
    const count = Math.max(1, Math.round((keys.length * percent) / 100));
    const candidates = buildCandidates(g, melds);
    let removed = 0;
    while (removed < count && candidates.length > 0) {
        const idx = weightedPickIndex(candidates, rng);
        const { key } = candidates[idx];
        const cell = g.cells.get(key);
        g.cells.delete(key);
        r.push(cell.tile);
        candidates.splice(idx, 1);
        removed++;
    }
    return { grid: g, rack: sortRack(r), removed };
}
export function gridTileCount(grid) {
    return grid.cells.size;
}
//# sourceMappingURL=remove.js.map