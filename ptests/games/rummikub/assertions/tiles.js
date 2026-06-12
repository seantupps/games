/**
 * Rummikub tile DOM + layout assertions (seed-agnostic).
 */
const { EXPECTED_TILES } = require('../lib/session');

const COLOR_KEYS = ['B', 'R', 'U', 'O'];

/**
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertAllTilesVisible(frame, label = 'tiles-visible') {
    const result = await frame.evaluate((expected) => {
        const tiles = [...document.querySelectorAll('.tile')];
        const bad = [];
        tiles.forEach((el) => {
            const face = el.querySelector('.tile-face');
            const val = el.querySelector('.tile-value');
            const r = el.getBoundingClientRect();
            if (!face || !val) {
                bad.push({ id: el.dataset.tileId, reason: 'missing-face' });
                return;
            }
            if (r.width < 8 || r.height < 8) {
                bad.push({ id: el.dataset.tileId, reason: 'tiny', w: r.width, h: r.height });
                return;
            }
            const text = (val.textContent || '').trim();
            if (!text) bad.push({ id: el.dataset.tileId, reason: 'empty-label' });
            const color = getComputedStyle(val).color;
            const hidden = color === 'rgba(0, 0, 0, 0)' || color === 'transparent';
            if (hidden) bad.push({ id: el.dataset.tileId, reason: 'hidden-text', color });
        });
        return {
            ok: tiles.length === expected && !bad.length,
            count: tiles.length,
            bad: bad.slice(0, 5)
        };
    }, EXPECTED_TILES);
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertRectangularTiles(frame, label = 'rectangular-tiles') {
    const result = await frame.evaluate(() => {
        const R = window.RummikubRules;
        const wantW = R?.TILE_W ?? 40;
        const wantH = R?.TILE_H ?? 52;
        const wantRatio = wantH / wantW;
        const tiles = [...document.querySelectorAll('.tile')];
        const sizes = tiles.map((t) => {
            const face = t.querySelector('.tile-face');
            const fr = face ? face.getBoundingClientRect() : t.getBoundingClientRect();
            return { w: fr.width, h: fr.height, ratio: fr.height / fr.width };
        });
        const ok = sizes.length > 0 && sizes.every((s) =>
            s.h > s.w + 2
            && Math.abs(s.ratio - wantRatio) < 0.08
        );
        return { ok, sample: sizes[0], wantRatio, count: sizes.length };
    });
    if (!result.ok) {
        throw new Error(`${label}: tiles must be rectangular (h/w ~${result.wantRatio.toFixed(2)}) (${JSON.stringify(result)})`);
    }
    return result;
}

/**
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertTileDigitColors(frame, label = 'tile-colors') {
    const result = await frame.evaluate(() => {
        const hex = window.RummikubRules?.COLOR_HEX || {
            B: '#1a1a1a',
            R: '#dc2626',
            U: '#2563eb',
            O: '#ea580c'
        };
        const probe = (colorHex) => {
            const el = document.createElement('span');
            el.style.color = colorHex;
            document.body.appendChild(el);
            const c = getComputedStyle(el).color;
            el.remove();
            return c;
        };
        const expected = {};
        for (const [key, h] of Object.entries(hex)) {
            expected[key] = probe(h);
        }
        const missing = [];
        const mismatches = [];
        for (const key of ['B', 'R', 'U', 'O']) {
            const face = document.querySelector(`.tile-face[data-color="${key}"]`);
            if (!face) {
                missing.push(key);
                continue;
            }
            const val = face.querySelector('.tile-value');
            const got = val ? getComputedStyle(val).color : null;
            if (got !== expected[key]) {
                mismatches.push({ key, got, want: expected[key] });
            }
        }
        return {
            ok: !missing.length && !mismatches.length,
            missing,
            mismatches: mismatches.slice(0, 4)
        };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Step-3 style start: melds on table + tiles on rack (any random puzzle).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertTableAndRack(frame, label = 'table-and-rack') {
    const result = await frame.evaluate((expected) => {
        const g = window.game;
        const table = (g?.tiles || []).filter((t) => t.zone === 'table');
        const rack = (g?.tiles || []).filter((t) => t.zone === 'rack');
        return {
            ok: g?.tiles?.length === expected
                && table.length > 0
                && rack.length > 0
                && table.length + rack.length === expected,
            total: g?.tiles?.length ?? 0,
            table: table.length,
            rack: rack.length
        };
    }, EXPECTED_TILES);
    if (!result.ok) {
        throw new Error(`${label}: expected table+rack split (${JSON.stringify(result)})`);
    }
    return result;
}

/**
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertRackBelowCenter(frame, label = 'rack-below-center') {
    const result = await frame.evaluate(() => {
        const host = document.getElementById('game-container')?.getBoundingClientRect();
        const rackTiles = (window.game?.tiles || []).filter((t) => t.zone === 'rack');
        const nodes = rackTiles.map((t) =>
            document.querySelector(`[data-tile-id="${t.id}"]`)
        ).filter(Boolean);
        if (!host || !nodes.length) return { ok: false, reason: 'no-rack-nodes' };
        let sy = 0;
        nodes.forEach((n) => {
            const r = n.getBoundingClientRect();
            sy += r.top + r.height / 2;
        });
        sy /= nodes.length;
        const centerY = host.top + host.height / 2;
        return { ok: sy > centerY + 24, sy, centerY, rackCount: nodes.length };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Table melds bounding box centered horizontally on screen / ORIGIN.
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertBoardCenteredHorizontally(frame, label = 'board-centered') {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const R = typeof RummikubRules !== 'undefined' ? RummikubRules : window.RummikubRules;
        const host = document.getElementById('game-container')?.getBoundingClientRect();
        const table = (g?.tiles || []).filter((t) => t.zone === 'table');
        if (!host || !table.length || !R) return { ok: false, reason: 'no-table-or-host' };
        const nodes = table.map((t) =>
            document.querySelector(`[data-tile-id="${t.id}"]`)
        ).filter(Boolean);
        if (!nodes.length) return { ok: false, reason: 'no-table-nodes' };
        let domMin = Infinity;
        let domMax = -Infinity;
        nodes.forEach((n) => {
            const r = n.getBoundingClientRect();
            domMin = Math.min(domMin, r.left);
            domMax = Math.max(domMax, r.right);
        });
        const domBoxCx = (domMin + domMax) / 2;
        const hostCx = host.left + host.width / 2;
        const domDrift = Math.abs(domBoxCx - hostCx);
        const minX = Math.min(...table.map((t) => t.x));
        const maxX = Math.max(...table.map((t) => t.x)) + R.TILE_W;
        const boardCx = (minX + maxX) / 2;
        const modelDrift = Math.abs(boardCx - g.ORIGIN);
        return {
            ok: domDrift <= 28 && modelDrift < 2,
            domDrift,
            modelDrift,
            hostCx,
            domBoxCx,
            boardCx,
            origin: g.ORIGIN,
            boardW: maxX - minX
        };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Rack horizontal center aligns with the game container (screen midpoint / ORIGIN).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertRackCenteredHorizontally(frame, label = 'rack-centered') {
    const result = await frame.evaluate(() => {
        const g = window.game;
        const R = typeof RummikubRules !== 'undefined' ? RummikubRules : window.RummikubRules;
        const host = document.getElementById('game-container')?.getBoundingClientRect();
        const rack = (g?.tiles || []).filter((t) => t.zone === 'rack');
        if (!host || !rack.length || !R) return { ok: false, reason: 'no-rack-or-host' };
        const nodes = rack.map((t) =>
            document.querySelector(`[data-tile-id="${t.id}"]`)
        ).filter(Boolean);
        if (!nodes.length) return { ok: false, reason: 'no-rack-nodes' };
        let domMin = Infinity;
        let domMax = -Infinity;
        nodes.forEach((n) => {
            const r = n.getBoundingClientRect();
            domMin = Math.min(domMin, r.left);
            domMax = Math.max(domMax, r.right);
        });
        const domBoxCx = (domMin + domMax) / 2;
        const hostCx = host.left + host.width / 2;
        const domDrift = Math.abs(domBoxCx - hostCx);
        const minX = Math.min(...rack.map((t) => t.x));
        const maxX = Math.max(...rack.map((t) => t.x)) + R.TILE_W;
        const rackCx = (minX + maxX) / 2;
        const modelDrift = Math.abs(rackCx - g.ORIGIN);
        return {
            ok: domDrift <= 28 && modelDrift < 2,
            domDrift,
            modelDrift,
            hostCx,
            domBoxCx,
            rackCx,
            origin: g.ORIGIN,
            rackW: maxX - minX
        };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Rack is laid out in at most RACK_ROWS rows (3).
 * @param {import('playwright').Frame} frame
 * @param {string} [label]
 */
async function assertRackMaxThreeRows(frame, label = 'rack-three-rows') {
    const result = await frame.evaluate(() => {
        const R = typeof RummikubRules !== 'undefined' ? RummikubRules : window.RummikubRules;
        const rack = (window.game?.tiles || []).filter((t) => t.zone === 'rack');
        if (!rack.length) return { ok: false, reason: 'no-rack' };
        const cols = R.rackCols(rack.length);
        const rowsUsed = Math.ceil(rack.length / cols);
        const ys = [...new Set(rack.map((t) => Math.round(t.y)))].sort((a, b) => a - b);
        let distinctRows = ys.length ? 1 : 0;
        for (let i = 1; i < ys.length; i++) {
            if (ys[i] - ys[i - 1] > R.TILE_H * 0.5) distinctRows += 1;
        }
        return {
            ok: rowsUsed <= R.RACK_ROWS && distinctRows <= R.RACK_ROWS,
            rackCount: rack.length,
            cols,
            rowsUsed,
            distinctRows,
            maxRows: R.RACK_ROWS
        };
    });
    if (!result.ok) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
    return result;
}

module.exports = {
    COLOR_KEYS,
    assertAllTilesVisible,
    assertRectangularTiles,
    assertTileDigitColors,
    assertTableAndRack,
    assertRackBelowCenter,
    assertBoardCenteredHorizontally,
    assertRackCenteredHorizontally,
    assertRackMaxThreeRows
};
