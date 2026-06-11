/**
 * Repro: after ` reset, guest dumps first — Dump! banner on guest but not host.
 *
 * Root cause hypothesis: mp-board onGameReset clears _lastPeelSeq but not _lastDumpSeq,
 * so host skips _applyMpActionBanners when dumpSeq returns to 1 after a prior-game dump.
 *
 *   node ptests/run.js mp --game=bananagrams --scenario=guest-dump-banner-repro
 *   node ptests/run.js mp --game=bananagrams --scenario=guest-dump-banner-repro --topology=mobile
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { buildMpCtx2p } = require('../../lib/mp-ctx');
const {
    bootMpPlaySessionFromPages,
    bootMpPlaySessionThroughDeal,
    bootMpPlaySessionSplit
} = require('../../lib/mp-session-boot');
const { seedBananaParty } = require('./seed-party');
const { resetAndSplitMp } = require('../sp/solve');
const { clearBanners } = require('../../../../shared/platform/mp-banners');
const { assertActionBannerOnBoth } = require('../../../../shared/assertions/mp-authority');
const { readBoardField } = require('../../assertions/core/capture');
const { joinBananaPartyLanPhoneGuest } = require('../../lib/mp-join-lan-phone');
const { holdDumpTouchPage } = require('../../adapters/mobile-touch');
const { deal } = require('../../assertions');

const {
    log,
    GUEST_UID,
    HOST_UID,
    WAIT_MS,
    dumpTile,
    flushHostBananaInteractions,
    waitForDiag,
    getGameFrame
} = lib;

const BANNER_TEXT = 'Dump!';

async function readBannerProbe(page, tag) {
    return page.evaluate(({ tag: lbl }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const g = win?.game;
        const el = doc?.getElementById('banana-banner');
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return {
            tag: lbl,
            bannerText: g?._bannerText || '',
            bannerActorUid: g?._bannerActorUid ?? null,
            domText: el?.textContent?.trim() || '',
            domVisible: el?.classList?.contains('is-visible') ?? false,
            lastDumpSeq: g?._lastDumpSeq ?? null,
            lastPeelSeq: g?._lastPeelSeq ?? null,
            boardDumpSeq: board?.dumpSeq ?? null,
            boardDumpActor: board?.dumpActorUid ?? null,
            resetCount: room?.global?.resetCount ?? null,
            isHost: !!g?.isHost?.()
        };
    }, { tag });
}

async function waitDumpSeq(page, label, { seq, uid }, mp) {
    await waitForDiag(page, label, ({ wantSeq, wantUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.dumpSeq || 0) > wantSeq && board?.dumpActorUid === wantUid;
    }, { wantSeq: seq, wantUid: uid }, WAIT_MS, mp);
}

async function runOneDump({ actor, frame1, frame2, page1, page2, mobile, mp, label }) {
    const guestTurn = actor === 'guest';
    const actorFrame = guestTurn ? frame2 : frame1;
    const actorUid = guestTurn ? GUEST_UID : HOST_UID;
    const dumpSeqBefore = await readBoardField(page1, 'dumpSeq');

    if (guestTurn) await flushHostBananaInteractions(page1);

    const dumpRes = mobile && guestTurn
        ? await holdDumpTouchPage(page2, actorFrame, -1)
        : await dumpTile(actorFrame, -1, { mobile: guestTurn && mobile, hostPage: page1 });

    if (!dumpRes?.ok) {
        throw new Error(`${label} dump failed: ${JSON.stringify(dumpRes)}`);
    }

    await waitDumpSeq(page1, `${label} dumpSeq`, { seq: dumpSeqBefore, uid: actorUid }, mp);
    await flushHostBananaInteractions(page1);
    return { dumpSeqBefore, actorUid };
}

async function runGuestDumpBannerRepro(scenarioCtx) {
    const {
        page1,
        page2,
        roomId,
        mobile = false,
        mp: mpIn = null,
        ctx: ctxIn = null
    } = scenarioCtx;
    const mp = mpIn || { page1, page2 };
    let frame1;
    let frame2;
    let ctx = ctxIn;

    if (mobile) {
        await joinBananaPartyLanPhoneGuest(page1, page2, roomId, { log });
        await deal.assertHostDealPool(page1, lib.EXPECTED_MP_2P_POOL, 'guest-dump-banner-repro deal', mp);
        ctx = buildMpCtx2p(page1, page2, { mobile: false });
        const boot = await bootMpPlaySessionThroughDeal(ctx, { mobile: false });
        await bootMpPlaySessionSplit(ctx, boot.frames, { mobile: false });
        frame1 = boot.frames[0];
        frame2 = await getGameFrame(page2);
    } else {
        ctx = ctx || buildMpCtx2p(page1, page2, { mobile: false });
        await seedBananaParty({ ...scenarioCtx, ctx }, { dealLabel: 'guest-dump-banner-repro deal' });
        ({ frame1, frame2 } = await bootMpPlaySessionFromPages(page1, page2, { mobile, roomId }));
    }

    log('guest-dump-banner-repro: pre-reset guest dump (bumps host _lastDumpSeq like a real game)...');
    await runOneDump({
        actor: 'guest',
        frame1,
        frame2,
        page1,
        page2,
        mobile,
        mp,
        label: 'pre-reset'
    });

    frame2 = await getGameFrame(page2);
    const hostBeforeReset = await readBannerProbe(page1, 'host-before-reset');
    log(`guest-dump-banner-repro: host before \` reset: ${JSON.stringify(hostBeforeReset)}`);

    log('guest-dump-banner-repro: host ` reset + SPLIT (same path as Done)...');
    await resetAndSplitMp(page1, page2);

    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);

    await Promise.all([clearBanners(frame1), clearBanners(frame2)]);
    await flushHostBananaInteractions(page1);

    const hostAfterReset = await readBannerProbe(page1, 'host-after-reset');
    const guestAfterReset = await readBannerProbe(page2, 'guest-after-reset');
    log(`guest-dump-banner-repro: after \` reset — host=${JSON.stringify(hostAfterReset)} guest=${JSON.stringify(guestAfterReset)}`);

    if ((hostAfterReset.lastDumpSeq || 0) > 0 && (hostAfterReset.boardDumpSeq || 0) === 0) {
        log('guest-dump-banner-repro: STALE host _lastDumpSeq after reset (repro precondition met).');
    }

    const dumpSeqBefore = await readBoardField(page1, 'dumpSeq');
    log(`guest-dump-banner-repro: post-reset guest dumps first (dumpSeq before=${dumpSeqBefore})...`);

    await runOneDump({
        actor: 'guest',
        frame1,
        frame2,
        page1,
        page2,
        mobile,
        mp,
        label: 'post-reset-first'
    });

    frame2 = await getGameFrame(page2);
    const guestImmediate = await frame2.evaluate(() => {
        const g = window.game;
        const el = document.getElementById('banana-banner');
        return {
            banner: g?._bannerText || '',
            domVisible: el?.classList?.contains('is-visible') ?? false,
            domText: el?.textContent?.trim() || ''
        };
    });
    log(`guest-dump-banner-repro: guest dump immediate: ${JSON.stringify(guestImmediate)}`);

    const [hostProbe, guestProbe] = await Promise.all([
        readBannerProbe(page1, 'host-after-post-reset-dump'),
        readBannerProbe(page2, 'guest-after-post-reset-dump')
    ]);
    log(`guest-dump-banner-repro: after dump — host=${JSON.stringify(hostProbe)} guest=${JSON.stringify(guestProbe)}`);

    const guestSees = guestProbe.domVisible && guestProbe.domText === BANNER_TEXT;
    const hostSees = hostProbe.domVisible && hostProbe.domText === BANNER_TEXT;

    if (guestSees && !hostSees) {
        throw new Error(
            'REPRO CONFIRMED: Dump! visible on guest but NOT on host after ` reset + guest-first dump\n'
            + JSON.stringify({
                hostBeforeReset,
                hostAfterReset,
                guestAfterReset,
                guestImmediate,
                hostProbe,
                guestProbe,
                mobile
            }, null, 2)
        );
    }

    if (!guestSees && !hostSees && (hostProbe.lastDumpSeq || 0) >= (hostProbe.boardDumpSeq || 0)) {
        throw new Error(
            'REPRO CONFIRMED (seq skip): host committed dumpSeq without showing banner '
            + `(lastDumpSeq=${hostProbe.lastDumpSeq}, boardDumpSeq=${hostProbe.boardDumpSeq})\n`
            + JSON.stringify({ hostBeforeReset, hostAfterReset, hostProbe, guestProbe, guestImmediate }, null, 2)
        );
    }

    await assertActionBannerOnBoth(
        page1,
        page2,
        BANNER_TEXT,
        GUEST_UID,
        'post-reset guest-first dump banner'
    );

    log('SUCCESS: post-reset guest-first dump banner visible on both clients.');
}

module.exports = defineMpScenario({
    id: 'guest-dump-banner-repro',
    kind: 'micro-fixture',
    description: 'Repro post-reset guest-first dump banner missing on host (` reset path)',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['dump-banner']
}, runGuestDumpBannerRepro);
