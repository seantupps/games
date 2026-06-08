/**
 * Last-bunch peel sync flow — host/guest peel drain + guest win review tests.
 */
const {
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    log,
    waitForDiag,
    flushHostBananaInteractions,
    readPoolSyncState,
    captureBothMpStates,
    mpVictoryWaitMs,
    mpReviewWaitMs
} = require('../../lib/mp-state');
const { core, sync, review } = require('../../assertions');
const { assertActionsReviewPersists,
    assertActionsWinBanner } = review;
const {
    LAST_BUNCH,
    setupLastBunchPeelReady,
    setupLastBunchWinReady,
    triggerPeel
} = require('../../fixtures/last-bunch-setup');

const { readBoardField } = core;

const LAST_BUNCH_TILES_PER_PLAYER = 4;

async function assertBothClientsEnterReviewImmediate(pages, frames, mp, label) {
    const reviewMs = Math.min(mpReviewWaitMs(), 2500);
    await review.waitMpClientsInReview(frames, `${label} in-review`, reviewMs, pages);
    await Promise.all(pages.map((p, i) =>
        review.assertGuestReviewVisibleWithoutInteraction(
            p, `${label} P${i + 1} immediate`, 2, LAST_BUNCH_TILES_PER_PLAYER
        )));
    log(`SUCCESS: ${label} — both clients in review immediately`);
}

async function runLastBunchGuestWinReviewTests(page1, page2, frame1, frame2, mp) {
    log('Last-bunch: guest win at pool=0 — hub banner + review must appear on both clients...');
    const winSetup = await setupLastBunchWinReady(frame1, page1, page2);
    frame2 = winSetup.frame2 || frame2;

    const winLabel = 'last-bunch guest win';
    await sync.assertHubWinBannerVisibleSameTime({
        page1,
        page2,
        label: `${winLabel} hub win banner`,
        maxSkewMs: 350,
        timeoutMs: Math.min(mpVictoryWaitMs(), 3500),
        assertLayout: false,
        triggerWin: async () => {
            const claimed = await frame2.evaluate(() => {
                window.game._bannerText = '';
                return window.game._checkPeel();
            });
            if (!claimed) {
                throw new Error(`${winLabel}: guest _checkPeel did not claim win at pool=0`);
            }
        }
    });

    await assertBothClientsEnterReviewImmediate([page1, page2], [frame1, frame2], mp, winLabel);
    await assertActionsWinBanner([page1, page2], `${winLabel} hub win banner persisted`);
    await assertActionsReviewPersists(
        [frame1, frame2], [page1, page2], mp, winLabel, { minTilesPerOwner: LAST_BUNCH_TILES_PER_PLAYER }
    );
    log('SUCCESS: last-bunch guest win — banner + review persisted on host and guest');
}

/**
 * @param {import('playwright').Page} page1 host
 * @param {import('playwright').Page} page2 guest
 * @param {import('playwright').Frame} frame1
 * @param {import('playwright').Frame} frame2
 * @param {{ page1: import('playwright').Page, page2: import('playwright').Page }} mp
 * @param {{ includeGuestWin?: boolean }} [options]
 */
async function runLastBunchPeelTests(page1, page2, frame1, frame2, mp, options = {}) {
    log('Last-bunch: host peel at bunch=2 must drain to 0 on both clients...');
    await setupLastBunchPeelReady(frame1, page1, page2, mp);

    const peelSeqBefore = await readBoardField(page1, 'peelSeq');
    const hostPeel = await triggerPeel(frame1, 'host last-bunch peel');
    if (!hostPeel.peeled) {
        throw new Error(`host last-bunch peel failed (${JSON.stringify(hostPeel)})`);
    }
    if (hostPeel.poolBefore !== LAST_BUNCH) {
        throw new Error(`host peel expected poolBefore=${LAST_BUNCH}, got ${hostPeel.poolBefore}`);
    }
    if (hostPeel.poolAfter !== 0) {
        throw new Error(`host peel did not drain local pool in-frame (${JSON.stringify(hostPeel)})`);
    }

    await waitForDiag(page2, 'host last-bunch peel seq on guest', ({ seq, uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
    }, { seq: peelSeqBefore, uid: HOST_UID }, WAIT_MS, mp);

    await sync.assertPeelDrainedStrict(page1, page2, 'host last-bunch peel');

    const postHostPeel = await captureBothMpStates(page1, page2, 'after host last-bunch peel');
    sync.assertLastBunchOwnedAfterHostPeel(
        postHostPeel.host.ownedLen ?? 0,
        postHostPeel.guest.ownedLen ?? 0,
        postHostPeel
    );

    log('Last-bunch: re-setup and guest peel at bunch=2...');
    await setupLastBunchPeelReady(frame1, page1, page2, mp);
    await flushHostBananaInteractions(page1);

    const guestPeelSeqBefore = await readBoardField(page1, 'peelSeq');
    const guestPeel = await triggerPeel(frame2, 'guest last-bunch peel');
    if (!guestPeel.peeled) {
        const guestDiag = await page2.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const grid = document.getElementById('game-frame')?.contentWindow?.BananaGrid;
            const hand = typeof g?._snapHandForValidation === 'function'
                ? g._snapHandForValidation(g.tiles)
                : g?.tiles;
            const result = grid?.validateGrid(hand, g?._checker);
            return {
                tiles: g?.tiles?.length ?? 0,
                pool: g?._tilePool?.length ?? -1,
                auth: typeof g?._mpAuthoritativeBunchLen === 'function'
                    ? g._mpAuthoritativeBunchLen() : null,
                allPlaced: typeof g?._allTilesPlacedOn === 'function'
                    ? g._allTilesPlacedOn(hand) : null,
                gridOk: !!result?.ok
            };
        });
        throw new Error(`guest last-bunch peel failed (${JSON.stringify({ guestPeel, guestDiag })})`);
    }

    await flushHostBananaInteractions(page1);
    await waitForDiag(page1, 'guest last-bunch peel on host', ({ seq, uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
    }, { seq: guestPeelSeqBefore, uid: GUEST_UID }, WAIT_MS, mp);

    await sync.assertPeelDrainedStrict(page1, page2, 'guest last-bunch peel');

    log('Last-bunch: verify guest cannot win while perceiving stale bunch...');
    const guestSnap = await readPoolSyncState(page2);
    if (guestSnap.authBunch > 0) {
        await sync.assertWinBlockedOnGuestWhenDesynced(page2, frame2, 'last-bunch guest win guard');
    }

    log('SUCCESS: last-bunch peel sync audit — host + guest peels drain bunch=2→0 on both clients');

    if (options.includeGuestWin !== false) {
        await runLastBunchGuestWinReviewTests(page1, page2, frame1, frame2, mp);
    }
}

module.exports = {
    runLastBunchPeelTests,
    runLastBunchGuestWinReviewTests,
    assertBothClientsEnterReviewImmediate
};
