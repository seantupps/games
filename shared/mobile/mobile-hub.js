/**
 * Hub mobile: pinch-zoom forward to game iframe, fullscreen / immersive mode.
 */
(function () {
    function isMobileHub() {
        return window.FiveViewport ? window.FiveViewport.isHubMobile() : false;
    }

    function getFrame() {
        return document.getElementById('game-frame');
    }

    function dist(t0, t1) {
        return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    }

    function requestFrameZoom(frame) {
        return new Promise((resolve) => {
            if (!frame?.contentWindow) {
                resolve(1);
                return;
            }
            const onMsg = (e) => {
                if (e.data?.type === 'pinch-zoom-current' && typeof e.data.zoom === 'number') {
                    window.removeEventListener('message', onMsg);
                    resolve(e.data.zoom);
                }
            };
            window.addEventListener('message', onMsg);
            frame.contentWindow.postMessage({ type: 'pinch-zoom-get' }, '*');
            setTimeout(() => {
                window.removeEventListener('message', onMsg);
                resolve(1);
            }, 300);
        });
    }

    function initHubPinchZoom() {
        const hub = document.getElementById('game-hub-container');
        if (!hub) return;
        let pinch = null;

        const dist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

        const forwardZoom = (scale) => {
            if (pinch?.zoom0 == null) return;
            const next = Math.min(Math.max(pinch.zoom0 * scale, 0.2), 5.0);
            getFrame()?.contentWindow?.postMessage({ type: 'pinch-zoom-set', zoom: next }, '*');
        };

        const onStart = (e) => {
            if (!isMobileHub()) return;
            if (e.touches?.length === 2) {
                pinch = {
                    d0: dist(e.touches[0], e.touches[1]),
                    zoom0: null
                };
                requestFrameZoom(getFrame()).then((z) => {
                    if (pinch) pinch.zoom0 = z;
                });
            }
        };

        const onMove = (e) => {
            if (!isMobileHub() || !pinch || e.touches?.length !== 2) return;
            e.preventDefault();
            const d = dist(e.touches[0], e.touches[1]);
            if (!pinch.d0) pinch.d0 = d;
            const scale = d / pinch.d0;
            forwardZoom(d / pinch.d0);
        };

        const onEnd = (e) => {
            if (e.touches && e.touches.length >= 2) return;
            pinch = null;
        };

        hub.addEventListener('touchstart', onStart, { passive: true });
        hub.addEventListener('touchmove', onMove, { passive: false });
        hub.addEventListener('touchend', onEnd, { passive: true });
        hub.addEventListener('touchcancel', onEnd, { passive: true });
    }

    function setImmersive(on) {
        const hub = document.getElementById('game-hub-container');
        if (hub) hub.classList.toggle('mobile-immersive', on);
        document.documentElement.classList.toggle('mobile-immersive', on);
        document.documentElement.classList.toggle('mobile-hub-immersive', on);
    }

    function getFrameViewportSize() {
        const frame = getFrame();
        if (!frame) {
            return { width: window.innerWidth, height: window.innerHeight };
        }
        const rect = frame.getBoundingClientRect();
        return {
            width: Math.round(rect.width) || frame.clientWidth || window.innerWidth,
            height: Math.round(rect.height) || frame.clientHeight || window.innerHeight
        };
    }

    function notifyGameFrameLayout() {
        const frame = getFrame();
        if (!frame?.contentWindow) return;
        const { width: vw, height: vh } = getFrameViewportSize();
        const vv = window.visualViewport;
        frame.contentWindow.postMessage({
            type: 'hub-visible-viewport',
            width: vw,
            height: vh,
            offsetTop: 0,
            chatOpen: document.getElementById('chat-container')?.classList.contains('active'),
            keyboardOpen: false
        }, '*');
        const win = frame.contentWindow;
        const run = () => {
            const g = win.game;
            if (g?.refreshMobileLayout) g.refreshMobileLayout();
            else if (g?.fitBoardToViewport) g.fitBoardToViewport();
            if (g?.requestRender) g.requestRender();
            try {
                win.dispatchEvent(new Event('resize'));
            } catch (_) { /* ignore */ }
        };
        requestAnimationFrame(() => {
            run();
            requestAnimationFrame(run);
        });
        if (vv) {
            setTimeout(run, 120);
        }
    }

    function initFullscreenButton() {
        const btn = document.getElementById('mobile-fullscreen-btn');
        if (!btn) return;
        let nativeFsActive = false;

        const isFullscreen = () => !!document.fullscreenElement
            || document.documentElement.classList.contains('mobile-hub-immersive');

        const syncIcon = () => {
            const on = isFullscreen();
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.classList.toggle('is-active', on);
            btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
        };

        const enterFullscreen = async () => {
            const hub = document.getElementById('game-hub-container');
            const target = hub || document.documentElement;
            setImmersive(true);
            try {
                if (target.requestFullscreen) {
                    await target.requestFullscreen();
                } else if (target.webkitRequestFullscreen) {
                    target.webkitRequestFullscreen();
                }
            } catch (_) { /* CSS immersive still expands the game area */ }
            window.scrollTo(0, 1);
            requestAnimationFrame(() => {
                window.scrollTo(0, 0);
                notifyGameFrameLayout();
            });
            setTimeout(notifyGameFrameLayout, 150);
        };

        const exitFullscreen = async () => {
            nativeFsActive = false;
            setImmersive(false);
            try {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            } catch (_) { /* ignore */ }
            setTimeout(notifyGameFrameLayout, 80);
        };

        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isFullscreen()) {
                await exitFullscreen();
            } else {
                await enterFullscreen();
            }
            syncIcon();
        });

        document.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                nativeFsActive = true;
                setImmersive(true);
                notifyGameFrameLayout();
                setTimeout(notifyGameFrameLayout, 200);
            } else if (nativeFsActive) {
                nativeFsActive = false;
                setImmersive(false);
                notifyGameFrameLayout();
            }
            syncIcon();
        });
        syncIcon();
    }

    let inited = false;
    function init() {
        if (inited) return;
        inited = true;
        initHubPinchZoom();
        initFullscreenButton();
    }

    window.addEventListener('five-mobile-ready', init);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
