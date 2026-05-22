/**
 * Single source of truth: mobile vs desktop viewport.
 * Mobile = touch-first device — NOT a narrow desktop window with a mouse.
 * Hub sets html.five-mobile and notifies game iframes via postMessage.
 */
(function () {
    function isTouchPrimaryDevice() {
        const touchPoints = navigator.maxTouchPoints > 0;
        const coarse = window.matchMedia('(pointer: coarse)').matches;
        const noHover = window.matchMedia('(hover: none)').matches;
        /* Phones/tablets: hover:none + touch. Coarse alone misses some iOS/Android builds. */
        if (touchPoints && noHover) return true;
        if (coarse && noHover) return true;
        return coarse && touchPoints;
    }

    function applyMobileClass(on) {
        document.documentElement.classList.toggle('five-mobile', !!on);
    }

    function isMobile() {
        return document.documentElement.classList.contains('five-mobile');
    }

    function isHubMobile() {
        return isMobile();
    }

    function notifyGameFrame(mobile) {
        const frame = document.getElementById('game-frame');
        if (frame?.contentWindow) {
            frame.contentWindow.postMessage({ type: 'five-viewport-mode', mobile: !!mobile }, '*');
        }
    }

    function syncViewportMeta(mobile) {
        const meta = document.querySelector('meta[name="viewport"]');
        if (!meta) return;
        const base = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
        meta.setAttribute('content', mobile
            ? `${base}, maximum-scale=1.0, user-scalable=no`
            : base);
    }

    function syncHubViewport() {
        const mobile = isTouchPrimaryDevice();
        applyMobileClass(mobile);
        syncViewportMeta(mobile);
        notifyGameFrame(mobile);
        return mobile;
    }

    window.FiveViewport = {
        isMobile,
        isHubMobile,
        isTouchPrimaryDevice,
        applyMobileClass,
        syncHubViewport,
        notifyGameFrame
    };

    window.addEventListener('message', (e) => {
        if (!e.data || typeof e.data.type !== 'string') return;
        if (e.data.type === 'five-viewport-mode') {
            applyMobileClass(e.data.mobile);
            syncViewportMeta(e.data.mobile);
            return;
        }
        if (e.data.type === 'five-viewport-query' && e.source) {
            try {
                e.source.postMessage({
                    type: 'five-viewport-mode',
                    mobile: document.documentElement.classList.contains('five-mobile')
                }, '*');
            } catch (_) { /* cross-origin */ }
        }
    });

    if (window.parent !== window) {
        try {
            window.parent.postMessage({ type: 'five-viewport-query' }, '*');
        } catch (_) { /* ignore */ }
        setTimeout(() => {
            if (!isMobile()) applyMobileClass(isTouchPrimaryDevice());
        }, 0);
    }
})();
