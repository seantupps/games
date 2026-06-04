import { assignJokersToMeld } from './validate.js';
/** Original runs this long (or longer) are targets for rearrangement bias. */
export const LONG_RUN_MIN = 4;
const BASE_WEIGHT = 1;
const GROUP_BREAK_BONUS = 0.45;
const SUBRUN_PENALTY_PER_TILE = 0.35;
const MIXED_SOURCE_BONUS = 0.9;
export function buildOriginalLongRuns(melds, minLen = LONG_RUN_MIN) {
    const out = [];
    for (const meld of melds) {
        if (meld.kind !== 'run' || meld.tiles.length < minLen)
            continue;
        const assigned = assignJokersToMeld(meld);
        if (!assigned?.length)
            continue;
        const color = assigned[0].color;
        const values = assigned.map((a) => a.value);
        const start = Math.min(...values);
        out.push({
            color,
            start,
            len: meld.tiles.length,
            tileIds: meld.tiles.map((t) => t.id)
        });
    }
    return out;
}
function tileLongRunMembership(tileId, runs) {
    let n = 0;
    for (const run of runs) {
        if (run.tileIds.includes(tileId))
            n++;
    }
    return n;
}
/** True when every meld tile is a contiguous slice of the same original long run. */
function isContiguousOriginalSubRun(meld, orig) {
    if (meld.kind !== 'run' || meld.tiles.length < 3)
        return false;
    const assigned = assignJokersToMeld(meld);
    if (!assigned || assigned[0].color !== orig.color)
        return false;
    const values = assigned.map((a) => a.value);
    for (let i = 1; i < values.length; i++) {
        if (values[i] !== values[i - 1] + 1)
            return false;
    }
    const indices = meld.tiles
        .map((t) => orig.tileIds.indexOf(t.id))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b);
    if (indices.length !== meld.tiles.length)
        return false;
    for (let i = 1; i < indices.length; i++) {
        if (indices[i] !== indices[i - 1] + 1)
            return false;
    }
    return true;
}
function contiguousOriginalMatch(meld, runs) {
    for (const run of runs) {
        if (isContiguousOriginalSubRun(meld, run))
            return run;
    }
    return null;
}
/** Pick weight: higher = more likely. Favors breaking original long runs (not guaranteed). */
export function meldPickWeight(meld, runs) {
    if (!runs.length)
        return BASE_WEIGHT;
    if (meld.kind === 'group') {
        let bonus = 0;
        for (const t of meld.tiles) {
            if (tileLongRunMembership(t.id, runs) > 0)
                bonus += GROUP_BREAK_BONUS;
        }
        return BASE_WEIGHT + bonus;
    }
    const preserved = contiguousOriginalMatch(meld, runs);
    if (preserved) {
        return Math.max(0.3, BASE_WEIGHT - SUBRUN_PENALTY_PER_TILE * meld.tiles.length);
    }
    const sourceRuns = new Set();
    for (const t of meld.tiles) {
        for (const run of runs) {
            if (run.tileIds.includes(t.id)) {
                sourceRuns.add(`${run.color}${run.start}`);
            }
        }
    }
    if (sourceRuns.size > 1)
        return BASE_WEIGHT + MIXED_SOURCE_BONUS;
    return BASE_WEIGHT;
}
/** Lower = less of the original long-run structure preserved (preferred). */
export function partitionPreservationScore(melds, runs) {
    let score = 0;
    for (const meld of melds) {
        if (meld.kind === 'group')
            continue;
        const match = contiguousOriginalMatch(meld, runs);
        if (match)
            score += meld.tiles.length * meld.tiles.length;
    }
    return score;
}
export function weightedPickMelds(items, weightFn, rng) {
    let total = 0;
    const weights = items.map((m) => {
        const w = weightFn(m);
        total += w;
        return w;
    });
    let pick = rng.randrange(total);
    for (let i = 0; i < items.length; i++) {
        pick -= weights[i];
        if (pick < 0)
            return items[i];
    }
    return items[items.length - 1];
}
//# sourceMappingURL=partition-bias.js.map