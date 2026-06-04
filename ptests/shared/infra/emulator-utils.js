/**
 * Playwright test stack helpers.
 *
 * Default: emulator (safe for CI and `npm run test:mp`).
 * Production debugging: FIVE_FIREBASE_TARGET=production (local serve + live RTDB only).
 *
 * Emulator stack:
 *   Terminal 1: npm run serve
 *   Terminal 2: npm run emulators
 *
 * Production debug:
 *   Terminal 1: npm run serve
 *   FIVE_FIREBASE_TARGET=production node ptests/desktop/multiplayer/mp_prod_debug.js
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const { STEP_MS } = require('./timeouts');
const ROOT = path.resolve(__dirname, '../../..');
const STATIC_PORT = Number(process.env.FIVE_STATIC_PORT || 8000);
const EMULATOR_DB_PORT = Number(process.env.FIVE_EMULATOR_DB_PORT || 9000);
const FIREBASE_TARGET = process.env.FIVE_FIREBASE_TARGET || 'emulator';
const USE_PRODUCTION = FIREBASE_TARGET === 'production';
const STATIC_HOST = process.env.FIVE_STATIC_HOST || '127.0.0.1';
const DEFAULT_STATIC_URL = process.env.FIVE_BASE_URL || `http://${STATIC_HOST}:${STATIC_PORT}/`;

function isAutoStartEnabled() {
    return process.env.FIVE_AUTO_START_STACK === '1';
}

function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (open) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) {}
            resolve(open);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}

function waitForPort(host, port, timeoutMs = STEP_MS, label = `${host}:${port}`) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = async () => {
            if (await isPortOpen(host, port)) {
                resolve();
                return;
            }
            if (Date.now() > deadline) {
                reject(new Error(`Timeout waiting for ${label}`));
                return;
            }
            setTimeout(tick, 250);
        };
        tick();
    });
}

function waitForHttp(url, timeoutMs = STEP_MS) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            const req = http.get(url, (res) => {
                res.resume();
                if (res.statusCode && res.statusCode < 500) resolve();
                else if (Date.now() > deadline) reject(new Error(`Timeout waiting for ${url} (status ${res.statusCode})`));
                else setTimeout(tick, 250);
            });
            req.on('error', () => {
                if (Date.now() > deadline) reject(new Error(`Timeout waiting for ${url}`));
                else setTimeout(tick, 250);
            });
            req.setTimeout(2000, () => req.destroy());
        };
        tick();
    });
}

function spawnLogged(cmd, args, opts = {}) {
    const child = spawn(cmd, args, {
        cwd: opts.cwd || ROOT,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...opts.env }
    });
    const tag = opts.tag || cmd;
    child.stdout?.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
    child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`[${tag}] exited with code ${code}`);
        }
    });
    return child;
}

function stackHelp() {
    if (USE_PRODUCTION) {
        return [
            'Production Playwright debug needs a local static server only.',
            '  Terminal 1: npm run serve',
            'Then: npm run test:mp:prod',
            'Uses live RTDB (games-fad3a). Do not run full test:mp against production.'
        ].join('\n');
    }
    return [
        'Local test stack not detected.',
        `  Terminal 1: python -m http.server ${STATIC_PORT} --bind ${STATIC_HOST}`,
        `           or: npm run serve  (http://${STATIC_HOST}:${STATIC_PORT}/)`,
        '  Terminal 2: npm run emulators  (RTDB :9000)',
        'Then run Playwright tests again.',
        'Or set FIVE_AUTO_START_STACK=1 to auto-spawn missing services.'
    ].join('\n');
}

async function ensureTestStack() {
    const staticUrl = DEFAULT_STATIC_URL.endsWith('/') ? DEFAULT_STATIC_URL : `${DEFAULT_STATIC_URL}/`;
    const children = [];
    const maxAttempts = 12;

    if (USE_PRODUCTION) {
        console.warn('[emulator-utils] *** PRODUCTION RTDB — test rooms/presence only (PW_PROD_*) ***');
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const staticUp = await isPortOpen(STATIC_HOST, STATIC_PORT);
        const emulatorUp = USE_PRODUCTION ? true : await isPortOpen(STATIC_HOST, EMULATOR_DB_PORT);

        if (staticUp && emulatorUp) {
            const suffix = attempt > 1 ? ` (ready after ${attempt} checks)` : '';
            if (USE_PRODUCTION) {
                console.log(`[emulator-utils] Production debug stack (${staticUrl}, firebase=production)${suffix}`);
            } else {
                console.log(`[emulator-utils] Using existing stack (${staticUrl}, RTDB :${EMULATOR_DB_PORT})${suffix}`);
            }
            return { staticUrl, firebaseQuery: `firebase=${FIREBASE_TARGET}`, children, firebaseTarget: FIREBASE_TARGET };
        }

        if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 400));
        }
    }

    if (!isAutoStartEnabled()) {
        throw new Error(stackHelp());
    }

    const staticUp = await isPortOpen(STATIC_HOST, STATIC_PORT);
    if (!staticUp) {
        console.log(`[emulator-utils] Starting static server on :${STATIC_PORT}...`);
        children.push(spawnLogged('node', ['scripts/dev/dev-static-server.js'], {
            tag: 'static',
            env: { FIVE_BIND_HOST: '127.0.0.1', FIVE_STATIC_PORT: String(STATIC_PORT) }
        }));
        await waitForHttp(staticUrl, STEP_MS);
    }

    if (!USE_PRODUCTION) {
        const emulatorUp = await isPortOpen(STATIC_HOST, EMULATOR_DB_PORT);
        if (!emulatorUp) {
            const withFunctions = process.env.FIVE_EMULATOR_WITH_FUNCTIONS === '1';
            const only = withFunctions ? 'database,functions' : 'database';
            console.log(`[emulator-utils] Starting Firebase emulators (${only})...`);
            const emuChild = spawnLogged('npx', ['firebase', 'emulators:start', '--only', only, '--project', 'games-fad3a'], {
                tag: 'firebase-emu'
            });
            children.push(emuChild);
            await waitForPort(STATIC_HOST, EMULATOR_DB_PORT, STEP_MS, `RTDB emulator :${EMULATOR_DB_PORT}`);
            console.log('[emulator-utils] Firebase RTDB emulator ready.');
        }
    }

    return { staticUrl, firebaseQuery: `firebase=${FIREBASE_TARGET}`, children, firebaseTarget: FIREBASE_TARGET };
}

function buildAppUrl(roomId, role, gameId, gameMode) {
    const base = DEFAULT_STATIC_URL;
    const params = new URLSearchParams({
        firebase: FIREBASE_TARGET,
        room: roomId,
        role,
        game: gameId,
        mode: gameMode
    });
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${params.toString()}`;
}

function buildHubUrl(room = 'lobby') {
    const base = DEFAULT_STATIC_URL;
    const params = new URLSearchParams({ firebase: FIREBASE_TARGET, room });
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${params.toString()}`;
}

module.exports = {
    ROOT,
    STATIC_PORT,
    EMULATOR_DB_PORT,
    FIREBASE_TARGET,
    USE_PRODUCTION,
    DEFAULT_STATIC_URL,
    STATIC_HOST,
    ensureTestStack,
    buildAppUrl,
    buildHubUrl,
    isPortOpen,
    waitForPort,
    waitForHttp
};
