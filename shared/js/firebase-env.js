/**
 * Firebase environment profiles.
 *
 * - emulator  : local RTDB + Functions (Playwright, daily coding). No prod quota.
 * - dev       : real Firebase project for two-device / staging testing.
 * - production: live public app (default when unset).
 *
 * Select via URL: ?firebase=emulator | ?firebase=dev
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

    const EMULATOR_HOST = '127.0.0.1';
    const EMULATOR_DATABASE_PORT = 9000;

    function resolveTarget() {
        if (global.FIVE_FIREBASE_TARGET) return global.FIVE_FIREBASE_TARGET;
        try {
            const params = new URLSearchParams(global.location?.search || '');
            const fromUrl = params.get('firebase');
            if (fromUrl) return fromUrl;
        } catch (_) { /* non-browser */ }
        return 'production';
    }

    function getFirebaseRuntime(target) {
        const t = target || resolveTarget();
        if (t === 'emulator') {
            return {
                target: 'emulator',
                config: { ...EMULATOR },
                useEmulator: true,
                emulatorHost: EMULATOR_HOST,
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
        EMULATOR_HOST,
        EMULATOR_DATABASE_PORT,
        resolveTarget,
        getFirebaseRuntime
    };
})(typeof window !== 'undefined' ? window : globalThis);
