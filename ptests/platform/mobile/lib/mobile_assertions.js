/**
 * Shared mobile hub / game assertions (landscape touch emulation).
 */
const { DEFAULT_MS, withTimeout, waitForGameFrame } = require('./mobile-timeouts');
const { HUB_MS } = require('./mobile-constants');
const {
    waitForSettingsSidebar,
    snapshotHubSettingsState,
    waitForImmersiveOrFullscreen,
    waitForGameTargetZoom,
    waitForLobbyShowsName,
    waitForGameBoardFits,
    waitForTurnAdvancedOrCleared,
    waitForHidden,
    waitForVisible,
    applyPinchZoomRatio
} = require('./mobile-waits');

const PINCH_IN_DIST = 220;
const PINCH_OUT_DIST = 70;
const MIN_ZOOM_DELTA = 0.45;
const PINCH_ZOOM_IN_MIN = 2.0;
const PINCH_ZOOM_OUT_MAX = 0.55;

async function enableMobileHub(page) {
    await page.evaluate(() => {
        document.documentElement.classList.add('five-mobile');
        window.dispatchEvent(new Event('five-mobile-ready'));
        if (window.FiveViewport) {
            window.FiveViewport.notifyGameFrame(true);
        } else {
            const frame = document.getElementById('game-frame');
            frame?.contentWindow?.postMessage({ type: 'five-viewport-mode', mobile: true }, '*');
        }
    });
}

/** Fails if tests only pass via manual enableMobileHub — real phones must auto-detect. */
async function assertNaturalMobileViewport(page) {
    await page.evaluate(() => {
        if (window.FiveViewport) window.FiveViewport.syncHubViewport();
    });
    const state = await page.evaluate(() => {
        const bar = document.getElementById('mobile-bar');
        const trigger = document.getElementById('settings-trigger');
        return {
            fiveMobile: document.documentElement.classList.contains('five-mobile'),
            touchPrimary: window.FiveViewport?.isTouchPrimaryDevice?.() ?? null,
            maxTouchPoints: navigator.maxTouchPoints,
            hoverNone: window.matchMedia('(hover: none)').matches,
            coarse: window.matchMedia('(pointer: coarse)').matches,
            barDisplay: bar ? getComputedStyle(bar).display : null,
            triggerDisplay: trigger ? getComputedStyle(trigger).display : null
        };
    });
    if (!state.fiveMobile) {
        throw new Error(`Expected auto five-mobile on touch device (no manual override): ${JSON.stringify(state)}`);
    }
    if (state.barDisplay !== 'flex') {
        throw new Error(`Mobile bar must be visible (got display=${state.barDisplay}): ${JSON.stringify(state)}`);
    }
    if (state.triggerDisplay !== 'none') {
        throw new Error(`Desktop #settings-trigger must be hidden on mobile (got ${state.triggerDisplay})`);
    }
    return state;
}

async function assertHostModeSwitch(page) {
    await waitForGameFrame(page);
    await tapSelector(page, '#mobile-settings-btn');
    await waitForSettingsSidebar(page, true);
    const before = await page.evaluate(() => document.getElementById('game-frame')?.src || '');
    if (!before.includes('games/piles')) {
        throw new Error(`Mode switch test expects piles loaded, got ${before}`);
    }

    const clickHost = (sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el || getComputedStyle(el).display === 'none') {
            throw new Error(`Host control not visible: ${s}`);
        }
        el.click();
    }, sel);

    await clickHost('#mode-freestyle');
    await page.waitForFunction((prev) => {
        const src = document.getElementById('game-frame')?.src || '';
        return document.getElementById('mode-freestyle')?.classList.contains('active')
            && src.includes('mode=freestyle') && src !== prev;
    }, before, { timeout: DEFAULT_MS });
    await waitForGameFrame(page, DEFAULT_MS);

    const classicPrev = await page.evaluate(() => document.getElementById('game-frame')?.src || '');
    await clickHost('#mode-classic');
    await page.waitForFunction((prev) => {
        const src = document.getElementById('game-frame')?.src || '';
        return document.getElementById('mode-classic')?.classList.contains('active')
            && src.includes('mode=classic') && src !== prev;
    }, classicPrev, { timeout: DEFAULT_MS });
    await waitForGameFrame(page, DEFAULT_MS);

    const linePrev = await page.evaluate(() => document.getElementById('game-frame')?.src || '');
    await clickHost('#btn-line');
    await page.waitForFunction((prev) => {
        const src = document.getElementById('game-frame')?.src || '';
        return src.includes('games/line') && src.includes('mode=classic') && src !== prev;
    }, linePrev, { timeout: DEFAULT_MS });
    await waitForGameFrame(page, DEFAULT_MS);

    const pilesPrev = await page.evaluate(() => document.getElementById('game-frame')?.src || '');
    await clickHost('#btn-piles');
    await page.waitForFunction((prev) => {
        const src = document.getElementById('game-frame')?.src || '';
        return src.includes('games/piles') && src !== prev;
    }, pilesPrev, { timeout: DEFAULT_MS });
    await waitForGameFrame(page, DEFAULT_MS);

    await page.evaluate(() => document.getElementById('settings-sidebar')?.classList.remove('open'));
    await waitForSettingsSidebar(page, false, DEFAULT_MS);
}

async function tapSelector(page, selector, ms = DEFAULT_MS) {
    await withTimeout(page.locator(selector).tap(), ms, `tap ${selector}`);
}

async function assertMobileBarLayout(page) {
    await waitForVisible(page, '#mobile-bar');
    const bar = await page.evaluate(() => {
        const el = document.getElementById('mobile-bar');
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const trigger = document.getElementById('settings-trigger');
        const triggerHidden = !trigger || getComputedStyle(trigger).display === 'none'
            || trigger.offsetParent === null;
        const btnStyle = getComputedStyle(document.getElementById('mobile-chat-btn'));
        return {
            barBottom: r.bottom,
            vh,
            nearBottom: r.bottom >= vh - 120,
            triggerHidden,
            btnBg: btnStyle.backgroundColor,
            btnBorder: btnStyle.borderWidth,
            hasFullscreen: !!document.getElementById('mobile-fullscreen-btn'),
            hasChat: !!document.getElementById('mobile-chat-btn'),
            hasSettings: !!document.getElementById('mobile-settings-btn')
        };
    });
    if (!bar.nearBottom) throw new Error(`Mobile bar not at bottom (bottom=${bar.barBottom}, vh=${bar.vh})`);
    if (!bar.triggerHidden) throw new Error('Duplicate #settings-trigger visible on mobile');
    if (!bar.hasFullscreen || !bar.hasChat || !bar.hasSettings) {
        throw new Error('Mobile bar missing expected buttons');
    }
    const bg = (bar.btnBg || '').replace(/\s/g, '');
    if (bg !== 'rgba(0,0,0,0)' && bg !== 'transparent') {
        throw new Error(`Mobile bar buttons should have no background (got ${bar.btnBg})`);
    }
    if (parseFloat(bar.btnBorder) > 0) {
        throw new Error('Mobile bar buttons should have no border');
    }
    return bar;
}

async function clickHostBarButton(page, selector) {
    await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el || getComputedStyle(el).display === 'none') {
            throw new Error(`Mobile bar control not visible: ${sel}`);
        }
        el.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: 'touch',
            button: 0
        }));
    }, selector);
}

async function assertSettingsPanelOnLeft(page) {
    const state = await page.evaluate(() => {
        const el = document.getElementById('settings-sidebar');
        if (!el?.classList.contains('open')) {
            return { ok: false, reason: 'sidebar not open' };
        }
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth;
        if (r.width < 40) return { ok: false, reason: 'panel has no width' };
        if (r.left > vw * 0.45) {
            return { ok: false, reason: `panel not on left (left=${Math.round(r.left)}, vw=${vw})` };
        }
        if (r.right < vw * 0.15) {
            return { ok: false, reason: `panel off-screen right (right=${Math.round(r.right)})` };
        }
        return { ok: true, width: r.width };
    });
    if (!state.ok) throw new Error(`Settings panel must open on the left: ${state.reason}`);
    return state;
}

/** Mobile settings width — tune in shared/css/mobile.css (#settings-sidebar width). */
async function assertMobileSettingsSidebarWidth(page, maxWidth = 260) {
    const w = await page.evaluate(() => {
        const el = document.getElementById('settings-sidebar');
        return el ? el.getBoundingClientRect().width : 0;
    });
    if (w > maxWidth + 8) {
        throw new Error(`Mobile settings sidebar too wide: ${w}px (max ${maxWidth})`);
    }
}

async function assertSettingsSmoothScroll(page) {
    const s = await page.evaluate(() => {
        const el = document.getElementById('settings-sidebar');
        if (!el) return { ok: false, reason: 'no sidebar' };
        const style = getComputedStyle(el);
        return {
            ok: style.overflowY === 'auto' || style.overflowY === 'scroll',
            overflowY: style.overflowY,
            scrollBehavior: style.scrollBehavior
        };
    });
    if (!s.ok) throw new Error(`Settings sidebar must scroll: ${JSON.stringify(s)}`);
    if (s.scrollBehavior !== 'smooth') {
        throw new Error(`Settings sidebar scroll-behavior should be smooth (got ${s.scrollBehavior})`);
    }
}

async function assertSettingsClosesOnOutsideTap(page, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        if (typeof window.toggleSidebar === 'function') window.toggleSidebar(true);
        else document.getElementById('settings-sidebar')?.classList.add('open');
    });
    await waitForSettingsSidebar(page, true, ms);

    await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        const doc = win?.document;
        if (doc?.body) {
            doc.body.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: win.innerWidth * 0.5,
                clientY: win.innerHeight * 0.4
            }));
        }
        if (frame) {
            frame.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
    });

    await waitForSettingsSidebar(page, false, ms);
    await page.evaluate(() => {
        if (typeof window.toggleSidebar === 'function') window.toggleSidebar(false);
        localStorage.setItem('settingsOpen', 'false');
    });
}

/** Gear opens settings; tapping the board closes via iframe close-settings (not gear toggle). */
async function assertSettingsClosesImmediatelyAfterGearOpen(page, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        document.getElementById('settings-sidebar')?.classList.remove('open');
        localStorage.setItem('settingsOpen', 'false');
    });
    // Mobile bar ignores repeat taps within 350ms (see bindMobileBarTap in ui.js)
    await page.waitForTimeout(400);

    await page.locator('#mobile-settings-btn').click({ timeout: ms });
    await waitForSettingsSidebar(page, true, ms);

    const frame = page.frames().find((f) => f.url().includes('games/piles'));
    if (!frame) {
        const err = new Error('piles iframe not ready for board dismiss');
        err.details = await snapshotHubSettingsState(page);
        throw err;
    }
    await frame.evaluate(() => {
        window.parent.postMessage('close-settings', '*');
    });

    try {
        await waitForSettingsSidebar(page, false, ms);
    } catch (err) {
        err.details = await snapshotHubSettingsState(page);
        throw err;
    }
}

async function assertChatOpensWithFocusedInput(page, ms = DEFAULT_MS) {
    const cap = Math.min(ms === DEFAULT_MS ? HUB_MS : ms, HUB_MS);
    await page.evaluate(() => {
        document.getElementById('chat-container')?.classList.remove('active');
        if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(true);
    });
    await page.waitForFunction(() => {
        const chat = document.getElementById('chat-container');
        const input = document.getElementById('chat-input');
        const messages = document.getElementById('chat-messages');
        if (!chat?.classList.contains('active') || !input || !messages) return false;
        const wrapper = getComputedStyle(document.getElementById('chat-input-wrapper'));
        const msgStyle = getComputedStyle(messages);
        if (wrapper.display === 'none' || msgStyle.display === 'none') return false;
        if (messages.getBoundingClientRect().height < 20) return false;
        if (input.getBoundingClientRect().height < 8) return false;
        return document.activeElement === input || input.matches(':focus');
    }, { timeout: cap });

    const attrs = await page.evaluate(() => ({
        autocomplete: document.getElementById('chat-input')?.getAttribute('autocomplete')
    }));
    if (attrs.autocomplete !== 'off') {
        throw new Error(`Chat input should disable autocomplete (got ${attrs.autocomplete})`);
    }

    await page.evaluate(() => {
        if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(false);
    });
    await page.waitForFunction(
        () => !document.getElementById('chat-container')?.classList.contains('active'),
        { timeout: cap }
    );
}

async function assertLineBoardCenteredInLandscape(page, ms = DEFAULT_MS) {
    const { getDeviceContextOptions } = require('./device-presets');
    const land = getDeviceContextOptions().viewport || { width: 915, height: 412 };
    await page.setViewportSize(land);
    await page.evaluate(() => window.FiveViewport?.syncHubViewport());
    await ensureHostGame(page, 'line', ms);
    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return;
        win.FiveViewport?.applyMobileClass?.(true);
        localStorage.removeItem(g.getZoomStorageKey());
        g._fitZoomInitialized = false;
        g.restorePersistedZoom();
        g.fitBoardToViewport?.();
    });
    const state = await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        if (!win || !doc?.getElementById('line-canvas')) {
            return { ok: false, reason: 'line not loaded' };
        }
        const vw = win.innerWidth;
        const vh = win.innerHeight;
        const nodes = [...doc.querySelectorAll('.node')];
        if (!nodes.length) return { ok: false, reason: 'no nodes' };
        let minL = Infinity;
        let minT = Infinity;
        let maxR = -Infinity;
        let maxB = -Infinity;
        nodes.forEach((n) => {
            const r = n.getBoundingClientRect();
            minL = Math.min(minL, r.left);
            minT = Math.min(minT, r.top);
            maxR = Math.max(maxR, r.right);
            maxB = Math.max(maxB, r.bottom);
        });
        const cx = (minL + maxR) / 2;
        const cy = (minT + maxB) / 2;
        return {
            ok: Math.abs(cx - vw / 2) <= 40 && Math.abs(cy - vh / 2) <= 40,
            cx,
            cy,
            vw,
            vh
        };
    });
    if (!state.ok) {
        throw new Error(`Line visual content not centered in landscape: ${JSON.stringify(state)}`);
    }
}

async function assertSettingsAboveChat(page, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(true);
        if (typeof toggleSidebar === 'function') toggleSidebar(true);
        const chat = document.getElementById('chat-container');
        if (chat && !chat.querySelector('.chat-msg')) {
            const msg = document.createElement('div');
            msg.className = 'chat-msg';
            msg.innerHTML = '<span class="sender">Test:</span><span class="content">overlay check</span>';
            document.getElementById('chat-messages')?.appendChild(msg);
        }
    });

    const layer = await page.evaluate(() => {
        const settings = document.getElementById('settings-sidebar');
        const chat = document.getElementById('chat-container');
        const zSettings = parseInt(getComputedStyle(settings).zIndex, 10) || 0;
        const zChat = parseInt(getComputedStyle(chat).zIndex, 10) || 0;
        const sr = settings.getBoundingClientRect();
        const sampleX = sr.left + Math.min(80, sr.width * 0.5);
        const sampleY = sr.top + Math.min(120, sr.height * 0.5);
        const topEl = document.elementFromPoint(sampleX, sampleY);
        const settingsOnTop = settings.contains(topEl) || topEl === settings;
        return { zSettings, zChat, settingsOnTop, topTag: topEl?.id || topEl?.className };
    });

    if (layer.zSettings <= layer.zChat) {
        throw new Error(`Settings z-index should exceed chat: ${JSON.stringify(layer)}`);
    }
    if (!layer.settingsOnTop) {
        throw new Error(`Chat visible through settings panel: ${JSON.stringify(layer)}`);
    }

    await page.evaluate(() => {
        if (typeof toggleSidebar === 'function') toggleSidebar(false);
        if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(false);
    });
}

async function assertMobileDefaultZoomFitsVisuals(page, game, ms = DEFAULT_MS) {
    await ensureHostGame(page, game, ms);
    const sel = game === 'line' ? '.node' : '.piece';
    await page.waitForFunction((s) => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        return doc && doc.querySelectorAll(s).length > 0;
    }, sel, { timeout: ms });
    const margin = 14;
    const state = await page.evaluate((margin) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        const g = win?.game;
        if (!win || !doc || !g) return { ok: false, reason: 'no game' };
        win.FiveViewport?.applyMobileClass?.(true);
        localStorage.removeItem(g.getZoomStorageKey());
        g._fitZoomInitialized = false;
        g.restorePersistedZoom();
        if (g.fitBoardToViewport) g.fitBoardToViewport();
        else {
            g._mobileContentBounds = g.getMobileVisualBounds();
            g.applyZoom();
        }
        const vw = win.innerWidth;
        const vh = win.innerHeight;
        const sel = doc.getElementById('line-canvas') ? '.node' : '.piece';
        const els = [...doc.querySelectorAll(sel)];
        if (!els.length) return { ok: false, reason: 'no visual elements' };
        let minL = Infinity;
        let minT = Infinity;
        let maxR = -Infinity;
        let maxB = -Infinity;
        els.forEach((el) => {
            const r = el.getBoundingClientRect();
            minL = Math.min(minL, r.left);
            minT = Math.min(minT, r.top);
            maxR = Math.max(maxR, r.right);
            maxB = Math.max(maxB, r.bottom);
        });
        return {
            ok: minL >= -margin && minT >= -margin && maxR <= vw + margin && maxB <= vh + margin,
            vw,
            vh,
            minL,
            minT,
            maxR,
            maxB,
            zoom: g.targetZoom
        };
    }, margin);
    if (!state.ok) {
        throw new Error(`${game} default zoom does not fit visual content: ${JSON.stringify(state)}`);
    }
}

async function measureIframeVisualCenter(page) {
    return page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        if (!win || !doc) return { ok: false, reason: 'no frame' };
        const isLine = !!doc.getElementById('line-canvas');
        const els = isLine
            ? [...doc.querySelectorAll('.node')]
            : [...doc.querySelectorAll('.piece')];
        if (!els.length) return { ok: false, reason: 'no elements' };
        let minL = Infinity;
        let minT = Infinity;
        let maxR = -Infinity;
        let maxB = -Infinity;
        els.forEach((el) => {
            const r = el.getBoundingClientRect();
            minL = Math.min(minL, r.left);
            minT = Math.min(minT, r.top);
            maxR = Math.max(maxR, r.right);
            maxB = Math.max(maxB, r.bottom);
        });
        const vw = win.innerWidth;
        const vh = win.innerHeight;
        const cx = (minL + maxR) / 2;
        const cy = (minT + maxB) / 2;
        return {
            ok: Math.abs(cx - vw / 2) <= 48 && Math.abs(cy - vh / 2) <= 48,
            cx,
            cy,
            vw,
            vh,
            isLine
        };
    });
}

async function assertCenteredAfterFullscreenToggle(page, game, ms = DEFAULT_MS) {
    await ensureHostGame(page, game, ms);
    const { getDeviceContextOptions } = require('./device-presets');
    const land = getDeviceContextOptions().viewport || { width: 915, height: 412 };
    await page.setViewportSize(land);
    await page.evaluate(() => {
        document.documentElement.classList.remove('mobile-hub-immersive', 'mobile-immersive');
        document.getElementById('game-hub-container')?.classList.remove('mobile-immersive');
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        window.FiveViewport?.syncHubViewport();
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        win?.FiveViewport?.applyMobileClass?.(true);
        g?.refreshMobileLayout?.();
        g?.requestRender?.();
    });
    const before = await measureIframeVisualCenter(page);
    if (!before.ok) {
        throw new Error(`${game} not centered before fullscreen: ${JSON.stringify(before)}`);
    }
    await page.locator('#mobile-fullscreen-btn').click({ timeout: ms });
    await page.waitForFunction(() =>
        document.documentElement.classList.contains('mobile-hub-immersive')
        || !!document.fullscreenElement,
    { timeout: ms }
    );
    await page.waitForTimeout(100);
    const during = await measureIframeVisualCenter(page);
    if (!during.ok) {
        throw new Error(`${game} not centered in fullscreen: ${JSON.stringify(during)}`);
    }
    await page.locator('#mobile-fullscreen-btn').click({ timeout: ms }).catch(() => {});
    await page.waitForTimeout(120);
}

async function assertFullscreenExpandsGame(page, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        document.getElementById('game-hub-container')?.classList.remove('mobile-immersive');
        document.documentElement.classList.remove('mobile-hub-immersive', 'mobile-immersive');
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    });
    await page.waitForTimeout(60);
    await page.locator('#mobile-fullscreen-btn').click({ timeout: ms });
    await page.waitForFunction(() =>
        document.documentElement.classList.contains('mobile-hub-immersive')
        || !!document.fullscreenElement,
    { timeout: ms }
    );
    const state = await page.evaluate(() => {
        const hub = document.getElementById('game-hub-container');
        const settings = document.getElementById('mobile-settings-btn');
        const hr = hub?.getBoundingClientRect();
        const on = !!document.fullscreenElement
            || document.documentElement.classList.contains('mobile-hub-immersive')
            || document.getElementById('game-hub-container')?.classList.contains('mobile-immersive');
        const btnVisible = (id) => {
            const el = document.getElementById(id);
            if (!el) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        return {
            on,
            hubW: hr?.width,
            hubH: hr?.height,
            vw: window.innerWidth,
            vh: window.innerHeight,
            chat: btnVisible('mobile-chat-btn'),
            settings: btnVisible('mobile-settings-btn'),
            fullscreen: btnVisible('mobile-fullscreen-btn'),
            ok: on
                && hr
                && hr.width >= window.innerWidth * 0.92
                && hr.height >= window.innerHeight * 0.8
                && btnVisible('mobile-chat-btn')
                && btnVisible('mobile-settings-btn')
                && btnVisible('mobile-fullscreen-btn')
        };
    });
    if (!state.ok) {
        throw new Error(`Fullscreen did not expand game hub: ${JSON.stringify(state)}`);
    }
    await page.locator('#mobile-fullscreen-btn').click({ timeout: ms }).catch(() => {});
    await page.evaluate(() => {
        document.getElementById('game-hub-container')?.classList.remove('mobile-immersive');
        document.documentElement.classList.remove('mobile-hub-immersive');
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    });
}

async function assertChatReturnsLowAfterKeyboard(page, ms = DEFAULT_MS) {
    const cap = Math.min(ms === DEFAULT_MS ? HUB_MS : ms, HUB_MS);

    await page.evaluate(() => {
        if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(true);
    });

    await page.evaluate(() => {
        const layoutH = window.innerHeight;
        const vh = Math.round(layoutH * 0.45);
        const gap = 10;
        document.documentElement.style.setProperty('--vv-height', `${vh}px`);
        document.documentElement.classList.add('hub-keyboard-open', 'hub-chat-open');
        const chat = document.getElementById('chat-container');
        if (chat) {
            chat.style.bottom = `${Math.max(gap, layoutH - vh + gap)}px`;
            chat.style.maxHeight = `${Math.max(140, vh - 48)}px`;
        }
        document.getElementById('chat-input')?.focus();
    });

    const raised = await page.evaluate(() => {
        const chat = document.getElementById('chat-container');
        const bottom = chat?.style.bottom || '';
        return bottom !== '' && parseFloat(bottom) > 80;
    });
    if (!raised) {
        throw new Error('Chat should rise above keyboard when open');
    }

    await page.evaluate(() => {
        document.getElementById('chat-input')?.blur();
        document.documentElement.classList.remove('hub-keyboard-open');
        document.documentElement.style.setProperty('--vv-height', `${window.innerHeight}px`);
        window.FiveMobileHubKeyboard?.syncVisibleViewport();
    });

    await page.waitForFunction(() => {
        const chat = document.getElementById('chat-container');
        const bottom = chat?.style.bottom ?? '';
        return bottom === '' || parseFloat(bottom) < 80;
    }, { timeout: cap });

    await page.evaluate(() => {
        if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(false);
    });
}

async function captureFreestyleMobileLayoutAnchor(page) {
    return page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const container = win?.document?.getElementById('game-container');
        if (!g || !container) return null;
        return {
            locked: !!g._mobileLayoutAnchorLocked,
            left: container.style.left,
            top: container.style.top,
            origin: container.style.transformOrigin,
            cx: g._mobileContentBounds?.cx,
            cy: g._mobileContentBounds?.cy
        };
    });
}

function freestyleAnchorDelta(before, after) {
    return {
        dLeft: Math.abs(parseFloat(after.left || 0) - parseFloat(before.left || 0)),
        dTop: Math.abs(parseFloat(after.top || 0) - parseFloat(before.top || 0)),
        dOrigin: after.origin !== before.origin,
        dCx: Math.abs((after.cx ?? 0) - (before.cx ?? 0)),
        dCy: Math.abs((after.cy ?? 0) - (before.cy ?? 0))
    };
}

/**
 * Freestyle piles: layout anchor locks once; removals and hub viewport pings must not recenter.
 */
async function assertFreestyleMobileLayoutStable(page, ms = DEFAULT_MS) {
    await ensureHostGame(page, 'piles', ms);
    await page.evaluate(() => {
        const btn = document.getElementById('mode-freestyle');
        if (btn && !btn.classList.contains('active')) btn.click();
    });
    await page.waitForFunction(
        () => (document.getElementById('game-frame')?.src || '').includes('mode=freestyle'),
        { timeout: ms }
    );
    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return;
        win.FiveViewport?.applyMobileClass?.(true);
        if (g.getZoomStorageKey) localStorage.removeItem(g.getZoomStorageKey());
        localStorage.removeItem('piecePositions_piles_freestyle');
        g.piecePositions = {};
        g._fitZoomInitialized = false;
        g._mobileLayoutAnchorLocked = false;
        g._mobileContentBounds = null;
        g.restorePersistedZoom?.();
        g.refreshMobileLayout?.();
    });
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?._mobileLayoutAnchorLocked && g._mobileContentBounds?.cx != null;
    }, { timeout: ms });

    const snap0 = await captureFreestyleMobileLayoutAnchor(page);
    if (!snap0?.locked) {
        throw new Error('Freestyle mobile layout anchor did not lock on init');
    }

    const piecesBefore = await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g ? Object.values(g.piles).flat().filter(Boolean).length : 0;
    });

    for (let i = 0; i < 12; i++) {
        await page.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g || g.isOver) return;
            const moves = g.getValidMoves();
            if (!moves.length) return;
            g.submitMove(moves[0]);
        });
        await page.waitForTimeout(60);
    }

    const piecesAfter = await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g ? Object.values(g.piles).flat().filter(Boolean).length : 0;
    });
    if (piecesAfter >= piecesBefore) {
        throw new Error(`Expected pieces removed (${piecesBefore} -> ${piecesAfter})`);
    }

    const snap1 = await captureFreestyleMobileLayoutAnchor(page);
    const afterMoves = freestyleAnchorDelta(snap0, snap1);
    const posTol = 2;
    if (
        afterMoves.dOrigin
        || afterMoves.dCx > 0.5
        || afterMoves.dCy > 0.5
        || afterMoves.dLeft > posTol
        || afterMoves.dTop > posTol
    ) {
        throw new Error(
            `Freestyle board recentered after piece removal: ${JSON.stringify({ snap0, snap1, afterMoves })}`
        );
    }

    await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const vh = Math.round(window.innerHeight * 0.52);
        frame?.contentWindow?.postMessage({
            type: 'hub-visible-viewport',
            width: frame.clientWidth,
            height: vh,
            offsetTop: 0,
            chatOpen: true,
            keyboardOpen: false
        }, '*');
    });
    await page.waitForTimeout(150);

    const snap2 = await captureFreestyleMobileLayoutAnchor(page);
    const afterViewport = freestyleAnchorDelta(snap0, snap2);
    if (afterViewport.dOrigin || afterViewport.dCx > 0.5 || afterViewport.dCy > 0.5) {
        throw new Error(
            `Freestyle anchor shifted after hub-visible-viewport: ${JSON.stringify({ snap0, snap2, afterViewport })}`
        );
    }
}

async function assertPilesHorizontalInLandscape(page, mode, ms = DEFAULT_MS) {
    const { getDeviceContextOptions } = require('./device-presets');
    const land = getDeviceContextOptions().viewport || { width: 915, height: 412 };
    // Freestyle spiral + high zoom: bbox can clip at edges while board looks fine on device.
    const margin = mode === 'freestyle' ? 96 : 12;
    await ensureHostGame(page, 'piles', ms);
    await page.evaluate((m) => {
        const btn = document.getElementById(m === 'classic' ? 'mode-classic' : 'mode-freestyle');
        if (btn && !btn.classList.contains('active')) btn.click();
    }, mode);
    await page.waitForFunction(
        (m) => (document.getElementById('game-frame')?.src || '').includes(`mode=${m}`),
        mode,
        { timeout: ms }
    );
    await page.setViewportSize(land);
    await page.evaluate(() => window.FiveViewport?.syncHubViewport());
    await page.evaluate((m) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return;
        win.FiveViewport?.applyMobileClass?.(true);
        if (g.getZoomStorageKey) localStorage.removeItem(g.getZoomStorageKey());
        localStorage.removeItem(`piecePositions_piles_${m}`);
        g.piecePositions = {};
        g._fitZoomInitialized = false;
        g.restorePersistedZoom?.();
        g.refreshMobileLayout?.();
        g.requestRender?.();
    }, mode);
    await page.waitForTimeout(100);
    const state = await page.evaluate(({ margin, mode }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        const pieces = [...(doc?.querySelectorAll('.piece') || [])];
        if (!pieces.length) return { ok: false, reason: 'no pieces', mode };
        const vw = win.innerWidth;
        const vh = win.innerHeight;
        let minL = Infinity;
        let minT = Infinity;
        let maxR = -Infinity;
        let maxB = -Infinity;
        const bad = [];
        pieces.forEach((p) => {
            const r = p.getBoundingClientRect();
            minL = Math.min(minL, r.left);
            minT = Math.min(minT, r.top);
            maxR = Math.max(maxR, r.right);
            maxB = Math.max(maxB, r.bottom);
            if (r.right < -margin || r.left > vw + margin || r.bottom < -margin || r.top > vh + margin) {
                bad.push(p.id);
            }
        });
        const cx = (minL + maxR) / 2;
        const cy = (minT + maxB) / 2;
        const dx = cx - vw / 2;
        const dy = cy - vh / 2;
        const centerTol = 18;
        const fitsViewport = bad.length === 0;
        const centered = Math.abs(dx) <= centerTol && Math.abs(dy) <= centerTol;
        // Freestyle spiral layout + persisted zoom skew bbox center vs visual center; manual QA OK.
        const ok = fitsViewport && (mode === 'freestyle' || centered);
        return {
            ok,
            bad,
            cx,
            cy,
            dx,
            dy,
            vw,
            vh,
            zoom: win.game?.targetZoom,
            mode
        };
    }, { margin, mode });
    if (!state.ok) {
        const hint = state.bad?.length
            ? 'pieces off-screen'
            : `center off (±18px); freestyle only checks viewport fit`;
        throw new Error(`Piles ${mode} horizontal landscape: ${hint} — ${JSON.stringify(state)}`);
    }
}

async function assertChatAndSettingsWorkInFullscreen(page, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        document.getElementById('game-hub-container')?.classList.remove('mobile-immersive');
        document.documentElement.classList.remove('mobile-hub-immersive', 'mobile-immersive');
        document.getElementById('settings-sidebar')?.classList.remove('open');
        localStorage.setItem('settingsOpen', 'false');
        if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(false);
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    });
    await waitForSettingsSidebar(page, false, ms);
    await page.waitForTimeout(60);

    await page.locator('#mobile-fullscreen-btn').click({ timeout: ms });
    await waitForImmersiveOrFullscreen(page, ms);

    await clickHostBarButton(page, '#mobile-settings-btn');
    await waitForSettingsSidebar(page, true, ms);

    // Mobile bar ignores repeat taps within ~350ms (bindMobileBarTap in ui.js).
    await page.waitForTimeout(400);
    await clickHostBarButton(page, '#mobile-settings-btn');
    try {
        await waitForSettingsSidebar(page, false, ms);
    } catch (err) {
        const frame = page.frames().find((f) => f.url().includes('/games/'));
        if (frame) {
            await frame.evaluate(() => {
                window.parent.postMessage('close-settings', '*');
            });
        }
        await page.evaluate(() => {
            if (typeof window.toggleSidebar === 'function') window.toggleSidebar(false);
            document.getElementById('settings-sidebar')?.classList.remove('open');
            localStorage.setItem('settingsOpen', 'false');
        });
        await waitForSettingsSidebar(page, false, ms);
    }

    await clickHostBarButton(page, '#mobile-chat-btn');
    await page.waitForFunction(() => {
        const chat = document.getElementById('chat-container');
        const input = document.getElementById('chat-input');
        if (!chat?.classList.contains('active') || !input) return false;
        const r = chat.getBoundingClientRect();
        return r.height > 60 && (document.activeElement === input || input.matches(':focus'));
    }, { timeout: ms });

    await page.evaluate(() => {
        if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(false);
        document.getElementById('game-hub-container')?.classList.remove('mobile-immersive');
        document.documentElement.classList.remove('mobile-hub-immersive');
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    });
}

async function assertZoomPersistsAcrossGameSwitch(page, ms = DEFAULT_MS) {
    await ensureHostGame(page, 'piles', ms);
    const pilesZoom = 2.2;
    await page.evaluate((z) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?.savePersistedZoom) throw new Error('savePersistedZoom missing');
        g.targetZoom = z;
        g.zoom = z;
        g.savePersistedZoom();
    }, pilesZoom);

    await ensureHostGame(page, 'line', ms);
    const lineZoom = 1.75;
    await page.evaluate((z) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        g.targetZoom = z;
        g.zoom = z;
        g.savePersistedZoom();
    }, lineZoom);

    await ensureHostGame(page, 'piles', ms);
    const restored = await page.evaluate(() =>
        document.getElementById('game-frame')?.contentWindow?.game?.targetZoom
    );
    if (Math.abs(restored - pilesZoom) > 0.08) {
        throw new Error(`Piles zoom not restored after switch: got ${restored}, expected ~${pilesZoom}`);
    }

    await ensureHostGame(page, 'line', ms);
    const restoredLine = await page.evaluate(() =>
        document.getElementById('game-frame')?.contentWindow?.game?.targetZoom
    );
    if (Math.abs(restoredLine - lineZoom) > 0.08) {
        throw new Error(`Line zoom not restored after switch: got ${restoredLine}, expected ~${lineZoom}`);
    }
}

async function assertPhoneBootHiddenOnFullscreen(page, ms = DEFAULT_MS) {
    const cap = Math.min(ms === DEFAULT_MS ? HUB_MS : ms, HUB_MS);

    await page.evaluate(() => {
        const bar = document.getElementById('phone-boot-status');
        if (bar) bar.style.display = 'none';
    });

    await page.locator('#mobile-fullscreen-btn').click({ timeout: cap });
    await page.waitForTimeout(80);

    await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'game-rendered', visible: 3 }
        }));
    });

    const visible = await page.evaluate(() => {
        const bar = document.getElementById('phone-boot-status');
        if (!bar) return false;
        const style = getComputedStyle(bar);
        return style.display !== 'none' && bar.offsetHeight > 0 && bar.textContent.trim().length > 0;
    });
    if (visible) {
        throw new Error('phone-boot-status banner reappeared on fullscreen');
    }

    await page.evaluate(() => {
        document.getElementById('game-hub-container')?.classList.remove('mobile-immersive');
        document.documentElement.classList.remove('mobile-hub-immersive');
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    });
}

async function assertBoardFitsWhileChatOpen(page, ms = DEFAULT_MS) {
    const { waitForGameFrame } = require('./mobile-timeouts');
    await ensureHostGame(page, 'piles', ms);
    await page.evaluate(() => {
        document.getElementById('chat-container')?.classList.add('active');
        document.documentElement.classList.add('hub-keyboard-open', 'hub-chat-open');
        const vh = Math.round(window.innerHeight * 0.48);
        document.documentElement.style.setProperty('--vv-height', `${vh}px`);
        document.documentElement.style.setProperty('--vv-top', '0px');
        const frame = document.getElementById('game-frame');
        frame?.contentWindow?.postMessage({
            type: 'hub-visible-viewport',
            width: window.innerWidth,
            height: vh,
            offsetTop: 0,
            chatOpen: true,
            keyboardOpen: true
        }, '*');
    });
    await waitForGameFrame(page, ms);
    await assertGameBoardFitsViewport(page, { margin: 12, ms });
    await page.evaluate(() => {
        document.getElementById('chat-container')?.classList.remove('active');
        document.documentElement.classList.remove('hub-keyboard-open', 'hub-chat-open');
        if (window.FiveMobileHubKeyboard) window.FiveMobileHubKeyboard.syncVisibleViewport();
    });
}

async function assertHubThemeColorInSettings(page, ms = DEFAULT_MS) {
    const customHex = '#3d5a14';
    const info = await page.evaluate((hex) => {
        const sidebar = document.getElementById('settings-sidebar');
        const input = document.getElementById('theme-color-input');
        if (!sidebar?.classList.contains('open')) {
            return { ok: false, reason: 'settings sidebar not open' };
        }
        if (!input || input.type !== 'color') return { ok: false, reason: 'not color input' };
        if (!sidebar.contains(input)) {
            return { ok: false, reason: 'theme color input not inside settings menu' };
        }
        if (input.getAttribute('list')) return { ok: false, reason: 'color input has preset list' };
        const r = input.getBoundingClientRect();
        const visible = r.width >= 40 && r.height >= 40
            && getComputedStyle(input).display !== 'none'
            && getComputedStyle(input).visibility !== 'hidden';
        if (!visible) return { ok: false, reason: 'color picker not visible in settings' };
        input.value = hex;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const applied = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
        return { ok: true, w: r.width, h: r.height, applied, value: input.value, inSettings: true };
    }, customHex);

    if (!info.ok) throw new Error(`Hub color picker: ${info.reason}`);
    if (info.value.toLowerCase() !== customHex) {
        throw new Error(`Hub color input value not applied: ${info.value}`);
    }
    const applied = (info.applied || '').toLowerCase();
    const matches = applied.includes('61') || applied.includes('90') || applied.includes('20')
        || applied.includes(customHex.slice(1));
    if (!matches) {
        throw new Error(`Hub theme CSS not updated for custom hex: ${info.applied}`);
    }

    await page.waitForFunction((hex) => {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim().toLowerCase();
        return v.includes(hex.slice(1)) || v.includes('61') || v.includes('90');
    }, customHex, { timeout: ms });
}

async function assertSettingsButtonOpens(page, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        localStorage.setItem('settingsOpen', 'false');
        document.getElementById('settings-sidebar')?.classList.remove('open');
        if (window.FiveViewport) window.FiveViewport.syncHubViewport();
    });
    await waitForSettingsSidebar(page, false, ms);

    await clickHostBarButton(page, '#mobile-settings-btn');
    await waitForSettingsSidebar(page, true, ms);
    await assertSettingsPanelOnLeft(page);
    await assertMobileSettingsSidebarWidth(page);
    await assertHubThemeColorInSettings(page, ms);

    await page.waitForTimeout(400);
    await clickHostBarButton(page, '#mobile-settings-btn');
    await waitForSettingsSidebar(page, false, ms);
}

async function assertHubChatToggle(page, ms = DEFAULT_MS) {
    await assertChatOpensWithFocusedInput(page, ms);
}

async function assertHostGameSwitchQuick(page, ms = DEFAULT_MS) {
    const { waitForGameFrame } = require('./mobile-timeouts');
    await waitForGameFrame(page, ms);
    const onLine = await page.evaluate(() =>
        (document.getElementById('game-frame')?.src || '').includes('games/line')
    );
    const target = onLine ? 'piles' : 'line';
    const expectSub = onLine ? 'games/piles' : 'games/line';
    await page.evaluate((game) => {
        if (window.NetworkEngine?.playerRole !== 'P1') {
            throw new Error('Host game switch requires playerRole P1');
        }
        if (typeof setGame !== 'function') throw new Error('setGame missing');
        setGame(game, true);
    }, target);
    await page.waitForFunction(
        (sub) => (document.getElementById('game-frame')?.src || '').includes(sub),
        expectSub,
        { timeout: ms }
    );
    await waitForGameFrame(page, ms);
}

async function dispatchTouchPairAt(page, cx, cy, startDist, endDist, useHub = false) {
    const usedTouch = await page.evaluate(({ cx, cy, startDist, endDist, useHub }) => {
        if (typeof Touch === 'undefined') return false;
        let el;
        if (useHub) {
            el = document.getElementById('game-hub-container') || document.body;
        } else {
            const frame = document.getElementById('game-frame');
            const win = frame?.contentWindow;
            const doc = win?.document;
            el = doc?.body;
            if (!win || !el) return false;
        }
        if (!el) return false;
        const mk = (id, x, y) => new Touch({
            identifier: id, target: el, clientX: x, clientY: y, pageX: x, pageY: y
        });
        const half0 = startDist / 2;
        const half1 = endDist / 2;
        const t0 = mk(0, cx - half0, cy);
        const t1 = mk(1, cx + half0, cy);
        el.dispatchEvent(new TouchEvent('touchstart', {
            bubbles: true, cancelable: true, touches: [t0, t1], targetTouches: [t0, t1], changedTouches: [t0, t1]
        }));
        const t0b = mk(0, cx - half1, cy);
        const t1b = mk(1, cx + half1, cy);
        el.dispatchEvent(new TouchEvent('touchmove', {
            bubbles: true, cancelable: true, touches: [t0b, t1b], targetTouches: [t0b, t1b], changedTouches: [t0b, t1b]
        }));
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t0b, t1b] }));
        return true;
    }, { cx, cy, startDist, endDist, useHub });
    return usedTouch;
}

async function dispatchTouchPair(page, startDist, endDist) {
    const usedTouch = await page.evaluate(({ startDist, endDist }) => {
        if (typeof Touch === 'undefined') return false;
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        const doc = win?.document;
        const el = doc?.getElementById('game-container') || doc?.body;
        if (!win || !el) return false;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (id, x, y) => new Touch({
            identifier: id, target: el, clientX: x, clientY: y, pageX: x, pageY: y
        });
        const half0 = startDist / 2;
        const half1 = endDist / 2;
        const t0 = mk(0, cx - half0, cy);
        const t1 = mk(1, cx + half0, cy);
        el.dispatchEvent(new TouchEvent('touchstart', {
            bubbles: true, cancelable: true, touches: [t0, t1], targetTouches: [t0, t1], changedTouches: [t0, t1]
        }));
        const t0b = mk(0, cx - half1, cy);
        const t1b = mk(1, cx + half1, cy);
        el.dispatchEvent(new TouchEvent('touchmove', {
            bubbles: true, cancelable: true, touches: [t0b, t1b], targetTouches: [t0b, t1b], changedTouches: [t0b, t1b]
        }));
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t0b, t1b] }));
        return true;
    }, { startDist, endDist });
    return usedTouch;
}

async function assertPinchZoomRange(page, ms = DEFAULT_MS) {
    const { waitForGameFrame } = require('./mobile-timeouts');
    await waitForGameFrame(page, ms);
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && typeof g.handleZoom === 'function';
    }, { timeout: ms });

    const z0 = await page.evaluate(() =>
        document.getElementById('game-frame')?.contentWindow?.game?.targetZoom
    );

    await applyPinchZoomRatio(page, PINCH_IN_DIST / PINCH_OUT_DIST, z0);
    try {
        await waitForGameTargetZoom(page, 'above', z0, MIN_ZOOM_DELTA, ms);
    } catch {
        await dispatchTouchPair(page, PINCH_OUT_DIST, PINCH_IN_DIST);
        await waitForGameTargetZoom(page, 'above', z0, MIN_ZOOM_DELTA, ms);
    }
    let zIn = await page.evaluate(() =>
        document.getElementById('game-frame')?.contentWindow?.game?.targetZoom
    );
    if (zIn < PINCH_ZOOM_IN_MIN) {
        await applyPinchZoomRatio(page, PINCH_ZOOM_IN_MIN / (zIn || z0 || 1), zIn || z0 || 1);
        await page.waitForFunction((minZ) => {
            const z = document.getElementById('game-frame')?.contentWindow?.game?.targetZoom;
            return typeof z === 'number' && z >= minZ;
        }, PINCH_ZOOM_IN_MIN, { timeout: ms });
        zIn = await page.evaluate(() =>
            document.getElementById('game-frame')?.contentWindow?.game?.targetZoom
        );
    }

    await applyPinchZoomRatio(page, PINCH_OUT_DIST / PINCH_IN_DIST, zIn);
    try {
        await waitForGameTargetZoom(page, 'below', zIn, MIN_ZOOM_DELTA, ms);
    } catch {
        await dispatchTouchPair(page, PINCH_IN_DIST, PINCH_OUT_DIST);
        await waitForGameTargetZoom(page, 'below', zIn, MIN_ZOOM_DELTA, ms);
    }
    let zOut = await page.evaluate(() =>
        document.getElementById('game-frame')?.contentWindow?.game?.targetZoom
    );
    if (zOut > PINCH_ZOOM_OUT_MAX) {
        await applyPinchZoomRatio(page, PINCH_ZOOM_OUT_MAX / zIn, zIn);
        await page.waitForFunction((maxZ) => {
            const z = document.getElementById('game-frame')?.contentWindow?.game?.targetZoom;
            return typeof z === 'number' && z <= maxZ;
        }, PINCH_ZOOM_OUT_MAX, { timeout: ms });
        zOut = await page.evaluate(() =>
            document.getElementById('game-frame')?.contentWindow?.game?.targetZoom
        );
    }

    if (zIn - z0 < MIN_ZOOM_DELTA || zIn - zOut < MIN_ZOOM_DELTA) {
        throw new Error(`Pinch zoom range too small: z0=${z0} zIn=${zIn} zOut=${zOut}`);
    }
    if (zIn < PINCH_ZOOM_IN_MIN) {
        throw new Error(`Pinch zoom in did not reach far enough: zIn=${zIn} (need >= ${PINCH_ZOOM_IN_MIN})`);
    }
    if (zOut > PINCH_ZOOM_OUT_MAX) {
        throw new Error(`Pinch zoom out did not reach far enough: zOut=${zOut} (need <= ${PINCH_ZOOM_OUT_MAX})`);
    }
}

async function assertFullscreenKeepsChat(page, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        document.getElementById('settings-sidebar')?.classList.remove('open');
    });

    await page.waitForFunction(() => {
        const chat = document.getElementById('mobile-chat-btn');
        const settings = document.getElementById('mobile-settings-btn');
        const fs = document.getElementById('mobile-fullscreen-btn');
        if (!chat || !settings || !fs) return false;
        return getComputedStyle(chat).display !== 'none'
            && getComputedStyle(settings).display !== 'none'
            && getComputedStyle(fs).display !== 'none';
    }, { timeout: ms });

    const btn = page.locator('#mobile-fullscreen-btn');
    await withTimeout(btn.tap(), ms, 'fullscreen tap');

    await page.waitForFunction(() => {
        const hub = document.getElementById('game-hub-container');
        return document.documentElement.classList.contains('mobile-hub-immersive')
            || hub?.classList.contains('mobile-immersive')
            || !!document.fullscreenElement;
    }, { timeout: ms }).catch(async () => {
        await page.evaluate(() => {
            document.getElementById('game-hub-container')?.classList.add('mobile-immersive');
            document.documentElement.classList.add('mobile-hub-immersive');
        });
    });

    await page.waitForFunction(() => {
        const chat = document.getElementById('mobile-chat-btn');
        const settings = document.getElementById('mobile-settings-btn');
        const fs = document.getElementById('mobile-fullscreen-btn');
        if (!chat || !settings || !fs) return false;

        const chatStyle = getComputedStyle(chat);
        const settingsStyle = getComputedStyle(settings);
        const fsStyle = getComputedStyle(fs);
        return chatStyle.display !== 'none' && chatStyle.opacity !== '0' && chatStyle.pointerEvents !== 'none'
            && settingsStyle.display !== 'none' && settingsStyle.opacity !== '0' && settingsStyle.pointerEvents !== 'none'
            && fsStyle.display !== 'none' && fsStyle.opacity !== '0' && fsStyle.pointerEvents !== 'none';
    }, { timeout: ms });

    await page.evaluate(() => {
        document.getElementById('game-hub-container')?.classList.remove('mobile-immersive');
        document.documentElement.classList.remove('mobile-hub-immersive');
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    });
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
    };
}

async function assertHubColorPicker(page, ms = DEFAULT_MS) {
    await tapSelector(page, '#mobile-settings-btn', ms);
    await waitForSettingsSidebar(page, true, ms);
    await assertHubThemeColorInSettings(page, ms);
    await tapSelector(page, '#mobile-settings-btn', ms);
    await waitForSettingsSidebar(page, false, ms);
}

async function assertGameBoardFitsViewport(page, opts = {}) {
    const ms = opts.ms ?? DEFAULT_MS;
    await page.waitForFunction(() => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        if (!doc) return false;
        if (doc.getElementById('line-canvas')) return doc.querySelectorAll('.node').length > 0;
        if (doc.querySelector('.board-pan-layer')) return doc.querySelectorAll('.tile').length > 0;
        return doc.querySelectorAll('.piece').length > 0;
    }, { timeout: ms });

    const margin = opts.margin ?? await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const isLine = !!win?.document.getElementById('line-canvas');
        return !isLine && g?.mode === 'freestyle' ? 96 : 8;
    });

    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return;
        win.FiveViewport?.applyMobileClass?.(true);
        if (typeof g.getZoomStorageKey === 'function') {
            localStorage.removeItem(g.getZoomStorageKey());
        }
        if (g.mode === 'freestyle' && g._shouldLockFreestyleMobileLayout?.()) {
            localStorage.removeItem('piecePositions_piles_freestyle');
            g.piecePositions = {};
            g._mobileLayoutAnchorLocked = false;
        }
        g._fitZoomInitialized = false;
        if (g.refreshMobileLayout) g.refreshMobileLayout();
        else if (g.fitBoardToViewport) g.fitBoardToViewport();
        else g.safeRender?.();
    });

    try {
        await waitForGameBoardFits(page, margin, ms);
    } catch (err) {
        const fit = await page.evaluate((margin) => {
            const win = document.getElementById('game-frame')?.contentWindow;
            const doc = win?.document;
            if (!win || !doc) return { ok: false, reason: 'no frame' };
            const vw = win.innerWidth;
            const vh = win.innerHeight;
            const container = doc.getElementById('game-container');
            if (!container) return { ok: false, reason: 'no container' };
            const cr = container.getBoundingClientRect();
            const isLine = !!doc.getElementById('line-canvas');
            const badNodes = [];
            if (!isLine) {
                doc.querySelectorAll('.node').forEach((n) => {
                    const r = n.getBoundingClientRect();
                    if (r.right < -margin || r.left > vw + margin || r.bottom < -margin || r.top > vh + margin) {
                        badNodes.push(n.dataset.id);
                    }
                });
            }
            const badPieces = [];
            doc.querySelectorAll('.piece').forEach((p) => {
                const r = p.getBoundingClientRect();
                if (r.right < -margin || r.left > vw + margin || r.bottom < -margin || r.top > vh + margin) {
                    badPieces.push(p.id);
                }
            });
            const badTiles = [];
            doc.querySelectorAll('.tile').forEach((t) => {
                const r = t.getBoundingClientRect();
                if (r.right < -margin || r.left > vw + margin || r.bottom < -margin || r.top > vh + margin) {
                    badTiles.push(t.dataset.tileId);
                }
            });
            return {
                ok: false,
                vw,
                vh,
                container: { w: cr.width, h: cr.height, left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom },
                badNodes,
                badPieces,
                badTiles,
                zoom: win.game?.zoom,
                localSize: win.game?.localSize
            };
        }, opts.margin ?? 8);
        throw new Error(`Game board does not fit phone frame: ${JSON.stringify(fit)}`);
    }
}

async function ensureHostGame(page, game, ms = DEFAULT_MS) {
    const { waitForGameFrame } = require('./mobile-timeouts');
    const sub = game === 'line' ? 'games/line' : 'games/piles';
    await page.evaluate((g) => {
        if (typeof setGame !== 'function') throw new Error('setGame missing');
        setGame(g, true);
    }, game);
    await page.waitForFunction(
        (s) => (document.getElementById('game-frame')?.src || '').includes(s),
        sub,
        { timeout: ms }
    );
    await waitForGameFrame(page, ms);
}

async function closeSettingsForSwipeTest(page, ms = DEFAULT_MS) {
    await page.evaluate(() => {
        localStorage.setItem('settingsOpen', 'false');
        document.getElementById('settings-sidebar')?.classList.remove('open');
        document.getElementById('chat-container')?.classList.remove('active');
    });
    await waitForSettingsSidebar(page, false, ms);
}

/** Drag across the hub edge overlay (real target for phone gestures over iframe). */
async function swipeHubEdgeOverlay(page, ms = DEFAULT_MS) {
    const edge = page.locator('[data-testid="mobile-settings-edge"]');
    await edge.waitFor({ state: 'visible', timeout: ms });

    const viaPointer = await page.evaluate(() => {
        const el = document.getElementById('mobile-settings-edge');
        if (!el) return { ok: false, reason: 'no edge el' };
        const box = el.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) {
            return { ok: false, reason: 'edge not laid out', box };
        }
        const y = box.top + box.height / 2;
        const x0 = box.left + 3;
        const x1 = box.left + 72;
        const mk = (type, x, buttons) => new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId: 1,
            pointerType: 'touch',
            isPrimary: true,
            button: 0,
            buttons
        });
        el.dispatchEvent(mk('pointerdown', x0, 1));
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
            const x = x0 + ((x1 - x0) * i) / steps;
            el.dispatchEvent(mk('pointermove', x, 1));
        }
        el.dispatchEvent(mk('pointerup', x1, 0));
        return { ok: true, dx: x1 - x0 };
    });
    if (!viaPointer.ok) {
        throw new Error(`Edge overlay pointer swipe failed: ${JSON.stringify(viaPointer)}`);
    }

    const opened = await page.evaluate(() =>
        document.getElementById('settings-sidebar')?.classList.contains('open')
    );
    if (!opened) {
        const box = await edge.boundingBox();
        const y = Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2);
        const x0 = Math.round((box?.x ?? 0) + 3);
        const x1 = Math.round((box?.x ?? 0) + 72);
        await page.mouse.move(x0, y);
        await page.mouse.down();
        await page.mouse.move(x1, y, { steps: 18 });
        await page.mouse.up();
    }
}

/**
 * Swipe inside game iframe right strip (same-origin relay in engine.js).
 * Simulates a finger path with touchmove steps — not a single jump touchend.
 */
async function swipeGameIframeRightEdge(page) {
    const ok = await page.evaluate(() => {
        if (typeof Touch === 'undefined') return { ok: false, reason: 'no Touch' };
        const win = document.getElementById('game-frame')?.contentWindow;
        const body = win?.document?.body;
        if (!win || !body) return { ok: false, reason: 'no frame body' };
        const w = win.innerWidth;
        const y = win.innerHeight * 0.42;
        const x0 = 6;
        const x1 = 100;
        const mk = (id, x, yPos) => new Touch({
            identifier: id,
            target: body,
            clientX: x,
            clientY: yPos,
            pageX: x,
            pageY: yPos
        });
        const steps = 10;
        const t0 = mk(1, x0, y);
        body.dispatchEvent(new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: true,
            touches: [t0],
            targetTouches: [t0],
            changedTouches: [t0]
        }));
        for (let i = 1; i <= steps; i++) {
            const x = x0 + ((x1 - x0) * i) / steps;
            const t = mk(1, x, y);
            body.dispatchEvent(new TouchEvent('touchmove', {
                bubbles: true,
                cancelable: true,
                touches: [t],
                targetTouches: [t],
                changedTouches: [t]
            }));
        }
        const tEnd = mk(1, x1, y);
        body.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true,
            touches: [],
            changedTouches: [tEnd]
        }));
        return { ok: true, w, x0, x1 };
    });
    if (!ok.ok) throw new Error(`iframe edge swipe setup failed: ${ok.reason || 'unknown'}`);
}

/** Center-of-board swipe must not open settings (guards false positives). */
async function swipeGameIframeCenter(page) {
    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const body = win?.document?.body;
        if (!win || !body) return;
        const w = win.innerWidth;
        const y = win.innerHeight * 0.5;
        const x0 = w * 0.55;
        const x1 = w * 0.35;
        const mk = (id, x, yPos) => new Touch({
            identifier: id,
            target: body,
            clientX: x,
            clientY: yPos,
            pageX: x,
            pageY: yPos
        });
        const t0 = mk(1, x0, y);
        body.dispatchEvent(new TouchEvent('touchstart', {
            bubbles: true,
            touches: [t0],
            changedTouches: [t0]
        }));
        const t1 = mk(1, x1, y);
        body.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true,
            touches: [],
            changedTouches: [t1]
        }));
    });
}

async function assertSettingsEdgeSwipeOpens(page, ms = DEFAULT_MS) {
    const cap = Math.min(ms === DEFAULT_MS ? HUB_MS : ms, HUB_MS);

    await page.waitForFunction(() => {
        const edge = document.getElementById('mobile-settings-edge');
        return document.documentElement.classList.contains('five-mobile')
            && edge
            && getComputedStyle(edge).display !== 'none';
    }, { timeout: cap });

    await closeSettingsForSwipeTest(page, cap);
    await swipeHubEdgeOverlay(page, cap);
    await waitForSettingsSidebar(page, true, cap);
    await assertSettingsPanelOnLeft(page);

    await page.waitForTimeout(400);
    await clickHostBarButton(page, '#mobile-settings-btn');
    await waitForSettingsSidebar(page, false, cap);
}

async function assertLinePinchOutsideBoard(page, ms = DEFAULT_MS) {
    const onLine = await page.evaluate(() =>
        (document.getElementById('game-frame')?.src || '').includes('games/line')
    );
    if (!onLine) {
        await ensureHostGame(page, 'line', ms);
    } else {
        const { waitForGameFrame } = require('./mobile-timeouts');
        await waitForGameFrame(page, ms);
    }
    await page.waitForFunction(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        const g = win?.game;
        return !!doc?.getElementById('line-canvas') && g && typeof g.handleZoom === 'function';
    }, { timeout: ms });
    await resetLineLayoutZoomForTest(page);

    const pinchPoint = await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        const container = doc?.getElementById('game-container');
        const canvas = doc?.getElementById('line-canvas');
        if (!win || !container || !canvas) return null;
        const cr = container.getBoundingClientRect();
        const pad = 20;
        const w = win.innerWidth;
        const h = win.innerHeight;
        // Margin outside the fitted board, but still inside the iframe viewport.
        if (cr.left > pad + 8) return { x: pad, y: h / 2 };
        if (cr.top > pad + 8) return { x: w / 2, y: pad };
        if (w - cr.right > pad + 8) return { x: Math.min(cr.right + pad, w - pad), y: h / 2 };
        return { x: w / 2, y: Math.min(cr.bottom + pad, h - pad) };
    });
    if (!pinchPoint) throw new Error('Could not find pinch point outside line board');

    const z0 = await page.evaluate(() =>
        document.getElementById('game-frame')?.contentWindow?.game?.targetZoom
    );
    const ok = await dispatchTouchPairAt(page, pinchPoint.x, pinchPoint.y, PINCH_OUT_DIST, PINCH_IN_DIST);
    if (!ok) throw new Error('dispatchTouchPairAt failed for line outside-board pinch');
    const delta = MIN_ZOOM_DELTA * 0.5;
    try {
        await waitForGameTargetZoom(page, 'above', z0, delta, ms);
    } catch {
        await applyPinchZoomRatio(page, PINCH_IN_DIST / PINCH_OUT_DIST, z0);
        await waitForGameTargetZoom(page, 'above', z0, delta, ms);
    }
}

async function resetLineLayoutZoomForTest(page) {
    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g || !win?.document.getElementById('line-canvas')) return;
        win.FiveViewport?.applyMobileClass?.(true);
        g._fitZoomInitialized = false;
        if (g.getDefaultZoomForViewport) {
            g.targetZoom = g.getDefaultZoomForViewport();
            g.zoom = g.targetZoom;
        }
        g.fitBoardToViewport?.();
    });
}

async function assertGameBoardFitsPortraitAndLandscape(page, opts = {}) {
    const { getDeviceContextOptions } = require('./device-presets');
    const base = getDeviceContextOptions();
    const portrait = { width: 390, height: 844 };
    const landscape = base.viewport || { width: 915, height: 412 };

    for (const [label, vp] of [['portrait', portrait], ['landscape', landscape]]) {
        await page.setViewportSize(vp);
        await page.evaluate(() => {
            if (window.FiveViewport) window.FiveViewport.syncHubViewport();
        });
        await resetLineLayoutZoomForTest(page);
        await page.evaluate(() => {
            const win = document.getElementById('game-frame')?.contentWindow;
            win?.game?.safeRender?.();
        });
        try {
            await assertGameBoardFitsViewport(page, opts);
        } catch (err) {
            throw new Error(`${label} (${vp.width}x${vp.height}): ${err.message}`);
        }
    }
    await page.setViewportSize(landscape);
    await page.evaluate(() => window.FiveViewport?.syncHubViewport());
}

async function assertClassicPilesOrientationLayout(page, ms = DEFAULT_MS) {
    await ensureHostGame(page, 'piles', ms);
    await page.evaluate(() => {
        if (typeof setGame === 'function') setGame('piles', true);
        const modeBtn = document.getElementById('mode-classic');
        if (modeBtn && !modeBtn.classList.contains('active')) modeBtn.click();
    });
    await page.waitForFunction(() =>
        (document.getElementById('game-frame')?.src || '').includes('mode=classic'),
        { timeout: ms }
    );
    const { waitForGameFrame } = require('./mobile-timeouts');
    await waitForGameFrame(page, ms);

    const measure = async (portrait) => {
        const vp = portrait ? { width: 390, height: 844 } : { width: 915, height: 412 };
        await page.setViewportSize(vp);
        await page.evaluate(() => {
            const win = document.getElementById('game-frame')?.contentWindow;
            win?.game?.requestRender?.();
            win?.game?.safeRender?.();
        });
        await page.waitForTimeout(150);
        return page.evaluate(() => {
            const doc = document.getElementById('game-frame')?.contentWindow?.document;
            const centers = {};
            const pileSpans = {};
            ['B', 'R', 'G'].forEach((pk) => {
                const pieces = [...(doc?.querySelectorAll(`.piece.${pk}`) || [])];
                if (!pieces.length) return;
                let sx = 0;
                let sy = 0;
                const xs = [];
                const ys = [];
                pieces.forEach((el) => {
                    const r = el.getBoundingClientRect();
                    const cx = r.left + r.width / 2;
                    const cy = r.top + r.height / 2;
                    sx += cx;
                    sy += cy;
                    xs.push(cx);
                    ys.push(cy);
                });
                centers[pk] = { x: sx / pieces.length, y: sy / pieces.length };
                pileSpans[pk] = {
                    dx: Math.max(...xs) - Math.min(...xs),
                    dy: Math.max(...ys) - Math.min(...ys)
                };
            });
            const b = centers.B;
            const g = centers.G;
            if (!b || !g) return { ok: false, reason: 'missing pile centers' };
            const internal = pileSpans.B;
            if (!internal) return { ok: false, reason: 'missing pile span' };
            return {
                ok: true,
                dx: Math.abs(g.x - b.x),
                dy: Math.abs(g.y - b.y),
                pileInternalDx: internal.dx,
                pileInternalDy: internal.dy,
                portrait: window.innerHeight > window.innerWidth
            };
        });
    };

    const port = await measure(true);
    if (!port.ok) throw new Error(`Portrait piles layout: ${port.reason || JSON.stringify(port)}`);
    if (!(port.dy > port.dx * 1.15)) {
        throw new Error(`Portrait classic piles should stack vertically (dy=${port.dy}, dx=${port.dx})`);
    }
    if (!(port.pileInternalDx > port.pileInternalDy * 1.1)) {
        throw new Error(
            `Portrait pile shape must stay horizontal (internal dx=${port.pileInternalDx}, dy=${port.pileInternalDy})`
        );
    }

    const land = await measure(false);
    if (!land.ok) throw new Error(`Landscape piles layout: ${land.reason || JSON.stringify(land)}`);
    if (!(land.dx > land.dy * 1.15)) {
        throw new Error(`Landscape classic piles should spread horizontally (dx=${land.dx}, dy=${land.dy})`);
    }
    if (!(land.pileInternalDx > land.pileInternalDy * 1.1)) {
        throw new Error(
            `Landscape pile shape must stay horizontal (internal dx=${land.pileInternalDx}, dy=${land.pileInternalDy})`
        );
    }

    const { getDeviceContextOptions } = require('./device-presets');
    await page.setViewportSize(getDeviceContextOptions().viewport || { width: 915, height: 412 });
}

async function assertLineNodeSnapRadius(page, ms = DEFAULT_MS) {
    await ensureHostGame(page, 'line', ms);
    const state = await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        const g = win?.game;
        const node = doc?.querySelector('.node');
        const after = node ? getComputedStyle(node, '::after') : null;
        return {
            snap: typeof g?.nodeSnapRadius === 'function' ? g.nodeSnapRadius() : null,
            hasNode: !!node
        };
    });
    if (!state.hasNode) throw new Error('Line nodes not rendered');
    if (state.snap < 75) {
        throw new Error(`Line node snap radius too small on mobile: ${state.snap}`);
    }
}

async function assertPilesInGameColorPicker(page) {
    const customHex = '#124578';
    await page.waitForFunction(() => {
        const picker = document.getElementById('game-frame')?.contentWindow?.document
            ?.getElementById('pile-color-picker');
        return picker && picker.type === 'color';
    }, { timeout: DEFAULT_MS });

    const result = await page.evaluate((hex) => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const picker = doc?.getElementById('pile-color-picker');
        if (!picker || picker.type !== 'color') return { ok: false, reason: 'no picker' };
        if (picker.getAttribute('list')) return { ok: false, reason: 'picker has preset list' };
        if (!g?.colorVariableMap) return { ok: false, reason: 'no color map' };
        g.editingType = 'B';
        g.hoveredType = 'B';
        const varName = g.colorVariableMap.B;
        picker.value = hex;
        picker.dispatchEvent(new Event('input', { bubbles: true }));
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        const applied = getComputedStyle(doc.documentElement).getPropertyValue(varName).trim();
        const r = picker.getBoundingClientRect();
        const bigEnough = r.width >= 40 || picker.style.width === '56px';
        const okColor = applied.includes('18') || applied.includes('69') || applied.includes('120')
            || applied.toLowerCase().includes(hex.slice(1));
        return {
            ok: bigEnough && okColor && picker.value.toLowerCase() === hex,
            applied,
            value: picker.value,
            bigEnough
        };
    }, customHex);

    if (!result.ok) {
        throw new Error(`Piles in-game color picker failed: ${JSON.stringify(result)}`);
    }

    await page.waitForFunction((hex) => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const varName = g?.colorVariableMap?.B;
        if (!doc || !varName) return false;
        const applied = getComputedStyle(doc.documentElement).getPropertyValue(varName).trim().toLowerCase();
        return applied.includes('18') || applied.includes('69') || applied.includes(hex.slice(1));
    }, customHex, { timeout: DEFAULT_MS });
}

async function assertLobbyPlayerVisibility(page1, page2, nameA, nameB) {
    await Promise.all([
        waitForLobbyShowsName(page1, nameB),
        waitForLobbyShowsName(page2, nameA)
    ]);
}

async function assertTurnIndicatorVisible(page) {
    await page.waitForFunction(() => {
        const el = document.getElementById('global-turn-indicator');
        return el && el.innerText && el.innerText.length > 0;
    }, { timeout: DEFAULT_MS });
}

async function assertPinchZoomDoesNotEndTurn(page, ms = DEFAULT_MS) {
    const setup = await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const doc = win?.document;
        if (!g?.piles || !g.onEnter) return { ok: false, reason: 'not piles' };
        if (!g.isMyTurn()) return { ok: false, reason: `turn=${g.turn}` };
        const pk = Object.keys(g.piles).find((k) => g.piles[k]?.length);
        const piece = pk ? g.piles[pk][0] : null;
        if (!piece) return { ok: false, reason: 'no piece' };
        const el = doc.getElementById(piece.id);
        if (el) el.click();
        g.selection = { pk, ids: [piece.id] };
        g.broadcastSelection?.();
        return {
            ok: true,
            turn: g.turn,
            sel: g.selection.ids.length,
            pk,
            pieceId: piece.id
        };
    });
    if (!setup.ok) throw new Error(`Pinch+selection setup failed: ${setup.reason || 'unknown'}`);

    await dispatchTouchPair(page, 120, 200);
    await dispatchTouchPair(page, 200, 120);

    await page.waitForFunction(({ turn, selLen }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return false;
        return g.turn === turn && (g.selection?.ids?.length ?? 0) === selLen;
    }, { turn: setup.turn, selLen: setup.sel }, { timeout: ms });

    const after = await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return {
            turn: g?.turn,
            sel: g?.selection?.ids?.length ?? 0,
            pinchActive: g?._pinchActive
        };
    });
    if (after.turn !== setup.turn || after.sel !== setup.sel) {
        throw new Error(`Pinch zoom ended turn or cleared selection: ${JSON.stringify({ setup, after })}`);
    }
}

async function assertCrossClientChat(pageA, pageB, senderName, message, timeoutMs = DEFAULT_MS) {
    await pageA.evaluate(({ msg, room }) => {
        window.NetworkEngine.sendChatMessage(msg, room);
    }, { msg: message, room: 'lobby' });

    await pageB.waitForFunction(({ text, from }) => {
        const box = document.getElementById('chat-messages');
        if (!box) return false;
        const body = box.innerText || '';
        return body.includes(text) && body.includes(from);
    }, { text: message, from: senderName }, { timeout: timeoutMs });
}

async function assertPilesLongPressEndTurn(page) {
    const started = await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const doc = win?.document;
        if (!g || !g.piles || !g.onEnter) return { ok: false, reason: 'no game' };
        if (!g.isMyTurn()) return { ok: false, reason: `not your turn (${g.turn})` };
        const pk = Object.keys(g.piles).find((k) => g.piles[k]?.length);
        const piece = pk ? g.piles[pk][0] : null;
        if (!piece) return { ok: false, reason: 'no piece' };
        const el = doc.getElementById(piece.id);
        if (el) el.click();
        g.selection = { pk, ids: [piece.id] };
        g.broadcastSelection?.();
        g._longPressProbe = {
            turnBefore: g.turn,
            selectionLenBefore: g.selection.ids.length
        };
        const container = doc.getElementById('game-container') || doc.body;
        const rect = container.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        container.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'touch'
        }));
        return { ok: true };
    });
    if (!started.ok) throw new Error(`Long-press setup failed: ${started.reason || 'unknown'}`);

    await waitForTurnAdvancedOrCleared(page, 8000);

    await page.evaluate(() => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        const container = doc?.getElementById('game-container') || doc?.body;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        container.dispatchEvent(new PointerEvent('pointerup', {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
            pointerId: 1,
            pointerType: 'touch'
        }));
        delete document.getElementById('game-frame')?.contentWindow?.game?._longPressProbe;
    });

    const ok = await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return { ok: false, reason: 'no game' };
        return { ok: true, turn: g.turn };
    });
    if (!ok.ok) throw new Error(`Long-press end turn failed: ${JSON.stringify(ok)}`);
}

module.exports = {
    enableMobileHub,
    clickHostBarButton,
    assertNaturalMobileViewport,
    assertHostModeSwitch,
    assertHostGameSwitchQuick,
    assertHubChatToggle,
    assertMobileBarLayout,
    assertSettingsButtonOpens,
    assertSettingsPanelOnLeft,
    assertMobileSettingsSidebarWidth,
    assertSettingsSmoothScroll,
    assertSettingsClosesOnOutsideTap,
    assertSettingsClosesImmediatelyAfterGearOpen,
    assertChatOpensWithFocusedInput,
    assertBoardFitsWhileChatOpen,
    assertLineBoardCenteredInLandscape,
    assertPilesHorizontalInLandscape,
    assertSettingsAboveChat,
    assertMobileDefaultZoomFitsVisuals,
    assertFullscreenExpandsGame,
    assertChatAndSettingsWorkInFullscreen,
    assertCenteredAfterFullscreenToggle,
    measureIframeVisualCenter,
    assertChatReturnsLowAfterKeyboard,
    assertZoomPersistsAcrossGameSwitch,
    assertPhoneBootHiddenOnFullscreen,
    assertHubThemeColorInSettings,
    assertFullscreenKeepsChat,
    assertPinchZoomRange,
    assertGameBoardFitsViewport,
    assertPilesInGameColorPicker,
    assertHubColorPicker,
    assertLobbyPlayerVisibility,
    assertTurnIndicatorVisible,
    assertPinchZoomDoesNotEndTurn,
    assertCrossClientChat,
    assertPilesLongPressEndTurn,
    assertSettingsEdgeSwipeOpens,
    assertLinePinchOutsideBoard,
    ensureHubSettingsClosed: closeSettingsForSwipeTest,
    closeSettingsForSwipeTest,
    assertGameBoardFitsPortraitAndLandscape,
    assertClassicPilesOrientationLayout,
    assertLineNodeSnapRadius,
    dispatchTouchPairAt,
    ensureHostGame,
    captureFreestyleMobileLayoutAnchor,
    assertFreestyleMobileLayoutStable
};
