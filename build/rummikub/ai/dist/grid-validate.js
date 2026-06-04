import { assignJokersToMeld, isValidMeld } from './validate.js';
/** Collect maximal horizontal and vertical segments on the grid. */
function segmentsAt(grid) {
    const melds = [];
    const seenH = new Set();
    const seenV = new Set();
    for (const key of grid.cells.keys()) {
        const [x, y] = key.split(',').map(Number);
        const hKey = `h,${y},${x}`;
        if (!seenH.has(hKey) && !grid.get(x - 1, y)) {
            const tiles = [];
            let cx = x;
            while (true) {
                const c = grid.get(cx, y);
                if (!c)
                    break;
                tiles.push(c.tile);
                seenH.add(`h,${y},${cx}`);
                cx++;
            }
            if (tiles.length >= 3) {
                const run = { kind: 'run', tiles };
                const grp = { kind: 'group', tiles };
                if (isValidMeld(run))
                    melds.push(run);
                else if (isValidMeld(grp))
                    melds.push(grp);
            }
        }
        const vKey = `v,${x},${y}`;
        if (!seenV.has(vKey) && !grid.get(x, y - 1)) {
            const tiles = [];
            let cy = y;
            while (true) {
                const c = grid.get(x, cy);
                if (!c)
                    break;
                tiles.push(c.tile);
                seenV.add(`v,${x},${cy}`);
                cy++;
            }
            if (tiles.length >= 3) {
                const run = { kind: 'run', tiles };
                const grp = { kind: 'group', tiles };
                if (isValidMeld(run))
                    melds.push(run);
                else if (isValidMeld(grp))
                    melds.push(grp);
            }
        }
    }
    return melds;
}
/** Every occupied cell belongs to at least one valid meld (group or run). */
export function gridIsValid(grid) {
    if (!grid.cells.size)
        return true;
    const covered = new Set();
    const melds = segmentsAt(grid);
    for (const m of melds) {
        if (!isValidMeld(m))
            continue;
        for (const t of m.tiles)
            covered.add(t.id);
    }
    for (const key of grid.cells.keys()) {
        const cell = grid.cells.get(key);
        if (!covered.has(cell.tile.id)) {
            const groupMeld = tryGroupAt(grid, key);
            if (groupMeld && isValidMeld(groupMeld)) {
                for (const t of groupMeld.tiles)
                    covered.add(t.id);
            }
        }
    }
    for (const cell of grid.cells.values()) {
        if (!covered.has(cell.tile.id))
            return false;
    }
    return true;
}
function tryGroupAt(grid, key) {
    const [x, y] = key.split(',').map(Number);
    const cell = grid.get(x, y);
    if (!cell)
        return null;
    const value = cell.value;
    const rowTiles = [];
    for (const [k, c] of grid.cells) {
        const [gx, gy] = k.split(',').map(Number);
        if (gy === y && c.value === value)
            rowTiles.push({ x: gx, tile: c.tile });
    }
    rowTiles.sort((a, b) => a.x - b.x);
    if (rowTiles.length < 3)
        return null;
    for (let i = 0; i <= rowTiles.length - 3; i++) {
        for (let len = 3; len <= 4 && i + len <= rowTiles.length; len++) {
            const slice = rowTiles.slice(i, i + len);
            if (slice[slice.length - 1].x - slice[0].x !== len - 1)
                continue;
            const meld = { kind: 'group', tiles: slice.map((s) => s.tile) };
            if (isValidMeld(meld))
                return meld;
        }
    }
    return null;
}
export function resolvedCell(tile, color, value) {
    return { tile, color, value };
}
export function jokerAssignmentForRun(tile, color, value) {
    return { ...tile, as: { color, value } };
}
/** Validate a candidate meld including joker assignment. */
export function meldValid(meld) {
    return assignJokersToMeld(meld) !== null;
}
//# sourceMappingURL=grid-validate.js.map