import type { Color, Tile } from './types.js';
import { COLOR_NAMES } from './types.js';
import { sortRack, tileLabel } from './tiles.js';
import type { Grid } from './grid.js';

/** ANSI foreground per tile color (Orange → yellow; Black → bright white). */
const FG: Record<Color, string> = {
  B: '\x1b[97m',  // bright white = black tiles
  R: '\x1b[31m',
  U: '\x1b[34m',
  O: '\x1b[33m'   // yellow/orange
};
const RESET = '\x1b[0m';
const DOT = '.';

function formatValue(n: number): string {
  return n >= 10 ? String(n) : String(n);
}

/** One display slot: "." or colored number (1–13). */
export function renderCell(value: number | null, color: Color | null): string {
  if (value == null) return DOT;
  const c = color ?? 'B';
  return `${FG[c]}${formatValue(value)}${RESET}`;
}

/** Joker on rack or board — J in black or red face. */
export function renderJoker(tile: Extract<Tile, { kind: 'joker' }>): string {
  if (tile.as) return renderCell(tile.as.value, tile.as.color);
  return `${FG[tile.display]}J${RESET}`;
}

/** Bananagrams-style lines: ". . 8 9 10 . . . ." */
export function renderGrid(grid: Grid, color = true): string[] {
  const { minX, maxX, minY, maxY } = grid.bounds(1, 1);
  const lines: string[] = [];
  for (let y = minY; y <= maxY; y++) {
    const parts: string[] = [];
    for (let x = minX; x <= maxX; x++) {
      const cell = grid.get(x, y);
      if (!cell) {
        parts.push(DOT);
      } else if (cell.tile.kind === 'joker') {
        parts.push(color ? renderJoker(cell.tile) : 'J');
      } else if (color) {
        parts.push(renderCell(cell.value, cell.color));
      } else {
        parts.push(formatValue(cell.value));
      }
    }
    lines.push(parts.join(' '));
  }
  return lines.length ? lines : ['. . . . . . . .'];
}

export function renderRack(tiles: Tile[], color = true): string {
  if (!tiles.length) return '(empty)';
  const sorted = sortRack(tiles);
  if (!color) return sorted.map(tileLabel).join(' ');
  return sorted
    .map((t) => (t.kind === 'joker' ? renderJoker(t) : renderCell(t.value, t.color)))
    .join(' ');
}

export function colorLegend(): string {
  const bases = Object.entries(COLOR_NAMES)
    .map(([code, name]) => `${FG[code as Color]}${code}${RESET}=${name}`)
    .join('  ');
  return `${bases}  ${FG.B}J${RESET}/${FG.R}J${RESET}=Joker`;
}
