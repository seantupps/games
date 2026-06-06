/**
 * full — 21-tile MP gameplay parity (deal → split → dump/peel → AI play-to-win).
 */
const { defineMpScenario } = require('./contract');
const { runFullScenario } = require('./full-run');

module.exports = defineMpScenario({
    id: 'full',
    kind: 'real-gameplay',
    description: '21-tile MP parity: deal, split, dump/peel rounds, refresh, AI play-to-win',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2, 3],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: [
        'mp-sync-split',
        'dump-spawn',
        'peel-spawn',
        'mp-sync-board',
        'mp-review',
        'mp-distribution',
        'layout-hub'
    ]
}, async (scenarioCtx) => runFullScenario({
    ...scenarioCtx,
    options: { ...scenarioCtx.options, focusDumpPeel: false }
}));
