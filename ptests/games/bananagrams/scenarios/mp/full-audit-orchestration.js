/**
 * MP full audit orchestration — ctx-native (2p/3p+ unified).
 */
const lib = require('../../lib/mp-state');
const { log, WAIT_MS, RESET_WAIT_MS, getGameFrame, enableFastBanners } = lib;
const { centerMpViewerOnPages } = require('../../../../shared/platform/mp-headed-view');
const { spawn, audit, sync, deal, review } = require('../../assertions');
const { assertDumpSpawnQuick } = spawn.dump;
const {
    assertAllPlayersDragLocal,
    assertAllPlayersRefreshPreservesLayout,
    assertSnapRules,
    assertNoPeelOnRack,
    clearMpLayoutPersistence,
    runPostGameReviewAudit
} = audit;
const {
    assertGuestFirstSplitStableAfterReset,
    waitForPreSplitHand
} = sync;
const { assertHostSplitSyncsBothAfterPostGameReset } = review;
const { ensureWinBannerDwellForAudit } = require('../../assertions').layout.hub;
const { bootMpPlaySessionFromPages, bootMpPlaySessionThroughDeal, bootMpPlaySessionSplit } = require('../../lib/mp-session-boot');
const { seedBananaParty } = require('./seed-party');
const { resolveSessionRounds, resolveSessionPause } = require('../../lib/mp-session-config');
const { runFocusDumpPeelStress } = require('./focus-dump-peel');
const { attachFramesToCtx } = require('../../lib/mp-ai-side-ctx');

async function syncMpHeadedView(pages, mobile, { review = false } = {}) {
    const {
        isMpHeaded,
        relayoutMpHeadedForReview,
        syncMpHeadedMobileViewport,
        syncMpHeadedReviewViewport
    } = require('../../../../shared/platform/mp-headed-view');
    if (!isMpHeaded()) return;
    if (mobile && review) {
        await relayoutMpHeadedForReview(pages, { mobile: true });
    } else if (mobile) {
        await Promise.all(pages.map((p) => syncMpHeadedMobileViewport(p, { relayoutPages: pages })));
    } else if (review) {
        await relayoutMpHeadedForReview(pages, { mobile: false });
    } else {
        await centerMpViewerOnPages(pages);
    }
}

async function runGuestFirstSplitProbe(ctx, mobile) {
    if (mobile || ctx.playerCount !== 2) return;
    await lib.waitForDeal(ctx.pages[0], 'P1', ctx.mp);
    await lib.waitForDeal(ctx.pages[1], 'P2', ctx.mp);
    await assertGuestFirstSplitStableAfterReset(ctx.pages[0], ctx.pages[1], lib, { mobile });
    log('Re-deal after guest-first-split test for main audit...');
    await (await getGameFrame(ctx.pages[0])).evaluate(() => {
        window.game.resetGame();
    });
    await lib.waitForDeal(ctx.pages[0], 'P1', ctx.mp);
    await lib.waitForDeal(ctx.pages[1], 'P2', ctx.mp);
    await Promise.all([
        waitForPreSplitHand(ctx.pages[0], 'P1', ctx.mp, lib),
        waitForPreSplitHand(ctx.pages[1], 'P2', ctx.mp, lib)
    ]);
}

/** Focus dump/peel stress (2p micro). */
async function runFocusAuditFromCtx(scenarioCtx) {
    const { ctx, mobile, options = {} } = scenarioCtx;
    const focusRounds = options.focusRounds ?? 6;
    const focusJitterMs = options.focusJitterMs ?? 140;
    const pages = ctx.pages;
    const { page1, page2 } = ctx.mp;

    const { resetMpForAiPlaythrough } = require('./ai-playthrough');
    let frame1;
    let frame2;

    if (!scenarioCtx.skipSeed) {
        await seedBananaParty(scenarioCtx);
        ({ frame1, frame2 } = await bootMpPlaySessionFromPages(page1, page2, { mobile, roomId: ctx.roomId }));
    } else {
        frame1 = await getGameFrame(page1);
        frame2 = await getGameFrame(page2);
        const reset = await resetMpForAiPlaythrough({
            ctx,
            pages: ctx.pages,
            frames: [frame1, frame2],
            playerCount: 2,
            mobile,
            instantBanners: true
        });
        frame1 = reset.frame1;
        frame2 = reset.frame2;
    }

    attachFramesToCtx(ctx, [frame1, frame2]);
    return runFocusDumpPeelStress({
        mpCtx: ctx,
        page1,
        page2,
        frame1,
        frame2,
        mp: ctx.mp,
        mobile,
        pages,
        focusRounds,
        focusJitterMs,
        syncMpHeadedView
    });
}

/** Full play-to-win audit with optional multi-round + pause (2p/3p+). */
async function runFullAuditFromCtx(scenarioCtx) {
    const { ctx, roomId, mobile, options = {} } = scenarioCtx;

    if (ctx.playerCount >= 3) {
        return runFullAuditMultiPlayer(scenarioCtx);
    }

    const rounds = resolveSessionRounds(options);
    const pause = resolveSessionPause(options);
    const { getWinSide } = require('../../../../shared/infra/run-config');
    const winSide = options.winSide ?? getWinSide() ?? null;

    await seedBananaParty(scenarioCtx);
    await runGuestFirstSplitProbe(ctx, mobile);

    log(`Bananagrams MP ${ctx.playerCount}p full audit in room ${roomId}${mobile ? ' (mobile)' : ''}...`);
    let { frames, poolAfterDeal: pool } = await bootMpPlaySessionThroughDeal(ctx, { mobile });
    await audit.assertPreSplitDealAudit(ctx, frames);
    await bootMpPlaySessionSplit(ctx, frames, { mobile });
    attachFramesToCtx(ctx, frames);

    const tileIdByUid = await assertAllPlayersDragLocal(ctx, frames, { mobile });
    if (!mobile) {
        frames = await assertAllPlayersRefreshPreservesLayout(ctx, frames, tileIdByUid);
        attachFramesToCtx(ctx, frames);
    } else {
        log('MP mobile: skip per-player refresh (SP mobile audit covers refresh).');
    }

    await assertSnapRules(ctx, frames[0]);
    await assertNoPeelOnRack(ctx, frames[0]);
    await clearMpLayoutPersistence(ctx, frames);

    const {
        runMpAiPlaythrough,
        resetMpForAiPlaythrough,
        advanceActionsRoundAfterReviewFromCtx,
        finishPausedReviewSessionFromCtx,
        exitReviewAfterActionsSessionFromCtx
    } = require('./ai-playthrough');

    if (mobile) {
        const { enableMobileHub } = require('../../../../platform/mobile/lib/mobile_assertions');
        await ensureWinBannerDwellForAudit(ctx.pages);
        await Promise.all(ctx.pages.map((p) => enableMobileHub(p)));
    }

    log(
        `AI: play-to-win (${rounds} round${rounds > 1 ? 's' : ''}`
        + `${pause ? ', pause in review' : ''})...`
    );

    let reset = await resetMpForAiPlaythrough({
        ctx,
        pages: ctx.pages,
        frames,
        playerCount: ctx.playerCount,
        expectedPool: pool,
        instantBanners: true,
        mobileAll: mobile,
        mobile
    });
    frames = [reset.frame1, reset.frame2].filter(Boolean);
    if (ctx.playerCount > 2) {
        frames = await Promise.all(ctx.pages.map((p) => getGameFrame(p)));
    }
    attachFramesToCtx(ctx, frames);

    for (let round = 1; round <= rounds; round++) {
        log(`AI playthrough round ${round}/${rounds}...`);
        await runMpAiPlaythrough({
            ctx,
            pages: ctx.pages,
            frames,
            playerCount: ctx.playerCount,
            playToWin: true,
            assertActionsWinInvariants: true,
            assertWinBanner: !!mobile,
            winSide,
            winDrag: false,
            instantBanners: true,
            mobileAll: mobile,
            mobile,
            aggressiveDumping: !!options.aggressiveDumping,
            aggressiveDumpsPerPlayer: Number(options.aggressiveDumpsPerPlayer) || 10
        });
        log(`SUCCESS: AI playthrough round ${round}/${rounds} complete.`);

        if (round < rounds) {
            reset = await advanceActionsRoundAfterReviewFromCtx(
                ctx,
                `round ${round}/${rounds}`,
                { pause, mobile }
            );
            frames = ctx.playerCount === 2
                ? [reset.frame1, reset.frame2]
                : await Promise.all(ctx.pages.map((p) => getGameFrame(p)));
            attachFramesToCtx(ctx, frames);
            continue;
        }

        if (pause) {
            await finishPausedReviewSessionFromCtx(ctx, { mobile });
            console.log(
                `SUCCESS: Bananagrams MP full ${ctx.playerCount}-player audit passed `
                + `(${rounds} round${rounds > 1 ? 's' : ''}, paused in review).`
            );
            return true;
        }
    }

    attachFramesToCtx(ctx, await Promise.all(ctx.pages.map((p) => getGameFrame(p))));
    await exitReviewAfterActionsSessionFromCtx(ctx, 'play-to-win');

    if (ctx.playerCount === 2) {
        await assertHostSplitSyncsBothAfterPostGameReset(ctx.pages[0], ctx.pages[1], lib, {
            label: 'full audit post-Done host SPLIT',
            mobile
        });
    } else {
        await runPostGameReviewAudit(ctx, ctx.frames, { mobile });
        if (!mobile) {
            await centerMpViewerOnPages(ctx.pages, { mobile: false });
        }
    }

    console.log(
        `SUCCESS: Bananagrams MP full ${ctx.playerCount}-player audit passed`
        + `${rounds > 1 ? ` (${rounds} rounds)` : ''}.`
    );
    return true;
}

/** 3p+ full audit — single playthrough + post-game review (no multi-round Done loop). */
async function runFullAuditMultiPlayer(scenarioCtx) {
    const { ctx, roomId, mobile, options = {} } = scenarioCtx;
    const { getWinSide } = require('../../../../shared/infra/run-config');
    const winSide = options.winSide ?? getWinSide() ?? null;

    await seedBananaParty(scenarioCtx);

    log(`Bananagrams MP ${ctx.playerCount}p full audit in room ${roomId}${mobile ? ' (mobile)' : ''}...`);
    let { frames, poolAfterDeal: pool } = await bootMpPlaySessionThroughDeal(ctx, { mobile });
    await audit.assertPreSplitDealAudit(ctx, frames);
    await bootMpPlaySessionSplit(ctx, frames, { mobile });
    attachFramesToCtx(ctx, frames);

    const tileIdByUid = await assertAllPlayersDragLocal(ctx, frames, { mobile });
    if (!mobile) {
        frames = await assertAllPlayersRefreshPreservesLayout(ctx, frames, tileIdByUid);
        attachFramesToCtx(ctx, frames);
    }

    await assertSnapRules(ctx, frames[0]);
    await assertNoPeelOnRack(ctx, frames[0]);
    await clearMpLayoutPersistence(ctx, frames);

    const { runMpAiPlaythrough, resetMpForAiPlaythrough } = require('./ai-playthrough');

    if (mobile) {
        const { enableMobileHub } = require('../../../../platform/mobile/lib/mobile_assertions');
        await ensureWinBannerDwellForAudit(ctx.pages);
        await Promise.all(ctx.pages.map((p) => enableMobileHub(p)));
    }

    await resetMpForAiPlaythrough({
        ctx,
        pages: ctx.pages,
        frames,
        playerCount: ctx.playerCount,
        expectedPool: pool,
        instantBanners: true,
        mobileAll: mobile,
        mobile
    });
    await runMpAiPlaythrough({
        ctx,
        pages: ctx.pages,
        frames,
        playerCount: ctx.playerCount,
        playToWin: true,
        assertActionsWinInvariants: true,
        instantBanners: true,
        mobileAll: mobile,
        mobile,
        winSide
    });
    log(`SUCCESS: ${ctx.playerCount}p AI playthrough complete.`);

    attachFramesToCtx(ctx, await Promise.all(ctx.pages.map((p) => getGameFrame(p))));
    await runPostGameReviewAudit(ctx, ctx.frames, { mobile });

    if (!mobile) {
        await centerMpViewerOnPages(ctx.pages, { mobile: false });
    }

    console.log(`SUCCESS: Bananagrams MP full ${ctx.playerCount}-player audit passed.`);
    return true;
}

module.exports = {
    syncMpHeadedView,
    seedBananaParty,
    runFocusAuditFromCtx,
    runFullAuditFromCtx
};
