import { renderGrid, renderRack, colorLegend } from './display.js';
export function tileCounts(board, rack) {
    const r = rack.length;
    return { board, rack: r, total: board + r };
}
export function formatCounts(board, rack) {
    const c = tileCounts(board, rack);
    return `board=${c.board} rack=${c.rack} total=${c.total}`;
}
export class Transcript {
    echo;
    lines = [];
    constructor(echo = true) {
        this.echo = echo;
    }
    out(...parts) {
        for (const part of parts) {
            this.lines.push(part);
            if (this.echo)
                console.log(part);
        }
    }
    separator() {
        this.out('--------------');
    }
    sessionStart(meta) {
        const gen = meta.genMs != null ? `  gen=${meta.genMs}ms` : '';
        const total = meta.board + meta.rack;
        this.out(`[play] seed=${meta.seed}  placed=${meta.placed}  board=${meta.board}  rack=${meta.rack}  total=${total}${gen}`);
        this.out(colorLegend());
    }
    solvedBoard(grid, rack) {
        const n = grid.cells.size;
        this.out(`Solved board — ${formatCounts(n, rack)}`);
        this.out(...renderGrid(grid));
        this.rackLine(rack);
    }
    removed(percent, count, grid, rack) {
        const n = grid.cells.size;
        this.out(`Removed ${percent}% (${count} tiles) — ${formatCounts(n, rack)}`);
        this.out(...renderGrid(grid));
        this.rackLine(rack);
    }
    /** Step 3 — player-facing start (mini melds on board + rack). */
    playerStart(grid, rack) {
        const n = grid.cells.size;
        this.out(`Player start — ${formatCounts(n, rack)}`);
        this.out(...renderGrid(grid));
        this.rackLine(rack);
    }
    rackLine(rack) {
        this.out(`Rack: ${renderRack(rack)}`);
    }
    solved(attempts, elapsedMs) {
        this.out(`SOLVED in ${attempts} attempt(s) (${(elapsedMs / 1000).toFixed(2)}s)`);
    }
    partialSolve(attempts, elapsedMs, stats) {
        const melded = stats.meldedTiles ?? stats.boardTiles - stats.orphanTiles;
        this.out(`PARTIAL after ${attempts} attempt(s) (${(elapsedMs / 1000).toFixed(2)}s): ` +
            `melded ${melded}/${stats.boardTiles}, ${stats.orphanTiles} tile(s) moved to rack`);
    }
    stuck(attempts, reason) {
        this.out(`STUCK after ${attempts} attempt(s): ${reason}`);
    }
    timeout(meta) {
        this.out(`[TIMEOUT] generation exceeded limit (${(meta.elapsedMs / 1000).toFixed(2)}s) ` +
            `target=${meta.target} placed=${meta.placed} melds=${meta.meldCount} tries=${meta.attempts}`);
    }
    note(msg) {
        this.out(msg);
    }
}
export { renderGrid, renderRack };
//# sourceMappingURL=transcript.js.map