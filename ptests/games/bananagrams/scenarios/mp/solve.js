/**
 * solve — dev /b solve command lifecycle in MP session.
 */
const { bootMpPlaySessionFromPages, bootMpPlaySessionThroughDeal, bootMpPlaySessionSplit } = require('../../lib/mp-session-boot');
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');

const { audit } = require('../../assertions');

const { runMpBoardSolveScenarios, runMpBoardSolveScenariosFromCtx } = require('../sp/solve');
const { resolveSessionRounds } = require('../../lib/mp-session-config');
const { seedBananaParty } = require('./seed-party');

async function runSolveScenario(scenarioCtx) {
    const { ctx, mobile, options = {} } = scenarioCtx;
    const rounds = resolveSessionRounds(options);
    if (rounds > 1) {
        lib.log(
            `Note: --rounds=${rounds} on --scenario=solve runs the solve suite once `
            + '(use --scenario=review for solve-2 win loops).'
        );
    }

    await seedBananaParty(scenarioCtx, { dealLabel: 'solve host deal after invite' });

    if (ctx.playerCount === 2) {
        await bootMpPlaySessionFromPages(ctx.pages[0], ctx.pages[1], { mobile });
        await runMpBoardSolveScenarios(ctx.pages[0], ctx.pages[1]);
        return;
    }

    let { frames } = await bootMpPlaySessionThroughDeal(ctx, { mobile });
    await audit.assertPreSplitDealAudit(ctx, frames);
    await bootMpPlaySessionSplit(ctx, frames, { mobile });
    ctx.frames = frames;
    await runMpBoardSolveScenariosFromCtx(ctx);
}

module.exports = defineMpScenario({
    id: 'solve',
    kind: 'real-gameplay',
    description: 'Dev /b solve board command — solver apply + MP sync',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2, 3],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['mp-review', 'mp-sync-board']
}, runSolveScenario);
