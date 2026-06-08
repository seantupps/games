/**
 * Load Firebase compat SDK before network.js — synchronous on public hosts (CDN),
 * vendor-first on local/LAN with CDN fallback when vendor 404s.
 */
(function (global) {
    const CDN = 'https://www.gstatic.com/firebasejs/9.22.1/';
    const VENDOR = 'vendor/firebase/';

    function isLocalDevHost() {
        try {
            const h = global.location?.hostname || '';
            if (h === 'localhost' || h === '127.0.0.1') return true;
            if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
            if (/\.(ngrok-free\.app|ngrok\.io|ngrok\.app)$/i.test(h)) return true;
        } catch (_) { /* non-browser */ }
        return false;
    }

    function writeScript(url) {
        global.document.write(`<script src="${url}"><\/script>`);
    }

    function loadScriptAsync(url) {
        return new Promise((resolve, reject) => {
            const el = global.document.createElement('script');
            el.src = url;
            el.onload = () => resolve(url);
            el.onerror = () => reject(new Error(`Failed to load ${url}`));
            global.document.head.appendChild(el);
        });
    }

    async function loadPair(base) {
        await loadScriptAsync(base + 'firebase-app-compat.js');
        await loadScriptAsync(base + 'firebase-database-compat.js');
        if (typeof global.firebase === 'undefined') {
            throw new Error(`Firebase global missing after loading from ${base}`);
        }
    }

    async function loadWithFallback() {
        const primary = isLocalDevHost() ? VENDOR : CDN;
        const secondary = primary === VENDOR ? CDN : VENDOR;
        try {
            await loadPair(primary);
        } catch (firstErr) {
            if (primary === secondary) throw firstErr;
            await loadPair(secondary);
        }
    }

    /** During initial HTML parse — blocks following scripts until Firebase is present. */
    function loadSyncForParse() {
        const base = isLocalDevHost() ? VENDOR : CDN;
        writeScript(base + 'firebase-app-compat.js');
        writeScript(base + 'firebase-database-compat.js');
    }

    global.FiveFirebaseSdkLoader = {
        CDN,
        VENDOR,
        isLocalDevHost,
        loadSyncForParse,
        loadWithFallback
    };

    if (global.document?.readyState === 'loading' && !global.__fiveFirebaseLoaderAsync) {
        loadSyncForParse();
    }
})(typeof window !== 'undefined' ? window : globalThis);
