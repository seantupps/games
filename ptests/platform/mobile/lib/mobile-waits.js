/**
 * Event-based waits for mobile Playwright (no arbitrary page.waitForTimeout).
 */
const { DEFAULT_MS } = require('./mobile-constants');

function withTimeout(promise, ms, label) {
    const deadline = ms || DEFAULT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label || 'step'} timed out after ${deadline}ms`));
        }, deadline);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForVisible(page, selector, ms = DEFAULT_MS) {
    await page.locator(selector).waitFor({ state: 'visible', timeout: ms });
}

async function waitForHidden(page, selector, ms = DEFAULT_MS) {
    await page.locator(selector).waitFor({ state: 'hidden', timeout: ms });
}

/** Hub settings sidebar state for failure logs. */
async function snapshotHubSettingsState(page) {
    const frameUrls = page.frames().map((f) => f.url());
    const hub = await page.evaluate(() => {
        const el = document.getElementById('settings-sidebar');
        const style = el ? getComputedStyle(el) : null;
        const rect = el?.getBoundingClientRect();
        return {
            room: new URL(location.href).searchParams.get('room'),
            fiveMobile: document.documentElement.classList.contains('five-mobile'),
            sidebarExists: !!el,
            sidebarOpenClass: !!el?.classList.contains('open'),
            settingsOpenLs: localStorage.getItem('settingsOpen'),
            sidebarDisplay: style?.display ?? null,
            sidebarLeft: style?.left ?? null,
            sidebarLeftPx: rect ? Math.round(rect.left) : null,
            sidebarWidth: rect ? Math.round(rect.width) : null,
            mobileBarVisible: (() => {
                const b = document.getElementById('mobile-bar');
                return b && getComputedStyle(b).display !== 'none';
            })(),
            hasToggleSidebar: typeof window.toggleSidebar === 'function',
            hasMuteDismiss: typeof window.muteHubOverlayDismiss === 'function',
            gameFrameSrc: document.getElementById('game-frame')?.src?.slice(-80) ?? null
        };
    }).catch((e) => ({ evaluateError: e.message }));
    return { frameUrls, hub };
}

function settingsWaitError(wantOpen, ms, cause, snapshot) {
    const lines = [
        `settings-sidebar: expected open=${wantOpen}, timed out after ${ms}ms`,
        cause?.message ? `cause: ${cause.message}` : '',
        `snapshot: ${JSON.stringify(snapshot, null, 2)}`
    ].filter(Boolean);
    const err = new Error(lines.join('\n'));
    err.wantOpen = wantOpen;
    err.snapshot = snapshot;
    if (cause?.stack) err.stack = `${err.stack}\n--- caused by ---\n${cause.stack}`;
    return err;
}

async function waitForSettingsSidebar(page, open, ms = DEFAULT_MS) {
    try {
        await page.waitForFunction((wantOpen) => {
            const el = document.getElementById('settings-sidebar');
            if (!el || el.classList.contains('open') !== wantOpen) return false;
            if (!wantOpen) return true;
            if (!document.documentElement.classList.contains('five-mobile')) return true;
            const left = parseFloat(getComputedStyle(el).left);
            return Number.isFinite(left) && left >= -4;
        }, open, { timeout: ms });
    } catch (cause) {
        throw settingsWaitError(open, ms, cause, await snapshotHubSettingsState(page));
    }
}

async function waitForImmersiveOrFullscreen(page, ms = DEFAULT_MS) {
    await page.waitForFunction(() => {
        const hub = document.getElementById('game-hub-container');
        return document.documentElement.classList.contains('mobile-hub-immersive')
            || hub?.classList.contains('mobile-immersive')
            || !!document.fullscreenElement;
    }, { timeout: ms });
}

async function waitForGameTargetZoom(page, mode, zRef, minDelta, ms = DEFAULT_MS) {
    await page.waitForFunction(({ mode, zRef, minDelta }) => {
        const z = document.getElementById('game-frame')?.contentWindow?.game?.targetZoom;
        if (typeof z !== 'number') return false;
        if (mode === 'above') return z > zRef + minDelta;
        if (mode === 'below') return z < zRef - minDelta;
        return false;
    }, { mode, zRef, minDelta }, { timeout: ms });
}

async function waitForLobbyShowsName(page, name, ms = DEFAULT_MS) {
    await page.waitForFunction((n) => {
        const names = [...document.querySelectorAll('#player-list .player-name')]
            .map((el) => el.innerText.trim());
        return names.some((text) => text.includes(n));
    }, name, { timeout: ms });
}

async function waitForLinePreview(page, ms = DEFAULT_MS) {
    await page.waitForFunction(() => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        return !!doc?.querySelector('line.preview');
    }, undefined, { timeout: ms });
}

async function waitForLinePathInFrame(page, minLen = 1, ms = DEFAULT_MS) {
    await page.waitForFunction((minLen) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && Array.isArray(g.path) && g.path.length >= minLen;
    }, minLen, { timeout: ms });
}

async function waitForOpponentPreviewLine(page, ms = DEFAULT_MS) {
    await page.waitForFunction(() => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        return !!doc?.querySelector('line.preview-opponent');
    }, undefined, { timeout: ms });
}

async function waitForOpponentPreviewGone(page, ms = DEFAULT_MS) {
    await page.waitForFunction(() => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        return doc && !doc.querySelector('line.preview-opponent');
    }, undefined, { timeout: ms });
}

async function waitForGameBoardFits(page, margin = 8, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (win?.document.getElementById('line-canvas') && g?.fitBoardToViewport) {
            g.fitBoardToViewport();
        } else if (g?.refreshMobileLayout) {
            g.refreshMobileLayout();
        } else if (g?.safeRender) {
            g.safeRender();
        }
    });

    await withTimeout(
        page.waitForFunction((margin) => {
            const win = document.getElementById('game-frame')?.contentWindow;
            const doc = win?.document;
            if (!win || !doc) return false;
            const vw = win.innerWidth;
            const vh = win.innerHeight;
            const container = doc.getElementById('game-container');
            if (!container) return false;
            const isLine = !!doc.getElementById('line-canvas');
            if (isLine) {
                const cr = container.getBoundingClientRect();
                const cx = (cr.left + cr.right) / 2;
                const cy = (cr.top + cr.bottom) / 2;
                if (cx < margin || cx > vw - margin || cy < margin || cy > vh - margin) return false;
            }
            for (const p of doc.querySelectorAll('.piece')) {
                const r = p.getBoundingClientRect();
                if (r.right < -margin || r.left > vw + margin || r.bottom < -margin || r.top > vh + margin) {
                    return false;
                }
            }
            return true;
        }, margin, { timeout: ms }),
        ms + 800,
        'board fits viewport'
    );
}

async function waitForTurnAdvancedOrCleared(page, ms = DEFAULT_MS) {
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?._longPressProbe) return false;
        const { turnBefore, selectionLenBefore } = g._longPressProbe;
        return g.turn !== turnBefore || (g.selection?.ids?.length ?? 0) !== selectionLenBefore;
    }, { timeout: ms });
}

async function applyPinchZoomRatio(page, ratio, baseZoom) {
    await page.evaluate(({ ratio, baseZoom }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        win?.postMessage({ type: 'pinch-zoom-set', zoom: baseZoom * ratio }, '*');
    }, { ratio, baseZoom });
    const mode = ratio > 1 ? 'above' : 'below';
    const minDelta = 0.01;
    await waitForGameTargetZoom(page, mode, baseZoom, Math.abs(baseZoom * (ratio - 1)) * 0.5 || minDelta, DEFAULT_MS);
}

module.exports = {
    waitForVisible,
    waitForHidden,
    snapshotHubSettingsState,
    waitForSettingsSidebar,
    waitForImmersiveOrFullscreen,
    waitForGameTargetZoom,
    waitForLobbyShowsName,
    waitForLinePreview,
    waitForLinePathInFrame,
    waitForOpponentPreviewLine,
    waitForOpponentPreviewGone,
    waitForGameBoardFits,
    waitForTurnAdvancedOrCleared,
    applyPinchZoomRatio
};
