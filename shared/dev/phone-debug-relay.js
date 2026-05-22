/**
 * Dev-only: streams console + errors from phone/browser to PC debug server (:8002).
 * Enabled on LAN, ngrok, or ?phoneDebug=1. Posts to same-origin /phone-debug/report
 * (proxied to PC :8002 by dev-static-server) so ngrok phones show on the dashboard.
 */
(function (global) {
    const FLUSH_MS = 4000;
    const MAX_BUFFER = 80;

    function isPrivateLan(host) {
        return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host || '');
    }

    function isNgrokHost(host) {
        return /\.(ngrok-free\.app|ngrok-free\.dev|ngrok\.io|ngrok\.app)$/i.test(host || '');
    }

    function shouldEnable() {
        try {
            if (global.FIVE_PHONE_DEBUG === '0') return false;
            if (global.FIVE_PHONE_DEBUG === '1') return true;
            const params = new URLSearchParams(global.location?.search || '');
            if (params.get('phoneDebug') === '1') return true;
            const host = global.location?.hostname || '';
            return isPrivateLan(host) || isNgrokHost(host);
        } catch (_) {
            return false;
        }
    }

    if (!shouldEnable()) return;

    const endpoint = `${global.location.origin}/phone-debug/report`;
    const deviceId = (function () {
        let id = sessionStorage.getItem('five_phone_debug_id');
        if (!id) {
            id = 'd_' + Math.random().toString(36).slice(2, 10);
            sessionStorage.setItem('five_phone_debug_id', id);
        }
        return id;
    })();

    const buffer = [];
    const errors = [];
    let flushTimer = null;

    function snapshotState() {
        const state = {
            url: global.location?.href,
            online: global.navigator?.onLine,
            hubLoading: !!document.getElementById('hub-loading') &&
                !document.getElementById('hub-loading').classList.contains('hidden'),
            firebaseTarget: global.FiveFirebaseEnv?.resolveTarget?.(),
            emulatorHost: global.FiveFirebaseEnv?.resolveEmulatorHost?.(),
            networkReady: !!(global.NetworkEngine && global.NetworkEngine.isInitialized),
            viewport: { w: global.innerWidth, h: global.innerHeight }
        };
        try {
            const frame = document.getElementById('game-frame');
            if (frame) {
                state.iframe = {
                    w: frame.offsetWidth,
                    h: frame.offsetHeight,
                    src: frame.src
                };
                const g = frame.contentWindow?.game;
                if (g) {
                    state.game = {
                        roomId: g.roomId,
                        role: g.playerRole,
                        turn: g.turn,
                        isOver: g.isOver,
                        identitySynced: g.identitySynced
                    };
                }
            }
        } catch (_) { /* cross-origin */ }
        return state;
    }

    function pushLog(level, args) {
        const msg = args.map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (_) { return String(a); }
        }).join(' ');
        buffer.push({ t: Date.now(), level, msg: msg.slice(0, 2000) });
        if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    }

    function sendReport(reason, urgent) {
        const payload = {
            deviceId,
            reason,
            ua: global.navigator?.userAgent || '',
            ts: new Date().toISOString(),
            logs: buffer.splice(0, buffer.length),
            errors: errors.splice(0, errors.length),
            state: snapshotState()
        };
        const body = JSON.stringify(payload);
        if (urgent && global.navigator?.sendBeacon) {
            global.navigator.sendBeacon(endpoint, body);
            return;
        }
        fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true
        }).catch(() => { /* PC debug server offline */ });
    }

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            if (buffer.length || errors.length) sendReport('interval', false);
        }, FLUSH_MS);
    }

    ['log', 'warn', 'error', 'info'].forEach((level) => {
        const orig = console[level]?.bind(console);
        if (!orig) return;
        console[level] = function (...args) {
            pushLog(level, args);
            scheduleFlush();
            orig(...args);
        };
    });

    global.addEventListener('error', (e) => {
        errors.push({
            t: Date.now(),
            message: e.message || 'error',
            stack: (e.error && e.error.stack) || '',
            source: `${e.filename || ''}:${e.lineno || ''}`
        });
        sendReport('window.error', true);
    });

    global.addEventListener('unhandledrejection', (e) => {
        const reason = e.reason;
        errors.push({
            t: Date.now(),
            message: reason?.message || String(reason),
            stack: reason?.stack || ''
        });
        sendReport('unhandledrejection', true);
    });

    global.addEventListener('pagehide', () => sendReport('pagehide', true));
    global.FivePhoneDebug = {
        flush: (reason) => sendReport(reason || 'manual', true),
        ping: () => sendReport('ping', true)
    };

    sendReport('boot', true);
    console.info('[PhoneDebug] Relay active →', endpoint);

    setInterval(function () {
        if (buffer.length || errors.length) sendReport('heartbeat', false);
        else sendReport('heartbeat-ping', false);
    }, 8000);

    document.addEventListener('visibilitychange', function () {
        sendReport(document.hidden ? 'hidden' : 'visible', true);
    });
})(typeof window !== 'undefined' ? window : globalThis);
