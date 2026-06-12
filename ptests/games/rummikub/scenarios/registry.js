/**
 * Scenario names for Rummikub test entry points.
 *   node ptests/run.js sp --game=rummikub              → AI playthrough (default)
 *   node ptests/run.js sp --game=rummikub --scenario=ui → capability + UI audit
 *
 * Scenario roles:
 *   all         — capability + UI audit + AI playthrough
 *   ui          — capability + UI audit (snap, pan/zoom, layout)
 *   playthrough — AI playthrough only (game logic, no capability audit)
 *   solve       — hub /solve chat scenarios
 *   smoke       — fast capability checks (CI)
 */

const SP_SCENARIOS = ['all', 'ui', 'playthrough', 'solve', 'smoke'];

/** Bare `--game=rummikub` — AI playthrough only. */
const SP_DEFAULT_SUITE = ['playthrough'];

function parseScenarioArgv(argv, defaultId = 'playthrough') {
    try {
        const { getActiveRunConfig } = require('../../../shared/infra/run-config');
        const cfg = getActiveRunConfig();
        if (cfg.scenario) return String(cfg.scenario).trim().toLowerCase();
    } catch (_) { /* run-config optional in some entry points */ }

    const args = argv || [];
    const eq = args.find((a) => a.startsWith('--scenario='));
    if (eq) return String(eq.split('=')[1] || defaultId).trim().toLowerCase();

    const idx = args.indexOf('--scenario');
    if (idx >= 0 && args[idx + 1]) {
        return String(args[idx + 1]).trim().toLowerCase();
    }
    return defaultId;
}

/** @param {string[]} [argv] @param {string} [defaultId] @returns {string[]} */
function parseSpScenarioSlices(argv, defaultId = 'playthrough') {
    const raw = parseScenarioArgv(argv, defaultId);
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Full solo AI playthrough (--scenario=playthrough). */
function isSpPlaythrough(slices) {
    return slices.includes('playthrough');
}

function listScenarios(kind = 'sp') {
    if (kind === 'sp') return [...SP_SCENARIOS];
    return [];
}

module.exports = {
    SP_SCENARIOS,
    SP_DEFAULT_SUITE,
    parseScenarioArgv,
    parseSpScenarioSlices,
    isSpPlaythrough,
    listScenarios
};
