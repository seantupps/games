/**
 * Assertions matching real phone / LAN hub load (emulator rtdbUrl, not plain localhost hub).
 */
const http = require('http');
const path = require('path');
const fs = require('fs');

const DEBUG_LATEST = path.join(__dirname, '../../debug-reports/latest.json');
const HUB_TIMEOUT_MS = Number(process.env.FIVE_PHONE_HUB_TIMEOUT_MS || 60000);

function checkDebugProxyOnStatic() {
    return new Promise((resolve) => {
        http.get('http://127.0.0.1:8000/phone-debug/ping', (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        }).on('error', () => resolve(false));
    });
}

function fetchDebugLatest() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:8002/latest', (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try {
                    resolve(body ? JSON.parse(body) : null);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function assertPhonePathHub(page, label = 'phone-path', opts = {}) {
    const fast = opts.fast !== false;
    const hubCap = Number(opts.timeoutMs) > 0
        ? Number(opts.timeoutMs)
        : (fast ? 8000 : HUB_TIMEOUT_MS);
    const sdkMs = fast ? hubCap : 20000;
    const readyMs = fast ? hubCap : HUB_TIMEOUT_MS;
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

    await page.waitForFunction(() => typeof firebase !== 'undefined', { timeout: sdkMs })
        .catch(() => { throw new Error(`${label}: firebase SDK never loaded`); });

    await page.waitForFunction(() => {
        return !!(window.NetworkEngine && window.NetworkEngine.isInitialized);
    }, { timeout: readyMs }).catch(() => {
        throw new Error(`${label}: NetworkEngine not ready (check rtdbUrl / emulator)`);
    });

    const params = await page.evaluate(() => ({
        firebase: new URLSearchParams(location.search).get('firebase'),
        rtdbUrl: new URLSearchParams(location.search).get('rtdbUrl') ||
            sessionStorage.getItem('five_rtdb_url'),
        target: window.FiveFirebaseEnv?.resolveTarget?.(),
        tunnelDb: window.FiveFirebaseEnv?.getRtdbTunnelUrl?.(),
        debugRelay: !!window.FivePhoneDebug,
        relayEndpoint: window.FivePhoneDebug ? '/phone-debug/report' : null
    }));

    if (params.target !== 'emulator') {
        throw new Error(`${label}: expected firebase=emulator, got ${params.target}`);
    }
    if (!params.rtdbUrl && !params.tunnelDb) {
        throw new Error(`${label}: missing rtdbUrl (phone-path URL must include emulator WS URL)`);
    }
    if (!params.debugRelay) {
        throw new Error(`${label}: phone debug relay not active (add ?phoneDebug=1)`);
    }

    await page.waitForFunction(() => {
        const loading = document.getElementById('hub-loading');
        if (loading && !loading.classList.contains('hidden')) return false;
        const frame = document.getElementById('game-frame');
        if (!frame || !frame.contentWindow) return false;
        if (frame.offsetWidth < 50 || frame.offsetHeight < 50) return false;
        const g = frame.contentWindow.game;
        return !!(g && (g.identitySynced || g.piles || g.nodes?.length > 0));
    }, { timeout: readyMs }).catch(() => {
        throw new Error(`${label}: hub/game not visible (blank iframe — common on real phones)`);
    });

    await page.evaluate(() => {
        document.documentElement.classList.add('five-mobile');
        if (window.FivePhoneDebug) window.FivePhoneDebug.flush('playwright-check');
    });

    const layout = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        return {
            iframeW: frame?.offsetWidth,
            iframeH: frame?.offsetHeight,
            viewportW: innerWidth,
            viewportH: innerHeight,
            gameRoom: g?.roomId,
            emulatorHost: window.FiveFirebaseEnv?.resolveEmulatorHost?.()
        };
    });

    if (layout.iframeW < 100 || layout.iframeH < 100) {
        throw new Error(`${label}: iframe too small ${layout.iframeW}x${layout.iframeH}`);
    }

    if (errors.length) {
        throw new Error(`${label}: ${errors.join('; ')}`);
    }

    return { params, layout };
}

async function assertDebugRelayReachable(page, label = 'phone-path') {
    const ping = await page.evaluate(async () => {
        try {
            const r = await fetch(`${location.origin}/phone-debug/ping`);
            return { ok: r.ok, status: r.status };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });
    if (!ping.ok) {
        throw new Error(
            `${label}: debug relay not reachable at /phone-debug/ping (${ping.status || ping.error}). ` +
            'Restart: npm run phone:stack (needs dev-static-server proxy)'
        );
    }
}

async function assertDebugReportReceived(page, { label = 'phone-path', minAgeMs = 0 } = {}) {
    await assertDebugRelayReachable(page, label);
    await new Promise((r) => setTimeout(r, 1500));
    let latest = null;
    try {
        latest = await fetchDebugLatest();
    } catch (_) {
        if (fs.existsSync(DEBUG_LATEST)) {
            latest = JSON.parse(fs.readFileSync(DEBUG_LATEST, 'utf8'));
        }
    }
    if (!latest) {
        throw new Error(`${label}: no report on PC — open http://127.0.0.1:8002/ (restart with games mobile)`);
    }
    if (minAgeMs > 0) {
        const age = Date.now() - new Date(latest.receivedAt || latest.ts).getTime();
        if (age > 120000) {
            throw new Error(`${label}: latest report is stale (${Math.round(age / 1000)}s old)`);
        }
    }
    return latest;
}

/** Mobile bar visible on phone-path URL (settings gear tested in mobile hub suite). */
async function assertMobileHubControls(page) {
    await page.evaluate(() => {
        if (window.FiveViewport) window.FiveViewport.syncHubViewport();
        else document.documentElement.classList.add('five-mobile');
    });
    await page.waitForSelector('#mobile-bar', { state: 'visible', timeout: 8000 });
    await page.waitForSelector('#mobile-settings-btn', { state: 'visible', timeout: 8000 });
}

async function assertGameMove(page, label) {
    const moved = await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return false;
        if (g.getValidMoves) {
            const moves = g.getValidMoves();
            if (moves.length) {
                g.submitMove(moves[0]);
                return true;
            }
        }
        if (g.piles?.length) {
            const pile = g.piles[0];
            if (pile?.pieces?.length) return true;
        }
        return g.nodes?.length > 0;
    });
    if (!moved) throw new Error(`${label}: could not verify game interaction`);
}

async function requireDevStaticServer() {
    if (await checkDebugProxyOnStatic()) return;
    throw new Error(
        'phone:stack must use dev-static-server (proxy /phone-debug → :8002). ' +
        'Stop old servers and run: npm run phone:stack'
    );
}

module.exports = {
    requireDevStaticServer,
    assertPhonePathHub,
    assertDebugRelayReachable,
    assertDebugReportReceived,
    assertMobileHubControls,
    assertGameMove,
    HUB_TIMEOUT_MS
};
