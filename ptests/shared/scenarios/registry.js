/**
 * Standard scenario vocabulary for all ptests games.
 *
 * New games register game-specific slices in their own scenarios/registry.js
 * only when standard names are insufficient (Bananagrams actions/placement/etc.).
 *
 * Platform runners map:
 *   smoke / ci  → fast capability checks (CI)
 *   default     → capability + cap-driven MP sync scenarios
 *   full        → default + generic move loop (multiplayer_base / audit_base)
 *   focus       → dev speed profile; game picks one area via --scenario=focus,area
 */

const STANDARD_SCENARIOS = ['smoke', 'default', 'full', 'focus'];

/** CLI aliases */
const SCENARIO_ALIASES = {
    ci: 'smoke'
};

/**
 * @param {string|null|undefined} raw
 * @returns {string}
 */
function normalizeScenario(raw) {
    const s = String(raw || 'default').trim().toLowerCase();
    return SCENARIO_ALIASES[s] || s;
}

/**
 * @param {string[]} argv
 * @param {string} [fallback]
 * @returns {string[]}
 */
function parseScenarioSlices(argv, fallback = 'default') {
    const flag = argv.find((a) => a.startsWith('--scenario='));
    if (flag) {
        return flag.slice('--scenario='.length)
            .split(',')
            .map((s) => normalizeScenario(s.trim()))
            .filter(Boolean);
    }
    try {
        const { getScenario } = require('../infra/run-config');
        const fromConfig = getScenario();
        if (fromConfig) {
            return String(fromConfig)
                .split(',')
                .map((s) => normalizeScenario(s.trim()))
                .filter(Boolean);
        }
    } catch (_) { /* run-config optional */ }
    return [normalizeScenario(fallback)];
}

/**
 * @param {string|string[]|null|undefined} scenario
 */
function isSmokeScenario(scenario) {
    const slices = Array.isArray(scenario) ? scenario : [scenario].filter(Boolean);
    if (!slices.length) {
        try {
            const { isSlimAudit } = require('../infra/run-config');
            return isSlimAudit();
        } catch (_) {
            return false;
        }
    }
    return slices.some((s) => normalizeScenario(s) === 'smoke');
}

function listStandardScenarios() {
    return STANDARD_SCENARIOS.slice();
}

module.exports = {
    STANDARD_SCENARIOS,
    SCENARIO_ALIASES,
    normalizeScenario,
    parseScenarioSlices,
    isSmokeScenario,
    listStandardScenarios
};
