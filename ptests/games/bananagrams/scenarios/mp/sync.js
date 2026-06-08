/**
 * sync — micro MP sync invariants (4-tile fixtures, peel spawn timing).
 * Real gameplay paths use --scenario=full or --scenario=actions.
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { bootMpPlaySessionFromPages } = require('../../lib/mp-session-boot');
const { getGameFrame } = lib;
const { patchMpThreeLetterChecker } = require('../../fixtures/mp-four-tile');
const { sync } = require('../../assertions');
const { runMpPeelSpawnScenario } = require('./sync-peel');
const { seedBananaParty } = require('./seed-party');

async function runSyncScenario(scenarioCtx) {
    const {
        page1,
        page2,
        mobile = false,
        mp: mpIn = null
    } = scenarioCtx;
    const mp = mpIn || { page1, page2 };
    const log = lib.log;

    if (!scenarioCtx.skipSeed) {
        await seedBananaParty(scenarioCtx, { dealLabel: 'sync host deal after invite' });
    }

    log('MP sync invariants: host-authoritative micro fixtures (4-tile symmetric)...');

    const boot = await bootMpPlaySessionFromPages(page1, page2, { mobile });
    let frame1 = boot.frame1;
    let frame2 = boot.frame2;

    await patchMpThreeLetterChecker([frame1, frame2]);

    log('MP sync: guest disconnected stragglers stable when host peels...');
    await sync.assertHostPeelGuestDisconnectedTilesStable({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        ctx: scenarioCtx.ctx,
        log
    });

    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);

    await runMpPeelSpawnScenario({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        log,
        microFixture: true
    });

    log('SUCCESS: MP sync invariant audit passed.');
}

module.exports = defineMpScenario({
    id: 'sync',
    kind: 'micro-fixture',
    description: 'Host-authoritative micro fixtures: disconnected stragglers + peel spawn skew',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['sync', 'mp-four-tile', 'peel-grid']
}, runSyncScenario);
