/**
 * MP review scenario — last-bunch peel sync, then /b solve 2 → solver finish → win → full review audit.
 *
 *   node ptests/run.js mp --game=bananagrams --scenario=review
 *   node ptests/run.js mp --game=bananagrams --scenario=review --win=guest
 *   node ptests/run.js mp --game=bananagrams --scenario=review --win=guest --rounds=20
 *
 * `last-bunch` is kept as an alias for this scenario.
 */
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const { getGameFrame } = require('../../../../shared/adapters/desktop-input');
const { createTestLogger } = require('../../../../shared/infra/test-logger');
const {
    BUNCH,
    WAIT_MS,
    log,
    HOST_UID,
    GUEST_UID,
    flushHostBananaInteractions,
    enableFastBanners,
    joinBananaPartyViaInvite,
    assertHostDealPool,
    EXPECTED_MP_2P_POOL
} = require('../../lib/mp-state');
const { bootMpPlaySession } = require('../../runners/mp-audit/mp-play-boot');
const { runLastBunchPeelTests } = require('../../fixtures/last-bunch');
const {
    runSolveAndAssert,
    assertMpSolveSynced,
    solveExpectations,
    resetAndSplitMp
} = require('../sp/solve');
const { parseWinSideArgv } = require('../registry');
const {
    runMpAiPlaythrough,
    resolveSessionRounds,
    resolveSessionPause,
    advanceActionsRoundAfterReview
} = require('../../runners/mp-audit/mp-ai-playthrough');
const {
    assertMpReviewShowsAllBoards,
    waitMpResetAfterDone
} = require('../../assertions/mp-review');
const { clickDone } = require('../../assertions/sp-review');
const { assertHostSplitSyncsBothAfterPostGameReset } = require('../../assertions/mp-review-done-split');
const {
    assertGuestWinAfterSolve2Placements,
    collectMpClientDiag
} = require('../../assertions/mp-review-solve2');
const {
    assertGuestWinHubBannerReview
} = require('../../assertions/mp-sync-guest-banner');
const mpLib = require('../../lib/mp-state');

const TIMEOUT_MS = STEP_MS;
const RESET_WAIT_MS = WAIT_MS;
const logger = createTestLogger({ gameId: 'bananagrams', scenario: 'review' });
const MIN_REVIEW_TILES_PER_PLAYER = 6;

async function waitForDictReady(page) {
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.gameName === 'bananagrams' && !!g?._dictReady && !!g?._checker;
    }, { timeout: TIMEOUT_MS });
}

async function waitForSolverReady(page) {
    await page.waitForFunction(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        return !!win?.BananaDev?.solveDevCrossword && !!win?.BananaAi?.solveAttemptFromRack;
    }, { timeout: TIMEOUT_MS });
}

/**
 * Every client must render both players' review boards (host-only view is a failure).
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 * @param {import('playwright').Frame[]} frames
 * @param {string[]} uids
 * @param {string} label
 * @param {{ round?: number, rounds?: number }} [meta]
 */
async function assertBothPlayersReviewBoardsOnEveryClient(hostPage, guestPage, frames, uids, label, meta = {}) {
    for (let i = 0; i < frames.length; i++) {
        const role = i === 0 ? 'host' : 'guest';
        const clientLabel = `${label} ${role} merged boards`;
        try {
            await assertMpReviewShowsAllBoards(
                frames[i],
                uids,
                clientLabel,
                MIN_REVIEW_TILES_PER_PLAYER
            );
        } catch (err) {
            const [hostDiag, guestDiag, frameState] = await Promise.all([
                collectMpClientDiag(hostPage, 'host'),
                collectMpClientDiag(guestPage, 'guest'),
                frames[i].evaluate(({ uids: playerUids }) => {
                    const g = window.game;
                    const board = g?.roomData?.global?.board;
                    const layouts = board?.reviewLayouts || g?._reviewLayouts || {};
                    const perLayout = {};
                    Object.entries(layouts).forEach(([uid, tiles]) => {
                        perLayout[uid] = Array.isArray(tiles) ? tiles.length : null;
                    });
                    const tiles = g?.tiles || [];
                    const ownerSample = tiles.slice(0, 8).map((t) => ({
                        id: t.id,
                        letter: t.letter,
                        ownerUid: t.ownerUid,
                        x: t.x,
                        y: t.y,
                        faceUp: t.faceUp
                    }));
                    return {
                        role: g?.isHost?.() ? 'host' : 'guest',
                        tileCount: tiles.length,
                        perLayout,
                        ownerSample,
                        reviewEpoch: board?.reviewEpoch ?? null,
                        winnerUid: board?.winnerUid ?? g?._winnerUid ?? null
                    };
                }, { uids })
            ]);
            const roundTag = meta.round != null && meta.rounds != null
                ? ` round ${meta.round}/${meta.rounds}`
                : '';
            const detail = [
                `${clientLabel} FAILED${roundTag}: ${err.message}`,
                '',
                '--- failing client frame ---',
                JSON.stringify(frameState, null, 2),
                '',
                '--- host diag ---',
                JSON.stringify(hostDiag, null, 2),
                '',
                '--- guest diag ---',
                JSON.stringify(guestDiag, null, 2)
            ].join('\n');
            log(detail);
            throw new Error(detail);
        }
    }
    log(`SUCCESS: ${label} — both players' boards visible on host and guest`);
}

/**
 * /b solve 2 → finish → win → review checks (one round).
 * @param {'host'|'guest'|null} winSide
 * @param {{ round?: number, rounds?: number }} [meta]
 */
async function runSolveToWinReviewTests(page1, page2, frame1, frame2, mp, winSide = null, meta = {}) {
    const side = winSide ?? parseWinSideArgv() ?? 'host';
    const roundLabel = meta.round != null && meta.rounds != null
        ? ` [round ${meta.round}/${meta.rounds}]`
        : '';
    const reviewLog = logger.child({ step: 'solve-to-win review', winSide: side, ...meta });
    const exp2 = solveExpectations(2, 2, BUNCH);

    reviewLog.step(`Fresh reset + SPLIT before /b solve 2${roundLabel}`);
    await resetAndSplitMp(page1, page2);

    await waitForDictReady(page1);
    await waitForSolverReady(page1);
    await Promise.all([waitForDictReady(page2), waitForSolverReady(page2)]);

    reviewLog.step(`/b solve 2 (bunch=2, 1 straggler each) — winSide=${side}${roundLabel}`);
    let solveOk = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await flushHostBananaInteractions(page1);
            await runSolveAndAssert(page1, 2, exp2, reviewLog);
            solveOk = true;
            break;
        } catch (err) {
            lastErr = err;
            reviewLog.step(`/b solve 2 attempt ${attempt} failed — ${err.message}`);
            if (attempt < 3) {
                await flushHostBananaInteractions(page1);
                await page1.waitForTimeout(80);
            }
        }
    }
    if (!solveOk) {
        throw lastErr || new Error('Review: /b solve 2 failed after retries');
    }

    await assertMpSolveSynced(page1, page2, `review /b solve 2 sync${roundLabel}`, exp2);

    if (side === 'guest') {
        reviewLog.step(`Guest finishes /b solve 2 via applyPlacements${roundLabel}`);
        frame2 = await getGameFrame(page2);
        await assertGuestWinAfterSolve2Placements(page1, page2, frame2, mp, 'review solve-2 guest placements', meta);
        await assertGuestWinHubBannerReview(page1, page2, frame2, `solve-2 guest win${roundLabel}`);
        reviewLog.success('solve-2 guest placements', `guest win + review + hub banner${roundLabel}`);
    } else {
        reviewLog.step(`Solver finish → ${side} win (play-to-win)${roundLabel}`);
        await runMpAiPlaythrough({
            page1,
            page2,
            frame1,
            frame2,
            mp,
            playToWin: true,
            assertActionsWinInvariants: true,
            winSide: side,
            winDrag: false,
            instantBanners: true,
            maxRoundTrips: 40
        });
    }

    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);
    await assertBothPlayersReviewBoardsOnEveryClient(
        page1,
        page2,
        [frame1, frame2],
        [HOST_UID, GUEST_UID],
        `solve-2 ${side} win${roundLabel}`,
        meta
    );
    reviewLog.success('solve-to-win review', `${side} win — merged boards on host and guest${roundLabel}`);
}

/**
 * @param {import('playwright').Page} page1 host
 * @param {import('playwright').Page} page2 guest
 * @param {{ roomId?: string, mobile?: boolean, skipSeed?: boolean, winSide?: 'host'|'guest'|null, rounds?: number, pause?: boolean }} [options]
 */
async function runReviewScenarioAudit(page1, page2, options = {}) {
    const roomId = options.roomId || `MP_REVIEW_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const mp = { page1, page2 };
    const rounds = resolveSessionRounds(options);
    const pause = resolveSessionPause(options);
    const winSide = options.winSide ?? parseWinSideArgv() ?? 'host';

    let frame1;
    let frame2;
    if (options.skipSeed) {
        const { resetMpForAiPlaythrough } = require('../../runners/mp-audit/mp-ai-playthrough');
        frame1 = await getGameFrame(page1);
        frame2 = await getGameFrame(page2);
        const reset = await resetMpForAiPlaythrough({
            page1, page2, frame1, frame2, mp, mobile: !!options.mobile
        });
        frame1 = reset.frame1;
        frame2 = reset.frame2;
    } else {
        await joinBananaPartyViaInvite(page1, page2, roomId);
        await assertHostDealPool(page1, EXPECTED_MP_2P_POOL, 'review host deal bunch', mp);
        ({ frame1, frame2 } = await bootMpPlaySession(page1, page2, { mobile: !!options.mobile }));
    }
    await Promise.all([enableFastBanners(frame1), enableFastBanners(frame2)]);

    log('Review scenario: last-bunch peel sync (host + guest peels)...');
    await runLastBunchPeelTests(page1, page2, frame1, frame2, mp, { includeGuestWin: false });

    if (rounds > 1) {
        log(`Review scenario: solve-to-win × ${rounds} rounds (winSide=${winSide}${pause ? ', pause between' : ''})...`);
    }

    for (let round = 1; round <= rounds; round++) {
        log(`Review solve-to-win round ${round}/${rounds} (winSide=${winSide})...`);
        frame1 = await getGameFrame(page1);
        frame2 = await getGameFrame(page2);
        try {
            await runSolveToWinReviewTests(page1, page2, frame1, frame2, mp, winSide, { round, rounds });
        } catch (err) {
            throw new Error(`Review solve-to-win round ${round}/${rounds} failed: ${err.message}`);
        }
        log(`SUCCESS: Review solve-to-win round ${round}/${rounds}`);

        if (round < rounds) {
            const next = await advanceActionsRoundAfterReview(
                page1,
                page2,
                frame1,
                frame2,
                mp,
                !!options.mobile,
                `review round ${round}/${rounds}`,
                { pause }
            );
            frame1 = next.frame1;
            frame2 = next.frame2;
        }
    }

    log('Review scenario: host Done → leave review cleanly');
    await flushHostBananaInteractions(page1);
    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);
    await clickDone(frame1);
    await Promise.all([
        waitMpResetAfterDone(frame1, 'review host after Done', RESET_WAIT_MS),
        waitMpResetAfterDone(frame2, 'review guest after Done', RESET_WAIT_MS)
    ]);

    log('Review scenario: after Done redeal, host SPLIT must sync guest');
    await assertHostSplitSyncsBothAfterPostGameReset(page1, page2, mpLib, {
        label: 'post-review Done host SPLIT'
    });

    log(`SUCCESS: Review scenario complete — ${rounds} solve-to-win round(s), Done reset, post-Done SPLIT`);
}

/** @deprecated alias — use runReviewScenarioAudit */
async function runLastBunchPeelSyncAudit(page1, page2, options = {}) {
    return runReviewScenarioAudit(page1, page2, options);
}

module.exports = {
    runReviewScenarioAudit,
    runLastBunchPeelSyncAudit,
    runSolveToWinReviewTests,
    assertBothPlayersReviewBoardsOnEveryClient
};
