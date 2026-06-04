/** Standard English edition colors (see ../distribution.txt). */
export type Color = 'B' | 'R' | 'U' | 'O';

export const COLORS: readonly Color[] = ['B', 'R', 'U', 'O'] as const;

export const COLOR_NAMES: Record<Color, string> = {
  B: 'Black',
  R: 'Red',
  U: 'Blue',
  O: 'Orange'
};

export type TileKind = 'number' | 'joker';

export interface NumberTile {
  kind: 'number';
  color: Color;
  value: number;
  id: string;
}

export interface JokerTile {
  kind: 'joker';
  id: string;
  /** Terminal face color for J (standard: one black, one red). */
  display: 'B' | 'R';
  as?: { color: Color; value: number };
}

export type Tile = NumberTile | JokerTile;

export type MeldKind = 'group' | 'run';

export interface Meld {
  kind: MeldKind;
  tiles: Tile[];
}

export type Variant = 'standard' | 'xp';

export interface PuzzleTranscriptLike {
  separator(): void;
  sessionStart(meta: { seed: number; placed: string; rack: number; board: number; genMs?: number }): void;
  solvedBoard(grid: import('./grid.js').Grid, rack: Tile[]): void;
  removed(percent: number, count: number, grid: import('./grid.js').Grid, rack: Tile[]): void;
  playerStart?(grid: import('./grid.js').Grid, rack: Tile[]): void;
  solved(attempts: number, elapsedMs: number): void;
  partialSolve?(
    attempts: number,
    elapsedMs: number,
    stats: { fragments: number; orphanTiles: number; boardTiles: number; meldedTiles?: number }
  ): void;
  stuck(attempts: number, reason: string): void;
  note?(msg: string): void;
  timeout(meta: {
    elapsedMs: number;
    target: number;
    placed: number;
    meldCount: number;
    attempts: number;
  }): void;
}
