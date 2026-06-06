/**
 * sync — micro MP sync invariants (4-tile fixtures, peel spawn timing).
 * Real gameplay paths use --scenario=full or --scenario=actions.
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { bootMpPlaySession } = require('../../runners/mp-audit/mp-play-boot');
const { getGameFrame } = lib;
const { patchMpThreeLetterChecker } = require('../../fixtures/mp-four-tile');
const {
    assertHostPeelGuestDisconnectedTilesStable
} = require('../../assertions/mp-sync-disconnected');
const { runMpPeelSpawnScenario } = require('./sync-peel');

async function runSyncScenario(ctx) {
    const {
        page1,
        page2,
        mobile = false,
        mp: mpIn = null
    } = ctx;
    const mp = mpIn || { page1, page2 };
    const log = lib.log;

    if (!ctx.skipSeed) {
        await lib.joinBananaPartyViaInvite(page1, page2, ctx.roomId);
    }

    log('MP sync invariants: host-authoritative micro fixtures (4-tile symmetric)...');

    const boot = await bootMpPlaySession(page1, page2, { mobile });
    let frame1 = boot.frame1;
    let frame2 = boot.frame2;

    await patchMpThreeLetterChecker([frame1, frame2]);

    log('MP sync: guest disconnected stragglers stable when host peels...');
    await assertHostPeelGuestDisconnectedTilesStable({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        ctx: ctx.ctx,
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
    assertions: ['mp-sync-disconnected', 'mp-sync-peel-spawn', 'mp-four-tile', 'peel-grid']
}, runSyncScenario);
