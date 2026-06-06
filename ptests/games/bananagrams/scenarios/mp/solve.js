/**
 * solve — dev /b solve command lifecycle in MP session.
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { bootMpPlaySession } = require('../../runners/mp-audit/mp-play-boot');
const { bootMpPlaySessionN } = require('../../lib/mp-session-boot');
const { runMpBoardSolveScenarios, runMpBoardSolveScenariosFromCtx } = require('../sp/solve');
const { resolveSessionRounds } = require('../../runners/mp-audit/mp-ai-playthrough');
const { joinBananaPartySequentially } = require('../../../../shared/infra/scenarios/mp-3p-banana-party');
const { assertJoinedPlayersReadyWithVisibility } = require('../../lib/mp-join-ready');

async function seedParty(scenarioCtx) {
    const { ctx, roomId, mobile, options = {} } = scenarioCtx;
    if (scenarioCtx.skipSeed) return;

    if (ctx.playerCount === 2) {
        await lib.joinBananaPartyViaInvite(ctx.pages[0], ctx.pages[1], roomId);
        return;
    }

    const mobilePageIndices = mobile ? ctx.pages.map((_, i) => i) : (options.mobilePageIndices || []);
    const guestOrder = options.guestJoinOrder || [1, 2];
    await joinBananaPartySequentially(ctx.pages, roomId, guestOrder, {
        log: lib.log,
        mobilePageIndices,
        assertJoinedPlayersReady: (pages, indices, rId, label, opts) =>
            assertJoinedPlayersReadyWithVisibility(pages, indices, rId, label, {
                ...opts,
                playerDefs: ctx.players,
                mobilePageIndices
            })
    });
}

async function runSolveScenario(scenarioCtx) {
    const { ctx, mobile, options = {} } = scenarioCtx;
    const rounds = resolveSessionRounds(options);
    if (rounds > 1) {
        lib.log(
            `Note: --rounds=${rounds} on --scenario=solve runs the solve suite once `
            + '(use --scenario=review for solve-2 win loops).'
        );
    }

    await seedParty(scenarioCtx);

    if (ctx.playerCount === 2) {
        await bootMpPlaySession(ctx.pages[0], ctx.pages[1], { mobile });
        await runMpBoardSolveScenarios(ctx.pages[0], ctx.pages[1]);
        return;
    }

    await bootMpPlaySessionN(ctx, { mobile });
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
