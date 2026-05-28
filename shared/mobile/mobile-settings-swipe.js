/**
 * Mobile hub: swipe left-edge → right opens settings.
 * Overlay #mobile-settings-edge + same-origin iframe relay (engine.js).
 */
(function () {
    const root = typeof globalThis !== 'undefined' ? globalThis : window;
    const EDGE_INSET_PX = 44;
    const MIN_SWIPE_PX = 52;
    const MAX_VERTICAL_DRIFT_PX = 90;
    const MAX_SWIPE_MS = 700;

    function isMobileHub() {
        return document.documentElement.classList.contains('five-mobile');
    }

    function settingsEdgeSwipeEnabled() {
        if (!isMobileHub()) return false;
        try {
            const frameGame = document.getElementById('game-frame')?.contentWindow?.game;
            if (frameGame?.hasCap) {
                return frameGame.hasCap('supportsSettingsEdgeSwipe');
            }
        } catch (_) { /* ignore cross-frame read */ }
        const Registry = root.GameRegistry;
        if (!Registry) return true;
        const game = root.FiveHubCtx?.currentGame
            || localStorage.getItem('lastGame')
            || 'piles';
        const inParty = (() => {
            const room = root.FiveHubCtx?.roomId || null;
            return !!room && room !== 'lobby';
        })();
        const mode = Registry.hubModeFor
            ? Registry.hubModeFor(game, inParty)
            : (root.FiveHubCtx?.gameMode || localStorage.getItem(`${game}_mode`));
        const caps = Registry.getCapabilities(game, mode);
        return caps.supportsSettingsEdgeSwipe !== false;
    }

    function openSettings() {
        if (typeof window.toggleSidebar === 'function') {
            window.toggleSidebar(true);
        } else {
            document.getElementById('settings-sidebar')?.classList.add('open');
        }
        if (typeof window.muteHubOverlayDismiss === 'function') {
            window.muteHubOverlayDismiss(200);
        }
    }

    function inLeftEdge(clientX) {
        return clientX <= EDGE_INSET_PX;
    }

    function createGesture() {
        let active = null;

        const cancel = () => {
            active = null;
        };

        const onStart = (clientX, clientY) => {
            if (!settingsEdgeSwipeEnabled()) return;
            if (!inLeftEdge(clientX)) return;
            active = { x0: clientX, y0: clientY, t0: Date.now() };
        };

        const onMove = (clientX) => {
            if (!active) return;
            if (clientX < active.x0 - 28) cancel();
        };

        const onEnd = (clientX, clientY) => {
            if (!active) return;
            const dx = clientX - active.x0;
            const dy = Math.abs(clientY - active.y0);
            const dt = Date.now() - active.t0;
            cancel();
            if (dx < MIN_SWIPE_PX || dy > MAX_VERTICAL_DRIFT_PX || dt > MAX_SWIPE_MS) return;
            openSettings();
        };

        return { onStart, onMove, onEnd, cancel };
    }

    function bindOverlay(el, gesture) {
        if (!el) return;

        el.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            gesture.onStart(e.clientX, e.clientY);
            try {
                el.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
            e.preventDefault();
        });

        el.addEventListener('pointermove', (e) => {
            gesture.onMove(e.clientX);
        });

        el.addEventListener('pointerup', (e) => {
            gesture.onEnd(e.clientX, e.clientY);
            try {
                if (el.hasPointerCapture?.(e.pointerId)) {
                    el.releasePointerCapture(e.pointerId);
                }
            } catch (_) { /* ignore */ }
        });

        el.addEventListener('pointercancel', () => gesture.cancel());

        let touchStart = null;
        el.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            touchStart = { x: t.clientX, y: t.clientY };
            gesture.onStart(t.clientX, t.clientY);
        }, { passive: true });

        el.addEventListener('touchmove', (e) => {
            if (!touchStart || e.touches.length !== 1) return;
            gesture.onMove(e.touches[0].clientX);
        }, { passive: true });

        el.addEventListener('touchend', (e) => {
            if (!touchStart) return;
            const t = e.changedTouches[0];
            gesture.onEnd(t.clientX, t.clientY);
            touchStart = null;
        }, { passive: true });

        el.addEventListener('touchcancel', () => {
            touchStart = null;
            gesture.cancel();
        }, { passive: true });
    }

    function syncEdgeVisibility() {
        const edge = document.getElementById('mobile-settings-edge');
        if (!edge) return;
        const on = settingsEdgeSwipeEnabled();
        edge.style.display = on ? 'block' : 'none';
        edge.setAttribute('aria-hidden', on ? 'false' : 'true');
        edge.style.pointerEvents = on ? 'auto' : 'none';
    }

    function init() {
        const gesture = createGesture();
        bindOverlay(document.getElementById('mobile-settings-edge'), gesture);

        window.addEventListener('message', (e) => {
            if (e.data?.type === 'open-settings-edge-swipe') {
                if (!settingsEdgeSwipeEnabled()) return;
                openSettings();
            }
        });

        const obs = new MutationObserver(syncEdgeVisibility);
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', syncEdgeVisibility);
        window.addEventListener('five-settings-edge-sync', syncEdgeVisibility);
        syncEdgeVisibility();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
