import type { Color, Meld, NumberTile, Tile } from './types.js';
import { COLORS } from './types.js';
import { isValidMeld } from './validate.js';
import type { Rng } from './rng.js';
import { canConnectToAny } from './meld-connect.js';

/** Sets (groups): 3–4 tiles. Runs: 3–6 tiles. */
export const GROUP_SIZES = [3, 4] as const;
export const RUN_SIZES = [3, 4, 5, 6] as const;
export const MELD_SIZES = [3, 4, 5, 6] as const;

function splitRack(rack: Tile[]): { numbers: NumberTile[]; jokers: Tile[] } {
  const numbers: NumberTile[] = [];
  const jokers: Tile[] = [];
  for (const t of rack) {
    if (t.kind === 'number') numbers.push(t);
    else jokers.push(t);
  }
  return { numbers, jokers };
}

/** True if n is a sum of meld sizes {3,4,5,6}. */
export function isAchievableTarget(n: number): boolean {
  if (n < 0) return false;
  if (n === 0) return true;
  const dp = new Array<boolean>(n + 1).fill(false);
  dp[0] = true;
  for (let i = 3; i <= n; i++) {
    for (const s of MELD_SIZES) {
      if (i >= s && dp[i - s]) {
        dp[i] = true;
        break;
      }
    }
  }
  return dp[n] ?? false;
}

function sizeCompletesBudget(budget: number, size: number): boolean {
  return isAchievableTarget(budget - size);
}

function tryBuildRun(
  numbers: NumberTile[],
  jokers: Tile[],
  color: Color,
  start: number,
  len: number
): Tile[] | null {
  const seq = numbers.filter((t) => t.color === color);
  const need = Array.from({ length: len }, (_, i) => start + i);
  const picked: Tile[] = [];
  const used = new Set<string>();
  let ji = 0;

  for (const v of need) {
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

  const tryPick = (colorOrder: Color[]): Tile[] | null => {
    const picked: Tile[] = [];
    let ji = 0;
    for (const c of colorOrder) {
      if (picked.length >= size) break;
      const t = byColor.get(c)?.[0];
      if (!t) continue;
      picked.push(t);
    }
    while (picked.length < size && ji < jokers.length) {
      picked.push(jokers[ji]!);
      ji++;
    }
    if (picked.length !== size) return null;
    const meld: Meld = { kind: 'group', tiles: picked };
    return isValidMeld(meld) ? picked : null;
  };

  const direct = tryPick(colors);
  if (direct) return direct;

  if (colors.length >= size) {
    const perm = [...colors];
    for (let i = 0; i < 12; i++) {
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

function meldTileKey(meld: Meld): string {
  return meld.tiles
    .map((t) => t.id)
    .sort()
    .join(',');
}

/** Collect valid melds from rack that keep the remainder partitionable. */
function enumerateCandidateMelds(
  rack: Tile[],
  budget: number,
  onBoard: Meld[],
  allowConnectable: boolean,
  cap: number
): Meld[] {
  if (budget < 3 || !isAchievableTarget(budget)) return [];
  const out: Meld[] = [];
  const seen = new Set<string>();
  const { numbers, jokers } = splitRack(rack);

  const tryAdd = (meld: Meld, size: number) => {
    if (out.length >= cap) return;
    if (!sizeCompletesBudget(budget, size)) return;
    if (!allowConnectable && canConnectToAny(meld, onBoard)) return;
    const key = meldTileKey(meld);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(meld);
  };

  const runSizes = RUN_SIZES.filter((s) => s <= Math.min(budget, 6, rack.length)).sort((a, b) => b - a);
  for (const len of runSizes) {
    for (const color of COLORS) {
      for (let start = 1; start + len - 1 <= 13; start++) {
        const tiles = tryBuildRun(numbers, jokers, color, start, len);
        if (!tiles) continue;
        tryAdd({ kind: 'run', tiles }, len);
        if (out.length >= cap) return out;
      }
    }
  }

  const groupSizes = GROUP_SIZES.filter((s) => s <= Math.min(budget, rack.length)).sort((a, b) => b - a);
  for (let value = 1; value <= 13; value++) {
    for (const size of groupSizes) {
      const tiles = tryBuildGroup(numbers, jokers, value, size);
      if (!tiles) continue;
      tryAdd({ kind: 'group', tiles }, size);
      if (out.length >= cap) return out;
    }
  }

  return out;
}

function backtrackPartition(
  remaining: Tile[],
  melds: Meld[],
  deadlineMs: number,
  rng: Rng,
  allowConnectable: boolean,
  poolSize: number,
  failed = new Set<string>()
): GreedyFillResult | null {
  if (remaining.length === 0) {
    return { melds, placed: poolSize, remaining: [] };
  }
  if (Date.now() >= deadlineMs) return null;
  if (remaining.length < 3 || !isAchievableTarget(remaining.length)) return null;

  const stateKey = poolSignature(remaining);
  if (failed.has(stateKey)) return null;

  const cap = remaining.length <= 24 ? 60 : 25;
  const candidates = enumerateCandidateMelds(remaining, remaining.length, melds, allowConnectable, cap);
  if (!candidates.length) {
    failed.add(stateKey);
    return null;
  }
  rng.shuffle(candidates);

  for (const meld of candidates) {
    const ids = new Set(meld.tiles.map((t) => t.id));
    const next = remaining.filter((t) => !ids.has(t.id));
    const hit = backtrackPartition(next, [...melds, meld], deadlineMs, rng, allowConnectable, poolSize, failed);
    if (hit) return hit;
  }
  failed.add(stateKey);
  return null;
}

function poolSignature(tiles: Tile[]): string {
  const counts = new Map<string, number>();
  for (const t of tiles) {
    const k = t.kind === 'joker' ? 'J' : `${t.color}${t.value}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}:${n}`)
    .join(',');
}

/** Pick one meld of exactly `size` tiles (run 3–6, set 3–4). */
function findMeldExactSize(
  rack: Tile[],
  size: number,
  rng: Rng,
  onBoard: Meld[] = [],
  allowConnectable = false
): Meld | null {
  if (size < 3) return null;
  const { numbers, jokers } = splitRack(rack);

  if (size <= 6) {
    const colors = [...COLORS];
    rng.shuffle(colors);
    const starts = Array.from({ length: 11 }, (_, i) => i + 1);
    rng.shuffle(starts);
    for (const color of colors) {
      for (const start of starts) {
        if (start + size - 1 > 13) continue;
        const tiles = tryBuildRun(numbers, jokers, color, start, size);
        if (!tiles) continue;
        const meld: Meld = { kind: 'run', tiles };
        if (!allowConnectable && canConnectToAny(meld, onBoard)) continue;
        return meld;
      }
    }
  }

  if (size <= 4) {
    const values = Array.from({ length: 13 }, (_, i) => i + 1);
    rng.shuffle(values);
    for (const value of values) {
      const tiles = tryBuildGroup(numbers, jokers, value, size);
      if (!tiles) continue;
      const meld: Meld = { kind: 'group', tiles };
      if (!allowConnectable && canConnectToAny(meld, onBoard)) continue;
      return meld;
    }
  }
  return null;
}

/** Random partition of n into meld sizes {3,4,5,6}. */
export function randomSizePlan(n: number, rng: Rng): number[] {
  const plan: number[] = [];
  let left = n;
  while (left > 0) {
    const opts = MELD_SIZES.filter((s) => s <= left && isAchievableTarget(left - s));
    if (!opts.length) return [];
    opts.sort((a, b) => b - a);
    const pick = opts[rng.randrange(Math.min(3, opts.length))]!;
    plan.push(pick);
    left -= pick;
  }
  rng.shuffle(plan);
  return plan;
}

function fillBySizePlan(
  pool: Tile[],
  plan: number[],
  rng: Rng,
  allowConnectable: boolean
): GreedyFillResult | null {
  const melds: Meld[] = [];
  let remaining = [...pool];
  for (const size of plan) {
    const meld = findMeldExactSize(remaining, size, rng, melds, allowConnectable);
    if (!meld) return null;
    const ids = new Set(meld.tiles.map((t) => t.id));
    remaining = remaining.filter((t) => !ids.has(t.id));
    melds.push(meld);
  }
  if (remaining.length !== 0) return null;
  return { melds, placed: pool.length, remaining: [] };
}

export function meldSizeValid(meld: Meld): boolean {
  const n = meld.tiles.length;
  if (meld.kind === 'group') return n >= 3 && n <= 4;
  return n >= 3 && n <= 6;
}

/** Any valid meld from rack (no exact-count budget), for full-board partition. */
export function findFastMeldLoose(
  rack: Tile[],
  rng: Rng,
  onBoard: Meld[] = [],
  allowConnectable = false
): Meld | null {
  const cap = Math.min(6, rack.length);
  return findFastMeld(rack, cap, rng, onBoard, allowConnectable, true);
}

/** First valid meld (run 3–6, set 3–4). Skips connect check when allowConnectable. */
export function findFastMeld(
  rack: Tile[],
  maxLen: number,
  rng: Rng,
  onBoard: Meld[] = [],
  allowConnectable = false,
  skipBudgetCheck = false
): Meld | null {
  if (maxLen < 3) return null;
  const { numbers, jokers } = splitRack(rack);

  const runSizes = RUN_SIZES.filter((s) => s <= Math.min(maxLen, 6));
  rng.shuffle(runSizes);
  const colors = [...COLORS];
  rng.shuffle(colors);

  for (const len of runSizes) {
    for (const color of colors) {
      const starts = Array.from({ length: 11 }, (_, i) => i + 1);
      rng.shuffle(starts);
      for (const start of starts) {
        if (start + len - 1 > 13) continue;
        const tiles = tryBuildRun(numbers, jokers, color, start, len);
        if (!tiles) continue;
        const meld: Meld = { kind: 'run', tiles };
        if (!skipBudgetCheck && !sizeCompletesBudget(maxLen, len)) continue;
        if (!allowConnectable && canConnectToAny(meld, onBoard)) continue;
        return meld;
      }
    }
  }

  const groupSizes = GROUP_SIZES.filter((s) => s <= maxLen);
  rng.shuffle(groupSizes);
  const values = Array.from({ length: 13 }, (_, i) => i + 1);
  rng.shuffle(values);
  for (const value of values) {
    for (const size of groupSizes) {
      const tiles = tryBuildGroup(numbers, jokers, value, size);
      if (!tiles) continue;
      const meld: Meld = { kind: 'group', tiles };
      if (!skipBudgetCheck && !sizeCompletesBudget(maxLen, size)) continue;
      if (!allowConnectable && canConnectToAny(meld, onBoard)) continue;
      return meld;
    }
  }
  return null;
}

export interface GreedyFillResult {
  melds: Meld[];
  placed: number;
  remaining: Tile[];
}

/** Greedily pack melds until exactly `target` tiles or stuck. */
export function greedyFill(
  pool: Tile[],
  target: number,
  rng: Rng,
  deadlineMs: number,
  allowConnectable = false
): GreedyFillResult {
  const melds: Meld[] = [];
  let remaining = [...pool];
  let placed = 0;

  while (placed < target) {
    if (Date.now() >= deadlineMs) break;
    const budget = target - placed;
    if (budget === 0) break;
    if (budget < 3 || !isAchievableTarget(budget)) break;
    if (remaining.length < 3) break;
    const meld = findFastMeld(remaining, budget, rng, melds, allowConnectable);
    if (!meld) break;
    const ids = new Set(meld.tiles.map((t) => t.id));
    remaining = remaining.filter((t) => !ids.has(t.id));
    melds.push(meld);
    placed += meld.tiles.length;
  }

  return { melds, placed, remaining };
}

/** Use every tile in melds (remainder empty). One fast attempt — caller retries. */
export function greedyFillComplete(
  pool: Tile[],
  rng: Rng,
  _deadlineMs: number,
  allowConnectable = false
): GreedyFillResult {
  const plan = randomSizePlan(pool.length, rng);
  if (plan.length) {
    const planned = fillBySizePlan(pool, plan, rng, allowConnectable);
    if (planned) return planned;
  }

  const melds: Meld[] = [];
  let remaining = [...pool];
  while (remaining.length >= 3 && isAchievableTarget(remaining.length)) {
    const meld = findFastMeld(remaining, remaining.length, rng, melds, allowConnectable);
    if (!meld) break;
    const ids = new Set(meld.tiles.map((t) => t.id));
    remaining = remaining.filter((t) => !ids.has(t.id));
    melds.push(meld);
  }

  return {
    melds,
    placed: pool.length - remaining.length,
    remaining
  };
}

/** Exhaustive partition for full pool (slow — use with deadline and retries). */
export function partitionAllTiles(
  pool: Tile[],
  rng: Rng,
  deadlineMs: number,
  allowConnectable = true
): GreedyFillResult | null {
  return backtrackPartition([...pool], [], deadlineMs, rng, allowConnectable, pool.length);
}

export function nearestAchievableTarget(n: number, poolSize: number): number[] {
  const out: number[] = [];
  for (let d = 0; d <= 6; d++) {
    for (const t of [n - d, n + d]) {
      if (t >= 3 && t <= poolSize && isAchievableTarget(t) && !out.includes(t)) out.push(t);
    }
  }
  return out.length ? out : [n];
}
