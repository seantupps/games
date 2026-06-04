import type { Meld, Tile, Variant } from './types.js';
import { COLORS } from './types.js';
import { buildPool, sortRack } from './tiles.js';
import type { Rng } from './rng.js';
import { Grid } from './grid.js';
import { greedyFill, greedyFillComplete, isAchievableTarget, meldSizeValid } from './board-gen.js';
import { boardHasConnectablePair } from './meld-connect.js';
import { layoutMelds } from './layout.js';

export interface Puzzle {
  grid: Grid;
  rack: Tile[];
  melds: Meld[];
  placedCount: number;
  rackCount: number;
  placedRatio: number;
  targetCount: number;
}

export interface GenerateResult {
  ok: boolean;
  timedOut: boolean;
  elapsedMs: number;
  puzzle: Puzzle | null;
  /** Set when timedOut or failed after deadline. */
  partial: {
    target: number;
    placed: number;
    meldCount: number;
    attempts: number;
    melds: Meld[];
    grid: Grid;
    rack: Tile[];
  } | null;
}

const DEFAULT_TIMEOUT_MS = 3000;

function buildPuzzle(pool: Tile[], melds: Meld[], target: number, strictConnect: boolean): Puzzle | null {
  if (melds.some((m) => !meldSizeValid(m))) return null;
  if (strictConnect && boardHasConnectablePair(melds)) return null;

  const grid = new Grid();
  layoutMelds(grid, melds);

  const placedCount = melds.reduce((s, m) => s + m.tiles.length, 0);
  return {
    grid,
    rack: [],
    melds,
    placedCount,
    rackCount: 0,
    placedRatio: placedCount / pool.length,
    targetCount: target
  };
}

/**
 * Build a fully solved board: exactly `placedCount` tiles on the table in valid melds.
 * Retries with new shuffles until success or timeoutMs (default 3s).
 */
export function generateSolvedBoard(
  rng: Rng,
  placedCount = 53,
  variant: Variant = 'standard',
  timeoutMs = DEFAULT_TIMEOUT_MS
): GenerateResult {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const pool = buildPool(variant);
  const target = placedCount;
  const fullBoard = target === pool.length;
  const strictConnect = !fullBoard;

  if (!isAchievableTarget(target)) {
    return {
      ok: false,
      timedOut: false,
      elapsedMs: 0,
      puzzle: null,
      partial: {
        target,
        placed: 0,
        meldCount: 0,
        attempts: 0,
        melds: [],
        grid: new Grid(),
        rack: []
      }
    };
  }

  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    const work = [...pool];
    rng.shuffle(work);

    const { melds, placed, remaining } = fullBoard
      ? greedyFillComplete(work, rng, deadline, true)
      : { ...greedyFill(work, target, rng, deadline, false), remaining: [] as Tile[] };

    if (fullBoard) {
      if (remaining.length !== 0) continue;
    } else if (placed !== target) {
      continue;
    }

    const puzzle = buildPuzzle(pool, melds, target, strictConnect);
    if (!puzzle || puzzle.placedCount !== target) continue;

    return {
      ok: true,
      timedOut: false,
      elapsedMs: Date.now() - t0,
      puzzle,
      partial: null
    };
  }

  const elapsedMs = Date.now() - t0;
  return {
    ok: false,
    timedOut: true,
    elapsedMs,
    puzzle: null,
    partial: {
      target,
      placed: 0,
      meldCount: 0,
      attempts,
      melds: [],
      grid: new Grid(),
      rack: []
    }
  };
}

export function demoPuzzle(): Puzzle {
  const grid = new Grid();
  let id = 0;
  const tile = (color: (typeof COLORS)[number], value: number): Tile => ({
    kind: 'number',
    color,
    value,
    id: `demo${id++}`
  });
  const runU: Meld = {
    kind: 'run',
    tiles: [tile('U', 8), tile('U', 9), tile('U', 10)]
  };
  const runR: Meld = {
    kind: 'run',
    tiles: [tile('R', 7), tile('R', 6), tile('R', 5)]
  };
  for (let i = 0; i < 3; i++) {
    grid.set(2 + i, 0, { tile: runU.tiles[i]!, color: 'U', value: 8 + i });
  }
  for (let i = 0; i < 3; i++) {
    grid.set(3 + i, 1, { tile: runR.tiles[i]!, color: 'R', value: 7 - i });
  }
  const rack: Tile[] = [tile('B', 4), tile('O', 11), tile('U', 3), tile('R', 12)];
  return {
    grid,
    rack: sortRack(rack),
    melds: [runU, runR],
    placedCount: 6,
    rackCount: 4,
    placedRatio: 6 / 10,
    targetCount: 6
  };
}

export function demoResult(): GenerateResult {
  const puzzle = demoPuzzle();
  return { ok: true, timedOut: false, elapsedMs: 0, puzzle, partial: null };
}
