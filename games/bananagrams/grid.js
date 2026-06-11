/**
 * Grid snap + crossword word extraction / validation for Bananagrams.
 */
(function (global) {
    const TILE_SIZE = 40;
    const SNAP_THRESHOLD = 18;
    const MIN_WORD_LEN = 2;

    function cellKey(gx, gy) {
        return `${gx},${gy}`;
    }

    function toCell(x, y) {
        return { gx: Math.round(x / TILE_SIZE), gy: Math.round(y / TILE_SIZE) };
    }

    function fromCell(gx, gy) {
        return { x: gx * TILE_SIZE, y: gy * TILE_SIZE };
    }

    /** Which cardinal edges of `tile` touch another tile (same grid step as snap). */
    function tileConnectedSides(tile, others, gap = TILE_SIZE) {
        let left = false;
        let right = false;
        let top = false;
        let bottom = false;
        for (const o of others) {
            if (!o || o.id === tile.id) continue;
            const dx = o.x - tile.x;
            const dy = o.y - tile.y;
            if (dx === -gap && dy === 0) left = true;
            else if (dx === gap && dy === 0) right = true;
            else if (dx === 0 && dy === -gap) top = true;
            else if (dx === 0 && dy === gap) bottom = true;
        }
        return { left, right, top, bottom };
    }

    /** True if two tile top-left positions share the same grid cell. */
    function tilesShareCell(a, b, size = TILE_SIZE) {
        const ca = toCell(a.x, a.y);
        const cb = toCell(b.x, b.y);
        return ca.gx === cb.gx && ca.gy === cb.gy;
    }

    /** Exact edge slot beside `other` — shares its row or column, no sub-pixel offset. */
    function alignedSnapPos(other, side, size = TILE_SIZE) {
        const ox = Math.round(other.x);
        const oy = Math.round(other.y);
        switch (side) {
            case 'right': return { x: ox + size, y: oy };
            case 'left': return { x: ox - size, y: oy };
            case 'down': return { x: ox, y: oy + size };
            case 'up': return { x: ox, y: oy - size };
            default: return { x: ox, y: oy };
        }
    }

    /** Snap to a free neighboring edge — never stack on the same cell. */
    function snapTilePosition(tile, others, size = TILE_SIZE) {
        const map = buildCellMap(others.filter((o) => o.id !== tile.id));
        const cx = tile.x + size / 2;
        const cy = tile.y + size / 2;
        const candidates = [];
        const sides = ['right', 'left', 'down', 'up'];

        others.forEach((other) => {
            if (other.id === tile.id) return;
            sides.forEach((side) => {
                const pos = alignedSnapPos(other, side, size);
                const { gx, gy } = toCell(pos.x, pos.y);
                if (map.has(cellKey(gx, gy))) return;
                const d = Math.hypot(cx - (pos.x + size / 2), cy - (pos.y + size / 2));
                candidates.push({ ...pos, dist: d, side, otherId: other.id });
            });
        });

        candidates.sort((a, b) => a.dist - b.dist);
        const inRange = candidates.filter((c) => c.dist <= SNAP_THRESHOLD);
        const pickFrom = (list) => {
            if (!list.length) return null;
            const pick = list[0];
            const anchor = others.find((o) => o.id === pick.otherId);
            if (!anchor) return { x: pick.x, y: pick.y, snapped: true };
            const aligned = alignedSnapPos(anchor, pick.side, size);
            return { x: aligned.x, y: aligned.y, snapped: true };
        };

        const inRangePick = pickFrom(inRange);
        if (inRangePick) return inRangePick;

        const selfCell = toCell(tile.x, tile.y);
        if (map.has(cellKey(selfCell.gx, selfCell.gy)) && candidates.length) {
            return pickFrom(candidates);
        }

        return {
            x: Number.isFinite(tile.x) ? Math.round(tile.x) : 0,
            y: Number.isFinite(tile.y) ? Math.round(tile.y) : 0,
            snapped: false
        };
    }

    function alignTileToGrid(x, y) {
        const { gx, gy } = toCell(x, y);
        return fromCell(gx, gy);
    }

    function tilesOverlapAt(ax, ay, bx, by, size = TILE_SIZE) {
        return ax < bx + size && ax + size > bx && ay < by + size && ay + size > by;
    }

    function tileOverlapsAny(x, y, others, size = TILE_SIZE) {
        return (others || []).some((o) => o && tilesOverlapAt(x, y, o.x, o.y, size));
    }

    function handHasOverlaps(tiles, size = TILE_SIZE) {
        const list = tiles || [];
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                if (!a || !b) continue;
                if (tilesOverlapAt(a.x, a.y, b.x, b.y, size)) return true;
            }
        }
        return false;
    }

    /** Smallest axis push so (x,y) no longer overlaps `others`. Prefers aligned edge slots. */
    function separateFromOverlaps(x, y, others, size = TILE_SIZE) {
        const hit = (others || []).find((o) => o && tilesOverlapAt(x, y, o.x, o.y, size));
        if (hit) {
            const sides = ['right', 'left', 'down', 'up'];
            const slots = sides
                .map((side) => ({ ...alignedSnapPos(hit, side, size), side }))
                .filter((pos) => !tileOverlapsAny(pos.x, pos.y, others, size))
                .map((pos) => ({
                    ...pos,
                    dist: Math.hypot(pos.x - x, pos.y - y)
                }))
                .sort((a, b) => a.dist - b.dist);
            if (slots.length) {
                return { x: slots[0].x, y: slots[0].y };
            }
        }

        let nx = x;
        let ny = y;
        let guard = 0;
        while (guard++ < (others?.length || 0) + 8) {
            const blocker = (others || []).find((o) => o && tilesOverlapAt(nx, ny, o.x, o.y, size));
            if (!blocker) break;
            const pushRight = blocker.x + size - nx;
            const pushLeft = nx + size - blocker.x;
            const pushDown = blocker.y + size - ny;
            const pushUp = ny + size - blocker.y;
            const moves = [
                { dx: pushRight, dy: 0 },
                { dx: -pushLeft, dy: 0 },
                { dx: 0, dy: pushDown },
                { dx: 0, dy: -pushUp }
            ].filter((m) => m.dx || m.dy);
            moves.sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy)));
            if (!moves.length) break;
            nx += moves[0].dx;
            ny += moves[0].dy;
        }
        return { x: Math.round(nx), y: Math.round(ny) };
    }

    /**
     * Edge-snap when near another tile; otherwise keep the drop position.
     * Only moves a tile when it snaps or overlaps another.
     */
    function resolveTilePosition(tile, others, size = TILE_SIZE) {
        const rest = (others || []).filter((o) => o && o.id !== tile.id);
        const snap = snapTilePosition(tile, rest, size);
        if (snap.snapped) {
            return { x: snap.x, y: snap.y, snapped: true };
        }

        const x = Number.isFinite(tile.x) ? Math.round(tile.x) : 0;
        const y = Number.isFinite(tile.y) ? Math.round(tile.y) : 0;
        if (!tileOverlapsAny(x, y, rest, size)) {
            return { x, y, snapped: false };
        }

        const probe = { ...tile, x, y };
        const edgeSnap = snapTilePosition(probe, rest, size);
        if (edgeSnap.snapped && !tileOverlapsAny(edgeSnap.x, edgeSnap.y, rest, size)) {
            return { x: edgeSnap.x, y: edgeSnap.y, snapped: true };
        }

        const separated = separateFromOverlaps(x, y, rest, size);
        return { x: separated.x, y: separated.y, snapped: false, nudged: true };
    }

    /** Resolve overlaps without moving tiles that are already clear and unsnapped. */
    function resolveHandPositions(tiles) {
        const resolved = [];
        (tiles || []).forEach((t) => {
            if (!t) return;
            const pos = resolveTilePosition(t, resolved);
            resolved.push({ ...t, x: pos.x, y: pos.y });
        });
        return resolved;
    }

    /** True if dropping at (x,y) would edge-snap onto another tile. */
    function wouldSnapAt(x, y, others, size = TILE_SIZE) {
        const probe = { id: '__spawn', letter: 'Z', x, y };
        return snapTilePosition(probe, others, size).snapped;
    }

    function getRackBounds(origin, cols = 7, gap = TILE_SIZE, tileSize = TILE_SIZE, handBelowCenter = 200) {
        const startX = origin.x - ((cols - 1) * gap + tileSize) / 2;
        const startY = origin.y + handBelowCenter;
        return {
            left: startX,
            top: startY,
            right: startX + (cols - 1) * gap + tileSize,
            bottom: startY + 2 * gap + tileSize
        };
    }

    function isTileInRack(tile, bounds, tileSize = TILE_SIZE) {
        const cx = tile.x + tileSize / 2;
        const cy = tile.y + tileSize / 2;
        return cx >= bounds.left && cx <= bounds.right && cy >= bounds.top && cy <= bounds.bottom;
    }

    function computeDealSlots(origin, options = {}) {
        const cols = options.cols ?? 7;
        const gap = options.gap ?? TILE_SIZE;
        const tileSize = options.tileSize ?? TILE_SIZE;
        const handBelowCenter = options.handBelowCenter ?? 200;
        const handSize = options.handSize ?? 21;
        const startX = origin.x - ((cols - 1) * gap + tileSize) / 2;
        const startY = origin.y + handBelowCenter;
        const slots = [];
        for (let idx = 0; idx < handSize; idx++) {
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            slots.push({ x: startX + col * gap, y: startY + row * gap });
        }
        return slots;
    }

    /** True when every tile is still on the initial 7×3 deal layout. */
    function isStartingRack(tiles, origin, options = {}) {
        const handSize = options.handSize ?? 21;
        if (tiles.length !== handSize) return false;
        const slots = computeDealSlots(origin, options);
        const used = new Set();
        return tiles.every((tile) => {
            const idx = slots.findIndex((slot, i) => !used.has(i)
                && Math.abs(slot.x - tile.x) < 1
                && Math.abs(slot.y - tile.y) < 1);
            if (idx < 0) return false;
            used.add(idx);
            return true;
        });
    }

    /** True when no two tiles round to the same grid cell. */
    function eachTileOccupiesUniqueCell(tiles) {
        if (!tiles.length) return false;
        return buildCellMap(tiles).size === tiles.length;
    }

    /**
     * Every tile on the board is in one connected grid and not the undealt starting rack.
     * Count can be 21, 22, … after earlier peels — not tied to initial hand size.
     */
    function allTilesPlacedInGrid(tiles, origin, options = {}) {
        if (!tiles.length) return false;
        if (!isConnected(tiles)) return false;
        return !isStartingRack(tiles, origin, options);
    }

    function buildCellMap(tiles) {
        const map = new Map();
        tiles.forEach((t) => {
            const { gx, gy } = toCell(t.x, t.y);
            map.set(cellKey(gx, gy), t);
        });
        return map;
    }

    function collectWords(tiles) {
        const map = buildCellMap(tiles);
        const words = new Set();

        map.forEach((_tile, key) => {
            const [gx, gy] = key.split(',').map(Number);
            if (!map.has(cellKey(gx - 1, gy))) {
                const run = [];
                let x = gx;
                while (map.has(cellKey(x, gy))) {
                    run.push(map.get(cellKey(x, gy)).letter);
                    x += 1;
                }
                if (run.length >= MIN_WORD_LEN) words.add(run.join('').toUpperCase());
            }
            if (!map.has(cellKey(gx, gy - 1))) {
                const run = [];
                let y = gy;
                while (map.has(cellKey(gx, y))) {
                    run.push(map.get(cellKey(gx, y)).letter);
                    y += 1;
                }
                if (run.length >= MIN_WORD_LEN) words.add(run.join('').toUpperCase());
            }
        });

        return [...words];
    }

    function isConnected(tiles) {
        if (tiles.length <= 1) return true;
        const map = buildCellMap(tiles);
        const keys = [...map.keys()];
        const start = keys[0];
        const [sgx, sgy] = start.split(',').map(Number);
        const seen = new Set([start]);
        const q = [{ gx: sgx, gy: sgy }];
        while (q.length) {
            const { gx, gy } = q.pop();
            [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
                const k = cellKey(gx + dx, gy + dy);
                if (map.has(k) && !seen.has(k)) {
                    seen.add(k);
                    q.push({ gx: gx + dx, gy: gy + dy });
                }
            });
        }
        return seen.size === map.size;
    }

    function largestComponentTiles(tiles) {
        const onBoard = (tiles || []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
        if (!onBoard.length) return { tiles: [], disconnected: 0 };
        const map = buildCellMap(onBoard);
        const keys = [...map.keys()];
        let largestKeys = new Set();
        let largest = 0;
        const visited = new Set();
        for (const start of keys) {
            if (visited.has(start)) continue;
            const [sgx, sgy] = start.split(',').map(Number);
            const seen = new Set([start]);
            const q = [{ gx: sgx, gy: sgy }];
            while (q.length) {
                const { gx, gy } = q.pop();
                [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
                    const k = cellKey(gx + dx, gy + dy);
                    if (map.has(k) && !seen.has(k)) {
                        seen.add(k);
                        q.push({ gx: gx + dx, gy: gy + dy });
                    }
                });
            }
            seen.forEach((k) => visited.add(k));
            if (seen.size > largest) {
                largest = seen.size;
                largestKeys = seen;
            }
        }
        const mainTiles = onBoard.filter((t) => {
            const { gx, gy } = toCell(t.x, t.y);
            return largestKeys.has(cellKey(gx, gy));
        });
        return { tiles: mainTiles, disconnected: onBoard.length - largest };
    }

    function validateGrid(tiles, checker) {
        if (!tiles.length) return { ok: false, reason: 'empty' };
        if (!isConnected(tiles)) return { ok: false, reason: 'disconnected' };
        const words = collectWords(tiles);
        if (!words.length) return { ok: false, reason: 'no-words' };
        for (const w of words) {
            if (!checker || !checker.isWord(w)) return { ok: false, reason: 'invalid-word', word: w };
        }
        return { ok: true, words };
    }

    /** Connected-component sizes (orthogonal), largest first. */
    function boardIslandSizes(tiles) {
        const onBoard = (tiles || []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
        if (!onBoard.length) return [];
        const map = buildCellMap(onBoard);
        const keys = [...map.keys()];
        const sizes = [];
        const visited = new Set();
        for (const start of keys) {
            if (visited.has(start)) continue;
            const [sgx, sgy] = start.split(',').map(Number);
            const seen = new Set([start]);
            const q = [{ gx: sgx, gy: sgy }];
            while (q.length) {
                const { gx, gy } = q.pop();
                [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
                    const k = cellKey(gx + dx, gy + dy);
                    if (map.has(k) && !seen.has(k)) {
                        seen.add(k);
                        q.push({ gx: gx + dx, gy: gy + dy });
                    }
                });
            }
            seen.forEach((k) => visited.add(k));
            sizes.push(seen.size);
        }
        return sizes.sort((a, b) => b - a);
    }

    /** Validate main crossword when N isolated single-tile stragglers sit off the blob. */
    function validateGridWithStragglers(tiles, checker, stragglerCount) {
        const n = Number(stragglerCount) | 0;
        if (!Number.isFinite(n) || n < 0) return { ok: false, reason: 'bad-straggler-count' };
        if (n === 0) return validateGrid(tiles, checker);
        const { tiles: mainTiles, disconnected } = largestComponentTiles(tiles);
        if (disconnected !== n) return { ok: false, reason: 'disconnected', disconnected, expected: n };
        const singles = boardIslandSizes(tiles).filter((s) => s === 1).length;
        if (singles !== n) return { ok: false, reason: 'straggler-islands', singles, expected: n };
        return validateGrid(mainTiles, checker);
    }

    /** Word list + validity for dev /b state (does not mutate the board). */
    function inspectBoardWords(tiles, checker) {
        const words = collectWords(tiles || []);
        const valid = [];
        const invalid = [];
        words.forEach((w) => {
            if (!checker || !checker.isWord(w)) invalid.push(w);
            else valid.push(w);
        });
        valid.sort();
        invalid.sort();
        return {
            connected: isConnected(tiles || []),
            words,
            valid,
            invalid
        };
    }

    const BananaGrid = {
        TILE_SIZE,
        SNAP_THRESHOLD,
        MIN_WORD_LEN,
        toCell,
        fromCell,
        tileConnectedSides,
        alignedSnapPos,
        alignTileToGrid,
        tilesOverlapAt,
        tileOverlapsAny,
        handHasOverlaps,
        separateFromOverlaps,
        resolveTilePosition,
        resolveHandPositions,
        snapTilePosition,
        wouldSnapAt,
        tilesShareCell,
        getRackBounds,
        isTileInRack,
        computeDealSlots,
        isStartingRack,
        eachTileOccupiesUniqueCell,
        allTilesPlacedInGrid,
        buildCellMap,
        collectWords,
        inspectBoardWords,
        isConnected,
        largestComponentTiles,
        boardIslandSizes,
        validateGrid,
        validateGridWithStragglers
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BananaGrid;
    } else {
        global.BananaGrid = BananaGrid;
    }
})(typeof window !== 'undefined' ? window : global);
