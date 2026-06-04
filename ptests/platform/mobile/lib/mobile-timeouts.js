/**
 * Bounded waits so mobile Playwright scripts fail fast instead of stalling.
 */
const {
    DEFAULT_MS,
    NAV_MS,
    NETWORK_MS,
    HEARTBEAT_MS,
    HUB_MS,
    HUB_INIT_MS
} = require('./mobile-constants');
const { isRunnerQuiet } = require('../../../shared/infra/runner-results');
/**
 * @param {Promise<unknown>} promise
 * @param {number} [ms]
 * @param {string} [label]
 * @param {() => Promise<unknown>} [onTimeout] optional snapshot hook when deadline hits
 */
function withTimeout(promise, ms, label, onTimeout) {
    const deadline = ms || DEFAULT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(async () => {
            let extra = '';
            if (onTimeout) {
                try {
                    const diag = await onTimeout();
                    extra = `\nDiagnostics:\n${JSON.stringify(diag, null, 2)}`;
                } catch (e) {
                    extra = `\nDiagnostics capture failed: ${e.message}`;
                }
            }
            reject(new Error(`${label || 'step'} timed out after ${deadline}ms${extra}`));
        }, deadline);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Named hub/mobile check — logs start/end only (no heartbeat). Assert steps: 2s; init steps: HUB_INIT_MS. */
async function runHubStep(label, fn, kind = 'assert', page = null) {
    const cap = kind === 'init' ? HUB_INIT_MS : HUB_MS;
    const start = Date.now();
    const quiet = isRunnerQuiet();
    if (!quiet) console.log(`\x1b[36m[MOBILE] ▶ ${label}\x1b[0m`);
    const onTimeout = page
        ? () => {
            const { snapshotHubSettingsState } = require('./mobile-waits');
            return snapshotHubSettingsState(page);
        }
        : null;
    try {
        const result = await withTimeout(fn(), cap, label, onTimeout);
        if (!quiet) console.log(`\x1b[32m[MOBILE] ✓ ${label}\x1b[0m (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        return result;
    } catch (err) {
        if (!quiet) console.log(`\x1b[31m[MOBILE] ✗ ${label}\x1b[0m`);
        if (err.snapshot) {
            console.error('\x1b[33m[MOBILE] diagnostics:\x1b[0m');
            console.error(typeof err.snapshot === 'string' ? err.snapshot : JSON.stringify(err.snapshot, null, 2));
        }
        if (err.details) {
            console.error('\x1b[33m[MOBILE] step trace:\x1b[0m');
            console.error(typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2));
        }
        if (err.stack) console.error(err.stack);
        throw err;
    }
}

/** Run fn with hard cap + console heartbeat so long steps never look frozen. */
async function runStep(label, fn, ms) {
    const cap = ms || DEFAULT_MS;
    const quiet = isRunnerQuiet();
    if (!quiet) console.log(`\x1b[36m[MOBILE] ▶ ${label}\x1b[0m (max ${(cap / 1000).toFixed(0)}s)`);
    const start = Date.now();
    const heartbeat = quiet ? null : setInterval(() => {
        const s = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`\x1b[36m[MOBILE]   … ${label} ${s}s\x1b[0m`);
    }, HEARTBEAT_MS);
    try {
        const result = await withTimeout(fn(), cap, label);
        if (!quiet) console.log(`\x1b[32m[MOBILE] ✓ ${label}\x1b[0m (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        return result;
    } finally {
        if (heartbeat) clearInterval(heartbeat);
    }
}

async function gotoHub(page, url) {
    const res = await withTimeout(
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }),
        NAV_MS,
        `goto ${url}`
    );
    if (!res || !res.ok()) {
        throw new Error(`HTTP ${res?.status() ?? 'no response'} for ${url}`);
    }
}

async function waitForNetwork(page, ms = NETWORK_MS) {
    await withTimeout(
        page.waitForFunction(
            () => window.NetworkEngine && window.NetworkEngine.isInitialized,
            { timeout: ms }
        ),
        ms,
        'NetworkEngine.init'
    );
}

async function waitForGameFrame(page, ms = DEFAULT_MS) {
    await withTimeout(
        page.waitForFunction(() => {
            const frame = document.getElementById('game-frame');
            const g = frame?.contentWindow?.game;
            return !!(g && (g.piles || g.nodes?.length > 0 || g.identitySynced));
        }, { timeout: ms }),
        ms,
        'game iframe ready'
    );
}

function applyPageDefaults(page) {
    page.setDefaultTimeout(DEFAULT_MS);
    page.setDefaultNavigationTimeout(NAV_MS);
}

function applyHubPageDefaults(page) {
    page.setDefaultTimeout(HUB_MS);
    page.setDefaultNavigationTimeout(NAV_MS);
}

async function ensureStackBounded() {
    const { ensureTestStack } = require('../../../shared/infra/emulator-utils');
    return withTimeout(ensureTestStack(), DEFAULT_MS, 'ensureTestStack');
}

module.exports = {
    runHubStep,
    DEFAULT_MS,
    NAV_MS,
    NETWORK_MS,
    HEARTBEAT_MS,
    withTimeout,
    runStep,
    gotoHub,
    waitForNetwork,
    waitForGameFrame,
    applyPageDefaults,
    applyHubPageDefaults,
    HUB_MS,
    ensureStackBounded,
    ...require('./mobile-waits')
};
