/**
 * Shared Bananagrams MP party seed — 2p invite or 3p+ sequential join.
 */
const lib = require('../../lib/mp-state');
const { joinBananaPartySequentially } = require('../../lib/banana-mp-party');
const { joinReady } = require('../../assertions');
const { assertJoinedPlayersReadyWithVisibility } = joinReady;
const { deal } = require('../../assertions');

/**
 * @param {import('./contract').ScenarioContext} scenarioCtx
 * @param {{ dealLabel?: string, log?: (msg: string) => void }} [opts]
 */
async function seedBananaParty(scenarioCtx, opts = {}) {
    const { ctx, roomId, mobile, options = {} } = scenarioCtx;
    if (scenarioCtx.skipSeed) return;

    const dealLabel = opts.dealLabel || 'host deal after invite';
    const log = opts.log || lib.log;

    if (ctx.playerCount === 2) {
        await lib.joinBananaPartyViaInvite(ctx.pages[0], ctx.pages[1], roomId);
        await deal.assertHostDealPool(
            ctx.host.page,
            lib.EXPECTED_MP_2P_POOL,
            dealLabel,
            ctx.mp
        );
        return;
    }

    const mobilePageIndices = mobile ? ctx.pages.map((_, i) => i) : (options.mobilePageIndices || []);
    const guestOrder = options.guestJoinOrder || Array.from({ length: ctx.playerCount - 1 }, (_, i) => i + 1);

    await joinBananaPartySequentially(ctx.pages, roomId, guestOrder, {
        log,
        mobilePageIndices,
        playerDefs: ctx.players,
        waitJoinedPlayersReady: (pages, indices, rId, label, joinOpts) =>
            assertJoinedPlayersReadyWithVisibility(pages, indices, rId, label, {
                ...joinOpts,
                playerDefs: ctx.players,
                mobilePageIndices
            })
    });
}

module.exports = { seedBananaParty };
