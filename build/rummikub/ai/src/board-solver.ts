import type { Color, Meld, NumberTile, Tile } from './types.js';
import { COLORS } from './types.js';
import { isValidMeld } from './validate.js';
import type { Rng } from './rng.js';
import { makeRng } from './rng.js';
import { Grid } from './grid.js';
import { layoutMelds } from './layout.js';
import {
  buildOriginalLongRuns,
  meldPickWeight,
  partitionPreservationScore,
  weightedPickMelds,
  type OriginalLongRun
} from './partition-bias.js';

export interface PartitionOptions {
  /** Step-1 melds; solver prefers partitions that break up original long runs. */
  originalMelds?: Meld[];
}

const GREEDY_TOP_CANDIDATES = 8;

const GROUP_SIZES = [3, 4] as const;
const MIN_RUN = 3;
const MAX_RUN = 13;

export interface PartitionResult {
  melds: Meld[];
  remaining: Tile[];
  placed: number;
}

function splitPool(pool: Tile[]): { numbers: NumberTile[]; jokers: Tile[] } {
  const numbers: NumberTile[] = [];
  const jokers: Tile[] = [];
  for (const t of pool) {
    if (t.kind === 'number') numbers.push(t);
    else jokers.push(t);
  }
  return { numbers, jokers };
}

function tryBuildRun(
  numbers: NumberTile[],
  jokers: Tile[],
  color: Color,
  start: number,
  len: number
): Tile[] | null {
  const seq = numbers.filter((t) => t.color === color);
  const picked: Tile[] = [];
  const used = new Set<string>();
  let ji = 0;

  for (let v = start; v < start + len; v++) {
    const hit = seq.find((t) => t.value === v && !used.has(t.id));
    if (hit) {
      used.add(hit.id);
      picked.push(hit);
    } else if (ji < jokers.length) {
      used.add(jokers[ji]!.id);
      picked.push(jokers[ji]!);
      ji++;
    } else {
      return null;
    }
  }
  const meld: Meld = { kind: 'run', tiles: picked };
  return isValidMeld(meld) ? picked : null;
}

function tryBuildGroup(numbers: NumberTile[], jokers: Tile[], value: number, size: number): Tile[] | null {
  const tiles = numbers.filter((t) => t.value === value);
  const byColor = new Map<Color, NumberTile[]>();
  for (const t of tiles) {
    const list = byColor.get(t.color) ?? [];
    list.push(t);
    byColor.set(t.color, list);
  }
  const colors = [...byColor.keys()];
  if (colors.length + jokers.length < size) return null;

  const tryPick = (order: Color[]): Tile[] | null => {
    const picked: Tile[] = [];
    let ji = 0;
    for (const c of order) {
      if (picked.length >= size) break;
      const t = byColor.get(c)?.[0];
      if (!t) continue;
      picked.push(t);
    }
    while (picked.length < size && ji < jokers.length) picked.push(jokers[ji]!);
    if (picked.length !== size) return null;
    const meld: Meld = { kind: 'group', tiles: picked };
    return isValidMeld(meld) ? picked : null;
  };

  const direct = tryPick(colors);
  if (direct) return direct;
  if (colors.length >= size) {
    const perm = [...colors];
    for (let i = 0; i < 24; i++) {
      for (let j = perm.length - 1; j > 0; j--) {
        const k = i % (j + 1);
        [perm[j], perm[k]] = [perm[k]!, perm[j]!];
      }
      const hit = tryPick(perm.slice(0, size));
      if (hit) return hit;
    }
  }
  return null;
}

function meldKey(meld: Meld): string {
  return meld.tiles
    .map((t) => t.id)
    .sort()
    .join(',');
}

function poolKey(pool: Tile[]): string {
  const counts = new Map<string, number>();
  for (const t of pool) {
    const k = t.kind === 'joker' ? 'J' : `${t.color}${t.value}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}:${n}`)
    .join(',');
}

/** All valid melds pickable from pool (solver rules: runs 3+, sets 3–4). */
function enumerateMelds(pool: Tile[], cap: number): Meld[] {
  const out: Meld[] = [];
  const seen = new Set<string>();
  const { numbers, jokers } = splitPool(pool);

  const add = (meld: Meld) => {
    if (out.length >= cap) return;
    const key = meldKey(meld);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(meld);
  };

  for (let len = MAX_RUN; len >= MIN_RUN; len--) {
    for (const color of COLORS) {
      for (let start = 1; start + len - 1 <= 13; start++) {
        const tiles = tryBuildRun(numbers, jokers, color, start, len);
        if (tiles) add({ kind: 'run', tiles });
        if (out.length >= cap) return out;
      }
    }
  }

  for (let value = 1; value <= 13; value++) {
    for (const size of GROUP_SIZES) {
      const tiles = tryBuildGroup(numbers, jokers, value, size);
      if (tiles) add({ kind: 'group', tiles });
      if (out.length >= cap) return out;
    }
  }

  return out;
}

function removeTiles(pool: Tile[], meld: Meld): Tile[] {
  const ids = new Set(meld.tiles.map((t) => t.id));
  return pool.filter((t) => !ids.has(t.id));
}

function updateBest(
  best: PartitionResult,
  melds: Meld[],
  remaining: Tile[],
  poolSize: number,
  longRuns: OriginalLongRun[]
): PartitionResult {
  const placed = poolSize - remaining.length;
  if (placed > best.placed) {
    return { melds: [...melds], remaining: [...remaining], placed };
  }
  if (placed < best.placed) return best;
  if (remaining.length < best.remaining.length) {
    return { melds: [...melds], remaining: [...remaining], placed };
  }
  if (remaining.length > best.remaining.length) return best;
  if (longRuns.length) {
    const nextPres = partitionPreservationScore(melds, longRuns);
    const bestPres = partitionPreservationScore(best.melds, longRuns);
    if (nextPres < bestPres) {
      return { melds: [...melds], remaining: [...remaining], placed };
    }
  }
  return best;
}

function backtrack(
  remaining: Tile[],
  melds: Meld[],
  deadlineMs: number,
  rng: Rng,
  poolSize: number,
  best: PartitionResult,
  failed: Set<string>,
  longRuns: OriginalLongRun[]
): PartitionResult {
  if (remaining.length === 0) {
    return { melds: [...melds], remaining: [], placed: poolSize };
  }
  if (Date.now() >= deadlineMs) return best;
  best = updateBest(best, melds, remaining, poolSize, longRuns);
  if (remaining.length < MIN_RUN && remaining.length > 0) return best;

  const key = poolKey(remaining);
  if (failed.has(key)) return best;

  const cap = remaining.length <= 20 ? 80 : 40;
  const candidates = enumerateMelds(remaining, cap);
  if (!candidates.length) {
    failed.add(key);
    return best;
  }
  rng.shuffle(candidates);

  let result = best;
  for (const meld of candidates) {
    const next = removeTiles(remaining, meld);
    const hit = backtrack(next, [...melds, meld], deadlineMs, rng, poolSize, result, failed, longRuns);
    if (hit.placed === poolSize) return hit;
    if (hit.placed > result.placed) result = hit;
    else if (hit.placed === result.placed && longRuns.length) {
      const hitPres = partitionPreservationScore(hit.melds, longRuns);
      const resPres = partitionPreservationScore(result.melds, longRuns);
      if (hitPres < resPres) result = hit;
    }
  }
  failed.add(key);
  return result;
}

function pickGreedyMeld(candidates: Meld[], longRuns: OriginalLongRun[], rng: Rng): Meld {
  candidates.sort((a, b) => b.tiles.length - a.tiles.length);
  const pool = candidates.slice(0, Math.min(GREEDY_TOP_CANDIDATES, candidates.length));
  if (!longRuns.length || pool.length <= 1) return pool[rng.randrange(pool.length)]!;
  return weightedPickMelds(pool, (m) => meldPickWeight(m, longRuns), rng);
}

/** Partition board tiles into valid melds; rack is not used. */
export function partitionBoardTiles(
  pool: Tile[],
  rng: Rng,
  deadlineMs: number,
  opts: PartitionOptions = {}
): { result: PartitionResult; grid: Grid; attempts: number } {
  const poolSize = pool.length;
  const longRuns = opts.originalMelds?.length ? buildOriginalLongRuns(opts.originalMelds) : [];
  let best: PartitionResult = { melds: [], remaining: [...pool], placed: 0 };
  let attempts = 0;

  while (Date.now() < deadlineMs) {
    attempts++;
    let remaining = [...pool];
    rng.shuffle(remaining);
    const melds: Meld[] = [];

    while (remaining.length >= MIN_RUN) {
      const cands = enumerateMelds(remaining, 35);
      if (!cands.length) break;
      const pick = pickGreedyMeld(cands, longRuns, rng);
      melds.push(pick);
      remaining = removeTiles(remaining, pick);
    }

    best = updateBest(best, melds, remaining, poolSize, longRuns);
    if (best.placed === poolSize) break;
    if (attempts >= 40) break;
  }

  if (best.remaining.length > 0 && best.remaining.length <= 14 && Date.now() < deadlineMs) {
    const tail = backtrack(
      best.remaining,
      best.melds,
      deadlineMs,
      rng,
      poolSize,
      best,
      new Set(),
      longRuns
    );
    if (tail.placed > best.placed) best = tail;
    else if (tail.placed === best.placed && longRuns.length) {
      const tailPres = partitionPreservationScore(tail.melds, longRuns);
      const bestPres = partitionPreservationScore(best.melds, longRuns);
      if (tailPres < bestPres) best = tail;
    }
    if (tail.placed === poolSize) best = tail;
  }

  const grid = meldsToGrid(best.melds);
  return { result: best, grid, attempts };
}

/** True when every board tile is in a valid meld on the laid-out grid. */
export function partitionIsSolved(result: PartitionResult): boolean {
  return result.remaining.length === 0 && result.melds.length > 0;
}

function sortCandidatesDeterministic(candidates: Meld[]): Meld[] {
  return [...candidates].sort((a, b) => {
    const d = b.tiles.length - a.tiles.length;
    if (d !== 0) return d;
    return meldKey(a).localeCompare(meldKey(b));
  });
}

/**
 * Deterministic backtrack — finds any full partition if one exists (win verification).
 * Does not use RNG or originalMelds bias.
 */
function searchFullPartition(
  remaining: Tile[],
  melds: Meld[],
  deadlineMs: number,
  poolSize: number,
  failed: Set<string>
): PartitionResult | null {
  if (remaining.length === 0) {
    return { melds: [...melds], remaining: [], placed: poolSize };
  }
  if (Date.now() >= deadlineMs) return null;
  if (remaining.length < MIN_RUN) return null;

  const key = poolKey(remaining);
  if (failed.has(key)) return null;

  const candidates = sortCandidatesDeterministic(enumerateMelds(remaining, 80));
  if (!candidates.length) {
    failed.add(key);
    return null;
  }

  for (const meld of candidates) {
    const hit = searchFullPartition(
      removeTiles(remaining, meld),
      [...melds, meld],
      deadlineMs,
      poolSize,
      failed
    );
    if (hit) return hit;
  }

  failed.add(key);
  return null;
}

const VERIFY_SEEDS = [0, 1, 7, 13, 42, 99, 12345, 99991];

export interface VerifyPartitionResult {
  solved: boolean;
  result: PartitionResult;
  elapsedMs: number;
  timedOut: boolean;
  /** How the verifier reached its answer. */
  method: 'empty' | 'partition-seeds' | 'backtrack' | 'exhausted';
  seedAttempts: number;
  partitionAttempts: number;
}

/** Rules-based win check: can every tile be placed in valid meld(s)? */
export function verifyBoardPartition(pool: Tile[], deadlineMs: number): VerifyPartitionResult {
  const t0 = Date.now();
  const emptyResult = {
    solved: false,
    result: { melds: [] as Meld[], remaining: [] as Tile[], placed: 0 },
    elapsedMs: 0,
    timedOut: false,
    method: 'empty' as const,
    seedAttempts: 0,
    partitionAttempts: 0
  };

  if (!pool.length) return emptyResult;

  let seedAttempts = 0;
  let partitionAttempts = 0;
  let best: PartitionResult = { melds: [], remaining: [...pool], placed: 0 };

  for (const seed of VERIFY_SEEDS) {
    if (Date.now() >= deadlineMs) break;
    seedAttempts++;
    const rng = makeRng(seed);
    const slice = Math.max(280, Math.floor((deadlineMs - Date.now()) / (VERIFY_SEEDS.length - seedAttempts + 2)));
    const { result, attempts } = partitionBoardTiles(pool, rng, Date.now() + slice, {});
    partitionAttempts += attempts;
    if (partitionIsSolved(result)) {
      return {
        solved: true,
        result,
        elapsedMs: Date.now() - t0,
        timedOut: false,
        method: 'partition-seeds',
        seedAttempts,
        partitionAttempts
      };
    }
    if (result.placed > best.placed
      || (result.placed === best.placed && result.remaining.length < best.remaining.length)) {
      best = result;
    }
  }

  if (Date.now() < deadlineMs) {
    const tail = best.remaining.length > 0 && best.remaining.length <= pool.length
      ? [...best.remaining]
      : [...pool];
    const melds = best.remaining.length > 0 && best.remaining.length < pool.length ? [...best.melds] : [];
    const hit = searchFullPartition(tail, melds, deadlineMs, pool.length, new Set());
    if (hit && partitionIsSolved(hit)) {
      return {
        solved: true,
        result: hit,
        elapsedMs: Date.now() - t0,
        timedOut: false,
        method: 'backtrack',
        seedAttempts,
        partitionAttempts
      };
    }
    if (hit && hit.placed > best.placed) best = hit;
  }

  const timedOut = Date.now() >= deadlineMs;
  return {
    solved: partitionIsSolved(best),
    result: best,
    elapsedMs: Date.now() - t0,
    timedOut,
    method: 'exhausted',
    seedAttempts,
    partitionAttempts
  };
}

export function meldsToGrid(melds: Meld[]): Grid {
  const g = new Grid();
  layoutMelds(g, melds);
  return g;
}

function countMeldedTiles(melds: Meld[]): number {
  return melds.reduce((s, m) => s + m.tiles.length, 0);
}

/** Fragment/orphan stats after layout. */
export function layoutStats(melds: Meld[], remaining: Tile[]) {
  const melded = countMeldedTiles(melds);
  return {
    melded,
    orphans: remaining.length,
    fragments: remaining.length > 0 ? 1 : 0,
    meldCount: melds.length
  };
}
