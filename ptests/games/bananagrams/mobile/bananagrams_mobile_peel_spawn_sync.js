/**
 * Mobile MP audit — peel tiles must appear on screen at the same time for host + guest.
 */
const {
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    waitForDiag,
    flushHostBananaInteractions,
    dismissBanners,
    assertActionBannerOnBoth
} = require('../lib/mp-lib');
const { peelGridInFrame } = require('../assertions/bananagrams_peel_fixture');
const { assertPeelSpawnVisibleSameTime } = require('../assertions/bananagrams_mp_peel_spawn_sync_assertions');

/** Run peel-grid setup + _checkPeel atomically (avoids board sync overwriting setup). */
async function guestPeelGridAndCheck(frame) {
    return frame.evaluate((fnStr) => {
        const peelGridInFrame = new Function(`return (${fnStr})`)();
        const setup = peelGridInFrame();
        const g = window.game;
        g._markLocalDrag?.();
        g._bannerText = '';
        g._checkPeel();
        return {
            banner: g._bannerText,
            count: g.tiles.length,
            setup
        };
    }, peelGridInFrame.toString());
}

async function readPeelSeq(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return board?.peelSeq || 0;
    });
}

/**
 * @param {object} opts
 * @param {import('playwright').Page} opts.page1
 * @param {import('playwright').Page} opts.page2
 * @param {import('playwright').Frame} opts.frame1
 * @param {import('playwright').Frame} opts.frame2
 * @param {object} opts.mp
 * @param {Function} [opts.log]
 */
async function runBananagramsMpMobilePeelSpawnSync(opts) {
    const {
        page1,
        page2,
        frame1,
        frame2,
        mp,
        log = (msg) => console.log(`[TEST] ${msg}`)
    } = opts;

    log('MP mobile: peel spawn visible at same time on host + guest...');
    await flushHostBananaInteractions(page1);

    const peelSetup = await frame1.evaluate(peelGridInFrame);
    if (!peelSetup.placed || !peelSetup.valid) {
        throw new Error(`Mobile peel spawn sync fixture invalid (${JSON.stringify(peelSetup)})`);
    }

    const [hostBeforeIds, guestBeforeIds] = await Promise.all([
        frame1.evaluate(() => [...window.game.tiles.map((t) => t.id)]),
        page2.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return [...(g?.tiles || []).map((t) => t.id)];
        })
    ]);
    const peelSeqBefore = await readPeelSeq(page1);

    const timing = await assertPeelSpawnVisibleSameTime({
        page1,
        page2,
        frame1,
        hostBeforeIds,
        guestBeforeIds,
        label: 'MP mobile host peel spawn sync'
    });

    await waitForDiag(page1, 'mobile peel spawn sync seq', ({ seq, hostUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === hostUid;
    }, { seq: peelSeqBefore, hostUid: HOST_UID }, WAIT_MS, mp);
    await assertActionBannerOnBoth(page1, page2, 'Peel!', HOST_UID, 'mobile peel spawn sync');
    await dismissBanners(page1, page2);

    log(`SUCCESS: Host peel spawn synced (host=${timing.hostMs}ms, guest=${timing.guestMs}ms, `
        + `skew=${timing.skew}ms, max=${timing.maxSkewMs}ms).`);

    log('MP mobile: guest peel spawn visible at same time on host + guest...');
    await flushHostBananaInteractions(page1);

    const [hostBeforeGuestPeel, guestBeforeGuestPeel] = await Promise.all([
        frame1.evaluate(() => [...window.game.tiles.map((t) => t.id)]),
        frame2.evaluate(() => [...window.game.tiles.map((t) => t.id)])
    ]);
    const guestPeelSeqBefore = await readPeelSeq(page1);

    const guestTiming = await assertPeelSpawnVisibleSameTime({
        page1,
        page2,
        frame1,
        peelFrame: frame2,
        hostBeforeIds: hostBeforeGuestPeel,
        guestBeforeIds: guestBeforeGuestPeel,
        label: 'MP mobile guest peel spawn sync',
        peelEvaluate: () => guestPeelGridAndCheck(frame2)
    });

    await waitForDiag(page1, 'mobile guest peel spawn sync seq', ({ seq, guestUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === guestUid;
    }, { seq: guestPeelSeqBefore, guestUid: GUEST_UID }, WAIT_MS, mp);
    await assertActionBannerOnBoth(page1, page2, 'Peel!', GUEST_UID, 'mobile guest peel spawn sync');
    await dismissBanners(page1, page2);

    log(`SUCCESS: Guest peel spawn synced (host=${guestTiming.hostMs}ms, guest=${guestTiming.guestMs}ms, `
        + `skew=${guestTiming.skew}ms, max=${guestTiming.maxSkewMs}ms).`);
}

module.exports = {
    runBananagramsMpMobilePeelSpawnSync
};
