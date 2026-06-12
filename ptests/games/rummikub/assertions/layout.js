/**
 * Rummikub layout / snap / selection assertions (seed-agnostic).
 */
const { EXPECTED_TILES } = require('../lib/session');

const APPROACH_PX = 8;
const DRAG_STEPS = 8;
/** Must exceed GameSelection MARQUEE_HOLD_MS (120) for hold-then-drag tests. */
const MOBILE_MARQUEE_HOLD_MS = 130;

/** Table tile with clear room on the requested snap side (no neighbor on that edge). */
function findHorizSnapAnchor(table, side) {
    const blockers = {
        right: ['right', 'bottom'],
        left: ['left', 'bottom']
    };
    const blocked = blockers[side] || ['bottom'];
    return table.find((t) => {
        const sides = RummikubGrid.tileConnectedSides(
            t,
            table.filter((o) => o.id !== t.id)
        );
        return blocked.every((edge) => !sides[edge]);
    });
}

/**
 * Real pointer drag through BaseGame.setupDragging (exercises onDragEnd + commit).
 * @param {import('playwright').Frame} frame
 * @param {string} tileId
 * @param {number} dropWorldX face-top-left world X
 * @param {number} dropWorldY face-top-left world Y
 */
async function realDragTile(frame, tileId, dropWorldX, dropWorldY, pointerType) {
    return frame.evaluate(async ({ tileId, dropWorldX, dropWorldY, steps, pointerType }) => {
        const g = window.game;
        const vp = window.GameViewport;
        const tile = g.tiles.find((t) => t.id === tileId);
        const node = document.querySelector(`[data-tile-id="${tileId}"]`);
        if (!tile || !node || !vp) return { ok: false, reason: 'missing-elements' };

        const ptr = pointerType || (g.isMobileViewport?.() ? 'touch' : 'mouse');
        g._syncAllTileElements?.();
        g.requestRender?.();
        await new Promise((r) => requestAnimationFrame(r));
        const offsetX = -RummikubRules.TILE_W / 2;
        const offsetY = -RummikubRules.TILE_H / 2;
        const startClient = vp.worldToClient(g, tile.x - offsetX, tile.y - offsetY);
        const endClient = vp.worldToClient(g, dropWorldX - offsetX, dropWorldY - offsetY);

        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType: ptr,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });

        const before = { x: tile.x, y: tile.y, zone: tile.zone };
        node.dispatchEvent(mk('pointerdown', startClient.x, startClient.y));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            node.dispatchEvent(mk(
                'pointermove',
                startClient.x + (endClient.x - startClient.x) * t,
                startClient.y + (endClient.y - startClient.y) * t
            ));
        }
        node.dispatchEvent(mk('pointerup', endClient.x, endClient.y));
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        g.requestRender?.();
        await new Promise((r) => requestAnimationFrame(r));

        const after = { x: tile.x, y: tile.y, zone: tile.zone };
        return {
            ok: true,
            id: tileId,
            before,
            after,
            moved: Math.hypot(after.x - before.x, after.y - before.y) > 5
        };
    }, { tileId, dropWorldX, dropWorldY, steps: DRAG_STEPS, pointerType: pointerType || null });
}

/**
 * Tile face background matches hub theme color.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertTileFaceThemeColor(frame, label = 'tile-face-theme') {
    const result = await frame.evaluate(() => {
        const theme = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim()
            || '#3b82f6';
        const probe = document.createElement('div');
        probe.style.background = theme;
        document.body.appendChild(probe);
        const themeBg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const faces = [...document.querySelectorAll('.tile-face')];
        const bad = faces.filter((f) => getComputedStyle(f).backgroundColor !== themeBg)
            .slice(0, 3)
            .map((f) => ({
                id: f.closest('.tile')?.dataset?.tileId,
                got: getComputedStyle(f).backgroundColor,
                want: themeBg
            }));
        return { ok: faces.length > 0 && !bad.length, count: faces.length, bad, themeBg };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * No overlapping tile bounding boxes in model space.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertNoOverlappingTiles(frame, label = 'no-overlap') {
    const result = await frame.evaluate(() => {
        const G = window.RummikubGrid;
        const tiles = window.game?.tiles || [];
        const pairs = [];
        for (let i = 0; i < tiles.length; i++) {
            for (let j = i + 1; j < tiles.length; j++) {
                const a = tiles[i];
                const b = tiles[j];
                if (G.tilesOverlapAt(a.x, a.y, b.x, b.y)) {
                    pairs.push({ a: a.id, b: b.id });
                }
            }
        }
        return { ok: !pairs.length, pairs: pairs.slice(0, 5), count: tiles.length };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Table tiles sit on grid cell origins (aligned snap).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertTableTilesGridAligned(frame, label = 'grid-aligned') {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const table = (g?.tiles || []).filter((t) => t.zone === 'table');
        const bad = [];
        table.forEach((t) => {
            const cell = RummikubGrid.snapWorldToCell(t.x, t.y, origin);
            const dx = Math.abs(t.x - cell.x);
            const dy = Math.abs(t.y - cell.y);
            if (dx > 1 || dy > 1) {
                bad.push({ id: t.id, x: t.x, y: t.y, cell });
            }
        });
        return { ok: table.length > 0 && !bad.length, table: table.length, bad: bad.slice(0, 5) };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Adjacent edge snap — drop beside a tile, never stack (Bananagrams parity).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertAdjacentTileSnap(frame, label = 'adjacent-snap') {
    const setup = await frame.evaluate(({ approachPx, findAnchorSrc }) => {
        const g = window.game;
        const findAnchor = new Function(`return (${findAnchorSrc})`)();
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        const rack = (g.tiles || []).find((t) => t.zone === 'rack');
        const anchor = findAnchor(table, 'right');
        if (!anchor || !rack) return { ok: false, reason: 'missing-tiles' };
        const slot = RummikubGrid.alignedSnapPos(anchor, 'right');
        return {
            ok: true,
            rackId: rack.id,
            anchorId: anchor.id,
            drop: { x: slot.x + approachPx, y: slot.y + 3 },
            want: { x: slot.x, y: slot.y },
            anchor: { x: anchor.x, y: anchor.y }
        };
    }, { approachPx: APPROACH_PX, findAnchorSrc: findHorizSnapAnchor.toString() });
    if (!setup.ok) throw new Error(`${label}: ${JSON.stringify(setup)}`);

    const drag = await realDragTile(frame, setup.rackId, setup.drop.x, setup.drop.y);
    if (!drag.ok || !drag.moved) {
        throw new Error(`${label}: drag failed (${JSON.stringify(drag)})`);
    }

    const snapResult = await frame.evaluate(({ rackId, anchorId, want }) => {
        const tileT = window.game.tiles.find((t) => t.id === rackId);
        const tileA = window.game.tiles.find((t) => t.id === anchorId);
        if (!tileT || !tileA) return { ok: false, reason: 'tiles-missing' };
        const shares = RummikubGrid.tilesOverlapAt(tileT.x, tileT.y, tileA.x, tileA.y);
        const hStep = RummikubRules.TILE_GAP;
        const adjacent = (tileT.x === tileA.x + hStep && tileT.y === tileA.y)
            || (tileT.x === tileA.x - hStep && tileT.y === tileA.y)
            || (tileT.x === tileA.x && tileT.y === tileA.y + RummikubRules.BOARD_ROW_STEP)
            || (tileT.x === tileA.x && tileT.y === tileA.y - RummikubRules.BOARD_ROW_STEP);
        const snapped = tileT.x === want.x && tileT.y === want.y;
        return {
            ok: tileT.zone === 'table' && snapped && adjacent && !shares,
            snapped,
            shares,
            pos: { x: tileT.x, y: tileT.y, zone: tileT.zone },
            want,
            anchor: { x: tileA.x, y: tileA.y },
            dragAfter: { x: tileT.x, y: tileT.y }
        };
    }, { rackId: setup.rackId, anchorId: setup.anchorId, want: setup.want });
    if (!snapResult.ok) {
        throw new Error(`${label}: ${JSON.stringify(snapResult)}`);
    }
    return snapResult;
}

/**
 * Mobile hit expand: open edges only; flush side against neighbor has no pad.
 * @param {import('playwright').Frame} frame
 * @param {boolean} expectMobile
 * @param {string} [label]
 */
async function assertSelectionHitExpand(frame, expectMobile, label = 'hit-expand') {
    const result = await frame.evaluate((expectMobileLayout) => {
        const g = window.game;
        const mobile = !!g.isMobileViewport?.();
        if (mobile !== expectMobileLayout) {
            return { ok: false, reason: 'viewport-mode-mismatch', mobile, expectMobileLayout };
        }
        const pad = mobile ? (g.constructor.TILE_SELECT_EXPAND || 0) : 0;
        const tiles = g?.tiles || [];
        if (!tiles.length) return { ok: false, reason: 'no-tiles' };
        const isolated = tiles.find((t) => {
            const sides = RummikubGrid.tileConnectedSides(t, tiles.filter((o) => o.id !== t.id));
            return !sides.left && !sides.right && !sides.top && !sides.bottom;
        }) || tiles[0];
        const layout = g._tileElLayout(isolated);
        const faceW = RummikubRules.TILE_W;
        const faceH = RummikubRules.TILE_H;
        const expandW = layout.width - faceW;
        const expandH = layout.height - faceH;
        if (!mobile) {
            return {
                ok: expandW < 1 && expandH < 1,
                mobile,
                expectMobileLayout,
                expandW,
                expandH,
                layout
            };
        }
        const sides = RummikubGrid.tileConnectedSides(isolated, tiles.filter((o) => o.id !== isolated.id));
        const openCount = ['left', 'right', 'top', 'bottom'].filter((k) => !sides[k]).length;
        const expectedW = faceW + (sides.left ? 0 : pad) + (sides.right ? 0 : pad);
        const expectedH = faceH + (sides.top ? 0 : pad) + (sides.bottom ? 0 : pad);
        return {
            ok: Math.abs(layout.width - expectedW) < 2 && Math.abs(layout.height - expectedH) < 2,
            mobile,
            expectMobileLayout,
            pad,
            sides,
            openCount,
            layout,
            expected: { w: expectedW, h: expectedH }
        };
    }, expectMobile);
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * L-corner drop must not overlap existing table tiles.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertCornerDropNoOverlap(frame, label = 'corner-no-overlap') {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        if (table.length < 2) return { ok: false, reason: 'need-table-pair' };
        const a = table[0];
        const b = table.find((t) => t.id !== a.id && t.y === a.y) || table[1];
        const probe = {
            id: '__corner-probe__',
            kind: 'number',
            color: 'B',
            value: 1,
            x: b.x + 34,
            y: a.y + 34,
            zone: 'table'
        };
        const resolved = RummikubGrid.resolveTablePosition(probe, table, origin, {
            autoInsert: g.autoInsert !== false
        });
        const overlaps = table.some((t) =>
            RummikubGrid.tilesOverlapAt(resolved.x, resolved.y, t.x, t.y));
        return {
            ok: !overlaps,
            overlaps,
            probe: { x: probe.x, y: probe.y },
            resolved: { x: resolved.x, y: resolved.y }
        };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Auto-insert places a tile dropped in a one-tile gap between neighbors.
 * @param {import('playwright').Frame} frame
 * @param {boolean} enabled
 * @param {string} [label]
 */
async function assertAutoInsert(frame, enabled, label = 'auto-insert') {
    const result = await frame.evaluate((wantEnabled) => {
        const g = window.game;
        g.setAutoInsert(wantEnabled);
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        if (!table.length) return { ok: false, reason: 'no-table' };
        const left = table[0];
        const right = {
            id: '__gap-right__',
            kind: 'number',
            color: 'R',
            value: 2,
            x: left.x + RummikubRules.TILE_W + RummikubRules.TILE_GAP,
            y: left.y,
            zone: 'table',
            gridX: (left.gridX ?? 0) + 2,
            gridY: left.gridY ?? 0
        };
        const pair = [left, right];
        const slotX = left.x + RummikubRules.TILE_W;
        const drop = {
            id: '__gap-drop__',
            kind: 'number',
            color: 'U',
            value: 3,
            x: slotX + 4,
            y: left.y + 4,
            zone: 'table'
        };
        const resolved = RummikubGrid.resolveTablePosition(drop, pair, origin, {
            autoInsert: g.autoInsert !== false
        });
        const inserted = resolved.x === slotX && resolved.y === left.y;
        const overlaps = pair.some((t) =>
            RummikubGrid.tilesOverlapAt(resolved.x, resolved.y, t.x, t.y));
        if (wantEnabled) {
            return {
                ok: inserted && resolved.autoInsert && !overlaps,
                wantEnabled,
                inserted,
                overlaps,
                resolved
            };
        }
        return {
            ok: !resolved.autoInsert,
            wantEnabled,
            resolved
        };
    }, enabled);
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Table melds spawn as separate islands, not one connected blob.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertTableMeldsDisconnected(frame, label = 'table-melds-disconnected') {
    const result = await frame.evaluate(() => {
        const table = (window.game?.tiles || []).filter((t) => t.zone === 'table');
        if (table.length < 6) return { ok: false, reason: 'need-table-tiles' };
        const components = RummikubGrid.countConnectedComponents(table);
        const minComponents = Math.max(3, Math.floor(table.length / 8));
        return {
            ok: components >= minComponents,
            table: table.length,
            components,
            minComponents
        };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Isolated table drop keeps the tile exactly where it landed (no grid snap).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertIsolatedDropExactPosition(frame, label = 'isolated-drop-exact') {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const rack = (g.tiles || []).find((t) => t.zone === 'rack');
        if (!rack) return { ok: false, reason: 'no-rack-tile' };
        const others = g.tiles.filter((t) => t.id !== rack.id);
        const dropTries = [
            [g.ORIGIN + 380, g.ORIGIN - 240],
            [g.ORIGIN - 380, g.ORIGIN - 240],
            [g.ORIGIN + 320, g.ORIGIN - 160],
            [g.ORIGIN - 320, g.ORIGIN - 120]
        ];
        let dropX = null;
        let dropY = null;
        for (const [x, y] of dropTries) {
            const probe = { ...rack, x, y, zone: 'table' };
            const snap = RummikubGrid.snapTilePosition(probe, others);
            if (snap.snapped) continue;
            if (RummikubGrid.tileOverlapsAny(x, y, others)) continue;
            dropX = x;
            dropY = y;
            break;
        }
        if (dropX == null) return { ok: false, reason: 'no-isolated-slot' };

        const wantX = Math.round(dropX);
        const wantY = Math.round(dropY);
        const resolved = RummikubGrid.resolveTablePosition(
            { ...rack, x: dropX, y: dropY, zone: 'table' },
            others,
            origin,
            { autoInsert: g.autoInsert !== false }
        );
        const gridExact = Math.abs(resolved.x - wantX) < 1
            && Math.abs(resolved.y - wantY) < 1
            && resolved.gridX == null
            && resolved.gridY == null
            && !resolved.snapped;

        const before = { x: rack.x, y: rack.y, zone: rack.zone };
        rack.x = dropX;
        rack.y = dropY;
        rack.zone = 'table';
        g._commitTilePositions([{ tile: rack, el: null }]);
        const live = g.tiles.find((t) => t.id === rack.id);
        const commitExact = live
            && Math.abs(live.x - wantX) < 1
            && Math.abs(live.y - wantY) < 1
            && live.gridX == null
            && live.gridY == null;

        rack.x = before.x;
        rack.y = before.y;
        rack.zone = before.zone;
        if (live) {
            live.x = before.x;
            live.y = before.y;
            live.zone = before.zone;
            live.gridX = null;
            live.gridY = null;
        }

        return {
            ok: gridExact && commitExact,
            gridExact,
            commitExact,
            want: { x: wantX, y: wantY },
            resolved: { x: resolved.x, y: resolved.y, gridX: resolved.gridX, gridY: resolved.gridY },
            live: live ? { x: live.x, y: live.y, gridX: live.gridX, gridY: live.gridY } : null
        };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Marquee group drop keeps relative offsets and skips grid snap when isolated.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertGroupDragCohesion(frame, label = 'group-drag-cohesion') {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        const step = RummikubRules.TILE_GAP;
        const a = table.find((t) =>
            table.some((o) => o.id !== t.id && o.y === t.y && o.x === t.x + step));
        if (!a) return { ok: false, reason: 'no-horizontal-pair' };
        const b = table.find((o) => o.id !== a.id && o.y === a.y && o.x === a.x + step);
        const dx0 = b.x - a.x;
        const dy0 = b.y - a.y;
        const others = g.tiles.filter((t) => t.id !== a.id && t.id !== b.id);
        const dropTries = [
            [g.ORIGIN + 360, g.ORIGIN - 220],
            [g.ORIGIN - 360, g.ORIGIN - 220],
            [g.ORIGIN + 300, g.ORIGIN - 120]
        ];
        let resolved = null;
        let ra = null;
        let rb = null;
        for (const [cx, cy] of dropTries) {
            const preSnap = RummikubGrid.snapTilePosition({ ...a, x: cx, y: cy }, others);
            if (preSnap.snapped) continue;
            const members = [
                { ...a, x: cx, y: cy },
                { ...b, x: cx + dx0, y: cy + dy0 }
            ];
            resolved = RummikubGrid.resolveGroupDrop(members, others, origin, {
                autoInsert: g.autoInsert !== false
            });
            ra = resolved.find((t) => t.id === a.id);
            rb = resolved.find((t) => t.id === b.id);
            const dx1 = rb.x - ra.x;
            const dy1 = rb.y - ra.y;
            const offsetKept = Math.abs(dx1 - dx0) < 1 && Math.abs(dy1 - dy0) < 1;
            if (offsetKept && !resolved[0]?.snapped) break;
        }
        if (!resolved || !ra || !rb) {
            return { ok: false, reason: 'no-isolated-drop' };
        }
        const dx1 = rb.x - ra.x;
        const dy1 = rb.y - ra.y;
        const offsetKept = Math.abs(dx1 - dx0) < 1 && Math.abs(dy1 - dy0) < 1;
        return {
            ok: offsetKept && !resolved[0]?.snapped,
            offsetKept,
            snapped: resolved[0]?.snapped,
            dx0,
            dx1,
            dy0,
            dy1,
            pos: { x: ra.x, y: ra.y }
        };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Single tile snaps horizontally left or right of an isolated table tile (real drag).
 * @param {import('playwright').Frame} frame
 * @param {'left' | 'right'} side
 * @param {string} [label]
 */
async function assertSingleTileHorizontalSnap(frame, side, label) {
    const setup = await frame.evaluate(({ snapSide, approachPx, findAnchorSrc }) => {
        const g = window.game;
        const findAnchor = new Function(`return (${findAnchorSrc})`)();
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        const rack = (g.tiles || []).find((t) => t.zone === 'rack');
        const anchor = findAnchor(table, snapSide);
        if (!anchor || !rack) return { ok: false, reason: 'missing-tiles' };
        const slot = RummikubGrid.alignedSnapPos(anchor, snapSide);
        return {
            ok: true,
            rackId: rack.id,
            anchorId: anchor.id,
            drop: { x: slot.x + approachPx, y: slot.y + 3 },
            want: { x: slot.x, y: slot.y },
            anchor: { x: anchor.x, y: anchor.y },
            side: snapSide
        };
    }, { snapSide: side, approachPx: APPROACH_PX, findAnchorSrc: findHorizSnapAnchor.toString() });
    if (!setup.ok) throw new Error(`${label}: ${JSON.stringify(setup)}`);

    const drag = await realDragTile(frame, setup.rackId, setup.drop.x, setup.drop.y);
    if (!drag.ok || !drag.moved) {
        throw new Error(`${label}: drag failed (${JSON.stringify(drag)})`);
    }

    const result = await frame.evaluate(({ rackId, anchorId, snapSide, want }) => {
        const tile = window.game.tiles.find((t) => t.id === rackId);
        const anchor = window.game.tiles.find((t) => t.id === anchorId);
        if (!tile || !anchor) return { ok: false, reason: 'tiles-missing' };
        const hStep = RummikubRules.TILE_GAP;
        const horiz = snapSide === 'right'
            ? tile.x === anchor.x + hStep && tile.y === anchor.y
            : tile.x === anchor.x - hStep && tile.y === anchor.y;
        const snapped = tile.x === want.x && tile.y === want.y;
        const overlaps = RummikubGrid.tilesOverlapAt(tile.x, tile.y, anchor.x, anchor.y);
        return {
            ok: tile.zone === 'table' && snapped && horiz && !overlaps,
            side: snapSide,
            snapped,
            horiz,
            overlaps,
            want,
            resolved: { x: tile.x, y: tile.y, zone: tile.zone },
            anchor: { x: anchor.x, y: anchor.y }
        };
    }, {
        rackId: setup.rackId,
        anchorId: setup.anchorId,
        snapSide: side,
        want: setup.want
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Marquee group snaps horizontally left or right of an external tile.
 * @param {import('playwright').Frame} frame
 * @param {'left' | 'right'} side
 * @param {string} [label]
 * @param {{ warnOnly?: boolean }} [opts]
 */
async function assertGroupHorizontalSnap(frame, side, label, opts = {}) {
    const setup = await frame.evaluate(({ snapSide, approachPx, findAnchorSrc }) => {
        const findAnchor = new Function(`return (${findAnchorSrc})`)();
        const g = window.game;
        g._setSelection([], false);
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        const step = RummikubRules.TILE_GAP;

        const externals = table.filter((t) => {
            const sides = RummikubGrid.tileConnectedSides(
                t,
                table.filter((o) => o.id !== t.id)
            );
            const blocked = snapSide === 'right' ? ['right', 'bottom'] : ['left', 'bottom'];
            return blocked.every((edge) => !sides[edge]);
        });

        for (const external of externals) {
            let left = null;
            let right = null;
            for (const a of table) {
                if (a.id === external.id || a.y !== external.y) continue;
                const b = table.find((o) => o.id !== a.id && o.id !== external.id
                    && o.y === a.y && Math.abs(o.x - a.x) === step);
                if (!b) continue;
                const candLeft = a.x <= b.x ? a : b;
                const candRight = a.x <= b.x ? b : a;
                if (RummikubGrid.tilesTouchHorizontal(candLeft, external)
                    || RummikubGrid.tilesTouchHorizontal(candRight, external)) {
                    continue;
                }
                left = candLeft;
                right = candRight;
                break;
            }
            if (!left || !right) continue;

            const dx0 = right.x - left.x;
            const slot = RummikubGrid.alignedSnapPos(external, snapSide);
            let dropLeft;
            if (snapSide === 'right') {
                dropLeft = { x: slot.x + approachPx, y: slot.y + 3 };
            } else {
                dropLeft = { x: slot.x + approachPx - dx0, y: slot.y + 3 };
            }
            g._setSelection([left.id, right.id], true);
            return {
                ok: true,
                dragId: left.id,
                leftId: left.id,
                rightId: right.id,
                externalId: external.id,
                drop: dropLeft,
                dx0,
                side: snapSide,
                external: { x: external.x, y: external.y },
                pairY: left.y,
                slot
            };
        }
        return { ok: false, reason: 'no-pair' };
    }, { snapSide: side, approachPx: APPROACH_PX, findAnchorSrc: findHorizSnapAnchor.toString() });
    if (!setup.ok) {
        if (opts.warnOnly) return { warn: true, label, result: setup };
        throw new Error(`${label}: ${JSON.stringify(setup)}`);
    }

    const drag = await realDragTile(frame, setup.dragId, setup.drop.x, setup.drop.y);
    if (!drag.ok || !drag.moved) {
        if (opts.warnOnly) return { warn: true, label, result: drag };
        throw new Error(`${label}: drag failed (${JSON.stringify(drag)})`);
    }

    const result = await frame.evaluate(({ leftId, rightId, externalId, snapSide, dx0 }) => {
        const tiles = window.game.tiles;
        const rLeft = tiles.find((t) => t.id === leftId);
        const rRight = tiles.find((t) => t.id === rightId);
        const external = tiles.find((t) => t.id === externalId);
        if (!rLeft || !rRight || !external) return { ok: false, reason: 'tiles-missing' };
        const touch = [rLeft, rRight].find((t) => RummikubGrid.tilesTouchHorizontal(t, external));
        const hStep = RummikubRules.TILE_GAP;
        const horiz = touch && (
            snapSide === 'right'
                ? touch.x === external.x + hStep && touch.y === external.y
                : touch.x === external.x - hStep && touch.y === external.y
        );
        const offsetKept = Math.abs((rRight.x - rLeft.x) - dx0) < 1;
        return {
            ok: !!touch && horiz && offsetKept,
            side: snapSide,
            horiz,
            offsetKept,
            touch: touch ? { x: touch.x, y: touch.y, zone: touch.zone } : null,
            external: { x: external.x, y: external.y },
            left: { x: rLeft.x, y: rLeft.y },
            right: { x: rRight.x, y: rRight.y }
        };
    }, {
        leftId: setup.leftId,
        rightId: setup.rightId,
        externalId: setup.externalId,
        snapSide: side,
        dx0: setup.dx0
    });
    if (!result.ok) {
        if (opts.warnOnly) return { warn: true, label, result };
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    await frame.evaluate(() => {
        window.game._setSelection([], false);
    });
    return result;
}

/**
 * Group snaps as one piece when dropped beside a tile outside the selection (right).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertGroupSnapToExternal(frame, label = 'group-snap-external') {
    return assertGroupHorizontalSnap(frame, 'right', label);
}

/**
 * Dropping directly on another tile must never leave an overlap.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertStackingDropNoOverlap(frame, label = 'stacking-no-overlap') {
    const setup = await frame.evaluate(() => {
        const g = window.game;
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        const rack = (g.tiles || []).find((t) => t.zone === 'rack');
        const anchor = table[0];
        if (!anchor || !rack) return { ok: false, reason: 'missing-tiles' };
        return {
            ok: true,
            rackId: rack.id,
            anchorId: anchor.id,
            drop: { x: anchor.x + 6, y: anchor.y + 4 },
            anchor: { x: anchor.x, y: anchor.y }
        };
    });
    if (!setup.ok) throw new Error(`${label}: ${JSON.stringify(setup)}`);

    const drag = await realDragTile(frame, setup.rackId, setup.drop.x, setup.drop.y);
    if (!drag.ok || !drag.moved) {
        throw new Error(`${label}: drag failed (${JSON.stringify(drag)})`);
    }

    const result = await frame.evaluate(({ rackId, anchorId }) => {
        const tile = window.game.tiles.find((t) => t.id === rackId);
        const anchor = window.game.tiles.find((t) => t.id === anchorId);
        if (!tile || !anchor) return { ok: false, reason: 'tiles-missing' };
        const overlaps = RummikubGrid.tilesOverlapAt(tile.x, tile.y, anchor.x, anchor.y);
        const adjacent = RummikubGrid.tilesTouch(tile, anchor);
        return {
            ok: !overlaps,
            overlaps,
            adjacent,
            anchor: { x: anchor.x, y: anchor.y },
            resolved: { x: tile.x, y: tile.y, zone: tile.zone }
        };
    }, { rackId: setup.rackId, anchorId: setup.anchorId });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Left-edge snap must target table tiles, not closer rack decoys.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertLeftSnapIgnoresRack(frame, label = 'left-snap-ignores-rack') {
    const setup = await frame.evaluate(({ approachPx, findAnchorSrc }) => {
        const g = window.game;
        const findAnchor = new Function(`return (${findAnchorSrc})`)();
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        const rack = (g.tiles || []).filter((t) => t.zone === 'rack');
        const anchor = findAnchor(table, 'left');
        if (!anchor || !rack.length) return { ok: false, reason: 'missing-tiles' };
        const leftPos = RummikubGrid.alignedSnapPos(anchor, 'left');
        const dragTile = rack[rack.length - 1];
        return {
            ok: true,
            rackId: dragTile.id,
            anchorId: anchor.id,
            drop: { x: leftPos.x + approachPx, y: leftPos.y + 4 },
            want: { x: leftPos.x, y: leftPos.y },
            leftPos,
            anchor: { x: anchor.x, y: anchor.y },
            decoy: { x: rack[0].x, y: rack[0].y }
        };
    }, { approachPx: APPROACH_PX, findAnchorSrc: findHorizSnapAnchor.toString() });
    if (!setup.ok) throw new Error(`${label}: ${JSON.stringify(setup)}`);

    const drag = await realDragTile(frame, setup.rackId, setup.drop.x, setup.drop.y);
    if (!drag.ok || !drag.moved) {
        throw new Error(`${label}: drag failed (${JSON.stringify(drag)})`);
    }

    const result = await frame.evaluate(({ rackId, want }) => {
        const tile = window.game.tiles.find((t) => t.id === rackId);
        if (!tile) return { ok: false, reason: 'tile-missing' };
        const snapped = tile.x === want.x && tile.y === want.y;
        return {
            ok: tile.zone === 'table' && snapped,
            snapped,
            want,
            resolved: { x: tile.x, y: tile.y, zone: tile.zone }
        };
    }, { rackId: setup.rackId, want: setup.want });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

function tapTile(frame, tileId, pointerType = 'mouse') {
    return frame.evaluate(({ tileId, pointerType }) => {
        const node = document.querySelector(`[data-tile-id="${tileId}"]`);
        if (!node) return { ok: false, reason: 'no-node' };
        const r = node.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const mk = (type) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        node.dispatchEvent(mk('pointerdown'));
        node.dispatchEvent(mk('pointerup'));
        window.game?.requestRender?.();
        return { ok: true, tileId };
    }, { tileId, pointerType });
}

/**
 * Tap a tile in a touch-connected pair of melds — selects only its own meld.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertTapSelectsConnectedSubMeld(frame, label = 'tap-sub-meld') {
    const setup = await frame.evaluate(() => {
        const g = window.game;
        const Core = RummikubCore;
        const step = RummikubRules.TILE_GAP;
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const boardSnap = (g.tiles || []).map((t) => ({
            id: t.id,
            x: t.x,
            y: t.y,
            gridX: t.gridX,
            gridY: t.gridY,
            zone: t.zone
        }));
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        const core = (tiles) => tiles.map((t) => g._coreTile(t));

        function isHorizontal(tiles) {
            return tiles.every((t) => Math.abs(t.y - tiles[0].y) <= 8);
        }

        function horizMeldFromCluster(cluster) {
            const byX = [...cluster].sort((a, b) => a.x - b.x);
            if (byX.length < 3 || !isHorizontal(byX)) return null;
            for (let i = 1; i < byX.length; i++) {
                if (byX[i].x !== byX[i - 1].x + step) return null;
            }
            if (Core.isValidMeld({ kind: 'run', tiles: core(byX) })) return byX;
            const byColor = [...byX].sort((a, b) => {
                const ac = a.color || 'Z';
                const bc = b.color || 'Z';
                return ac.localeCompare(bc);
            });
            if (Core.isValidMeld({ kind: 'group', tiles: core(byColor) })) return byX;
            return null;
        }

        const islands = RummikubGrid.extractTouchClusters(table);
        let melds = islands.map(horizMeldFromCluster).filter(Boolean);

        if (melds.length < 2) {
            const meldA = melds[0];
            if (!meldA) return { ok: false, reason: 'need-one-meld', boardSnap };
            const rack = (g.tiles || []).filter((t) => t.zone === 'rack');
            let built = null;
            outer: for (let i = 0; i < rack.length - 2; i++) {
                for (let j = i + 1; j < rack.length - 1; j++) {
                    for (let k = j + 1; k < rack.length; k++) {
                        const trio = [rack[i], rack[j], rack[k]].sort((a, b) => a.value - b.value);
                        if (Core.isValidMeld({ kind: 'run', tiles: core(trio) })) {
                            built = trio;
                            break outer;
                        }
                    }
                }
            }
            if (!built) return { ok: false, reason: 'need-two-melds', boardSnap };
            melds = [meldA, built];
        }

        const runA = melds[0];
        const runB = melds[1];
        runB.forEach((t, idx) => {
            t.zone = 'table';
            t.x = runA[runA.length - 1].x + step + idx * step;
            t.y = runA[0].y;
            const cell = RummikubGrid.worldToCell(t.x, t.y, origin);
            t.gridX = cell.gx;
            t.gridY = cell.gy;
        });
        g._syncAllTileElements?.();
        g._setSelection([], false);
        return {
            ok: true,
            tapId: runA[0].id,
            expectIds: runA.map((t) => t.id),
            rejectIds: runB.map((t) => t.id),
            boardSnap
        };
    });
    if (!setup.ok) throw new Error(`${label}: ${JSON.stringify(setup)}`);

    await tapTile(frame, setup.tapId);

    const result = await frame.evaluate(({ expectIds, rejectIds, boardSnap }) => {
        const g = window.game;
        const selected = [...(g._selectedIds || [])];
        const hasAll = expectIds.every((id) => selected.includes(id));
        const hasExtra = rejectIds.some((id) => selected.includes(id));
        const out = {
            ok: g._selectionHighlight && selected.length === expectIds.length && hasAll && !hasExtra,
            selected,
            expectIds,
            rejectIds
        };
        boardSnap.forEach((snap) => {
            const live = g.tiles.find((t) => t.id === snap.id);
            if (live) Object.assign(live, snap);
        });
        g._setSelection([], false);
        g._syncAllTileElements?.();
        g.requestRender?.();
        return out;
    }, {
        expectIds: setup.expectIds,
        rejectIds: setup.rejectIds,
        boardSnap: setup.boardSnap
    });
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result)}`);
    return result;
}

/**
 * Mobile: one-motion background drag pans (no tap dwell → not marquee).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertMobileFluidBackgroundPan(frame, label = 'mobile-fluid-pan') {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer');
        if (!g || !surface) return { ok: false, reason: 'missing-setup' };

        g._setSelection([], false);
        const before = { x: g.canvasPanX || 0, y: g.canvasPanY || 0 };
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 12,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const x0 = r.left + 40;
        const y0 = r.top + 40;
        const x1 = r.left + 180;
        const y1 = r.top + 160;
        surface.dispatchEvent(mk('pointerdown', x0, y0));
        surface.dispatchEvent(mk('pointermove', x1, y1));
        surface.dispatchEvent(mk('pointerup', x1, y1));
        const after = { x: g.canvasPanX || 0, y: g.canvasPanY || 0 };
        const dist = Math.hypot(after.x - before.x, after.y - before.y);
        return {
            ok: dist >= 20 && !g._mobileMarqueeActive,
            dist,
            before,
            after
        };
    });
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result)}`);
    return result;
}

/**
 * Mobile: tap empty board clears selection (surface, canvas, slight jitter).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertMobileTapClearsSelection(frame, label = 'mobile-tap-clear') {
    const result = await frame.evaluate(async () => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer');
        const canvas = document.getElementById('board-canvas');
        const tableTile = (g.tiles || []).find((t) => t.zone === 'table');
        if (!g || !surface || !canvas || !tableTile) {
            return { ok: false, reason: 'missing-setup' };
        }

        const mk = (type, x, y, pointerId) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const cases = [];

        const runTap = (target, x, y, pointerId, jitterUp) => {
            g._setSelection([tableTile.id], true);
            target.dispatchEvent(mk('pointerdown', x, y, pointerId));
            if (jitterUp) {
                target.dispatchEvent(mk('pointerup', x + jitterUp.dx, y + jitterUp.dy, pointerId));
            } else {
                target.dispatchEvent(mk('pointerup', x, y, pointerId));
            }
            const cleared = !g._selectionHighlight && (g._selectedIds?.size || 0) === 0;
            cases.push({
                target: target.className || target.id,
                cleared,
                selected: [...(g._selectedIds || [])]
            });
            return cleared;
        };

        const sr = surface.getBoundingClientRect();
        const cr = canvas.getBoundingClientRect();
        const okSurface = runTap(surface, sr.left + 36, sr.top + 36, 13);
        const okCanvas = runTap(canvas, cr.left + 24, cr.top + 24, 14);
        const okJitter = runTap(surface, sr.left + 52, sr.top + 52, 15, { dx: 3, dy: -2 });

        return {
            ok: okSurface && okCanvas && okJitter,
            cases
        };
    });
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result)}`);
    return result;
}

/**
 * Mobile: hold on background then drag must not pan the viewport.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertMobileMarqueeBlocksPan(frame, label = 'mobile-marquee-pan-block') {
    const result = await frame.evaluate(async (holdMs) => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer');
        if (!g || !surface) return { ok: false, reason: 'missing-setup' };

        g._setSelection([], false);
        if (typeof g._cancelViewportPan === 'function') g._cancelViewportPan();
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y, pointerId = 9) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const x0 = r.left + 40;
        const y0 = r.top + 40;
        const x1 = r.left + 180;
        const y1 = r.top + 160;
        surface.dispatchEvent(mk('pointerdown', x0, y0));
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        const before = { x: g.canvasPanX || 0, y: g.canvasPanY || 0 };
        for (let i = 1; i <= 8; i++) {
            const t = i / 8;
            surface.dispatchEvent(mk(
                'pointermove',
                x0 + (x1 - x0) * t,
                y0 + (y1 - y0) * t
            ));
        }
        surface.dispatchEvent(mk('pointerup', x1, y1));
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        const after = { x: g.canvasPanX || 0, y: g.canvasPanY || 0 };
        const dist = Math.hypot(after.x - before.x, after.y - before.y);
        return {
            ok: !!g._bgGestureWasMarquee && dist < 40,
            dist,
            wasMarquee: !!g._bgGestureWasMarquee,
            before,
            after,
            marqueeActive: !!g._mobileMarqueeActive
        };
    }, MOBILE_MARQUEE_HOLD_MS);
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result)}`);
    await frame.evaluate(() => {
        window.game._setSelection([], false);
    });
    return result;
}

/**
 * Mobile: hold empty board + drag to marquee-select tiles.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertMobileMarqueeSelection(frame, label = 'mobile-marquee') {
    const setup = await frame.evaluate(() => {
        const g = window.game;
        const table = (g.tiles || []).filter((t) => t.zone === 'table');
        if (table.length < 4) return { ok: false, reason: 'need-table-tiles' };
        g._setSelection([], false);
        return { ok: true, tableCount: table.length };
    });
    if (!setup.ok) throw new Error(`${label}: ${JSON.stringify(setup)}`);

    const drag = await frame.evaluate(async (holdMs) => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer');
        const nodes = [...document.querySelectorAll('.tile')].filter((n) => n.dataset.tileId);
        if (!surface || nodes.length < 3) return { ok: false, reason: 'need-tiles' };

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        nodes.forEach((n) => {
            const b = n.getBoundingClientRect();
            minX = Math.min(minX, b.left);
            minY = Math.min(minY, b.top);
            maxX = Math.max(maxX, b.right);
            maxY = Math.max(maxY, b.bottom);
        });
        const pad = 12;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 11,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const x0 = minX - pad;
        const y0 = minY - pad;
        const x1 = maxX + pad;
        const y1 = maxY + pad;
        surface.dispatchEvent(mk('pointerdown', x0, y0));
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        for (let i = 1; i <= 8; i++) {
            const t = i / 8;
            surface.dispatchEvent(mk(
                'pointermove',
                x0 + (x1 - x0) * t,
                y0 + (y1 - y0) * t
            ));
        }
        surface.dispatchEvent(mk('pointerup', x1, y1));
        g.requestRender?.();
        await new Promise((r) => requestAnimationFrame(r));
        return {
            ok: true,
            selected: [...(g._selectedIds || [])],
            highlighted: !!g._selectionHighlight,
            wasMarquee: !!g._bgGestureWasMarquee
        };
    }, MOBILE_MARQUEE_HOLD_MS);
    if (!drag.ok) throw new Error(`${label}: ${JSON.stringify(drag)}`);
    if (!drag.wasMarquee || !drag.highlighted || drag.selected.length < 2) {
        throw new Error(`${label}: expected hold+drag marquee (${JSON.stringify(drag)})`);
    }
    await frame.evaluate(() => {
        window.game._setSelection([], false);
        window.game.requestRender?.();
    });
    return drag;
}

/**
 * Mobile: quick pan then hold+drag marquee still works (no stuck hold state).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertMobileMarqueeAfterPan(frame, label = 'mobile-marquee-after-pan') {
    const result = await frame.evaluate(async (holdMs) => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer');
        const nodes = [...document.querySelectorAll('.tile')].filter((n) => n.dataset.tileId);
        if (!g || !surface || nodes.length < 3) return { ok: false, reason: 'missing-setup' };

        g._setSelection([], false);
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y, pointerId = 16) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const x0 = r.left + 40;
        const y0 = r.top + 40;
        const x1 = r.left + 180;
        const y1 = r.top + 160;

        // Quick pan swipe (no hold)
        surface.dispatchEvent(mk('pointerdown', x0, y0));
        surface.dispatchEvent(mk('pointermove', x1, y1));
        surface.dispatchEvent(mk('pointerup', x1, y1));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const panDist = Math.hypot((g.canvasPanX || 0), (g.canvasPanY || 0));

        // Hold + drag marquee
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        nodes.forEach((n) => {
            const b = n.getBoundingClientRect();
            minX = Math.min(minX, b.left);
            minY = Math.min(minY, b.top);
            maxX = Math.max(maxX, b.right);
            maxY = Math.max(maxY, b.bottom);
        });
        const pad = 12;
        const mx0 = minX - pad;
        const my0 = minY - pad;
        const mx1 = maxX + pad;
        const my1 = maxY + pad;
        surface.dispatchEvent(mk('pointerdown', mx0, my0, 17));
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        for (let i = 1; i <= 8; i++) {
            const t = i / 8;
            surface.dispatchEvent(mk(
                'pointermove',
                mx0 + (mx1 - mx0) * t,
                my0 + (my1 - my0) * t,
                17
            ));
        }
        surface.dispatchEvent(mk('pointerup', mx1, my1, 17));
        g.requestRender?.();

        return {
            ok: panDist >= 20
                && !!g._bgGestureWasMarquee
                && g._selectedIds?.size >= 2
                && !g._mobileMarqueeHoldPending
                && !g._mobileMarqueeHoldArmed,
            panDist,
            wasMarquee: !!g._bgGestureWasMarquee,
            selected: [...(g._selectedIds || [])],
            holdPending: !!g._mobileMarqueeHoldPending,
            holdArmed: !!g._mobileMarqueeHoldArmed
        };
    }, MOBILE_MARQUEE_HOLD_MS);
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result)}`);
    return result;
}

/**
 * Mobile: pinch / second finger must not start marquee.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertMobilePinchSkipsMarquee(frame, label = 'mobile-pinch-no-marquee') {
    const result = await frame.evaluate(async (holdMs) => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer');
        if (!g || !surface) return { ok: false, reason: 'missing-setup' };

        g._setSelection([], false);
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y, pointerId) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const x = r.left + 48;
        const y = r.top + 48;

        g._pinchActive = true;
        surface.dispatchEvent(mk('pointerdown', x, y, 20));
        const pinchBlocked = !g._mobileMarqueeHoldPending && !g._mobileMarqueeActive;
        surface.dispatchEvent(mk('pointerup', x, y, 20));
        g._pinchActive = false;

        surface.dispatchEvent(mk('pointerdown', x, y, 21));
        surface.dispatchEvent(mk('pointerdown', x + 8, y + 8, 22));
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        const multiBlocked = !g._mobileMarqueeActive;
        surface.dispatchEvent(mk('pointerup', x + 8, y + 8, 22));
        surface.dispatchEvent(mk('pointerup', x, y, 21));

        return { ok: pinchBlocked && multiBlocked, pinchBlocked, multiBlocked };
    }, MOBILE_MARQUEE_HOLD_MS);
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result)}`);
    return result;
}

module.exports = {
    realDragTile,
    assertTileFaceThemeColor,
    assertNoOverlappingTiles,
    assertTableTilesGridAligned,
    assertAdjacentTileSnap,
    assertStackingDropNoOverlap,
    assertLeftSnapIgnoresRack,
    assertSelectionHitExpand,
    assertCornerDropNoOverlap,
    assertAutoInsert,
    assertTableMeldsDisconnected,
    assertIsolatedDropExactPosition,
    assertGroupDragCohesion,
    assertGroupSnapToExternal,
    assertSingleTileHorizontalSnap,
    assertGroupHorizontalSnap,
    assertTapSelectsConnectedSubMeld,
    assertMobileFluidBackgroundPan,
    assertMobileTapClearsSelection,
    assertMobileMarqueeBlocksPan,
    assertMobileMarqueeSelection,
    assertMobileMarqueeAfterPan,
    assertMobilePinchSkipsMarquee
};

