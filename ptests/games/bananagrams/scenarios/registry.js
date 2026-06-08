/**
 * Scenario names for Bananagrams test entry points.
 *   node ptests/run.js mp --game=bananagrams              → consolidated full audit (one session)
 *   node ptests/run.js mp --game=bananagrams --scenario=all → every MP scenario (separate runs)
 *
 * Scenario roles:
 *   full    — 21-tile gameplay parity (deal, split, AI win, review, distribution)
 *   sync    — micro layout/sync invariants (disconnected stragglers, peel spawn timing)
 *   review  — last-bunch pool drain + solve/win/review loop (last-bunch alias)
 *   join    — sequential 3p invite join orders
 *   ctx-proof — MpCtx assertion smoke (pool, peel, banner) on 2p and 3p
 */

const MP_SCENARIOS = ['full', 'sync', 'focus', 'actions', 'solve', 'review', 'join', 'ctx-proof', 'peel-register-repro'];
/** Bare `--game=bananagrams` — single full audit (focus/solve/actions/review via `--scenario=`). */
const MP_DEFAULT_SUITE = ['full'];
const SP_SCENARIOS = ['all', 'hub', 'ui', 'actions', 'placement', 'dump', 'peel', 'solve'];
const SP_ACTION_SLICES = ['placement', 'dump', 'peel'];

/**
 * Multi-round / play-to-win MP debug runs should use actions (AI playthrough), not full audit.
 * @param {{ game?: string|null, scenario?: string|null, rounds?: number, winSide?: string|null, pause?: boolean }} config
 * @returns {string|null}
 */
function inferBananagramsMpScenario(config) {
    if (!config || config.scenario || config.manualTest) return null;
    const game = config.game;
    if (game) {
        const { matchesGameFilter } = require('../../../shared/infra/run-spec');
        if (!matchesGameFilter(game, 'bananagrams')) return null;
    }
    if ((config.rounds || 0) > 1 || config.winSide || config.pause) return 'actions';
    return null;
}

/**
 * Bare `--game=bananagrams` (no --scenario/--win/--rounds/--pause) runs consolidated `full` audit.
 * `--scenario=all` runs every MP scenario; other explicit flags run a single scenario.
 * @param {import('../../../shared/infra/run-spec').RunConfig} [config]
 * @returns {string[]}
 */
function resolveBananagramsMpScenarioPlan(config) {
    const cfg = config || (() => {
        try {
            return require('../../../shared/infra/run-config').getActiveRunConfig();
        } catch (_) {
            return {};
        }
    })();

    if (cfg.manualTest) return [];

    if (cfg.scenario) {
        let scenario = String(cfg.scenario).trim().toLowerCase();
        if (scenario === 'last-bunch') scenario = 'review';
        if (scenario === 'all') return [...MP_SCENARIOS];
        return [scenario];
    }

    const inferred = inferBananagramsMpScenario(cfg);
    if (inferred) return [inferred];

    const game = cfg.game;
    if (game) {
        const { matchesGameFilter } = require('../../../shared/infra/run-spec');
        if (matchesGameFilter(game, 'bananagrams')) {
            return [...MP_DEFAULT_SUITE];
        }
    }

    return ['full'];
}

function parseScenarioArgv(argv, defaultId = 'all') {
    try {
        const { getActiveRunConfig } = require('../../../shared/infra/run-config');
        const cfg = getActiveRunConfig();
        if (cfg.scenario) return String(cfg.scenario).trim().toLowerCase();
        const inferred = inferBananagramsMpScenario(cfg);
        if (inferred) return inferred;
    } catch (_) { /* run-config optional in some entry points */ }

    const args = argv || [];
    if (args.includes('--focus')) return 'focus';
    const eq = args.find((a) => a.startsWith('--scenario='));
    if (eq) {
        const v = eq.split('=')[1] || defaultId;
        return String(v).trim().toLowerCase() === 'last-bunch' ? 'review' : v;
    }
    const idx = args.indexOf('--scenario');
    if (idx >= 0 && args[idx + 1]) {
        const v = args[idx + 1];
        return String(v).trim().toLowerCase() === 'last-bunch' ? 'review' : v;
    }
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
    if (kind === 'mp') {
        const { listMpScenarioMeta } = require('./mp/index');
        return listMpScenarioMeta().map((m) => m.id);
    }
    return [...SP_SCENARIOS];
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

    try {
        const { getWinSide } = require('../../../shared/infra/run-config');
        const fromConfig = getWinSide();
        if (fromConfig) return fromConfig;
    } catch (_) { /* run-config optional */ }

    return null;
}

module.exports = {
    MP_SCENARIOS,
    MP_DEFAULT_SUITE,
    SP_SCENARIOS,
    SP_ACTION_SLICES,
    inferBananagramsMpScenario,
    resolveBananagramsMpScenarioPlan,
    parseScenarioArgv,
    parseWinSideArgv,
    parseWinSideValue,
    parseSpScenarioSlices,
    resolveSpActionSlices,
    isSpActionsPlaythrough,
    isSpActionScenario,
    listScenarios
};
