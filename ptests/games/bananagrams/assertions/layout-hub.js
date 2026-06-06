/**
 * Hub UI layout checks — poll until ready (no fixed sleeps).
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');

async function ensureWinBannerDwellForAudit(pages, minMs = 4000) {
    await Promise.all(pages.map((page) => page.evaluate((ms) => {
        window.FIVE_VICTORY_DWELL_MS = Math.max(Number(window.FIVE_VICTORY_DWELL_MS || 0), ms);
        const gw = document.getElementById('game-frame')?.contentWindow;
        if (gw) gw.FIVE_VICTORY_DWELL_MS = window.FIVE_VICTORY_DWELL_MS;
    }, minMs)));
}

async function assertWinBannerLayout(page, label = 'win-banner') {
    const mobile = await page.evaluate(() => document.documentElement.classList.contains('five-mobile'));
    const minFs = mobile ? 16 : 20;
    const maxFs = mobile ? 36 : 60;
    const timeoutMs = mobile ? Math.max(STEP_MS, 8000) : STEP_MS;

    try {
        await page.waitForFunction(() => {
            const b = document.getElementById('global-win-banner');
            return !!b?.classList.contains('visible') && !b.classList.contains('is-fitting');
        }, undefined, { timeout: timeoutMs });
    } catch (err) {
        const diag = await page.evaluate(() => {
            const b = document.getElementById('global-win-banner');
            if (!b) return { missing: true };
            const r = b.getBoundingClientRect();
            return {
                visible: b.classList.contains('visible'),
                fitting: b.classList.contains('is-fitting'),
                fading: b.classList.contains('is-fading-out'),
                text: (b.innerText || '').slice(0, 48),
                opacity: getComputedStyle(b).opacity,
                fs: parseFloat(getComputedStyle(b).fontSize) || 0,
                rect: { left: r.left, top: r.top, width: r.width, height: r.height }
            };
        });
        throw new Error(`${label}: hub win banner not visible (${JSON.stringify(diag)})`);
    }
    try {
        await page.waitForFunction(({ minFs: min, maxFs: max }) => {
            const b = document.getElementById('global-win-banner');
            if (!b?.classList.contains('visible') || b.classList.contains('is-fitting')) return false;
            const r = b.getBoundingClientRect();
            const fs = parseFloat(getComputedStyle(b).fontSize) || 0;
            const vv = window.visualViewport;
            const vw = vv?.width ?? window.innerWidth;
            const vh = vv?.height ?? window.innerHeight;
            return r.width > 24 && r.height > 8 && fs >= min && fs <= max
                && r.top >= -2 && r.left >= -2
                && r.right <= vw + 2 && r.bottom <= vh + 2;
        }, { minFs, maxFs }, { timeout: timeoutMs });
    } catch (err) {
        const snap = await page.evaluate(() => {
            const b = document.getElementById('global-win-banner');
            const r = b?.getBoundingClientRect() || {};
            const vv = window.visualViewport;
            return {
                fs: parseFloat(getComputedStyle(b).fontSize) || 0,
                fitting: b?.classList.contains('is-fitting'),
                visible: b?.classList.contains('visible'),
                w: r.width,
                h: r.height,
                rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                viewport: {
                    w: vv?.width ?? window.innerWidth,
                    h: vv?.height ?? window.innerHeight
                }
            };
        });
        throw new Error(`${label}: win banner layout (${JSON.stringify(snap)})`);
    }
}

/** Mobile: rack stays visible when localStorage has an unusably low persisted zoom. */
async function assertBananagramsRackVisibleWithLowPersistedZoom(page, opts = {}) {
    const ms = opts.ms ?? STEP_MS;
    const margin = opts.margin ?? 12;
    const BAD_ZOOM = 0.2;

    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && typeof g.getZoomStorageKey === 'function' && g.tiles?.length >= 7;
    }, undefined, { timeout: ms });

    await page.evaluate((badZoom) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return;
        win.FiveViewport?.applyMobileClass?.(true);
        localStorage.setItem(g.getZoomStorageKey(), String(badZoom));
        g._fitZoomInitialized = false;
        g._mobileLayoutAnchorLocked = false;
        g.restorePersistedZoom?.();
        g.refreshMobileLayout?.();
        g.requestRender?.();
    }, BAD_ZOOM);

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
        const zoom = win.game?.targetZoom;
        return { ok: !bad.length, bad, count: tiles.length, vw, vh, zoom };
    }, margin);

    if (!fit.ok) {
        throw new Error(`Bananagrams rack should auto-fit after low persisted zoom (${JSON.stringify(fit)})`);
    }
    if (typeof fit.zoom === 'number' && fit.zoom <= BAD_ZOOM + 0.01) {
        throw new Error(`Low persisted zoom was not corrected on mobile (zoom=${fit.zoom})`);
    }
}

module.exports = { assertWinBannerLayout, assertBananagramsRackVisibleWithLowPersistedZoom, ensureWinBannerDwellForAudit };
