/**
 * focus — dump/peel convergence stress (micro rounds, strict tile stability).
 */
const { defineMpScenario } = require('./contract');
const { runFullScenario } = require('./full-run');

module.exports = defineMpScenario({
    id: 'focus',
    kind: 'micro-fixture',
    description: 'Dump/peel stress — post-reset guest-first dump banners, on-screen dump spawns in current viewport',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['mp-sync-board', 'peel-grid', 'dump-spawn', 'peel-spawn']
}, async (scenarioCtx) => runFullScenario({
    ...scenarioCtx,
    options: { ...scenarioCtx.options, focusDumpPeel: true }
}));
