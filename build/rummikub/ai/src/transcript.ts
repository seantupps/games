import type { Tile } from './types.js';
import type { PuzzleTranscriptLike } from './types.js';
import { renderGrid, renderRack, colorLegend } from './display.js';
import type { Grid } from './grid.js';

export function tileCounts(board: number, rack: Tile[]): { board: number; rack: number; total: number } {
  const r = rack.length;
  return { board, rack: r, total: board + r };
}

export function formatCounts(board: number, rack: Tile[]): string {
  const c = tileCounts(board, rack);
  return `board=${c.board} rack=${c.rack} total=${c.total}`;
}

export class Transcript implements PuzzleTranscriptLike {
  readonly lines: string[] = [];

  constructor(private readonly echo = true) {}

  private out(...parts: string[]): void {
    for (const part of parts) {
      this.lines.push(part);
      if (this.echo) console.log(part);
    }
  }

  separator(): void {
    this.out('--------------');
  }

  sessionStart(meta: { seed: number; placed: string; rack: number; board: number; genMs?: number }): void {
    const gen = meta.genMs != null ? `  gen=${meta.genMs}ms` : '';
    const total = meta.board + meta.rack;
    this.out(
      `[play] seed=${meta.seed}  placed=${meta.placed}  board=${meta.board}  rack=${meta.rack}  total=${total}${gen}`
    );
    this.out(colorLegend());
  }

  solvedBoard(grid: Grid, rack: Tile[]): void {
    const n = grid.cells.size;
    this.out(`Solved board — ${formatCounts(n, rack)}`);
    this.out(...renderGrid(grid));
    this.rackLine(rack);
  }

  removed(percent: number, count: number, grid: Grid, rack: Tile[]): void {
    const n = grid.cells.size;
    this.out(`Removed ${percent}% (${count} tiles) — ${formatCounts(n, rack)}`);
    this.out(...renderGrid(grid));
    this.rackLine(rack);
  }

  /** Step 3 — player-facing start (mini melds on board + rack). */
  playerStart(grid: Grid, rack: Tile[]): void {
    const n = grid.cells.size;
    this.out(`Player start — ${formatCounts(n, rack)}`);
    this.out(...renderGrid(grid));
    this.rackLine(rack);
  }

  private rackLine(rack: Tile[]): void {
    this.out(`Rack: ${renderRack(rack)}`);
  }

  solved(attempts: number, elapsedMs: number): void {
    this.out(`SOLVED in ${attempts} attempt(s) (${(elapsedMs / 1000).toFixed(2)}s)`);
  }

  partialSolve(
    attempts: number,
    elapsedMs: number,
    stats: { fragments: number; orphanTiles: number; boardTiles: number; meldedTiles?: number }
  ): void {
    const melded = stats.meldedTiles ?? stats.boardTiles - stats.orphanTiles;
    this.out(
      `PARTIAL after ${attempts} attempt(s) (${(elapsedMs / 1000).toFixed(2)}s): ` +
        `melded ${melded}/${stats.boardTiles}, ${stats.orphanTiles} tile(s) moved to rack`
    );
  }

  stuck(attempts: number, reason: string): void {
    this.out(`STUCK after ${attempts} attempt(s): ${reason}`);
  }

  timeout(meta: {
    elapsedMs: number;
    target: number;
    placed: number;
    meldCount: number;
    attempts: number;
  }): void {
    this.out(
      `[TIMEOUT] generation exceeded limit (${(meta.elapsedMs / 1000).toFixed(2)}s) ` +
        `target=${meta.target} placed=${meta.placed} melds=${meta.meldCount} tries=${meta.attempts}`
    );
  }

  note(msg: string): void {
    this.out(msg);
  }
}

export { renderGrid, renderRack };
