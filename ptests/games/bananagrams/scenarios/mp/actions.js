/**
 * actions — full 21-tile AI play-to-win (no micro fixtures).
 */
const { defineMpScenario } = require('./contract');
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const { applySpeedProfile } = require('../../../../shared/infra/speed-profiles');
const { getWinSide, getActiveRunConfig, isPaused } = require('../../../../shared/infra/run-config');
const { parseWinSideArgv } = require('../registry');
const { resolveSessionRounds } = require('../../lib/mp-session-config');
const { withActionsTimeout } = require('../../runners/mp-audit/actions-audit');
const { bootMpPlaySessionThroughDeal, bootMpPlaySessionSplit } = require('../../lib/mp-session-boot');
const { audit } = require('../../assertions');
const { runMpAiActionsOnlyFromCtx } = require('./ai-playthrough');
const { seedBananaParty } = require('./seed-party');

async function runActionsScenario(scenarioCtx) {
    const { ctx, mobile, options = {}, skipSeed } = scenarioCtx;

    if (!skipSeed) {
        await seedBananaParty(scenarioCtx, { dealLabel: 'actions host deal after invite' });
    }

    await Promise.all(ctx.pages.map((p) => p.setDefaultTimeout(STEP_MS)));
    applySpeedProfile('ci', { scenario: 'actions' });

    const cfg = getActiveRunConfig();
    const playOpts = {
        ...options,
        skipSeed: true,
        mobile,
        rounds: resolveSessionRounds({ ...options, rounds: options.rounds ?? cfg.rounds }),
        winSide: options.winSide ?? getWinSide() ?? parseWinSideArgv() ?? null,
        pause: options.pause ?? isPaused()
    };

    if (ctx.playerCount >= 3) {
        let { frames } = await bootMpPlaySessionThroughDeal(ctx, { mobile });
        await audit.assertPreSplitDealAudit(ctx, frames);
    await bootMpPlaySessionSplit(ctx, frames, { mobile });
    ctx.frames = frames;
    }

    return withActionsTimeout(
        runMpAiActionsOnlyFromCtx(ctx, playOpts),
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
