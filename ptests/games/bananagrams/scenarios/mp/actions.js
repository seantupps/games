/**
 * actions — full 21-tile AI play-to-win (no micro fixtures).
 */
const { defineMpScenario } = require('./contract');
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const {
    runBananagramsMpActionsAudit,
    withActionsTimeout
} = require('../../runners/mp-audit/actions-audit');

async function runActionsScenario(ctx) {
    const { page1, page2, roomId, options = {} } = ctx;
    if (!ctx.skipSeed) {
        await require('../../lib/mp-state').joinBananaPartyViaInvite(page1, page2, roomId);
    }
    page1.setDefaultTimeout(STEP_MS);
    page2.setDefaultTimeout(STEP_MS);
    return withActionsTimeout(
        runBananagramsMpActionsAudit(page1, page2, { ...options, skipSeed: true }),
        'MP Actions'
    );
}

module.exports = defineMpScenario({
    id: 'actions',
    kind: 'real-gameplay',
    description: 'AI play-to-win mid-game through victory, review, and distribution',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2, 3],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['mp-review', 'mp-distribution', 'mp-sync-win-banner', 'mp-authority']
}, runActionsScenario);
