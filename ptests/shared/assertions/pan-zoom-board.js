/**
 * Shared pan-zoom tile board assertions (Bananagrams, Rummikub, …).
 */
const { STEP_MS } = require('../infra/timeouts');
const { getGameFrame } = require('../adapters/desktop-input');

/**
 * All .tile nodes should be visible inside the game iframe viewport after default framing.
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.margin]
 * @param {number} [opts.minTiles]
 * @param {number} [opts.timeoutMs]
 */
async function assertPanZoomTilesFitViewport(page, opts = {}) {
    const margin = opts.margin ?? 12;
    const minTiles = opts.minTiles ?? 1;
    const timeoutMs = opts.timeoutMs ?? STEP_MS;

    await page.waitForFunction(({ need }) => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        return doc && doc.querySelectorAll('.tile').length >= need;
    }, { need: minTiles }, { timeout: timeoutMs });

    await page.evaluate((isMobile) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return;
        if (isMobile) {
            win.FiveViewport?.applyMobileClass?.(true);
        }
        if (typeof g.getZoomStorageKey === 'function') {
            localStorage.removeItem(g.getZoomStorageKey());
        }
        g._fitZoomInitialized = false;
        g._applyDefaultPlayingViewport?.();
        if (isMobile) {
            g.refreshMobileLayout?.();
        }
        g.requestRender?.();
    }, !!opts.isMobile);

    await page.waitForTimeout(80);

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
                bad.push({ id: t.dataset.tileId, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
            }
        });
        return { ok: !bad.length, bad: bad.slice(0, 5), count: tiles.length, vw, vh };
    }, margin);

    if (!fit.ok) {
        throw new Error(`Pan-zoom tiles should fit viewport (${JSON.stringify(fit)})`);
    }
    return fit;
}

/**
 * Default viewport focal should center the board content (table + rack).
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.maxDriftPx]
 */
async function assertPanZoomBoardCentered(page, opts = {}) {
    const maxDrift = opts.maxDriftPx ?? 120;
    const result = await page.evaluate((maxDriftPx) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const vp = win?.GameViewport;
        const host = win?.document.getElementById('game-container');
        if (!g || !vp?.worldToClient || !host) return { ok: false, reason: 'missing-engine' };
        const bounds = typeof g.getPanZoomWorldVisualBounds === 'function'
            ? g.getPanZoomWorldVisualBounds()
            : null;
        if (!bounds || !Number.isFinite(bounds.cx) || !Number.isFinite(bounds.cy)) {
            return { ok: false, reason: 'no-bounds' };
        }
        const hr = host.getBoundingClientRect();
        const vcx = hr.left + hr.width / 2;
        const vcy = hr.top + hr.height / 2;
        const focalWorld = typeof g.getViewportContentCenter === 'function'
            ? g.getViewportContentCenter()
            : { x: bounds.cx, y: bounds.cy };
        const client = vp.worldToClient(g, focalWorld.x, focalWorld.y);
        const drift = Math.hypot(client.x - vcx, client.y - vcy);
        return {
            ok: drift <= maxDriftPx,
            drift,
            maxDriftPx,
            bounds,
            focalWorld,
            focal: { x: client.x, y: client.y },
            viewport: { x: vcx, y: vcy }
        };
    }, maxDrift);
    if (!result.ok) {
        throw new Error(`Pan-zoom board should be centered on load (${JSON.stringify(result)})`);
    }
    return result;
}

module.exports = {
    assertPanZoomTilesFitViewport,
    assertPanZoomBoardCentered
};
