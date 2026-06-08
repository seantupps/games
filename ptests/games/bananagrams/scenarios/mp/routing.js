/**
 * N-player MP scenarios routed through registry + mp-n-audit (not legacy monoliths).
 */
const GameRegistry = require('../../../../../shared/games/registry');

const ROUTED_MP_SCENARIOS = new Set([
    'join', 'ctx-proof', 'full', 'solve', 'peel-register-repro', 'actions', 'review', 'sync', 'focus'
]);

/** Default N-player scenario when --scenario is omitted. */
const DEFAULT_MP_SCENARIO = 'full';

/**
 * @param {string} [gameId]
 * @returns {number[]}
 */
function supportedMpPlayerCounts(gameId = 'bananagrams') {
    return GameRegistry.mpPlayerCountsFor(gameId);
}

module.exports = {
    ROUTED_MP_SCENARIOS,
    DEFAULT_MP_SCENARIO,
    supportedMpPlayerCounts
};
