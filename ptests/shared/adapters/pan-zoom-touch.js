/**
 * Shared pan-zoom board touch/pointer helpers (any game with .board-pan-layer + .tile).
 */
const { getGameFrame } = require('./desktop-input');

function pointerEventOpts(pointerType) {
    return { pointerType, button: 0 };
}

/**
 * @param {import('playwright').Frame} frame
 * @param {object} [opts]
 * @param {'mouse'|'touch'} [opts.pointerType]
 * @param {number} [opts.minDist]
 */
async function panBackgroundInFrame(frame, opts = {}) {
    const pointerType = opts.pointerType || 'mouse';
    const minDist = opts.minDist ?? 20;
    return frame.evaluate(({ pointerType, minDist }) => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer') || document.getElementById('board-canvas');
        if (!g || !surface) return { ok: false, reason: 'no-game-or-surface' };
        const before = { x: g.canvasPanX || 0, y: g.canvasPanY || 0 };
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 9,
            pointerType,
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
        const after = { x: g.canvasPanX || 0, y: g.canvasPanY || 0 };
        const dist = Math.hypot(after.x - before.x, after.y - before.y);
        return {
            ok: dist >= minDist,
            dist,
            panInit: !!g._viewportPanInit,
            viewportPanEnabled: g.capabilities?.viewportPanEnabled !== false
        };
    }, { pointerType, minDist });
}

/**
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 */
async function panBackground(page, opts = {}) {
    const frame = await getGameFrame(page);
    return panBackgroundInFrame(frame, opts);
}

/**
 * @param {import('playwright').Frame} frame
 * @param {object} [opts]
 * @param {number} [opts.tileIndex]
 * @param {number} [opts.dx]
 * @param {number} [opts.dy]
 * @param {'mouse'|'touch'} [opts.pointerType]
 */
async function dragTileInFrame(frame, opts = {}) {
    const {
        tileIndex = 0,
        dx = 80,
        dy = 60,
        pointerType = 'mouse'
    } = opts;
    return frame.evaluate(async ({ idx, dx, dy, pointerType }) => {
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
            pointerType,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const before = { x: tile.x, y: tile.y };
        node.dispatchEvent(mk('pointerdown', x0, y0));
        for (let i = 1; i <= 4; i++) {
            node.dispatchEvent(mk('pointermove', x0 + (dx * i) / 4, y0 + (dy * i) / 4));
        }
        node.dispatchEvent(mk('pointerup', x0 + dx, y0 + dy));
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        const after = { x: tile.x, y: tile.y };
        return {
            ok: true,
            id: tile.id,
            moved: Math.hypot(after.x - before.x, after.y - before.y) > 15,
            before,
            after
        };
    }, { idx: tileIndex, dx, dy, pointerType });
}

/**
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 */
async function dragTile(page, opts = {}) {
    const frame = await getGameFrame(page);
    return dragTileInFrame(frame, opts);
}

module.exports = {
    panBackgroundInFrame,
    panBackground,
    dragTileInFrame,
    dragTile
};
