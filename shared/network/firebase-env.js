/**
 * Firebase environment profiles.
 *
 * - emulator  : local RTDB + Functions (Playwright, daily coding). No prod quota.
 * - dev       : real Firebase project for two-device / staging testing.
 * - production: live public app (default when unset).
 *
 * Select via URL: ?firebase=emulator | ?firebase=dev | ?firebase=production
 * localhost / 127.0.0.1 / private LAN IP defaults to emulator unless ?firebase=production
 * Or before NetworkEngine.init(): window.FIVE_FIREBASE_TARGET = 'emulator'
 */
(function (global) {
    const PRODUCTION = {
        apiKey: 'AIzaSyCt0DtKHmp8JVQegsTgmxJwfiie_BBobe8',
        authDomain: 'games-fad3a.firebaseapp.com',
        projectId: 'games-fad3a',
        storageBucket: 'games-fad3a.firebasestorage.app',
        messagingSenderId: '526013940943',
        appId: '1:526013940943:web:f5ba2e59ead8465b8423ba',
        measurementId: 'G-JG4Q476RJQ',
        databaseURL: 'https://games-fad3a-default-rtdb.firebaseio.com'
    };

    /** Replace with your dev/staging Firebase web app config when created. */
    const DEV = {
        ...PRODUCTION,
        projectId: 'games-fad3a-dev',
        databaseURL: 'https://games-fad3a-dev-default-rtdb.firebaseio.com',
        authDomain: 'games-fad3a-dev.firebaseapp.com',
        storageBucket: 'games-fad3a-dev.firebasestorage.app'
    };

    const EMULATOR = {
        ...PRODUCTION,
        databaseURL: 'http://127.0.0.1:9000?ns=games-fad3a-default-rtdb'
    };

    const EMULATOR_DATABASE_PORT = 9000;

    /** RTDB emulator host: same machine as the page (LAN IP on phone, 127.0.0.1 on desktop). */
    function resolveEmulatorHost() {
        try {
            const host = global.location?.hostname || '';
            if (host && host !== 'localhost' && host !== '127.0.0.1') {
                return host;
            }
        } catch (_) { /* non-browser */ }
        return '127.0.0.1';
    }

    function isPrivateLanHost(host) {
        return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host || '');
    }

    function isNgrokHost(host) {
        return /\.(ngrok-free\.app|ngrok\.io|ngrok\.app)$/i.test(host || '');
    }

    const RTDB_NS = 'games-fad3a-default-rtdb';

    /** RTDB via same host proxy (?rtdbUrl=). Ngrok always uses current origin (not stale tunnel URLs). */
    function getRtdbTunnelUrl() {
        try {
            const params = new URLSearchParams(global.location?.search || '');
            const host = global.location?.hostname || '';
            const origin = global.location?.origin || '';

            /* LAN play: direct emulator WebSocket — drop ngrok tunnel URL from storage */
            if (isPrivateLanHost(host) && !params.get('rtdbUrl')) {
                global.sessionStorage?.removeItem('five_rtdb_url');
            }

            const fromUrl = params.get('rtdbUrl');
            if (fromUrl) {
                global.sessionStorage?.setItem('five_rtdb_url', fromUrl);
                return fromUrl;
            }

            if (isNgrokHost(host) && origin) {
                const sameOrigin = `${origin}?ns=${RTDB_NS}`;
                global.sessionStorage?.setItem('five_rtdb_url', sameOrigin);
                return sameOrigin;
            }

            const stored = global.sessionStorage?.getItem('five_rtdb_url') || null;
            if (stored && origin) {
                try {
                    if (new URL(stored).origin !== origin) {
                        global.sessionStorage?.removeItem('five_rtdb_url');
                        return null;
                    }
                } catch (_) {
                    global.sessionStorage?.removeItem('five_rtdb_url');
                    return null;
                }
            }
            return stored;
        } catch (_) {
            return null;
        }
    }

    function resolveTarget() {
        if (global.FIVE_FIREBASE_TARGET) return global.FIVE_FIREBASE_TARGET;
        try {
            const params = new URLSearchParams(global.location?.search || '');
            const fromUrl = params.get('firebase');
            if (fromUrl) return fromUrl;
            const host = global.location?.hostname || '';
            if (host === '127.0.0.1' || host === 'localhost' || isPrivateLanHost(host) || isNgrokHost(host)) {
                return 'emulator';
            }
        } catch (_) { /* non-browser */ }
        return 'production';
    }

    function getFirebaseRuntime(target) {
        const t = target || resolveTarget();
        if (t === 'emulator') {
            const tunnelUrl = getRtdbTunnelUrl();
            if (tunnelUrl) {
                return {
                    target: 'emulator',
                    config: { ...EMULATOR, databaseURL: tunnelUrl },
                    useEmulator: false,
                    rtdbTunnelUrl: tunnelUrl
                };
            }
            const emulatorHost = resolveEmulatorHost();
            const config = {
                ...EMULATOR,
                databaseURL: `http://${emulatorHost}:${EMULATOR_DATABASE_PORT}?ns=games-fad3a-default-rtdb`
            };
            return {
                target: 'emulator',
                config,
                useEmulator: true,
                emulatorHost,
                emulatorDatabasePort: EMULATOR_DATABASE_PORT
            };
        }
        if (t === 'dev') {
            return { target: 'dev', config: { ...DEV }, useEmulator: false };
        }
        return { target: 'production', config: { ...PRODUCTION }, useEmulator: false };
    }

    global.FiveFirebaseEnv = {
        PRODUCTION,
        DEV,
        EMULATOR,
        RTDB_NS,
        EMULATOR_DATABASE_PORT,
        resolveEmulatorHost,
        isNgrokHost,
        getRtdbTunnelUrl,
        resolveTarget,
        getFirebaseRuntime
    };
})(typeof window !== 'undefined' ? window : globalThis);
