/**
 * Scenario names for Bananagrams test entry points.
 *   node .../desktop-mp/index.js --focus
 *   node .../desktop-sp.js --scenario=hub
 *   node ptests/run.js sp --game=bananagrams --scenario=actions
 */

const MP_SCENARIOS = ['full', 'focus', 'actions'];
const SP_SCENARIOS = ['all', 'hub', 'ui', 'actions', 'placement', 'dump', 'peel'];
const SP_ACTION_SLICES = ['placement', 'dump', 'peel'];

function parseScenarioArgv(argv, defaultId = 'all') {
    const fromEnv = process.env.FIVE_SCENARIO;
    if (fromEnv) return String(fromEnv).trim().toLowerCase();

    const fromNpm = process.env.npm_config_scenario;
    if (fromNpm) return String(fromNpm).trim().toLowerCase();

    const args = argv || [];
    if (args.includes('--focus')) return 'focus';
    const eq = args.find((a) => a.startsWith('--scenario='));
    if (eq) return eq.split('=')[1] || defaultId;
    const idx = args.indexOf('--scenario');
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    return defaultId;
}

/** @param {string[]} [argv] @param {string} [defaultId] @returns {string[]} */
function parseSpScenarioSlices(argv, defaultId = 'all') {
    const raw = parseScenarioArgv(argv, defaultId);
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Full solo playthrough (50-tile bag, AI + peel + dump). */
function isSpActionsPlaythrough(slices) {
    return slices.includes('actions');
}

/**
 * Unit-test slices only (not actions).
 * @param {string[]} slices
 * @returns {string[]}
 */
function resolveSpActionSlices(slices) {
    return slices.filter((s) => SP_ACTION_SLICES.includes(s));
}

function isSpActionScenario(slices) {
    return slices.some((s) => SP_ACTION_SLICES.includes(s));
}

function listScenarios(kind = 'mp') {
    return kind === 'sp' ? [...SP_SCENARIOS] : [...MP_SCENARIOS];
}

/** @param {string} raw */
function parseWinSideValue(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'host' || s === 'p1') return 'host';
    if (s === 'guest' || s === 'p2') return 'guest';
    throw new Error(`Invalid --win= value "${raw}" (use host or guest)`);
}

/** @param {string[]} [argv] @returns {'host'|'guest'|null} null = random */
function parseWinSideArgv(argv = process.argv.slice(2)) {
    const eq = argv.find((a) => a.startsWith('--win='));
    if (eq) return parseWinSideValue(eq.slice('--win='.length));

    const idx = argv.indexOf('--win');
    if (idx >= 0 && argv[idx + 1]) return parseWinSideValue(argv[idx + 1]);

    const fromEnv = process.env.FIVE_MP_WIN_SIDE;
    if (fromEnv) return parseWinSideValue(fromEnv);

    const fromNpm = process.env.npm_config_win;
    if (fromNpm) return parseWinSideValue(fromNpm);

    return null;
}

module.exports = {
    MP_SCENARIOS,
    SP_SCENARIOS,
    SP_ACTION_SLICES,
    parseScenarioArgv,
    parseWinSideArgv,
    parseWinSideValue,
    parseSpScenarioSlices,
    resolveSpActionSlices,
    isSpActionsPlaythrough,
    isSpActionScenario,
    listScenarios
};
