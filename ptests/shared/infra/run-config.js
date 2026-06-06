/**
 * Active RunConfig — parse once at entry, read everywhere via getActiveRunConfig().
 * Env is for external/global overrides only (stack URL, step timeouts, FIVE_PROFILE).
 */
const { parseRunSpec, finalizeRunConfig } = require('./run-spec');

/** @type {import('./run-spec').RunConfig | null} */
let activeRunConfig = null;

/**
 * Run-scoped env keys — never read for behavior; cleared on every bootstrap/init
 * so stale shells cannot override CLI RunConfig.
 */
const STALE_RUN_ENV_KEYS = [
    'FIVE_HEADED',
    'FIVE_HEADLESS',
    'FIVE_KEEP_BROWSER_OPEN',
    'FIVE_MANUAL_TEST',
    'FIVE_SCENARIO',
    'FIVE_GAME',
    'FIVE_RUN_MODE',
    'FIVE_MP_SLIM',
    'FIVE_MP_SKIP_PLATFORM',
    'FIVE_PLAYER_COUNTS',
    'FIVE_PLAYERS',
    'FIVE_TOPOLOGY',
    'FIVE_MOBILE',
    'FIVE_MP_SUITE',
    'FIVE_MP_FRESH_CONTEXT',
    'FIVE_SLOW_MO',
    'FIVE_MP_WIN_SIDE',
    'FIVE_ROUNDS',
    'FIVE_PAUSE',
    'FIVE_MP_HEADED_LAYOUT',
    'FIVE_MP_HEADED_CENTER',
    'FIVE_MP_HEADED_CHAT',
    'FIVE_MP_HEADED_MOBILE_VIEWPORT_PROBE',
    'FIVE_AUDIT_ONLY',
    'FIVE_MP_ONLY',
    'FIVE_CROSS_CLIENT'
];

/** @type {boolean} */
let configParsedFromArgv = false;

function clearStaleRunEnv() {
    for (const key of STALE_RUN_ENV_KEYS) {
        delete process.env[key];
    }
}

/** Alias — reset all run-scoped env keys (safe to call any time). */
function resetRunEnv() {
    clearStaleRunEnv();
}

/**
 * @returns {import('./run-spec').RunConfig}
 */
function createDefaultRunConfig() {
    return {
        mode: 'all',
        playerCounts: [2],
        players: 2,
        topology: 'desktop',
        mixedLayout: [],
        suite: 'default',
        game: null,
        scenario: null,
        skipPlatform: false,
        slimAudit: false,
        bundle: true,
        freshContext: false,
        headed: false,
        keepBrowserOpen: false,
        manualTest: false,
        slowMo: null,
        winSide: null,
        rounds: 1,
        pause: false,
        headedLayout: true,
        headedCenter: true,
        headedChat: true,
        headedMobileViewportProbe: false
    };
}

/**
 * @param {import('./run-spec').RunConfig} config
 */
function setActiveRunConfig(config) {
    activeRunConfig = config;
}

/**
 * @param {Partial<import('./run-spec').RunConfig>} patch
 * @returns {import('./run-spec').RunConfig}
 */
function patchActiveRunConfig(patch) {
    const base = getActiveRunConfig();
    const next = { ...base, ...patch };
    setActiveRunConfig(next);
    return next;
}

/**
 * @returns {import('./run-spec').RunConfig}
 */
function getActiveRunConfig() {
    if (!activeRunConfig) {
        activeRunConfig = createDefaultRunConfig();
    }
    return activeRunConfig;
}

function isHeadless() {
    return !getActiveRunConfig().headed;
}

function shouldKeepBrowserOpen() {
    return !!getActiveRunConfig().keepBrowserOpen;
}

function isManualTestMode() {
    return !!getActiveRunConfig().manualTest;
}

function isHeadedLayoutEnabled() {
    const cfg = getActiveRunConfig();
    return !!cfg.headed && cfg.headedLayout !== false;
}

function isHeadedCenterEnabled() {
    const cfg = getActiveRunConfig();
    return !!cfg.headed && cfg.headedCenter !== false;
}

function isHeadedChatEnabled() {
    const cfg = getActiveRunConfig();
    return !!cfg.headed && cfg.headedChat !== false;
}

function isHeadedMobileViewportProbeEnabled() {
    const cfg = getActiveRunConfig();
    return !!cfg.headed && !!cfg.headedMobileViewportProbe;
}

function isMobileTopology() {
    const t = getActiveRunConfig().topology;
    return t === 'mobile' || t === 'mixed';
}

function isSlimAudit() {
    return !!getActiveRunConfig().slimAudit;
}

function getGameFilter() {
    return getActiveRunConfig().game || null;
}

function getScenario() {
    return getActiveRunConfig().scenario || null;
}

function getWinSide() {
    return getActiveRunConfig().winSide || null;
}

function getRounds() {
    return getActiveRunConfig().rounds || 1;
}

function isPaused() {
    return !!getActiveRunConfig().pause;
}

function getSlowMo() {
    const v = getActiveRunConfig().slowMo;
    return v != null && v > 0 ? v : 0;
}

/**
 * Parse argv (via parseRunSpec), store config.
 * @param {string[]} [argv]
 * @returns {import('./run-spec').RunConfig}
 */
function initRunConfig(argv = process.argv.slice(2)) {
    resetRunEnv();
    const config = parseRunSpec(argv);
    if (config.help) return config;
    finalizeRunConfig(config);
    setActiveRunConfig(config);
    configParsedFromArgv = true;
    return config;
}

/**
 * Idempotent init for modules loaded before run.js main.
 * @param {string[]} [argv]
 */
function ensureRunConfig(argv = process.argv.slice(2)) {
    if (activeRunConfig && configParsedFromArgv) return activeRunConfig;
    if (argv.length) return initRunConfig(argv);
    resetRunEnv();
    const config = createDefaultRunConfig();
    setActiveRunConfig(config);
    return config;
}

function isRunConfigFromArgv() {
    return configParsedFromArgv;
}

module.exports = {
    clearStaleRunEnv,
    resetRunEnv,
    isRunConfigFromArgv,
    createDefaultRunConfig,
    setActiveRunConfig,
    patchActiveRunConfig,
    getActiveRunConfig,
    isHeadless,
    shouldKeepBrowserOpen,
    isManualTestMode,
    isHeadedLayoutEnabled,
    isHeadedCenterEnabled,
    isHeadedChatEnabled,
    isHeadedMobileViewportProbeEnabled,
    isMobileTopology,
    isSlimAudit,
    getGameFilter,
    getScenario,
    getWinSide,
    getRounds,
    isPaused,
    getSlowMo,
    initRunConfig,
    ensureRunConfig
};
