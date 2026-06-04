import type { Color, Tile } from './types.js';
import { assignJokersToMeld } from './validate.js';

export interface GridCell {
  tile: Tile;
  /** Resolved color/value for display and validation. */
  color: Color;
  value: number;
}

/** Sparse 2D board — same role as Bananagrams grid cells map. */
export class Grid {
  readonly cells = new Map<string, GridCell>();

  static key(x: number, y: number): string {
    return `${x},${y}`;
  }

  get(x: number, y: number): GridCell | undefined {
    return this.cells.get(Grid.key(x, y));
  }

  set(x: number, y: number, cell: GridCell): void {
    this.cells.set(Grid.key(x, y), cell);
  }

  clone(): Grid {
    const g = new Grid();
    for (const [k, v] of this.cells) {
      g.cells.set(k, { tile: v.tile, color: v.color, value: v.value });
    }
    return g;
  }

  bounds(padX = 1, padY = 1): { minX: number; maxX: number; minY: number; maxY: number } {
    const keys = [...this.cells.keys()];
    if (!keys.length) {
      return { minX: 0, maxX: 7, minY: 0, maxY: 1 };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const k of keys) {
      const [x, y] = k.split(',').map(Number);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return {
      minX: minX - padX,
      maxX: maxX + padX,
      minY: minY - padY,
      maxY: maxY + padY
    };
  }

  /** Place a meld horizontally starting at (startX, y). */
  placeMeldHorizontal(meld: { kind: 'group' | 'run'; tiles: Tile[] }, startX: number, y: number): void {
    const resolved = assignJokersToMeld(meld);
    if (!resolved) throw new Error('invalid meld for grid placement');
    resolved.forEach((r, i) => {
      this.set(startX + i, y, {
        tile: meld.tiles[i]!,
        color: r.color!,
        value: r.value!
      });
    });
  }
}
