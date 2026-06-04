/**
 * Headed MP runs — side-by-side windows + camera centered on visible tiles.
 * Playwright viewport must match the physical window size or pan/zoom centers on the wrong point.
 */
const { playwrightHeadless } = require('../infra/env-defaults');
const { getDeviceContextOptions } = require('../../platform/mobile/lib/device-presets');

const MP_HEADED_WIDTH = Number(process.env.FIVE_MP_HEADED_WIDTH || 960);
const MP_HEADED_HEIGHT = Number(process.env.FIVE_MP_HEADED_HEIGHT || 1040);

function isMpHeaded() {
    return !playwrightHeadless();
}

function mpHeadedViewportSize() {
    return { width: MP_HEADED_WIDTH, height: MP_HEADED_HEIGHT };
}

/** Playwright context opts when launching headed MP (match tiled window size). */
function mpHeadedContextOpts() {
    const { width, height } = mpHeadedViewportSize();
    return {
        viewport: { width, height },
        screen: { width, height },
        deviceScaleFactor: 1
    };
}

async function placeMpHeadedWindow(page, bounds) {
    try {
        const session = await page.context().newCDPSession(page);
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { ...bounds, windowState: 'normal' }
        });
    } catch (_) { /* CDP layout is best-effort */ }
}

/** Resize Playwright viewport + nudge hub iframe / game to reflow pan-zoom. */
async function syncMpHeadedViewport(page) {
    if (!isMpHeaded()) return;
    const { width, height } = mpHeadedViewportSize();
    await page.setViewportSize({ width, height }).catch(() => { });
    await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        if (!win) return;
        win.dispatchEvent(new Event('resize'));
        if (win.FiveViewport?.syncHubViewport) win.FiveViewport.syncHubViewport();
        const g = win.game;
        if (!g || typeof GameViewport === 'undefined') return;
        if (typeof g.refreshMobileLayoutViewportOnly === 'function') {
            g.refreshMobileLayoutViewportOnly();
        } else if (typeof g.refreshMobileLayout === 'function') {
            g.refreshMobileLayout();
        }
        if (typeof GameViewport.reflowOnResize === 'function') {
            GameViewport.reflowOnResize(g);
        }
    }).catch(() => { });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))).catch(() => { });
}

/**
 * Tile host/guest windows side-by-side (960×1040 each by default).
 * @param {import('playwright').Page[]} pages
 */
async function layoutMpHeadedWindows(pages, options = {}) {
    if (!isMpHeaded() || process.env.FIVE_MP_HEADED_LAYOUT === '0') return;
    const width = options.width ?? MP_HEADED_WIDTH;
    const height = options.height ?? MP_HEADED_HEIGHT;
    const top = options.top ?? 0;
    const gap = options.gap ?? 12;
    await Promise.all(pages.map(async (page, i) => {
        await page.setViewportSize({ width, height }).catch(() => { });
        await placeMpHeadedWindow(page, {
            left: i * (width + gap),
            top,
            width,
            height
        });
        await syncMpHeadedViewport(page);
    }));
}

async function syncMpHeadedMobileViewport(page) {
    if (!isMpHeaded()) return;
    const { viewport } = getDeviceContextOptions();
    await page.setViewportSize({ width: viewport.width, height: viewport.height }).catch(() => { });
    await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        if (!win) return;
        win.dispatchEvent(new Event('resize'));
        win.FiveViewport?.syncHubViewport?.();
        win.FiveViewport?.applyMobileClass?.(true);
        const g = win.game;
        if (typeof g?.refreshMobileLayout === 'function') g.refreshMobileLayout();
        else if (typeof g?.refreshMobileLayoutViewportOnly === 'function') {
            g.refreshMobileLayoutViewportOnly();
        }
        g?.requestRender?.();
    }).catch(() => { });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))).catch(() => { });
}

/**
 * Headed mobile MP — keep emulated phone viewport (not desktop 960×1040 tiles).
 * @param {import('playwright').Page[]} pages
 */
async function layoutMpHeadedMobileWindows(pages, options = {}) {
    if (!isMpHeaded() || process.env.FIVE_MP_HEADED_LAYOUT === '0') return;
    const { viewport } = getDeviceContextOptions(options.deviceOverrides);
    const width = options.width ?? viewport.width;
    const height = options.height ?? viewport.height;
    const top = options.top ?? 0;
    const gap = options.gap ?? 12;
    const chromePad = Number(process.env.FIVE_MP_HEADED_CHROME_PAD || 88);
    await Promise.all(pages.map(async (page, i) => {
        await page.setViewportSize({ width, height });
        await placeMpHeadedWindow(page, {
            left: i * (width + gap),
            top,
            width,
            height: height + chromePad
        });
        await syncMpHeadedMobileViewport(page);
    }));
}

/**
 * Headed mixed MP — tile each player window by slot kind (desktop vs mobile).
 * @param {import('playwright').Page[]} pages
 * @param {object} options
 * @param {('desktop'|'mobile')[]} [options.mixedLayout]
 * @param {boolean[]} [options.isMobileSlot]
 */
async function layoutMpHeadedMixedWindows(pages, options = {}) {
    if (!isMpHeaded() || process.env.FIVE_MP_HEADED_LAYOUT === '0') return;
    const { viewport } = getDeviceContextOptions(options.deviceOverrides);
    const mixedLayout = options.mixedLayout || [];
    const isMobileSlot = options.isMobileSlot || [];
    const desktopW = options.desktopWidth ?? MP_HEADED_WIDTH;
    const desktopH = options.desktopHeight ?? MP_HEADED_HEIGHT;
    const mobileW = options.mobileWidth ?? viewport.width;
    const mobileH = options.mobileHeight ?? viewport.height;
    const top = options.top ?? 0;
    const gap = options.gap ?? 12;
    const chromePad = Number(process.env.FIVE_MP_HEADED_CHROME_PAD || 88);

    let left = 0;
    for (let i = 0; i < pages.length; i++) {
        const mobile = isMobileSlot[i] || mixedLayout[i] === 'mobile';
        const width = mobile ? mobileW : desktopW;
        const viewH = mobile ? mobileH : desktopH;
        const winH = mobile ? mobileH + chromePad : desktopH;
        await pages[i].setViewportSize({ width, height: viewH });
        await placeMpHeadedWindow(pages[i], { left, top, width, height: winH });
        if (mobile) await syncMpHeadedMobileViewport(pages[i]);
        else await syncMpHeadedViewport(pages[i]);
        left += width + gap;
    }
}

/**
 * Pan/zoom so the current rack/board is in frame for human observers.
 * Works on hub pages (game in #game-frame iframe) or direct game pages.
 * @param {import('playwright').Page} page
 */
async function centerMpViewerOnPage(page, options = {}) {
    if (!isMpHeaded() || process.env.FIVE_MP_HEADED_CENTER === '0') return;
    if (options.mobile) {
        await syncMpHeadedMobileViewport(page);
        return;
    }
    await syncMpHeadedViewport(page);
    const envZoom = Number(process.env.FIVE_MP_HEADED_ZOOM || 0);
    const zoom = options.zoom ?? (envZoom > 0 ? envZoom : 1.15);
    await page.evaluate(({ z }) => {
        const g = (() => {
            const frame = document.getElementById('game-frame');
            return frame?.contentWindow?.game || window.game || null;
        })();
        if (!g || typeof GameViewport === 'undefined') return false;

        let cx = g.ORIGIN;
        let cy = g.ORIGIN;
        if (typeof g.getViewportContentCenter === 'function') {
            const c = g.getViewportContentCenter();
            if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) {
                cx = c.x;
                cy = c.y;
            }
        } else if (g.tiles?.length) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const t of g.tiles) {
                minX = Math.min(minX, t.x);
                minY = Math.min(minY, t.y);
                maxX = Math.max(maxX, t.x);
                maxY = Math.max(maxY, t.y);
            }
            cx = (minX + maxX) / 2;
            cy = (minY + maxY) / 2;
        }

        GameViewport.centerWorldPoint(g, cx, cy);
        if (z > 0) {
            g.zoom = z;
            g.targetZoom = z;
        }
        GameViewport.applyPanZoom(g);
        g.requestRender?.();
        if (typeof g._flushViewport === 'function') g._flushViewport();
        if (typeof g.applyZoom === 'function') g.applyZoom();
        return true;
    }, { z: zoom }).catch(() => { });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))).catch(() => { });
}

/** @param {import('playwright').Page[]} pages */
async function centerMpViewerOnPages(pages, options = {}) {
    if (!isMpHeaded()) return;
    await Promise.all(pages.map((p) => centerMpViewerOnPage(p, options)));
}

module.exports = {
    isMpHeaded,
    MP_HEADED_WIDTH,
    MP_HEADED_HEIGHT,
    mpHeadedViewportSize,
    mpHeadedContextOpts,
    syncMpHeadedViewport,
    syncMpHeadedMobileViewport,
    layoutMpHeadedWindows,
    layoutMpHeadedMobileWindows,
    layoutMpHeadedMixedWindows,
    centerMpViewerOnPage,
    centerMpViewerOnPages
};
