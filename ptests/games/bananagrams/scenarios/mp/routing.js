/**
 * 3p scenarios routed through registry + mp-n-audit (not the legacy mp-3p monolith).
 */
const ROUTED_3P_SCENARIOS = new Set(['join', 'ctx-proof', 'full', 'solve', 'peel-register-repro']);

/** Default 3p scenario when --scenario is omitted (full after step 5). */
const DEFAULT_3P_SCENARIO = 'full';

module.exports = {
    ROUTED_3P_SCENARIOS,
    DEFAULT_3P_SCENARIO
};
