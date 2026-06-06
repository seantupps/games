/**
 * Headed MP runs — side-by-side windows + camera centered on visible tiles.
 * Playwright viewport must match the physical window size or pan/zoom centers on the wrong point.
 */
const { playwrightHeadless } = require('../infra/env-defaults');
const {
    isHeadedLayoutEnabled,
    isHeadedCenterEnabled,
    isHeadedChatEnabled,
    isHeadedMobileViewportProbeEnabled
} = require('../infra/run-config');
const { getDeviceContextOptions } = require('../../platform/mobile/lib/device-presets');
const {
    headedMobileWindowTag,
    shouldAhkForceMobileHeaded,
    forceChromeWindow,
    markHeadedWindow
} = require('./ahk');

const {
    DESKTOP_VIEWPORT: SP_DESKTOP_VIEWPORT,
    MOBILE_VIEWPORT,
    MOBILE_WINDOW
} = require('../infra/viewport-constants');

function mpHeadedBaseSize() {
    return {
        width: Number(process.env.FIVE_MP_HEADED_BASE_WIDTH || SP_DESKTOP_VIEWPORT.width),
        height: Number(process.env.FIVE_MP_HEADED_BASE_HEIGHT || SP_DESKTOP_VIEWPORT.height)
    };
}

/**
 * Headed desktop tile — SP canvas split evenly across N players (2p→960×931, 3p→640×931).
 * Override slot: FIVE_MP_HEADED_WIDTH / FIVE_MP_HEADED_HEIGHT.
 */
function mpHeadedSlotSize(playerCount = 2) {
    const envW = process.env.FIVE_MP_HEADED_WIDTH;
    const envH = process.env.FIVE_MP_HEADED_HEIGHT;
    if (envW != null && envW !== '') {
        return {
            width: Number(envW),
            height: Number(envH != null && envH !== '' ? envH : mpHeadedBaseSize().height)
        };
    }
    const base = mpHeadedBaseSize();
    const n = Math.max(1, Number(playerCount) || 1);
    return {
        width: Math.floor(base.width / n),
        height: base.height
    };
}

/** @deprecated use mpHeadedSlotSize(n) — 2p slot width for legacy imports */
const MP_HEADED_WIDTH = mpHeadedSlotSize(2).width;
/** @deprecated use mpHeadedSlotSize(n) — SP desktop height */
const MP_HEADED_HEIGHT = mpHeadedSlotSize(2).height;

function mpHeadedGap() {
    const raw = process.env.FIVE_MP_HEADED_GAP;
    if (raw == null || raw === '') return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function headedMobileViewport(options = {}) {
    return getDeviceContextOptions(options.deviceOverrides).viewport;
}

function headedMobileChromePadV() {
    const env = Number(process.env.FIVE_MP_HEADED_MOBILE_CHROME_PAD || 0);
    return env > 0 ? env : MOBILE_WINDOW.height - MOBILE_VIEWPORT.height;
}

function headedMobileOuterSize(bounds = {}) {
    return {
        width: bounds.outerWidth ?? MOBILE_WINDOW.width,
        height: bounds.outerHeight ?? MOBILE_WINDOW.height
    };
}

/** Portrait emulated phone vs landscape desktop MP tile (960×931). */
function isHeadedMobilePage(page) {
    const vp = page?.viewportSize?.();
    return !!(vp?.height && vp?.width && vp.height > vp.width);
}

async function readHeadedWindowBounds(page) {
    try {
        const { session, windowId } = await openCdpWindowSession(page);
        const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
        if (!bounds?.width) return null;
        return {
            left: bounds.left ?? 0,
            top: bounds.top ?? 0,
            width: bounds.width,
            height: bounds.height
        };
    } catch {
        return null;
    }
}

async function readHeadedOuterWidth(page) {
    const b = await readHeadedWindowBounds(page);
    return b?.width ?? null;
}

function isMpHeaded() {
    return !playwrightHeadless();
}

function mpHeadedViewportSize(playerCount = 2) {
    return mpHeadedSlotSize(playerCount);
}

/** Playwright context opts when launching headed MP (match tiled window size). */
function mpHeadedContextOpts(options = {}) {
    const players = options.players ?? 2;
    const { width, height } = mpHeadedSlotSize(players);
    return {
        viewport: { width, height },
        screen: { width, height },
        deviceScaleFactor: 1
    };
}

async function openCdpWindowSession(page) {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    return { session, windowId };
}

async function placeMpHeadedWindow(page, bounds) {
    try {
        const { session, windowId } = await openCdpWindowSession(page);
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { ...bounds, windowState: 'normal' }
        });
    } catch (_) { /* CDP layout is best-effort */ }
}

/**
 * Force OS window to emulated mobile outer size (Windows Chrome ~516px min bypass).
 * Best-effort — skipped when AHK is disabled or missing.
 */
async function maybeForceMobileHeadedWindowViaAhk(page, bounds) {
    if (!bounds.ahkMobile || !shouldAhkForceMobileHeaded()) return;
    const { left = 0, top = 0, windowTag } = bounds;
    const { width, height } = headedMobileOuterSize(bounds);
    if (!windowTag || !Number.isFinite(width) || !Number.isFinite(height)) return;

    try {
        await markHeadedWindow(page, windowTag);
        await page.bringToFront();
        let matchRect = null;
        try {
            const { session, windowId } = await openCdpWindowSession(page);
            const { bounds: cdpBounds } = await session.send('Browser.getWindowBounds', { windowId });
            if (cdpBounds?.width && cdpBounds?.height) {
                matchRect = {
                    left: cdpBounds.left ?? left,
                    top: cdpBounds.top ?? top,
                    width: cdpBounds.width,
                    height: cdpBounds.height
                };
            }
        } catch (_) { /* fall back to target outer size */ }
        const forceOpts = {
            width,
            height,
            left,
            top,
            matchRect: matchRect || { left, top, width, height },
            title: windowTag
        };
        let ahkOk = false;
        for (let attempt = 0; attempt < 2 && !ahkOk; attempt++) {
            try {
                if (attempt > 0) await page.waitForTimeout(120);
                forceChromeWindow(forceOpts);
                ahkOk = true;
            } catch (_) { /* retry */ }
        }
        if (!ahkOk) {
            forceChromeWindow({ width, height, left, top, title: windowTag });
        }
        await page.waitForTimeout(100);
        if (process.env.FIVE_MP_HEADED_DEBUG === '1') {
            try {
                const { session, windowId } = await openCdpWindowSession(page);
                const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
                console.warn(`[mp-headed-view] AHK post-force CDP: ${bounds.width}×${bounds.height}`);
            } catch (_) { /* ignore */ }
        }
    } catch (err) {
        if (process.env.FIVE_MP_HEADED_DEBUG === '1') {
            console.warn('[mp-headed-view] AHK force failed:', err?.message || err);
        }
    }
}

/** Headed MP: T / chat work while the game iframe has focus (same as normal play). */
async function enableHeadedHubChat(page) {
    if (!isMpHeaded() || !isHeadedChatEnabled()) return;
    await page.evaluate(() => {
        const isTextInput = (el) => {
            if (!el) return false;
            const tag = el.tagName;
            if (tag === 'TEXTAREA') return true;
            if (tag !== 'INPUT') return false;
            const t = (el.type || 'text').toLowerCase();
            return ['text', 'search', 'email', 'password', 'number', 'url', 'tel'].includes(t);
        };

        const ensureChatLayer = () => {
            const chat = document.getElementById('chat-container');
            if (chat) chat.style.zIndex = '15000';
            const sidebar = document.getElementById('settings-sidebar');
            if (sidebar && !sidebar.style.zIndex) sidebar.style.zIndex = '15000';
        };
        ensureChatLayer();

        const attachIframeChatKeys = () => {
            const frame = document.getElementById('game-frame');
            const win = frame?.contentWindow;
            if (!win) return;
            if (win.__fiveHeadedHubChatIframe) return;
            try {
                win.__fiveHeadedHubChatIframe = true;
                win.addEventListener('keydown', (e) => {
                    if (isTextInput(e.target)) return;
                    const key = e.key?.toLowerCase();
                    if (key === 't') {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        window.parent.postMessage('toggle-chat', '*');
                    } else if (key === '/') {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        window.parent.postMessage('toggle-command', '*');
                    }
                }, true);
            } catch (_) { /* cross-origin */ }
        };

        attachIframeChatKeys();
        const frame = document.getElementById('game-frame');
        if (frame && !frame.__fiveHeadedChatLoadHook) {
            frame.__fiveHeadedChatLoadHook = true;
            frame.addEventListener('load', attachIframeChatKeys);
        }
    }).catch(() => { });
}

/** Hub shell: no white letterboxing when Chrome outer width exceeds viewport. */
async function applyHeadedHubShell(page) {
    await page.evaluate(() => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const root = document.documentElement;
        const body = document.body;
        root.style.overflow = 'hidden';
        root.style.width = `${w}px`;
        root.style.height = `${h}px`;
        root.style.background = '#000';
        if (body) {
            body.style.margin = '0';
            body.style.padding = '0';
            body.style.overflow = 'hidden';
            body.style.width = `${w}px`;
            body.style.height = `${h}px`;
            body.style.background = '#000';
        }
        const hub = document.getElementById('game-hub-container');
        if (hub) {
            hub.style.width = `${w}px`;
            hub.style.height = `${h}px`;
        }
        const frame = document.getElementById('game-frame');
        if (frame) {
            frame.style.width = '100%';
            frame.style.height = '100%';
            frame.style.border = 'none';
            frame.style.display = 'block';
        }
        window.dispatchEvent(new Event('resize'));
        const win = frame?.contentWindow;
        win?.dispatchEvent(new Event('resize'));
        win?.FiveViewport?.syncHubViewport?.();
    }).catch(() => { });
    await enableHeadedHubChat(page);
}

async function readHeadedInnerSize(page) {
    return page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight
    })).catch(() => null);
}

/**
 * Playwright viewport must match the visible window — never taller than innerHeight
 * or the bottom of the page (Done, chat, rack) is clipped with overflow:hidden.
 */
async function alignHeadedPlaywrightViewport(page) {
    if (isHeadedMobilePage(page)) {
        return ensureHeadedMobileEmulatedViewport(page);
    }
    const vp0 = page.viewportSize();
    const target = (vp0?.width && vp0?.height)
        ? { width: vp0.width, height: vp0.height }
        : mpHeadedViewportSize(2);
    let inner = await readHeadedInnerSize(page);
    if (!inner) return target;

    if (inner.height < target.height - 8 || inner.width < target.width - 8) {
        const b = await readHeadedWindowBounds(page);
        if (b) {
            await fitHeadedWindowToViewport(page, {
                left: b.left,
                top: b.top,
                width: target.width,
                height: target.height,
                skipShell: true
            });
            inner = await readHeadedInnerSize(page) || inner;
        }
    }

    const wantW = Math.min(target.width, inner.width);
    const wantH = Math.min(target.height, inner.height);
    const vp = page.viewportSize();
    if (!vp || vp.width !== wantW || vp.height !== wantH) {
        await page.setViewportSize({ width: wantW, height: wantH }).catch(() => { });
    }
    return { width: wantW, height: wantH };
}

/**
 * Size the OS window so the content area matches the emulated viewport (no side whitespace).
 * Chrome enforces a minimum outer width; when that happens we expand viewport to innerWidth.
 */
async function fitHeadedWindowToViewport(page, bounds) {
    const {
        left = 0,
        top = 0,
        width,
        height,
        chromePadV = Number(process.env.FIVE_MP_HEADED_CHROME_PAD || 88),
        skipShell = false,
        /** Mobile headed — never shrink below emulated viewport; grow OS window instead. */
        keepEmulatedViewport = false
    } = bounds;
    const padV = keepEmulatedViewport ? headedMobileChromePadV() : chromePadV;
    const maxGrowAttempts = keepEmulatedViewport ? 8 : 3;
    const mobileOuter = keepEmulatedViewport ? headedMobileOuterSize(bounds) : null;
    await page.setViewportSize({ width, height }).catch(() => { });
    try {
        const { session, windowId } = await openCdpWindowSession(page);
        if (keepEmulatedViewport && mobileOuter) {
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left,
                    top,
                    width: mobileOuter.width,
                    height: mobileOuter.height,
                    windowState: 'normal'
                }
            });
        } else {
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left,
                    top,
                    width,
                    height: height + padV,
                    windowState: 'normal'
                }
            });
        }
        await page.waitForTimeout(40);

        let chrome = await readHeadedInnerSize(page);
        if (!chrome) return;
        const frameW = Math.max(0, chrome.outerWidth - chrome.width);
        const frameH = Math.max(0, chrome.outerHeight - chrome.height);

        if (!keepEmulatedViewport) {
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left,
                    top,
                    width: width + frameW,
                    height: height + frameH,
                    windowState: 'normal'
                }
            });
            await page.waitForTimeout(40);
        }

        for (let attempt = 0; attempt < maxGrowAttempts; attempt++) {
            chrome = await readHeadedInnerSize(page);
            if (!chrome) break;
            const hDeficit = height - chrome.height;
            const wDeficit = width - chrome.width;
            if (hDeficit <= 2 && wDeficit <= 2) break;
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left,
                    top,
                    width: chrome.outerWidth + Math.max(0, wDeficit),
                    height: chrome.outerHeight + Math.max(0, hDeficit),
                    windowState: 'normal'
                }
            });
            await page.waitForTimeout(40);
        }

        chrome = await readHeadedInnerSize(page);
        if (chrome) {
            if (keepEmulatedViewport) {
                await page.setViewportSize({ width, height }).catch(() => { });
            } else {
                const vw = Math.min(width, chrome.width);
                const vh = Math.min(height, chrome.height);
                await page.setViewportSize({ width: vw, height: vh }).catch(() => { });
            }
        }
    } catch (_) { /* CDP layout is best-effort */ }

    if (!skipShell) await applyHeadedHubShell(page);
}

/** Grow headed mobile OS window so Playwright viewport matches emulated phone (MOBILE_VIEWPORT). */
async function ensureHeadedMobileEmulatedViewport(page, options = {}) {
    if (!isMpHeaded()) return headedMobileViewport(options);
    const { width, height } = headedMobileViewport(options);
    const b = await readHeadedWindowBounds(page);
    await fitHeadedWindowToViewport(page, {
        left: b?.left ?? 0,
        top: b?.top ?? 0,
        width,
        height,
        keepEmulatedViewport: true,
        skipShell: true
    });
    const inner = await readHeadedInnerSize(page);
    const vp = page.viewportSize();
    if (!vp || vp.width !== width || vp.height !== height) {
        await page.setViewportSize({ width, height }).catch(() => { });
    }
    if (inner && inner.height < height - 8) {
        try {
            const { session, windowId } = await openCdpWindowSession(page);
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left: b?.left ?? 0,
                    top: b?.top ?? 0,
                    width: inner.outerWidth,
                    height: inner.outerHeight + (height - inner.height),
                    windowState: 'normal'
                }
            });
            await page.waitForTimeout(40);
            await page.setViewportSize({ width, height }).catch(() => { });
        } catch (_) { /* best-effort */ }
    }
    return { width, height };
}

/**
 * Desktop headed — 1× zoom, no play pan/zoom (reflowOnResize re-applies headed zoom and clips the bottom).
 * Optional FIVE_MP_HEADED_ZOOM=1.15 restores old observer zoom.
 */
async function syncMpHeadedDesktopViewport(page, options = {}) {
    if (!isMpHeaded()) return;
    if (isHeadedMobilePage(page)) {
        await syncMpHeadedMobileViewport(page, options);
        return;
    }
    await alignHeadedPlaywrightViewport(page);
    const envZoom = Number(process.env.FIVE_MP_HEADED_ZOOM || 0);
    const zoom = options.zoom ?? (envZoom > 0 ? envZoom : 1);
    const recenter = zoom > 1.01 && options.recenter !== false;
    await page.evaluate(({ z, recenterTiles }) => {
        window.dispatchEvent(new Event('resize'));
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        if (!win) return;
        win.dispatchEvent(new Event('resize'));
        win.FiveViewport?.syncHubViewport?.();
        const g = win.game;
        const GV = win.GameViewport;
        if (!g || !GV) return;

        g._mobileLayoutAnchorLocked = false;
        if (recenterTiles) {
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
            GV.centerWorldPoint(g, cx, cy);
        }

        g.zoom = z;
        g.targetZoom = z;
        GV.applyPanZoom(g);
        g.requestRender?.();
        g._flushViewport?.();
    }, { z: zoom, recenterTiles: recenter }).catch(() => { });
    await applyHeadedHubShell(page);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))).catch(() => { });
}

/** Resize Playwright viewport + sync desktop headed game at 1× (no reflowOnResize). */
async function syncMpHeadedViewport(page, options = {}) {
    if (!isMpHeaded()) return;
    if (isHeadedMobilePage(page)) {
        await syncMpHeadedMobileViewport(page, options);
        return;
    }
    await syncMpHeadedDesktopViewport(page, options);
}

/**
 * Tile MP windows side-by-side — SP desktop (1920×931) split by player count.
 * Uses CDP outer width so windows sit flush (no desktop gap from chrome frame).
 * @param {import('playwright').Page[]} pages
 */
async function layoutMpHeadedWindows(pages, options = {}) {
    if (!isMpHeaded() || !isHeadedLayoutEnabled()) return;
    const slot = mpHeadedSlotSize(pages.length);
    const width = options.width ?? slot.width;
    const height = options.height ?? slot.height;
    const top = options.top ?? 0;
    const gap = options.gap ?? mpHeadedGap();
    const review = !!options.review;
    let left = 0;
    for (let i = 0; i < pages.length; i++) {
        const slotTag = headedMobileWindowTag(i);
        await markHeadedWindow(pages[i], slotTag);
        await fitHeadedWindowToViewport(pages[i], { left, top, width, height });
        if (review) {
            await syncMpHeadedReviewViewportSize(pages[i]);
        } else {
            await syncMpHeadedViewport(pages[i]);
        }
        const outer = await readHeadedOuterWidth(pages[i]);
        left += (outer ?? width) + gap;
    }
}

/** Re-shrink OS window after setViewportSize expands Chrome past emulator width. */
async function reapplyMobileHeadedAhkIfNeeded(page) {
    if (!isMpHeaded() || !shouldAhkForceMobileHeaded()) return false;
    const { viewport } = getDeviceContextOptions();
    const width = viewport.width;
    const height = viewport.height;
    const { width: outerW, height: outerH } = headedMobileOuterSize();
    try {
        const { session, windowId } = await openCdpWindowSession(page);
        const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
        if (!bounds?.width || bounds.width < width + 24) return false;
        forceChromeWindow({
            width: outerW,
            height: outerH,
            left: bounds.left ?? 0,
            top: bounds.top ?? 0,
            matchRect: {
                left: bounds.left ?? 0,
                top: bounds.top ?? 0,
                width: bounds.width,
                height: bounds.height
            }
        });
        await applyHeadedHubShell(page);
        return true;
    } catch (_) { /* best-effort */ }
    return false;
}

async function syncMpHeadedMobileViewport(page, options = {}) {
    if (!isMpHeaded()) return;
    const { width, height } = await ensureHeadedMobileEmulatedViewport(page, options);
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
    await applyHeadedHubShell(page);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))).catch(() => { });
    const ahkResized = await reapplyMobileHeadedAhkIfNeeded(page);
    const relayoutPages = options.relayoutPages;
    if (ahkResized && relayoutPages?.length > 1) {
        await layoutMpHeadedMobileWindows(relayoutPages);
    }
    if (isHeadedMobileViewportProbeEnabled()) {
        const { assertHeadedMobileEmulatedViewport } = require('./mp-headed-assertions');
        const tag = options.probeLabel || 'syncMpHeadedMobileViewport';
        await assertHeadedMobileEmulatedViewport([page], tag, (m) => console.log(m));
    }
}

/**
 * Re-tile headed MP windows for review (flush side-by-side).
 * Mobile AHK shrinks change outer width without moving later slots — re-layout fixes gaps.
 * @param {import('playwright').Page[]} pages
 * @param {{ mobile?: boolean }} [options]
 */
/** Resize hub + iframe for review without re-applying headed play pan/zoom. */
async function syncMpHeadedReviewViewportSize(page, options = {}) {
    if (!isMpHeaded()) return;
    if (options.mobile || isHeadedMobilePage(page)) {
        await ensureHeadedMobileEmulatedViewport(page, options);
    } else {
        await alignHeadedPlaywrightViewport(page);
    }
    await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
        const win = document.getElementById('game-frame')?.contentWindow;
        win?.dispatchEvent(new Event('resize'));
    }).catch(() => { });
    await applyHeadedHubShell(page);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))).catch(() => { });
}

const headedStepMs = () => Number(process.env.FIVE_MP_HEADED_STEP_MS || 2000);

/** Headed desktop review: 1× zoom + pan only — never _fitReviewViewportOnce (zooms in and clips Done). */
async function applyHeadedDesktopReviewView(page) {
    if (!isMpHeaded()) return;
    const stepMs = headedStepMs();
    await page.waitForFunction(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        return !!(win?.game && win.GameViewport);
    }, undefined, { timeout: stepMs });
    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const GV = win?.GameViewport;
        if (!g || !GV) return;
        g._headedMpReviewLock = true;
        g._mobileLayoutAnchorLocked = false;
        g._reviewFitRetries = 0;
        g._fitZoomInitialized = true;
        g._reviewViewportSettled = true;
        g.zoom = 1;
        g.targetZoom = 1;
        if (typeof g.centerViewOnReviewBoards === 'function') {
            g.centerViewOnReviewBoards();
        } else if (typeof g.centerViewOnOrigin === 'function') {
            g.centerViewOnOrigin();
        }
        GV.applyPanZoom(g);
        g._syncDoneButton?.();
        g.requestRender?.();
    });
}

/** Reset play zoom on every headed desktop client entering review. */
async function resetHeadedDesktopReviewViewport(page) {
    if (!isMpHeaded()) return;
    if (isHeadedMobilePage(page)) {
        await syncMpHeadedMobileViewport(page);
        return;
    }
    await alignHeadedPlaywrightViewport(page);
    await applyHeadedDesktopReviewView(page);
    await applyHeadedHubShell(page);
}

/** Host only — review viewport fit + Done on screen (never use syncMpHeadedViewport here). */
async function syncHeadedHostReviewUi(hostPage) {
    if (!isMpHeaded() || !hostPage) return;
    if (isHeadedMobilePage(hostPage)) {
        await syncMpHeadedMobileViewport(hostPage);
        await hostPage.evaluate(() => {
            const banner = document.getElementById('global-win-banner');
            if (banner) {
                banner.classList.remove('visible', 'is-fitting', 'is-fading-out');
                banner.style.visibility = 'hidden';
            }
            const win = document.getElementById('game-frame')?.contentWindow;
            const g = win?.game;
            if (!g) return;
            g._dismissHubWinBanner?.();
            if (g._isBoardInReview?.() && !g._postGameReview && typeof g._activateReviewUi === 'function') {
                g._activateReviewUi();
            }
            if (typeof g.refreshMobileLayout === 'function') g.refreshMobileLayout();
            else if (typeof g.refreshMobileLayoutViewportOnly === 'function') {
                g.refreshMobileLayoutViewportOnly();
            }
            g._syncDoneButton?.();
            g.requestRender?.();
        }).catch(() => { });
        return;
    }
    await hostPage.evaluate(() => {
        const banner = document.getElementById('global-win-banner');
        if (banner) {
            banner.classList.remove('visible', 'is-fitting', 'is-fading-out');
            banner.style.visibility = 'hidden';
        }
    }).catch(() => { });
    await hostPage.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const GV = win?.GameViewport;
        if (!g || !GV) return;
        g._dismissHubWinBanner?.();
        if (g._isBoardInReview?.() && !g._postGameReview && typeof g._activateReviewUi === 'function') {
            g._activateReviewUi();
        }
        g._headedMpReviewLock = true;
        g._mobileLayoutAnchorLocked = false;
        g._reviewFitRetries = 0;
        g._fitZoomInitialized = true;
        g._reviewViewportSettled = true;
        g.zoom = 1;
        g.targetZoom = 1;
        if (typeof g.centerViewOnReviewBoards === 'function') {
            g.centerViewOnReviewBoards();
        } else if (typeof g.centerViewOnOrigin === 'function') {
            g.centerViewOnOrigin();
        }
        GV.applyPanZoom(g);
        g._syncDoneButton?.();
        g.requestRender?.();
        const doc = document.getElementById('game-frame')?.contentDocument;
        const btn = doc?.getElementById('banana-done-btn');
        if (btn?.classList.contains('show')) {
            btn.style.setProperty('position', 'fixed', 'important');
            btn.style.setProperty('bottom', '24px', 'important');
            btn.style.setProperty('left', '50%', 'important');
            btn.style.setProperty('transform', 'translateX(-50%)', 'important');
            btn.style.setProperty('z-index', '10050', 'important');
        }
    }).catch(() => { });
    await hostPage.waitForFunction(() => {
        const doc = document.getElementById('game-frame')?.contentDocument;
        const btn = doc?.getElementById('banana-done-btn');
        if (!btn?.classList.contains('show')) return false;
        const r = btn.getBoundingClientRect();
        const vh = doc?.defaultView?.innerHeight ?? 0;
        return r.width > 20 && r.height > 20 && r.top >= 0 && r.bottom <= vh + 2;
    }, undefined, { timeout: headedStepMs() }).catch(() => { });
    await hostPage.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => { });
}

async function relayoutMpHeadedForReview(pages, options = {}) {
    if (!isMpHeaded() || !isHeadedLayoutEnabled() || !pages?.length) return;
    const mobile = !!options.mobile;
    if (mobile) {
        await layoutMpHeadedMobileWindows(pages, options);
    } else {
        await layoutMpHeadedWindows(pages, { ...options, review: true });
        await Promise.all(pages.map((p) => resetHeadedDesktopReviewViewport(p)));
    }
    await syncHeadedHostReviewUi(pages[0]);
}

/** Headed desktop review — viewport size + host Done (no headed play zoom reflow). */
async function syncMpHeadedReviewViewport(page, options = {}) {
    if (!isMpHeaded()) return;
    await syncMpHeadedReviewViewportSize(page, options);
    if (options.host) {
        await syncHeadedHostReviewUi(page);
    }
}

/**
 * Headed mobile MP — keep emulated phone viewport (not desktop SP-split tiles).
 * @param {import('playwright').Page[]} pages
 */
async function layoutMpHeadedMobileWindows(pages, options = {}) {
    if (!isMpHeaded() || !isHeadedLayoutEnabled()) return;
    const { viewport } = getDeviceContextOptions(options.deviceOverrides);
    const width = options.width ?? viewport.width;
    const height = options.height ?? viewport.height;
    const top = options.top ?? 0;
    const gap = options.gap ?? mpHeadedGap();
    const layoutSlot = async (page, i, slotLeft) => {
        const slotTag = headedMobileWindowTag(i);
        await markHeadedWindow(page, slotTag);
        await fitHeadedWindowToViewport(page, {
            left: slotLeft,
            top,
            width,
            height,
            keepEmulatedViewport: true
        });
        await syncMpHeadedMobileViewport(page, options);
        const { enableMobileHub } = require('../../platform/mobile/lib/mobile_assertions');
        await enableMobileHub(page).catch(() => { });
        await page.evaluate(() => window.FiveViewport?.syncHubViewport?.()).catch(() => { });
        await maybeForceMobileHeadedWindowViaAhk(page, {
            left: slotLeft,
            top,
            ahkMobile: true,
            windowTag: slotTag
        });
        await applyHeadedHubShell(page);
        return readHeadedOuterWidth(page);
    };
    let left = 0;
    for (let i = 0; i < pages.length; i++) {
        const outer = await layoutSlot(pages[i], i, left);
        left += (outer ?? width) + gap;
    }
    await Promise.all(pages.map((p) => syncMpHeadedMobileViewport(p, options)));
}

/**
 * Headed mixed MP — tile each player window by slot kind (desktop vs mobile).
 * @param {import('playwright').Page[]} pages
 * @param {object} options
 * @param {('desktop'|'mobile')[]} [options.mixedLayout]
 * @param {boolean[]} [options.isMobileSlot]
 */
async function layoutMpHeadedMixedWindows(pages, options = {}) {
    if (!isMpHeaded() || !isHeadedLayoutEnabled()) return;
    const { viewport } = getDeviceContextOptions(options.deviceOverrides);
    const mixedLayout = options.mixedLayout || [];
    const isMobileSlot = options.isMobileSlot || [];
    const desktopSlot = mpHeadedSlotSize(pages.length);
    const desktopW = options.desktopWidth ?? desktopSlot.width;
    const desktopH = options.desktopHeight ?? desktopSlot.height;
    const mobileW = options.mobileWidth ?? viewport.width;
    const mobileH = options.mobileHeight ?? viewport.height;
    const top = options.top ?? 0;
    const gap = options.gap ?? mpHeadedGap();
    let left = 0;
    for (let i = 0; i < pages.length; i++) {
        const mobile = isMobileSlot[i] || mixedLayout[i] === 'mobile';
        const width = mobile ? mobileW : desktopW;
        const viewH = mobile ? mobileH : desktopH;
        if (mobile) await markHeadedWindow(pages[i], headedMobileWindowTag(i));
        await fitHeadedWindowToViewport(pages[i], {
            left,
            top,
            width,
            height: viewH,
            keepEmulatedViewport: mobile
        });
        if (mobile) {
            await syncMpHeadedMobileViewport(pages[i], options);
            const { enableMobileHub } = require('../../platform/mobile/lib/mobile_assertions');
            await enableMobileHub(pages[i]).catch(() => { });
            await pages[i].evaluate(() => window.FiveViewport?.syncHubViewport?.()).catch(() => { });
            await maybeForceMobileHeadedWindowViaAhk(pages[i], {
                left,
                top,
                ahkMobile: true,
                windowTag: headedMobileWindowTag(i)
            });
            await applyHeadedHubShell(pages[i]);
        } else {
            await syncMpHeadedViewport(pages[i]);
        }
        const outer = await readHeadedOuterWidth(pages[i]);
        left += (outer ?? width) + gap;
    }
}

/**
 * Pan/zoom so the current rack/board is in frame for human observers.
 * Works on hub pages (game in #game-frame iframe) or direct game pages.
 * @param {import('playwright').Page} page
 */
async function centerMpViewerOnPage(page, options = {}) {
    if (!isMpHeaded() || !isHeadedCenterEnabled()) return;
    const mobile = options.mobile ?? isHeadedMobilePage(page);
    if (mobile) {
        await syncMpHeadedMobileViewport(page, options);
        return;
    }
    await syncMpHeadedDesktopViewport(page, options);
}

/** @param {import('playwright').Page[]} pages */
async function centerMpViewerOnPages(pages, options = {}) {
    if (!isMpHeaded()) return;
    await Promise.all(pages.map((p) => centerMpViewerOnPage(p, options)));
}

module.exports = {
    isMpHeaded,
    SP_DESKTOP_VIEWPORT,
    MP_HEADED_WIDTH,
    MP_HEADED_HEIGHT,
    mpHeadedBaseSize,
    mpHeadedSlotSize,
    mpHeadedViewportSize,
    mpHeadedContextOpts,
    applyHeadedHubShell,
    enableHeadedHubChat,
    fitHeadedWindowToViewport,
    syncMpHeadedViewport,
    syncMpHeadedDesktopViewport,
    syncMpHeadedMobileViewport,
    syncMpHeadedReviewViewport,
    relayoutMpHeadedForReview,
    applyHeadedDesktopReviewView,
    syncHeadedHostReviewUi,
    mpHeadedGap,
    readHeadedWindowBounds,
    readHeadedOuterWidth,
    layoutMpHeadedWindows,
    layoutMpHeadedMobileWindows,
    layoutMpHeadedMixedWindows,
    centerMpViewerOnPage,
    centerMpViewerOnPages
};
