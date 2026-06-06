/**
 * 3-player full audit — ctx-based parity with 2p full-run + legacy runBananagrams3pTest.
 */
const lib = require('../../lib/mp-state');
const { bootMpPlaySessionN } = require('../../lib/mp-session-boot');
const { assertJoinedPlayersReadyWithVisibility } = require('../../lib/mp-join-ready');
const { joinBananaPartySequentially } = require('../../../../shared/infra/scenarios/mp-3p-banana-party');
const { centerMpViewerOnPages } = require('../../../../shared/platform/mp-headed-view');
const {
    assertAllPlayersDragLocal,
    assertAllPlayersRefreshPreservesLayout,
    assertSnapRules,
    assertNoPeelOnRack,
    clearMpLayoutPersistence,
    runPostGameReviewAudit
} = require('../../assertions/mp-full-audit-ctx');

const { log, getGameFrame } = lib;

/**
 * @param {import('./contract').MpScenarioContext} scenarioCtx
 */
async function runFullScenario3p(scenarioCtx) {
    const { ctx, roomId, mobile, options = {} } = scenarioCtx;
    const pages = ctx.pages;
    const playerDefs = ctx.players;

    if (!scenarioCtx.skipSeed) {
        const mobilePageIndices = mobile ? pages.map((_, i) => i) : (options.mobilePageIndices || []);
        const guestOrder = options.guestJoinOrder || [1, 2];
        await joinBananaPartySequentially(pages, roomId, guestOrder, {
            log,
            mobilePageIndices,
            assertJoinedPlayersReady: (p, indices, rId, label, opts) =>
                assertJoinedPlayersReadyWithVisibility(p, indices, rId, label, {
                    ...opts,
                    playerDefs,
                    mobilePageIndices
                })
        });
    }

    log(`Bananagrams MP 3p full audit in room ${roomId}${mobile ? ' (mobile)' : ''}...`);
    let { frames, poolAfterDeal: pool } = await bootMpPlaySessionN(ctx, { mobile });

    const tileIdByUid = await assertAllPlayersDragLocal(ctx, frames, { mobile });

    if (!mobile) {
        frames = await assertAllPlayersRefreshPreservesLayout(ctx, frames, tileIdByUid);
    } else {
        log('MP mobile: skip per-player refresh (SP mobile audit covers refresh).');
    }

    await assertSnapRules(ctx, frames[0]);
    await assertNoPeelOnRack(ctx, frames[0]);
    await clearMpLayoutPersistence(ctx, frames);

    log('AI: solver-driven 3-player playthrough (placement, peel, dump)...');
    const { runMpAiPlaythrough3p, resetMpForAiPlaythrough3p } = require('../../runners/mp-audit/mp-ai-playthrough-3p');
    await resetMpForAiPlaythrough3p({
        pages,
        frames,
        playerCount: ctx.playerCount,
        expectedPool: pool
    });
    await runMpAiPlaythrough3p({
        pages,
        frames,
        playerCount: ctx.playerCount
    });
    log('SUCCESS: 3p AI playthrough complete.');

    for (let i = 0; i < frames.length; i++) {
        frames[i] = await getGameFrame(pages[i]);
    }

    if (mobile) {
        const { ensureWinBannerDwellForAudit } = require('../../assertions/layout-hub');
        const { enableMobileHub } = require('../../../../platform/mobile/lib/mobile_assertions');
        await ensureWinBannerDwellForAudit(pages);
        await Promise.all(pages.map((p) => enableMobileHub(p)));
    }

    await runPostGameReviewAudit(ctx, frames, { mobile });

    if (!mobile) {
        await centerMpViewerOnPages(pages, { mobile: false });
    }

    console.log('SUCCESS: Bananagrams MP full 3-player audit passed.');
    return true;
}

module.exports = { runFullScenario3p };
