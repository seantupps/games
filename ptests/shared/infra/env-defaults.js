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

/** @param {string[]} [argv] */
function parseHeadedFromArgv(argv = process.argv.slice(2)) {
    return argv.some((a) => HEADED_ARGV.has(a));
}

/** @param {string[]} [argv] */
function parseKeepBrowserOpenFromArgv(argv = process.argv.slice(2)) {
    return argv.some((a) => KEEP_OPEN_ARGV.has(a));
}

/** npm run script -- --headed (Windows often leaves this in env, not argv). */
function parseHeadedFromNpmConfig() {
    const v = process.env.npm_config_headed;
    if (v == null || v === 'false' || v === '0') return false;
    return v === 'true' || v === '1' || v === '';
}

/** npm run script -- --open */
function parseKeepOpenFromNpmConfig() {
    const v = process.env.npm_config_open;
    if (v == null || v === 'false' || v === '0') return false;
    return v === 'true' || v === '1' || v === '';
}

/** Explicit headed request for this process — argv/npm only, not stale FIVE_HEADED. */
function isHeadedRequested(argv = process.argv.slice(2)) {
    return parseHeadedFromArgv(argv) || parseHeadedFromNpmConfig();
}

/** Explicit keep-open request — argv/npm only, not stale FIVE_KEEP_BROWSER_OPEN. */
function isKeepOpenRequested(argv = process.argv.slice(2)) {
    return parseKeepBrowserOpenFromArgv(argv) || parseKeepOpenFromNpmConfig();
}

/** Default headless unless FIVE_HEADLESS=0 or FIVE_HEADED=1 (or --h on argv). */
function playwrightHeadless() {
    if (process.env.FIVE_HEADED === '1' || process.env.FIVE_HEADLESS === '0') return false;
    return true;
}

/** SlowMo value from FIVE_SLOW_MO env var. */
function playwrightSlowMo() {
    const v = Number(process.env.FIVE_SLOW_MO || 0);
    return v > 0 ? v : 0;
}

/** Whether the browser should automatically close after the test. */
function shouldCloseBrowser() {
    // Keep headed window open for manual inspection: FIVE_KEEP_BROWSER_OPEN=1 (or --open / --keep-open).
    if (process.env.FIVE_KEEP_BROWSER_OPEN === '1') return false;
    return true;
}

/** Block until the user closes the browser or presses Ctrl+C (headed --open runs). */
async function awaitBrowserDismissal() {
    if (shouldCloseBrowser()) return;
    console.log(
        '\n\x1b[33m[ptests] Browser left open (--open). Close the window or press Ctrl+C to exit.\x1b[0m'
    );
    await new Promise(() => { });
}

/** @param {boolean} headed */
function applyPlaywrightHeadedMode(headed) {
    if (headed) {
        process.env.FIVE_HEADLESS = '0';
        process.env.FIVE_HEADED = '1';
    } else {
        process.env.FIVE_HEADLESS = '1';
        delete process.env.FIVE_HEADED;
    }
}

/** Sync Playwright display mode from argv (clears stale FIVE_HEADED from prior runs). */
function applyDefaultPlaywrightDisplayMode(argv = process.argv.slice(2)) {
    const keepOpen = isKeepOpenRequested(argv);
    const headed = isHeadedRequested(argv) || keepOpen;
    applyPlaywrightHeadedMode(headed);
    if (keepOpen) {
        process.env.FIVE_KEEP_BROWSER_OPEN = '1';
    } else {
        delete process.env.FIVE_KEEP_BROWSER_OPEN;
    }
}

module.exports = {
    PROFILES,
    setEnvIfUnset,
    applyEnvProfile,
    applyEnvProfiles,
    resolveProfileName,
    defaultBootstrapProfiles,
    parseHeadedFromArgv,
    parseHeadedFromNpmConfig,
    isHeadedRequested,
    parseKeepBrowserOpenFromArgv,
    parseKeepOpenFromNpmConfig,
    isKeepOpenRequested,
    playwrightHeadless,
    playwrightSlowMo,
    shouldCloseBrowser,
    awaitBrowserDismissal,
    applyPlaywrightHeadedMode,
    applyDefaultPlaywrightDisplayMode
};
