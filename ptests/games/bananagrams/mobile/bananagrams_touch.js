/**
 * Touch helpers for Bananagrams mobile Playwright audits.
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { getGameFrame } = require('../../../shared/platform/game-harness');

const TOUCH = 'touch';
const DOUBLE_TAP_GAP_MS = 80;
const HOLD_DUMP_MS = 480;

function pointerOpts(type = TOUCH) {
    return { pointerType: type, button: 0 };
}

/** Face-down rack: class + letters not visible (transparent text), matching desktop audit. */
async function assertFaceDownRack(frame, label = 'rack') {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const tiles = [...document.querySelectorAll('.tile')];
        if (!tiles.length) return { ok: false, reason: 'no-tiles' };
        const bad = [];
        tiles.forEach((t) => {
            const face = t.querySelector('.tile-face');
            if (!t.classList.contains('is-face-down')) {
                bad.push({ id: t.dataset.tileId, reason: 'not-face-down-class' });
                return;
            }
            if (!face) {
                bad.push({ id: t.dataset.tileId, reason: 'no-face' });
                return;
            }
            const cs = getComputedStyle(face);
            const color = cs.color;
            const hidden = color === 'rgba(0, 0, 0, 0)' || color === 'transparent';
            if (!hidden) {
                bad.push({ id: t.dataset.tileId, reason: 'letter-visible', color });
            }
        });
        const modelFaceDown = g?.tiles?.every((t) => !t.faceUp) ?? false;
        return {
            ok: !bad.length && !g?.gameStarted && modelFaceDown,
            bad: bad.slice(0, 3),
            count: tiles.length,
            gameStarted: !!g?.gameStarted
        };
    });
    if (!result.ok) {
        throw new Error(`Face-down ${label} expected (${JSON.stringify(result)})`);
    }
    return result;
}

async function assertBananagramsRackFitsViewport(page, opts = {}) {
    const ms = opts.ms ?? STEP_MS;
    const margin = opts.margin ?? 12;
    const minTiles = opts.minTiles ?? 7;
    await page.waitForFunction(({ need }) => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        return doc && doc.querySelectorAll('.tile').length >= need;
    }, { need: minTiles }, { timeout: ms });

    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return;
        win.FiveViewport?.applyMobileClass?.(true);
        if (typeof g.getZoomStorageKey === 'function') {
            localStorage.removeItem(g.getZoomStorageKey());
        }
        g._fitZoomInitialized = false;
        g.refreshMobileLayout?.();
        g.requestRender?.();
    });

    const fit = await page.evaluate((margin) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        if (!win || !doc) return { ok: false, reason: 'no-frame' };
        const vw = win.innerWidth;
        const vh = win.innerHeight;
        const tiles = [...doc.querySelectorAll('.tile')];
        if (!tiles.length) return { ok: false, reason: 'no-tiles' };
        const bad = [];
        tiles.forEach((t) => {
            const r = t.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) bad.push({ id: t.dataset.tileId, reason: 'tiny' });
            if (r.right < -margin || r.left > vw + margin || r.bottom < -margin || r.top > vh + margin) {
                bad.push({ id: t.dataset.tileId, left: r.left, top: r.top });
            }
        });
        return { ok: !bad.length, bad, count: tiles.length, vw, vh };
    }, margin);

    if (!fit.ok) {
        throw new Error(`Bananagrams rack should fit mobile viewport (${JSON.stringify(fit)})`);
    }
}

async function touchPanBackground(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer') || document.getElementById('board-canvas');
        if (!surface) return { ok: false, reason: 'no-surface' };
        const before = { x: g.canvasPanX, y: g.canvasPanY };
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 9,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const x0 = r.left + 48;
        const y0 = r.top + 48;
        const x1 = r.left + 200;
        const y1 = r.top + 160;
        surface.dispatchEvent(mk('pointerdown', x0, y0));
        surface.dispatchEvent(mk('pointermove', x1, y1));
        surface.dispatchEvent(mk('pointerup', x1, y1));
        const after = { x: g.canvasPanX, y: g.canvasPanY };
        const dist = Math.hypot(after.x - before.x, after.y - before.y);
        return {
            ok: dist >= 20,
            dist,
            panInit: !!g._viewportPanInit,
            viewportPanEnabled: g.capabilities?.viewportPanEnabled !== false
        };
    });
}

async function touchDragTile(frame, tileIndex = 0, dx = 80, dy = 60) {
    return frame.evaluate(({ idx, dx, dy }) => {
        const g = window.game;
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx];
        if (!node || !g) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const r = node.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const before = { x: tile.x, y: tile.y };
        node.dispatchEvent(mk('pointerdown', x0, y0));
        node.dispatchEvent(mk('pointermove', x0 + dx, y0 + dy));
        node.dispatchEvent(mk('pointerup', x0 + dx, y0 + dy));
        const after = { x: tile.x, y: tile.y };
        return {
            ok: true,
            id: tile.id,
            moved: Math.hypot(after.x - before.x, after.y - before.y) > 15,
            before,
            after
        };
    }, { idx: tileIndex, dx, dy });
}

/** Hold primary button on a tile without dragging — dump (+3). */
async function holdDump(frame, tileIndex = -1, holdMs = HOLD_DUMP_MS) {
    return frame.evaluate(async ({ idx, holdMs }) => {
        const g = window.game;
        g.beginGame?.();
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx < 0 ? nodes.length + idx : idx];
        if (!node) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const beforeIds = [...g.tiles.map((t) => t.id)];
        const poolBefore = g._tilePool.length;
        const r = node.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type) => new PointerEvent(type, {
            clientX: cx,
            clientY: cy,
            bubbles: true,
            pointerId: 1,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        node.dispatchEvent(mk('pointerdown'));
        await new Promise((res) => setTimeout(res, holdMs));
        node.dispatchEvent(mk('pointerup'));
        await new Promise((res) => requestAnimationFrame(res));
        return {
            ok: g.tiles.length === beforeIds.length + 2 && g._tilePool.length === poolBefore - 2,
            beforeIds,
            afterCount: g.tiles.length,
            poolAfter: g._tilePool.length
        };
    }, { idx: tileIndex, holdMs });
}

/** Left-edge swipe must not open hub settings (line + bananagrams disable this). */
async function assertSettingsEdgeSwipeDisabled(page) {
    const result = await page.evaluate(() => {
        const sidebar = document.getElementById('settings-sidebar');
        const wasOpen = sidebar?.classList.contains('open') ?? false;
        const edge = document.getElementById('mobile-settings-edge');
        if (!edge) return { ok: false, reason: 'no-edge' };
        const rect = edge.getBoundingClientRect();
        const x0 = rect.left + 8;
        const y0 = rect.top + rect.height / 2;
        const x1 = x0 + 120;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 7,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        edge.dispatchEvent(mk('pointerdown', x0, y0));
        edge.dispatchEvent(mk('pointermove', x1, y0));
        edge.dispatchEvent(mk('pointerup', x1, y0));
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        if (win) {
            win.postMessage({ type: 'open-settings-edge-swipe' }, '*');
        }
        const opened = sidebar?.classList.contains('open') && !wasOpen;
        return { ok: !opened, opened, wasOpen };
    });
    if (!result.ok) {
        throw new Error(`Settings edge swipe should be disabled (${JSON.stringify(result)})`);
    }
    return result;
}

/** Tap empty board — pan/focal must not jump back to default center. */
async function touchTapBackgroundStable(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer') || document.getElementById('board-canvas');
        if (!surface) return { ok: false, reason: 'no-surface' };
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 9,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const r = surface.getBoundingClientRect();
        const pan = async () => {
            const x0 = r.left + 60;
            const y0 = r.top + 60;
            const x1 = r.left + 220;
            const y1 = r.top + 180;
            surface.dispatchEvent(mk('pointerdown', x0, y0));
            surface.dispatchEvent(mk('pointermove', x1, y1));
            surface.dispatchEvent(mk('pointerup', x1, y1));
        };
        return pan().then(() => {
            const afterPan = { x: g.canvasPanX, y: g.canvasPanY };
            const focalAfterPan = g._viewportFocal ? { ...g._viewportFocal } : null;
            const distPan = Math.hypot(afterPan.x, afterPan.y);
            const tx = r.left + r.width * 0.55;
            const ty = r.top + r.height * 0.35;
            surface.dispatchEvent(mk('pointerdown', tx, ty));
            surface.dispatchEvent(mk('pointerup', tx, ty));
            const afterTap = { x: g.canvasPanX, y: g.canvasPanY };
            const jump = Math.hypot(afterTap.x - afterPan.x, afterTap.y - afterPan.y);
            return {
                ok: distPan >= 20 && jump < 12,
                distPan,
                jump,
                focalAfterPan,
                focalAfterTap: g._viewportFocal
            };
        });
    });
}

/** Drag a tile to world coords (triggers real drag commit + peel check). */
async function touchDragTileToWorld(frame, tileIndex, worldX, worldY) {
    return frame.evaluate(({ idx, worldX, worldY }) => {
        const g = window.game;
        const vp = window.GameViewport;
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx];
        if (!node || !vp) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const size = typeof BananaRules !== 'undefined' ? BananaRules.TILE_SIZE : 40;
        const end = vp.worldToClient(g, worldX + size / 2, worldY + size / 2);
        const r = node.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const before = { x: tile.x, y: tile.y };
        node.dispatchEvent(mk('pointerdown', x0, y0));
        for (let i = 1; i <= 10; i++) {
            const t = i / 10;
            const x = x0 + (end.x - x0) * t;
            const y = y0 + (end.y - y0) * t;
            document.dispatchEvent(mk('pointermove', x, y));
        }
        document.dispatchEvent(mk('pointerup', end.x, end.y));
        const after = { x: tile.x, y: tile.y };
        return {
            ok: true,
            id: tile.id,
            moved: Math.hypot(after.x - before.x, after.y - before.y) > 8,
            before,
            after
        };
    }, { idx: tileIndex, worldX, worldY });
}

/** Double-tap helper kept for future gestures — does not dump anymore. */
async function doubleTapDump(frame, tileIndex = -1) {
    return holdDump(frame, tileIndex);
}

/**
 * Peel draw must sit outside the crossword (min gap + not edge-snappable).
 * Mirrors desktop solo peel test (wouldSnapAt) and MP assertSpawnedAtViewportBottom.
 */
async function assertPeelSpawnClearance(frame, beforeIds, label = 'peel spawn') {
    const result = await frame.evaluate(({ idList, label: tag }) => {
        const g = window.game;
        const size = BananaRules.TILE_SIZE;
        const gap = BananaRules.TILE_GAP;
        const minGapTiles = BananaRules.SPAWN_MIN_GAP_FROM_ANCHOR;
        const minEdge = minGapTiles * gap;
        const minScore = minEdge * minEdge;
        const idSet = new Set(idList);
        const added = g.tiles.filter((t) => !idSet.has(t.id));
        const grid = g.tiles.filter((t) => idSet.has(t.id));
        if (!added.length) return { ok: false, reason: 'no-new-tiles', label: tag };

        const anchor = BananaRules.spawnAnchorTiles(grid, gap);
        const anchorBox = BananaRules.spawnAnchorBBox(anchor, size);
        const pad = BananaRules.spawnViewportPad();
        const bounds = g._getVisibleWorldBounds();
        const keys = new Set();

        for (const t of added) {
            if (t.x < bounds.left + pad || t.y < bounds.top + pad
                || t.x + size > bounds.right - pad || t.y + size > bounds.bottom - pad) {
                return { ok: false, reason: 'not-visible', tile: t, label: tag };
            }
            const key = BananaRules.tileCellKey(t.x, t.y, size);
            if (keys.has(key)) return { ok: false, reason: 'duplicate-cell', key, label: tag };
            keys.add(key);
            if (BananaGrid.wouldSnapAt(t.x, t.y, grid, size)) {
                return { ok: false, reason: 'snap-adjacent', tile: t, label: tag };
            }
            const px = t.x + size / 2;
            const py = t.y + size / 2;
            const score = BananaRules.distSqPointToRect(px, py, anchorBox);
            if (score < minScore) {
                return {
                    ok: false,
                    reason: 'too-close-to-crossword',
                    tile: t,
                    score,
                    minScore,
                    minGapTiles,
                    label: tag
                };
            }
            for (const o of grid) {
                if (BananaRules.tilesOverlap(t.x, t.y, o.x, o.y, size)) {
                    return { ok: false, reason: 'overlap-grid', tile: t, other: o, label: tag };
                }
            }
        }
        return {
            ok: true,
            added: added.map((t) => ({ id: t.id, letter: t.letter, x: t.x, y: t.y })),
            label: tag
        };
    }, { idList: beforeIds, label });
    if (!result.ok) {
        throw new Error(`${label} invalid (${JSON.stringify(result)})`);
    }
    return result;
}

/**
 * Four-tile hand on deal slots (peel grid script parity) — touch-drag each to crossword coords.
 */
async function preparePeelCrosswordTouchPlan(frame, placements) {
    return frame.evaluate((pts) => {
        const g = window.game;
        g.beginGame();
        g._bannerText = '';
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const opts = typeof g._rackLayoutOptions === 'function'
            ? g._rackLayoutOptions()
            : {
                cols: BananaRules.COLS,
                gap: BananaRules.TILE_GAP,
                tileSize: BananaRules.TILE_SIZE,
                handBelowCenter: BananaRules.HAND_BELOW_CENTER,
                handSize: pts.length
            };
        const slots = BananaGrid.computeDealSlots(origin, opts);
        g.tiles = pts.map((p, i) => ({
            id: `t-${i}`,
            letter: p.letter,
            x: slots[i].x,
            y: slots[i].y,
            faceUp: true
        }));
        g.requestRender();
        const moves = pts.map((p, i) => ({ idx: i, wx: p.x, wy: p.y }));
        return {
            ok: moves.length === pts.length,
            moves,
            poolBefore: g._tilePool.length,
            countBefore: g.tiles.length
        };
    }, placements);
}

async function assertNoMarqueeOnMobile(frame) {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer');
        if (!surface) return { ok: false, reason: 'no-surface' };
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y, button) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 2,
            pointerType: 'touch',
            button,
            buttons: button === 2 ? 2 : 0
        });
        g._setSelection?.([], false);
        surface.dispatchEvent(mk('pointerdown', r.left + 8, r.top + 8, 2));
        surface.dispatchEvent(mk('pointermove', r.right - 8, r.bottom - 8, 2));
        surface.dispatchEvent(mk('pointerup', r.right - 8, r.bottom - 8, 2));
        return {
            ok: g._selectedIds.size === 0,
            selected: g._selectedIds.size,
            selectionInit: !!g._selectionInit
        };
    });
    if (!result.ok) {
        throw new Error(`Marquee should not select on mobile (${JSON.stringify(result)})`);
    }
}

module.exports = {
    TOUCH,
    DOUBLE_TAP_GAP_MS,
    HOLD_DUMP_MS,
    getGameFrame,
    pointerOpts,
    assertFaceDownRack,
    assertBananagramsRackFitsViewport,
    touchPanBackground,
    touchTapBackgroundStable,
    touchDragTile,
    touchDragTileToWorld,
    holdDump,
    doubleTapDump,
    assertPeelSpawnClearance,
    preparePeelCrosswordTouchPlan,
    assertSettingsEdgeSwipeDisabled,
    assertNoMarqueeOnMobile
};
