/**
 * Central env defaults for Playwright runners.
 *
 * Profiles compose: applyEnvProfiles(['stack', 'fast', 'viewportMobile'])
 *
 * - `fast` (default via bootstrap): aggressive step/MP timings — use with FULL audits
 *   (do not conflate with FIVE_MP_FAST / skipRefresh / skipPostVictory).
 * - `full`: slow timeouts for debugging flakes (FIVE_PROFILE=full).
 * - `mpBundle`: alias of `fast` for backward compatibility.
 *
 * Override any value from the shell, e.g. FIVE_VICTORY_DWELL_MS=300 npm run test:mp
 */

/** @type {Record<string, Record<string, string>>} */
const PROFILES = {
    stack: {
        FIVE_STATIC_HOST: '127.0.0.1',
        FIVE_BASE_URL: 'http://127.0.0.1:8000/',
        FIVE_AUTO_START_STACK: '1'
    },
    quiet: {
        FIVE_MP_QUIET: '1'
    },
    /** Default timings — full scenario coverage, fast waits. */
    fast: {
        FIVE_MP_OPTIMIZED: '1',
        FIVE_STEP_TIMEOUT_MS: '3000',
        FIVE_VICTORY_DWELL_MS: '150',
        FIVE_AUTO_RESET_WAIT_MS: '800',
        FIVE_MP_READY_MS: '1200',
        FIVE_MP_TURN_SYNC_MS: '800',
        FIVE_MP_MAX_MOVES: '30',
        FIVE_MP_AI_MAX_ROUNDS: '30',
        FIVE_BANANA_MAX_TURNS: '30',
        FIVE_MP_QUIET: '1'
    },
    /** @deprecated use `fast` */
    mpBundle: {
        FIVE_MP_OPTIMIZED: '1',
        FIVE_STEP_TIMEOUT_MS: '3000',
        FIVE_VICTORY_DWELL_MS: '150',
        FIVE_AUTO_RESET_WAIT_MS: '800',
        FIVE_MP_READY_MS: '1200',
        FIVE_MP_TURN_SYNC_MS: '800',
        FIVE_MP_MAX_MOVES: '30',
        FIVE_MP_AI_MAX_ROUNDS: '30',
        FIVE_BANANA_MAX_TURNS: '30',
        FIVE_MP_QUIET: '1'
    },
    step3s: {
        FIVE_STEP_TIMEOUT_MS: '3000'
    },
    mpOptimized: {
        FIVE_MP_OPTIMIZED: '1',
        FIVE_STEP_TIMEOUT_MS: '3000'
    },
    /** Device preset only — no slow MP timeouts. Apply after `fast`. */
    viewportMobile: {
        FIVE_DEVICE: 'galaxys24'
    },
    /** Legacy slow mobile profile — only when FIVE_PROFILE=full + mobile viewport. */
    mobileSlow: {
        FIVE_AUTO_RESET_WAIT_MS: '20000',
        FIVE_MP_READY_MS: '15000'
    },
    full: {
        FIVE_STEP_TIMEOUT_MS: '15000',
        FIVE_MP_READY_MS: '15000',
        FIVE_AUTO_RESET_WAIT_MS: '20000',
        FIVE_VICTORY_DWELL_MS: '5000',
        FIVE_MP_QUIET: '0'
    },
    prod: {
        FIVE_AUTO_START_STACK: '0'
    }
};

function setEnvIfUnset(key, value) {
    if (process.env[key] == null) process.env[key] = String(value);
}

/**
 * @param {string | string[] | Record<string, string>} profile
 */
function applyEnvProfile(profile) {
    if (Array.isArray(profile)) {
        profile.forEach(applyEnvProfile);
        return;
    }
    if (typeof profile === 'string') {
        const block = PROFILES[profile];
        if (!block) {
            throw new Error(`Unknown env profile "${profile}". Known: ${Object.keys(PROFILES).join(', ')}`);
        }
        Object.entries(block).forEach(([k, v]) => setEnvIfUnset(k, v));
        return;
    }
    if (profile && typeof profile === 'object') {
        Object.entries(profile).forEach(([k, v]) => setEnvIfUnset(k, v));
    }
}

/** @param {string[]} names */
function applyEnvProfiles(names) {
    applyEnvProfile(names);
}

function resolveProfileName() {
    return String(process.env.FIVE_PROFILE || 'fast').toLowerCase();
}

/** Stack + fast|full + optional viewport extras (order matters: fast before viewportMobile). */
function defaultBootstrapProfiles(extra = []) {
    const name = resolveProfileName();
    if (name === 'prod') return ['prod', ...extra];
    if (name === 'full') return ['stack', 'full', ...extra];
    return ['stack', 'fast', ...extra];
}

const HEADED_ARGV = new Set(['-h', '--h', '--headed']);
const KEEP_OPEN_ARGV = new Set(['--open', '--keep-open', '--keep-browser']);
const MANUAL_TEST_ARGV = new Set(['--test']);

/** @param {string[]} [argv] */
function parseHeadedFromArgv(argv = process.argv.slice(2)) {
    return argv.some((a) => HEADED_ARGV.has(a));
}

/** @param {string[]} [argv] */
function parseKeepBrowserOpenFromArgv(argv = process.argv.slice(2)) {
    return argv.some((a) => KEEP_OPEN_ARGV.has(a));
}

/** @param {string[]} [argv] */
function parseManualTestFromArgv(argv = process.argv.slice(2)) {
    return argv.some((a) => MANUAL_TEST_ARGV.has(a));
}

/** --test on argv for this invocation only. */
function isManualTestFromCli(argv = process.argv.slice(2)) {
    return parseManualTestFromArgv(argv);
}

/** Manual test mode — RunConfig when parsed from argv, else argv/npm for this invocation. */
function isManualTestRequested(argv = process.argv.slice(2)) {
    try {
        const { isManualTestMode, isRunConfigFromArgv } = require('./run-config');
        if (isRunConfigFromArgv()) return isManualTestMode();
    } catch (_) { /* run-config optional */ }
    return isManualTestFromCli(argv);
}

/** Headed request from argv for this invocation (--open/--test imply headed). */
function isHeadedFromCli(argv = process.argv.slice(2)) {
    return parseHeadedFromArgv(argv)
        || isKeepOpenFromCli(argv)
        || isManualTestFromCli(argv);
}

/** Headed — RunConfig when parsed from argv, else argv/npm for this invocation. */
function isHeadedRequested(argv = process.argv.slice(2)) {
    try {
        const { getActiveRunConfig, isRunConfigFromArgv } = require('./run-config');
        if (isRunConfigFromArgv()) return !!getActiveRunConfig().headed;
    } catch (_) { /* run-config optional */ }
    return isHeadedFromCli(argv);
}

/** Keep-open from argv for this invocation. */
function isKeepOpenFromCli(argv = process.argv.slice(2)) {
    return parseKeepBrowserOpenFromArgv(argv);
}

/** Keep-open — RunConfig when parsed from argv, else argv/npm. */
function isKeepOpenRequested(argv = process.argv.slice(2)) {
    try {
        const { getActiveRunConfig, isRunConfigFromArgv } = require('./run-config');
        if (isRunConfigFromArgv()) return !!getActiveRunConfig().keepBrowserOpen;
    } catch (_) { /* run-config optional */ }
    return isKeepOpenFromCli(argv);
}

/** Headless unless active RunConfig.headed (CLI source of truth). */
function playwrightHeadless() {
    const { isHeadless } = require('./run-config');
    return isHeadless();
}

/** SlowMo from active RunConfig (--slow). */
function playwrightSlowMo() {
    try {
        const { getSlowMo } = require('./run-config');
        return getSlowMo();
    } catch (_) {
        return 0;
    }
}

/** @type {Set<import('playwright').Browser>} */
const keepOpenBrowsers = new Set();

/** Track a browser for --open runs so awaitBrowserDismissal can exit when it closes. */
function registerKeepOpenBrowser(browser) {
    if (!browser || shouldCloseBrowser()) return;
    keepOpenBrowsers.add(browser);
}

function pruneDisconnectedKeepOpenBrowsers() {
    for (const browser of keepOpenBrowsers) {
        if (!browser.isConnected()) keepOpenBrowsers.delete(browser);
    }
}

/** Whether the browser should automatically close after the test. */
function shouldCloseBrowser() {
    const { shouldKeepBrowserOpen } = require('./run-config');
    return !shouldKeepBrowserOpen();
}

/** Force-close every tracked browser (default exit path). */
async function forceCloseAllBrowsers() {
    pruneDisconnectedKeepOpenBrowsers();
    const browsers = [...keepOpenBrowsers];
    keepOpenBrowsers.clear();
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
}

/** Block until browsers close/disconnect or the user presses Ctrl+C (--open / --test only). */
async function awaitBrowserDismissal() {
    pruneDisconnectedKeepOpenBrowsers();
    if (!keepOpenBrowsers.size) return;

    const { isManualTestMode } = require('./run-config');
    const reason = isManualTestMode() ? '--test' : '--open';
    console.log(
        `\n\x1b[33m[ptests] Browser left open (${reason}). Close Chrome or press Ctrl+C to exit.\x1b[0m`
    );

    await new Promise((resolve) => {
        const timers = [];
        const listeners = [];

        const done = () => {
            for (const [target, event, handler] of listeners) {
                target.removeListener(event, handler);
            }
            for (const t of timers) clearInterval(t);
            resolve();
        };

        const onSignal = () => done();
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        listeners.push([process, 'SIGINT', onSignal], [process, 'SIGTERM', onSignal]);

        const onBrowserGone = () => {
            pruneDisconnectedKeepOpenBrowsers();
            if (!keepOpenBrowsers.size) done();
        };

        for (const browser of keepOpenBrowsers) {
            if (!browser.isConnected()) continue;
            browser.on('disconnected', onBrowserGone);
            listeners.push([browser, 'disconnected', onBrowserGone]);
        }

        const poll = setInterval(onBrowserGone, 400);
        timers.push(poll);
        onBrowserGone();
    });
}

/** Normal runs: close browsers immediately. --open / --test: wait for manual dismissal. */
async function endPlaywrightRun() {
    const { shouldKeepBrowserOpen } = require('./run-config');
    if (shouldKeepBrowserOpen()) {
        await awaitBrowserDismissal();
        return;
    }
    await forceCloseAllBrowsers();
}

module.exports = {
    PROFILES,
    setEnvIfUnset,
    applyEnvProfile,
    applyEnvProfiles,
    resolveProfileName,
    defaultBootstrapProfiles,
    parseHeadedFromArgv,
    isHeadedRequested,
    parseKeepBrowserOpenFromArgv,
    parseManualTestFromArgv,
    isManualTestFromCli,
    isManualTestRequested,
    isHeadedFromCli,
    isKeepOpenFromCli,
    isKeepOpenRequested,
    playwrightHeadless,
    playwrightSlowMo,
    shouldCloseBrowser,
    registerKeepOpenBrowser,
    forceCloseAllBrowsers,
    awaitBrowserDismissal,
    endPlaywrightRun
};
