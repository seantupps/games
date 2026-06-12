/**
 * World ↔ puzzle grid mapping, rack layout, tile snap (Bananagrams-style).
 */
const RummikubGrid = (() => {
    const R = RummikubRules;
    const SNAP_THRESHOLD = 28;
    const ALIGN_REFINE_THRESHOLD = 32;
    const AUTO_INSERT_THRESHOLD = 28;

    let _tableBounds = null;

    function setTableBounds(bounds) {
        _tableBounds = bounds;
    }

    function boundsFromCoreGrid(coreGrid) {
        let minGx = Infinity;
        let maxGx = -Infinity;
        for (const key of coreGrid.cells.keys()) {
            const gx = Number(key.split(',')[0]);
            minGx = Math.min(minGx, gx);
            maxGx = Math.max(maxGx, gx);
        }
        if (!Number.isFinite(minGx)) return null;
        return { minGx, maxGx };
    }

    function tableAnchor(origin) {
        if (_tableBounds) {
            const { minGx, maxGx } = _tableBounds;
            const boardW = (maxGx - minGx) * R.BOARD_CELL_STEP + R.TILE_W;
            return {
                x: origin.x - boardW / 2 - minGx * R.BOARD_CELL_STEP,
                y: R.boardAnchor(origin).y
            };
        }
        return R.boardAnchor(origin);
    }

    function cellToWorld(gx, gy, origin) {
        const anchor = tableAnchor(origin);
        return {
            x: anchor.x + gx * R.BOARD_CELL_STEP,
            y: anchor.y + gy * R.BOARD_ROW_STEP
        };
    }

    function worldToCell(x, y, origin) {
        const anchor = tableAnchor(origin);
        const gx = Math.round((x - anchor.x) / R.BOARD_CELL_STEP);
        const gy = Math.round((y - anchor.y) / R.BOARD_ROW_STEP);
        return { gx, gy };
    }

    function snapWorldToCell(x, y, origin) {
        const { gx, gy } = worldToCell(x, y, origin);
        return { ...cellToWorld(gx, gy, origin), gx, gy };
    }

    function layoutRack(tiles, origin) {
        const count = tiles.length;
        const { startX, startY, cols } = R.rackOrigin(origin, count);
        return tiles.map((tile, idx) => {
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            return {
                ...tile,
                x: startX + col * R.TILE_GAP,
                y: startY + row * R.TILE_H,
                zone: 'rack',
                gridX: null,
                gridY: null
            };
        });
    }

    function isRackZone(tile, origin) {
        if (tile.zone === 'rack') return true;
        const { startY } = R.rackOrigin(origin);
        return tile.y >= startY - R.TILE_H;
    }

    function isStartingRack(tiles, origin) {
        if (!tiles.length) return true;
        const rack = layoutRack(
            tiles.map((t) => ({ id: t.id, kind: t.kind, color: t.color, value: t.value, display: t.display })),
            origin
        );
        const tol = 4;
        return tiles.every((t) => {
            const target = rack.find((r) => r.id === t.id);
            if (!target) return false;
            return Math.hypot(t.x - target.x, t.y - target.y) < tol;
        });
    }

    function tileConnectedSides(tile, others) {
        const stepX = R.TILE_GAP;
        const stepY = tile.zone === 'table' ? R.BOARD_ROW_STEP : R.TILE_H;
        if (typeof TileLayout !== 'undefined') {
            return TileLayout.tileConnectedSides(tile, others, stepX, stepY);
        }
        return { left: false, right: false, top: false, bottom: false };
    }

    function tilesOverlapAt(ax, ay, bx, by, w = R.TILE_W, h = R.TILE_H) {
        return ax < bx + w && ax + w > bx && ay < by + h && ay + h > by;
    }

    function tileOverlapsAny(x, y, others, w = R.TILE_W, h = R.TILE_H) {
        return (others || []).some((o) => o && tilesOverlapAt(x, y, o.x, o.y, w, h));
    }

    function tilesShareCell(a, b, origin) {
        const ca = worldToCell(a.x, a.y, origin);
        const cb = worldToCell(b.x, b.y, origin);
        return ca.gx === cb.gx && ca.gy === cb.gy;
    }

    function alignedSnapPos(other, side, hStep = R.TILE_GAP) {
        const ox = Math.round(other.x);
        const oy = Math.round(other.y);
        const vy = other.zone === 'table' ? R.BOARD_ROW_STEP : R.TILE_H;
        switch (side) {
            case 'right': return { x: ox + hStep, y: oy };
            case 'left': return { x: ox - hStep, y: oy };
            case 'down': return { x: ox, y: oy + vy };
            case 'up': return { x: ox, y: oy - vy };
            default: return { x: ox, y: oy };
        }
    }

    function snapNeighborTiles(tile, others, options = {}) {
        const zone = options.snapZone;
        return (others || []).filter((o) => o && o.id !== tile.id && (!zone || o.zone === zone));
    }

    /** Edge snap uses every placed tile; auto-insert still respects snapZone. */
    function snapEdgeNeighbors(tile, others, options = {}) {
        if (options.snapZone) return snapNeighborTiles(tile, others, options);
        return (others || []).filter((o) => o && o.id !== tile.id);
    }

    /** Prefer the side the user is approaching from when distances tie. */
    function snapApproachBias(tile, other, side) {
        const tcx = tile.x + R.TILE_W / 2;
        const ocx = other.x + R.TILE_W / 2;
        const tcy = tile.y + R.TILE_H / 2;
        const ocy = other.y + R.TILE_H / 2;
        switch (side) {
            case 'left': return tcx < ocx ? 1 : 0;
            case 'right': return tcx > ocx ? 1 : 0;
            case 'up': return tcy < ocy ? 1 : 0;
            case 'down': return tcy > ocy ? 1 : 0;
            default: return 0;
        }
    }

    function sortSnapCandidates(tile, rest, candidates) {
        const byId = new Map(rest.map((o) => [o.id, o]));
        candidates.sort((a, b) => {
            if (Math.abs(a.dist - b.dist) > 2) return a.dist - b.dist;
            const biasA = snapApproachBias(tile, byId.get(a.otherId), a.side);
            const biasB = snapApproachBias(tile, byId.get(b.otherId), b.side);
            if (biasB !== biasA) return biasB - biasA;
            return a.dist - b.dist;
        });
    }

    function collectNonOverlappingSlots(x, y, others) {
        const slots = [];
        const seen = new Set();
        for (const hit of others || []) {
            if (!hit) continue;
            for (const side of ['right', 'left', 'down', 'up']) {
                const pos = alignedSnapPos(hit, side);
                const key = `${pos.x},${pos.y}`;
                if (seen.has(key)) continue;
                seen.add(key);
                if (!tileOverlapsAny(pos.x, pos.y, others)) {
                    slots.push({
                        ...pos,
                        dist: Math.hypot(pos.x - x, pos.y - y)
                    });
                }
            }
        }
        slots.sort((a, b) => a.dist - b.dist);
        return slots;
    }

    function separateFromOverlaps(x, y, others) {
        const nx = Math.round(x);
        const ny = Math.round(y);
        if (!tileOverlapsAny(nx, ny, others)) return { x: nx, y: ny };

        const blocker = (others || []).find((o) => o && tilesOverlapAt(nx, ny, o.x, o.y));
        if (blocker) {
            const edgeSlots = ['right', 'left', 'down', 'up']
                .map((side) => alignedSnapPos(blocker, side))
                .filter((pos) => !tileOverlapsAny(pos.x, pos.y, others))
                .map((pos) => ({
                    ...pos,
                    dist: Math.hypot(pos.x - nx, pos.y - ny)
                }))
                .sort((a, b) => a.dist - b.dist);
            if (edgeSlots.length) return { x: edgeSlots[0].x, y: edgeSlots[0].y };
        }

        const slots = collectNonOverlappingSlots(nx, ny, others);
        if (slots.length) return { x: slots[0].x, y: slots[0].y };

        let px = nx;
        let py = ny;
        let guard = 0;
        while (guard++ < (others?.length || 0) + 8) {
            const blocker = (others || []).find((o) => o && tilesOverlapAt(px, py, o.x, o.y));
            if (!blocker) break;
            const pushRight = blocker.x + R.TILE_W - px;
            const pushLeft = px + R.TILE_W - blocker.x;
            const pushDown = blocker.y + R.TILE_H - py;
            const pushUp = py + R.TILE_H - blocker.y;
            const moves = [
                { dx: pushRight, dy: 0 },
                { dx: -pushLeft, dy: 0 },
                { dx: 0, dy: pushDown },
                { dx: 0, dy: -pushUp }
            ].filter((m) => m.dx || m.dy);
            moves.sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy)));
            if (!moves.length) break;
            px += moves[0].dx;
            py += moves[0].dy;
        }
        return { x: Math.round(px), y: Math.round(py) };
    }

    function ensureNoOverlap(x, y, others) {
        let nx = Math.round(x);
        let ny = Math.round(y);
        for (let i = 0; i < 12; i++) {
            if (!tileOverlapsAny(nx, ny, others)) return { x: nx, y: ny };
            const sep = separateFromOverlaps(nx, ny, others);
            if (sep.x === nx && sep.y === ny) break;
            nx = sep.x;
            ny = sep.y;
        }
        if (tileOverlapsAny(nx, ny, others)) {
            const slots = collectNonOverlappingSlots(nx, ny, others);
            if (slots.length) return { x: slots[0].x, y: slots[0].y };
        }
        return { x: nx, y: ny };
    }

    /**
     * Drop clearly between two colinear tiles with a one-tile gap (auto insert).
     */
    function findAutoInsertSlot(tile, others, options = {}) {
        if (options.autoInsert === false) return null;
        const rest = snapNeighborTiles(tile, others, options);
        const cx = tile.x + R.TILE_W / 2;
        const cy = tile.y + R.TILE_H / 2;
        let best = null;

        for (let i = 0; i < rest.length; i++) {
            for (let j = i + 1; j < rest.length; j++) {
                const a = rest[i];
                const b = rest[j];

                if (Math.abs(a.y - b.y) <= 2) {
                    const left = a.x <= b.x ? a : b;
                    const right = a.x <= b.x ? b : a;
                    const gap = right.x - (left.x + R.TILE_W);
                    if (gap < R.TILE_GAP - 4 || gap > R.TILE_GAP + 4) continue;
                    const slotX = left.x + R.TILE_W;
                    const slotY = left.y;
                    const targetCx = slotX + R.TILE_W / 2;
                    const targetCy = slotY + R.TILE_H / 2;
                    const dist = Math.hypot(cx - targetCx, cy - targetCy);
                    if (dist <= AUTO_INSERT_THRESHOLD && !tileOverlapsAny(slotX, slotY, rest)) {
                        if (!best || dist < best.dist) {
                            best = { x: slotX, y: slotY, dist, autoInsert: true };
                        }
                    }
                }

                if (Math.abs(a.x - b.x) <= 2) {
                    const top = a.y <= b.y ? a : b;
                    const bottom = a.y <= b.y ? b : a;
                    const gap = bottom.y - (top.y + R.TILE_H);
                    if (gap < R.BOARD_ROW_STEP - 4 || gap > R.BOARD_ROW_STEP + 4) continue;
                    const slotX = top.x;
                    const slotY = top.y + R.TILE_H;
                    const targetCx = slotX + R.TILE_W / 2;
                    const targetCy = slotY + R.TILE_H / 2;
                    const dist = Math.hypot(cx - targetCx, cy - targetCy);
                    if (dist <= AUTO_INSERT_THRESHOLD && !tileOverlapsAny(slotX, slotY, rest)) {
                        if (!best || dist < best.dist) {
                            best = { x: slotX, y: slotY, dist, autoInsert: true };
                        }
                    }
                }
            }
        }

        if (!best) return null;
        return { x: best.x, y: best.y, snapped: true, autoInsert: true };
    }

    function snapTilePosition(tile, others, options = {}) {
        const rest = snapEdgeNeighbors(tile, others, options);
        const threshold = options.threshold ?? SNAP_THRESHOLD;
        const candidates = [];
        const sides = ['right', 'left', 'down', 'up'];

        rest.forEach((other) => {
            sides.forEach((side) => {
                const pos = alignedSnapPos(other, side);
                const d = Math.hypot(tile.x - pos.x, tile.y - pos.y);
                candidates.push({ ...pos, dist: d, side, otherId: other.id });
            });
        });

        sortSnapCandidates(tile, rest, candidates);
        const inRange = candidates.filter((c) => c.dist <= threshold);
        const pickFrom = (list) => {
            for (const pick of list) {
                const anchor = rest.find((o) => o.id === pick.otherId);
                const aligned = anchor
                    ? alignedSnapPos(anchor, pick.side)
                    : { x: pick.x, y: pick.y };
                if (!tileOverlapsAny(aligned.x, aligned.y, rest)) {
                    return { x: aligned.x, y: aligned.y, snapped: true };
                }
            }
            return null;
        };

        const inRangePick = pickFrom(inRange);
        if (inRangePick) return inRangePick;

        const overlap = rest.find((o) => tilesOverlapAt(tile.x, tile.y, o.x, o.y));
        if (overlap && candidates.length) {
            const forced = pickFrom(candidates);
            if (forced) return forced;
        }

        return {
            x: Number.isFinite(tile.x) ? Math.round(tile.x) : 0,
            y: Number.isFinite(tile.y) ? Math.round(tile.y) : 0,
            snapped: false
        };
    }

    function resolveRackPosition(tile, others, options = {}) {
        const rackOpts = { ...options, snapZone: 'rack' };
        const rest = snapNeighborTiles(tile, others, rackOpts);
        const insert = findAutoInsertSlot(tile, rest, rackOpts);
        if (insert) {
            const clear = ensureNoOverlap(insert.x, insert.y, rest);
            return { ...clear, snapped: true, autoInsert: true };
        }
        const snap = snapTilePosition(tile, others, options);
        if (snap.snapped) {
            const clear = ensureNoOverlap(snap.x, snap.y, rest);
            return { ...clear, snapped: true };
        }
        const x = Math.round(tile.x);
        const y = Math.round(tile.y);
        if (!tileOverlapsAny(x, y, rest)) {
            return { x, y, snapped: false };
        }
        const forced = snapTilePosition(
            { ...tile, x, y },
            others,
            { ...options, threshold: Infinity }
        );
        if (forced.snapped && !tileOverlapsAny(forced.x, forced.y, rest)) {
            return { ...forced, snapped: true };
        }
        const sep = separateFromOverlaps(x, y, rest);
        const clear = ensureNoOverlap(sep.x, sep.y, rest);
        return { ...clear, snapped: false, nudged: true };
    }

    function occupiedCellKeys(tiles, skipId = null) {
        const keys = new Set();
        for (const t of tiles) {
            if (t.id === skipId || t.zone === 'rack') continue;
            if (t.gridX != null && t.gridY != null) {
                keys.add(`${t.gridX},${t.gridY}`);
            }
        }
        return keys;
    }

    function findNearestFreeCell(gx, gy, occupied) {
        for (let r = 0; r < 12; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dy = -r; dy <= r; dy++) {
                    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                    const nx = gx + dx;
                    const ny = gy + dy;
                    if (nx < 0 || ny < 0) continue;
                    const k = `${nx},${ny}`;
                    if (!occupied.has(k)) return { gx: nx, gy: ny };
                }
            }
        }
        return null;
    }

    function assignTableGrid(x, y, others, origin) {
        const cell = snapWorldToCell(x, y, origin);
        const occupied = occupiedCellKeys(others);
        const key = `${cell.gx},${cell.gy}`;
        if (occupied.has(key)) {
            const alt = findNearestFreeCell(cell.gx, cell.gy, occupied);
            if (alt) {
                const pos = cellToWorld(alt.gx, alt.gy, origin);
                return {
                    x: pos.x,
                    y: pos.y,
                    zone: 'table',
                    gridX: alt.gx,
                    gridY: alt.gy
                };
            }
        }
        return {
            x: cell.x,
            y: cell.y,
            zone: 'table',
            gridX: cell.gx,
            gridY: cell.gy
        };
    }

    function tablePositionFromSnap(x, y, origin) {
        const cell = worldToCell(x, y, origin);
        return {
            x,
            y,
            zone: 'table',
            gridX: cell.gx,
            gridY: cell.gy,
            snapped: true
        };
    }

    function resolveTablePosition(tile, others, origin, options = {}) {
        const tableOpts = { ...options, snapZone: 'table' };
        const rest = snapNeighborTiles(tile, others, tableOpts);

        const insert = findAutoInsertSlot(tile, rest, tableOpts);
        if (insert) {
            const clear = ensureNoOverlap(insert.x, insert.y, rest);
            return {
                ...tablePositionFromSnap(clear.x, clear.y, origin),
                autoInsert: true
            };
        }

        const edge = snapTilePosition(tile, others, options);
        if (edge.snapped) {
            const clear = ensureNoOverlap(edge.x, edge.y, rest);
            return tablePositionFromSnap(clear.x, clear.y, origin);
        }

        const x = Math.round(tile.x);
        const y = Math.round(tile.y);
        if (!tileOverlapsAny(x, y, rest)) {
            return {
                x,
                y,
                zone: 'table',
                gridX: null,
                gridY: null,
                snapped: false
            };
        }

        const forced = snapTilePosition(
            { ...tile, x, y },
            others,
            { ...options, threshold: Infinity }
        );
        if (forced.snapped && !tileOverlapsAny(forced.x, forced.y, rest)) {
            return tablePositionFromSnap(forced.x, forced.y, origin);
        }

        const sep = separateFromOverlaps(x, y, rest);
        const clear = ensureNoOverlap(sep.x, sep.y, rest);
        return {
            x: clear.x,
            y: clear.y,
            zone: 'table',
            gridX: null,
            gridY: null,
            snapped: false,
            nudged: true
        };
    }

    /** Nudge near-miss table tiles onto exact edge slots before win / render. */
    function refineTableAlignment(tiles, origin) {
        const table = (tiles || []).filter((t) => t && t.zone === 'table');
        if (table.length < 2) return false;
        let changed = false;
        for (let pass = 0; pass < 6; pass++) {
            let passChanged = false;
            for (const tile of table) {
                const others = table.filter((o) => o.id !== tile.id);
                const snap = snapTilePosition(tile, others, {
                    snapZone: 'table',
                    threshold: ALIGN_REFINE_THRESHOLD
                });
                if (!snap.snapped) continue;
                if (tile.x !== snap.x || tile.y !== snap.y) {
                    tile.x = snap.x;
                    tile.y = snap.y;
                    passChanged = true;
                }
            }
            if (!passChanged) break;
            changed = true;
        }
        if (changed && origin) {
            table.forEach((t) => {
                const cell = worldToCell(t.x, t.y, origin);
                t.gridX = cell.gx;
                t.gridY = cell.gy;
            });
        }
        return changed;
    }

    function tilesTouch(a, b) {
        const sides = tileConnectedSides(a, [b]);
        return sides.left || sides.right || sides.top || sides.bottom;
    }

    /** Horizontal edge-touch only — used by win verification (vertical snap is allowed but ignored). */
    function tilesTouchHorizontal(a, b) {
        const sides = tileConnectedSides(a, [b]);
        return sides.left || sides.right;
    }

    function countConnectedComponents(tiles) {
        return extractTouchClusters(tiles).length;
    }

    /** Connected components by edge-touch (each island on the table). */
    function extractTouchClusters(tiles) {
        const list = (tiles || []).filter(Boolean);
        const seen = new Set();
        const clusters = [];
        for (const seed of list) {
            if (seen.has(seed.id)) continue;
            const cluster = [];
            const stack = [seed];
            seen.add(seed.id);
            while (stack.length) {
                const cur = stack.pop();
                cluster.push(cur);
                for (const other of list) {
                    if (seen.has(other.id)) continue;
                    if (tilesTouch(cur, other)) {
                        seen.add(other.id);
                        stack.push(other);
                    }
                }
            }
            clusters.push(cluster);
        }
        return clusters;
    }

    function groupOverlapsAny(positions, others) {
        return positions.some((p) => tileOverlapsAny(p.x, p.y, others));
    }

    function applyRigidOffsets(anchorX, anchorY, offsets) {
        return offsets.map(({ tile, dx, dy }) => ({
            tile,
            x: anchorX + dx,
            y: anchorY + dy
        }));
    }

    /** Nudge the whole group together — never separate members. */
    function nudgeRigidGroup(positions, others) {
        if (!positions.length) return positions;
        if (!groupOverlapsAny(positions, others)) {
            return positions.map((p) => ({
                tile: p.tile,
                x: Math.round(p.x),
                y: Math.round(p.y)
            }));
        }
        const anchor = positions[0];
        const offsets = positions.map((p) => ({
            tile: p.tile,
            dx: p.x - anchor.x,
            dy: p.y - anchor.y
        }));
        const slots = collectNonOverlappingSlots(anchor.x, anchor.y, others);
        for (const slot of slots) {
            const trial = applyRigidOffsets(slot.x, slot.y, offsets);
            if (!groupOverlapsAny(trial, others)) return trial;
        }
        const cleared = separateFromOverlaps(anchor.x, anchor.y, others);
        const trial = applyRigidOffsets(cleared.x, cleared.y, offsets);
        if (!groupOverlapsAny(trial, others)) return trial;
        const anchorSlots = collectNonOverlappingSlots(anchor.x, anchor.y, others);
        for (const slot of anchorSlots) {
            const slotTrial = applyRigidOffsets(slot.x, slot.y, offsets);
            if (!groupOverlapsAny(slotTrial, others)) return slotTrial;
        }
        return positions.map((p) => ({
            tile: p.tile,
            x: Math.round(p.x),
            y: Math.round(p.y)
        }));
    }

    /**
     * Snap a rigid group — try each member as probe so the edge nearest the target
     * wins (left-side drops must not use group[0] on the far edge).
     */
    function snapGroupRigidPosition(group, rest, options = {}) {
        let best = null;
        for (const probe of group) {
            const offsets = group.map((t) => ({
                tile: t,
                dx: t.x - probe.x,
                dy: t.y - probe.y
            }));
            const snap = snapTilePosition({ ...probe }, rest, options);
            if (!snap.snapped) continue;
            const trial = applyRigidOffsets(snap.x, snap.y, offsets);
            if (groupOverlapsAny(trial, rest)) continue;
            const dist = Math.hypot(probe.x - snap.x, probe.y - snap.y);
            if (!best || dist < best.dist) {
                best = { x: snap.x, y: snap.y, dist, snapped: true, offsets };
            }
        }
        if (best) return best;
        const primary = group[0];
        return {
            x: primary.x,
            y: primary.y,
            snapped: false,
            dist: Infinity,
            offsets: group.map((t) => ({
                tile: t,
                dx: t.x - primary.x,
                dy: t.y - primary.y
            }))
        };
    }

    /** Drop a marquee-selected group as one rigid piece. */
    function resolveGroupDrop(members, others, origin, options = {}) {
        const group = (members || []).filter(Boolean);
        if (!group.length) return [];
        if (group.length === 1) {
            return [resolveDrop(group[0], others, origin, options)];
        }

        const memberIds = new Set(group.map((t) => t.id));
        const rest = (others || []).filter((t) => t && !memberIds.has(t.id));
        const primary = group[0];
        const { startY } = R.rackOrigin(origin, group.length);
        const snap = snapGroupRigidPosition(group, rest, options);
        const ax = snap.snapped ? snap.x : primary.x;
        const ay = snap.snapped ? snap.y : primary.y;
        let positions = nudgeRigidGroup(
            applyRigidOffsets(ax, ay, snap.offsets),
            rest
        );
        const placed = [...rest];
        return positions.map(({ tile, x, y }) => {
            let fx = Math.round(x);
            let fy = Math.round(y);
            if (tileOverlapsAny(fx, fy, placed)) {
                const onRack = fy >= startY - R.TILE_H * 0.5;
                const cleared = onRack
                    ? resolveRackPosition({ ...tile, x: fx, y: fy }, placed, options)
                    : resolveTablePosition({ ...tile, x: fx, y: fy }, placed, origin, options);
                fx = cleared.x;
                fy = cleared.y;
            }
            const onRack = fy >= startY - R.TILE_H * 0.5;
            const result = onRack
                ? {
                    ...tile,
                    x: fx,
                    y: fy,
                    zone: 'rack',
                    gridX: null,
                    gridY: null,
                    snapped: snap.snapped
                }
                : {
                    ...tile,
                    x: fx,
                    y: fy,
                    zone: 'table',
                    gridX: snap.snapped ? worldToCell(fx, fy, origin).gx : null,
                    gridY: snap.snapped ? worldToCell(fx, fy, origin).gy : null,
                    snapped: snap.snapped
                };
            placed.push(result);
            return result;
        });
    }

    function resolveDrop(tile, others, origin, options = {}) {
        const { startY } = R.rackOrigin(origin);
        const rackLine = startY - R.TILE_H * 0.5;
        if (tile.y < rackLine) {
            return { ...tile, ...resolveTablePosition(tile, others, origin, options) };
        }
        const pos = resolveRackPosition(tile, others, options);
        if (pos.y < rackLine) {
            return {
                ...tile,
                ...resolveTablePosition({ ...tile, x: pos.x, y: pos.y }, others, origin, options)
            };
        }
        return {
            ...tile,
            x: pos.x,
            y: pos.y,
            zone: 'rack',
            gridX: null,
            gridY: null
        };
    }

    function handHasOverlaps(tiles) {
        const list = tiles || [];
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                if (!a || !b) continue;
                if (tilesOverlapAt(a.x, a.y, b.x, b.y)) return true;
            }
        }
        return false;
    }

    function resolveHandPositions(tiles, options = {}) {
        const resolved = [];
        (tiles || []).forEach((t) => {
            if (!t) return;
            const pos = resolveRackPosition(t, resolved, options);
            resolved.push({ ...t, x: pos.x, y: pos.y });
        });
        return resolved;
    }

    /** Re-resolve every tile in order — last resort when any zone still overlaps. */
    function resolveBoardOverlaps(tiles, origin, options = {}) {
        const resolved = [];
        (tiles || []).forEach((t) => {
            if (!t) return;
            resolved.push(resolveDrop({ ...t }, resolved, origin, options));
        });
        return resolved;
    }

    function clusterMeldsInBand(tiles) {
        const sorted = [...tiles].sort((a, b) => a.gridX - b.gridX);
        if (!sorted.length) return [];
        const clusters = [];
        let cluster = [sorted[0]];
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].gridX - sorted[i - 1].gridX === 1) {
                cluster.push(sorted[i]);
            } else {
                clusters.push(cluster);
                cluster = [sorted[i]];
            }
        }
        clusters.push(cluster);
        return clusters;
    }

    function extractMeldClusters(tiles) {
        const byGy = new Map();
        (tiles || []).forEach((t) => {
            if (!byGy.has(t.gridY)) byGy.set(t.gridY, []);
            byGy.get(t.gridY).push(t);
        });
        const melds = [];
        [...byGy.keys()].sort((a, b) => a - b).forEach((gy) => {
            melds.push(...clusterMeldsInBand(byGy.get(gy)));
        });
        return melds;
    }

    /** Deal layout — all spacing from rules.js (single source of truth). */
    function relayoutTableSpacing(tiles, origin) {
        const gapX = R.MELD_ISLAND_GAP_PX <= 0
            ? 0
            : Math.max(1, Math.round(R.MELD_ISLAND_GAP_PX / R.BOARD_CELL_STEP));
        const gapY = R.MELD_GAP_Y;
        const maxRowW = R.MAX_MELD_ROW_WIDTH;
        const melds = extractMeldClusters(tiles);
        const staged = [];
        let visualGy = 0;
        let visualGx = 0;
        melds.forEach((meld) => {
            const w = meld.length;
            if (visualGx > 0 && visualGx + w > maxRowW) {
                visualGx = 0;
                visualGy += 1 + gapY;
            } else if (visualGx > 0) {
                visualGx += gapX;
            }
            meld.forEach((t, ti) => {
                staged.push({ tile: t, visualGx: visualGx + ti, visualGy });
            });
            visualGx += w;
        });
        if (!staged.length) return [];
        let minGx = Infinity;
        let maxGx = -Infinity;
        staged.forEach((s) => {
            minGx = Math.min(minGx, s.visualGx);
            maxGx = Math.max(maxGx, s.visualGx);
        });
        setTableBounds({ minGx, maxGx });
        return staged.map((s) => {
            const pos = cellToWorld(s.visualGx, s.visualGy, origin);
            return {
                ...s.tile,
                x: pos.x,
                y: pos.y,
                gridX: s.visualGx,
                gridY: s.visualGy
            };
        });
    }

    function tilesFromCoreGrid(coreGrid, origin) {
        const raw = [];
        for (const [key, cell] of coreGrid.cells.entries()) {
            const [gx, gy] = key.split(',').map(Number);
            raw.push({
                ...cell.tile,
                color: cell.color,
                value: cell.value,
                zone: 'table',
                gridX: gx,
                gridY: gy
            });
        }
        return relayoutTableSpacing(raw, origin);
    }

    const api = {
        cellToWorld,
        worldToCell,
        snapWorldToCell,
        layoutRack,
        isRackZone,
        isStartingRack,
        tileConnectedSides,
        tilesOverlapAt,
        tileOverlapsAny,
        tilesShareCell,
        alignedSnapPos,
        findAutoInsertSlot,
        snapTilePosition,
        ensureNoOverlap,
        resolveRackPosition,
        resolveTablePosition,
        refineTableAlignment,
        resolveDrop,
        resolveGroupDrop,
        tilesTouch,
        tilesTouchHorizontal,
        countConnectedComponents,
        extractTouchClusters,
        handHasOverlaps,
        resolveHandPositions,
        resolveBoardOverlaps,
        tilesFromCoreGrid,
        setTableBounds,
        tableAnchor
    };

    if (typeof window !== 'undefined') {
        window.RummikubGrid = api;
    }
    return api;
})();
