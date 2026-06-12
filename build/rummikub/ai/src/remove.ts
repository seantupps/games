import type { Rng } from './rng.js';
import type { Meld, Tile } from './types.js';
import { Grid } from './grid.js';
import { sortRack } from './tiles.js';
import { isValidMeld } from './validate.js';

export interface RemoveResult {
  grid: Grid;
  rack: Tile[];
  removed: number;
}

interface RemoveCandidate {
  key: string;
  weight: number;
  meldKey: string | null;
}

const FALLBACK_WEIGHT = 1;

/** Ends of a run — prefer middle tiles when trimming a still-valid run. */
const RUN_END_WEIGHT = 1;
const RUN_MIDDLE_BONUS = 2;

function meldKey(meld: Meld): string {
  return meld.tiles
    .map((t) => t.id)
    .sort()
    .join('|');
}

function boardTileIds(grid: Grid): Set<string> {
  return new Set([...grid.cells.values()].map((c) => c.tile.id));
}

function findCellKey(grid: Grid, tileId: string): string | null {
  for (const [key, cell] of grid.cells) {
    if (cell.tile.id === tileId) return key;
  }
  return null;
}

function removalBreaksMeld(meld: Meld, tileId: string): boolean {
  const remaining = meld.tiles.filter((t) => t.id !== tileId);
  if (remaining.length < 3) return true;
  return !isValidMeld({ kind: meld.kind, tiles: remaining });
}

function runTileRemovalWeight(index: number, len: number): number {
  if (len <= 2) return RUN_END_WEIGHT;
  const center = (len - 1) / 2;
  const dist = Math.abs(index - center);
  const maxDist = Math.max(center, 1);
  const middleScore = 1 - dist / maxDist;
  return RUN_END_WEIGHT + middleScore * RUN_MIDDLE_BONUS;
}

/**
 * Higher weight = remove sooner. Prioritize breaking intact melds; groups of 4 and
 * long runs that need multiple hits still rank above orphan tiles.
 */
function meldTileRemovalWeight(meld: Meld, tileId: string): number {
  if (removalBreaksMeld(meld, tileId)) {
    let weight = 1000 + meld.tiles.length;
    if (meld.kind === 'run') {
      const idx = meld.tiles.findIndex((t) => t.id === tileId);
      weight += runTileRemovalWeight(idx, meld.tiles.length);
    }
    return weight;
  }

  if (meld.kind === 'group') {
    return 800 + meld.tiles.length * 10;
  }

  const idx = meld.tiles.findIndex((t) => t.id === tileId);
  const len = meld.tiles.length;
  const trimWeight = 600 + len * 5;
  return trimWeight + runTileRemovalWeight(idx, len);
}

/** Valid horizontal/vertical segments currently on the board. */
function findBoardMelds(grid: Grid): Meld[] {
  const melds: Meld[] = [];
  const seenH = new Set<string>();
  const seenV = new Set<string>();

  for (const key of grid.cells.keys()) {
    const [x, y] = key.split(',').map(Number);

    const hStart = `h,${y},${x}`;
    if (!seenH.has(hStart) && !grid.get(x - 1, y)) {
      const tiles: Tile[] = [];
      let cx = x;
      while (true) {
        const cell = grid.get(cx, y);
        if (!cell) break;
        tiles.push(cell.tile);
        seenH.add(`h,${y},${cx}`);
        cx++;
      }
      if (tiles.length >= 3) {
        const run: Meld = { kind: 'run', tiles };
        const grp: Meld = { kind: 'group', tiles };
        if (isValidMeld(run)) melds.push(run);
        else if (isValidMeld(grp)) melds.push(grp);
      }
    }

    const vStart = `v,${x},${y}`;
    if (!seenV.has(vStart) && !grid.get(x, y - 1)) {
      const tiles: Tile[] = [];
      let cy = y;
      while (true) {
        const cell = grid.get(x, cy);
        if (!cell) break;
        tiles.push(cell.tile);
        seenV.add(`v,${x},${cy}`);
        cy++;
      }
      if (tiles.length >= 3) {
        const run: Meld = { kind: 'run', tiles };
        const grp: Meld = { kind: 'group', tiles };
        if (isValidMeld(run)) melds.push(run);
        else if (isValidMeld(grp)) melds.push(grp);
      }
    }
  }

  return melds;
}

/** One best tile per meld — prefer a single breaking hit over trimming. */
function bestRemovalForMeld(meld: Meld, grid: Grid): RemoveCandidate | null {
  const keyForMeld = meldKey(meld);
  let best: RemoveCandidate | null = null;
  let onlyBreaking = false;

  for (const t of meld.tiles) {
    const key = findCellKey(grid, t.id);
    if (!key) continue;

    const breaks = removalBreaksMeld(meld, t.id);
    if (onlyBreaking && !breaks) continue;
    if (breaks && !onlyBreaking) {
      best = null;
      onlyBreaking = true;
    }

    const weight = meldTileRemovalWeight(meld, t.id);
    if (!best || weight > best.weight) {
      best = { key, weight, meldKey: keyForMeld };
    }
  }

  return best;
}

function intactMelds(melds: Meld[], grid: Grid, touched: Set<string>): Meld[] {
  const onBoard = boardTileIds(grid);
  return melds.filter(
    (m) => !touched.has(meldKey(m)) && m.tiles.every((t) => onBoard.has(t.id))
  );
}

/** Prefer one hit per meld; rescan the board for leftover valid segments. */
function buildCandidates(
  grid: Grid,
  originalMelds: Meld[],
  touchedMelds: Set<string>
): RemoveCandidate[] {
  const out: RemoveCandidate[] = [];

  for (const meld of intactMelds(originalMelds, grid, touchedMelds)) {
    const best = bestRemovalForMeld(meld, grid);
    if (best) out.push(best);
  }

  if (!out.length) {
    for (const meld of findBoardMelds(grid)) {
      if (touchedMelds.has(meldKey(meld))) continue;
      const best = bestRemovalForMeld(meld, grid);
      if (best) out.push(best);
    }
  }

  if (!out.length) {
    for (const key of grid.cells.keys()) {
      out.push({ key, weight: FALLBACK_WEIGHT, meldKey: null });
    }
  }

  return out;
}

function weightedPickIndex(candidates: RemoveCandidate[], rng: Rng): number {
  let total = 0;
  for (const c of candidates) total += c.weight;
  let pick = rng.randrange(total);
  for (let i = 0; i < candidates.length; i++) {
    pick -= candidates[i]!.weight;
    if (pick < 0) return i;
  }
  return candidates.length - 1;
}

/** Move `percent`% of board tiles (rounded) from grid to player rack. */
export function removePercentFromBoard(
  grid: Grid,
  rack: Tile[],
  melds: Meld[],
  percent: number,
  rng: Rng
): RemoveResult {
  const g = grid.clone();
  const r = [...rack];
  const keys = [...g.cells.keys()];
  if (!keys.length || percent <= 0) {
    return { grid: g, rack: r, removed: 0 };
  }

  const count = Math.max(1, Math.round((keys.length * percent) / 100));

  const touchedMelds = new Set<string>();
  let removed = 0;
  while (removed < count && g.cells.size > 0) {
    const candidates = buildCandidates(g, melds, touchedMelds);
    const idx = weightedPickIndex(candidates, rng);
    const pick = candidates[idx]!;
    const cell = g.cells.get(pick.key)!;
    g.cells.delete(pick.key);
    r.push(cell.tile);
    if (pick.meldKey) touchedMelds.add(pick.meldKey);
    removed++;
  }

  return { grid: g, rack: sortRack(r), removed };
}

export function gridTileCount(grid: Grid): number {
  return grid.cells.size;
}
