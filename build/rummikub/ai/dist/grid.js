import { assignJokersToMeld } from './validate.js';
/** Sparse 2D board — same role as Bananagrams grid cells map. */
export class Grid {
    cells = new Map();
    static key(x, y) {
        return `${x},${y}`;
    }
    get(x, y) {
        return this.cells.get(Grid.key(x, y));
    }
    set(x, y, cell) {
        this.cells.set(Grid.key(x, y), cell);
    }
    clone() {
        const g = new Grid();
        for (const [k, v] of this.cells) {
            g.cells.set(k, { tile: v.tile, color: v.color, value: v.value });
        }
        return g;
    }
    bounds(padX = 1, padY = 1) {
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
    placeMeldHorizontal(meld, startX, y) {
        const resolved = assignJokersToMeld(meld);
        if (!resolved)
            throw new Error('invalid meld for grid placement');
        resolved.forEach((r, i) => {
            this.set(startX + i, y, {
                tile: meld.tiles[i],
                color: r.color,
                value: r.value
            });
        });
    }
}
//# sourceMappingURL=grid.js.map