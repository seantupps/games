/**
 * template — canonical MpCtx scenario skeleton.
 *
 * Copy this file when adding a new MP scenario. Pattern:
 *   1. defineMpScenario metadata (id, kind, playerCounts, assertions list)
 *   2. seedBananaParty via shared seed-party module
 *   3. assertions barrel only (capture → compare → assert)
 *   4. no page1/page2 boot helpers; no runner imports from assertions/
 *
 *   node ptests/run.js mp --game=bananagrams --scenario=template
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { bootMpPlaySessionN } = require('../../lib/mp-session-boot');
const { seedBananaParty } = require('./seed-party');
const { sync, core } = require('../../assertions');

async function runTemplateScenario(scenarioCtx) {
    const { ctx, mobile } = scenarioCtx;
    const log = lib.log;

    await seedBananaParty(scenarioCtx, { dealLabel: 'template host deal' });

    log(`template: boot ${ctx.playerCount}p via bootMpPlaySessionN...`);
    const { frames, poolAfterDeal } = await bootMpPlaySessionN(ctx, { mobile });
    ctx.frames = frames;

    log('template: pool synced on all clients...');
    await sync.assertAllPlayersPoolSynced(ctx, 'template pool', { expectedPool: poolAfterDeal });

    const snap = await core.capture.capturePlayerStates(ctx, 'template-post-boot');
    core.assertOk(snap.host.boardPileCount === poolAfterDeal, 'host pool after boot', { snap, poolAfterDeal });

    log(`SUCCESS: template scenario passed (${ctx.playerCount}p).`);
}

module.exports = defineMpScenario({
    id: 'template',
    kind: 'micro-fixture',
    description: 'Canonical MpCtx + barrel assertions skeleton (copy for new scenarios)',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2, 3],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: false,
    assertions: ['mp-sync', 'deal', 'core.capture']
}, runTemplateScenario);
