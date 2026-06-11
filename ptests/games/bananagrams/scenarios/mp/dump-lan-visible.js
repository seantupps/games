/**
 * dump-lan-visible — guest dump spawns paint then must survive stale RTDB inventory echo.
 *
 * Mobile: PC host @ 127.0.0.1, guest @ LAN IP (phone repro path).
 * Desktop: localhost invite join, mouse dump — same stale onNetworkUpdate repro.
 *
 *   npm run mp:banana:dump-lan-visible
 *   npm run mp:banana:dump-lan-visible:mobile
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { buildMpCtx2p } = require('../../lib/mp-ctx');
const { bootMpPlaySessionThroughDeal, bootMpPlaySessionSplit, bootMpPlaySessionN } = require('../../lib/mp-session-boot');
const { seedBananaParty } = require('./seed-party');
const { deal } = require('../../assertions');
const { readBoardField } = require('../../assertions/core/capture');
const { joinBananaPartyLanPhoneGuest } = require('../../lib/mp-join-lan-phone');
const { holdDumpTouchPage } = require('../../adapters/mobile-touch');
const { waitForDiag, flushHostBananaInteractions } = require('../../lib/mp-state');
const {
    deliverStaleDumpEchoViaNetworkUpdate,
    waitForDumpSpawnsPainted,
    assertDumpSpawnsStayVisibleAfterStaleEcho
} = require('../../lib/dump-lan-repro');

const ROUNDS = 10;

async function assertLanDumpSpawnsVisible({ frame, beforeIds, label, log }) {
    const result = await assertDumpSpawnsStayVisibleAfterStaleEcho(frame, beforeIds, label);
    if (!result.ok) {
        throw new Error(
            `${label} — spawn tiles vanished/jitter after stale RTDB echo: `
            + `${JSON.stringify(result, null, 2)}`
        );
    }
    log(`SUCCESS: ${label} — 3 spawns still visible after stale echo.`);
}

async function runOneDumpLanVisibleRound({
    i,
    frame2,
    page1,
    mp,
    log,
    mobile,
    dumpGuest
}) {
    const guestBefore = await frame2.evaluate(() => [...window.game.tiles.map((t) => t.id)]);
    const dumpSeqBefore = await readBoardField(page1, 'dumpSeq');

    const guestDump = await dumpGuest();
    if (!guestDump.ok) {
        throw new Error(`dump-lan-visible guest dump ${i}/${ROUNDS} gesture failed (${JSON.stringify(guestDump)})`);
    }

    const early = await deliverStaleDumpEchoViaNetworkUpdate(frame2, guestBefore, {
        bypassStaleGuard: false
    });
    log(`dump-lan-visible r${i}/${ROUNDS}: early stale echo via onNetworkUpdate (local=${early?.localCount})`);

    await waitForDiag(page1, `dump-lan-visible r${i}/${ROUNDS} host dumpSeq`, ({ seq, uid }) => {
        const board = document.getElementById('game-frame')?.contentWindow?.game?.roomData?.global?.board;
        return (board?.dumpSeq || 0) > seq && board?.dumpActorUid === uid;
    }, { seq: dumpSeqBefore, uid: lib.GUEST_UID }, lib.WAIT_MS, mp);

    await flushHostBananaInteractions(page1);

    await waitForDumpSpawnsPainted(frame2, guestBefore, lib.WAIT_MS);
    log(`dump-lan-visible r${i}/${ROUNDS}: spawns painted in DOM`);

    const late = await deliverStaleDumpEchoViaNetworkUpdate(frame2, guestBefore, {
        bypassStaleGuard: true,
        lowerInventorySeq: true
    });
    log(`dump-lan-visible r${i}/${ROUNDS}: late stale echo (stale=${late?.staleOwned}, local=${late?.localCount})`);

    await frame2.waitForTimeout(16);

    await assertLanDumpSpawnsVisible({
        frame: frame2,
        beforeIds: guestBefore,
        label: `dump-lan-visible guest r${i}/${ROUNDS}`,
        log
    });
}

async function runDumpLanVisibleScenario(scenarioCtx) {
    const {
        page1,
        page2,
        roomId,
        mobile = false,
        mp: mpIn = null,
        ctx: ctxIn = null
    } = scenarioCtx;
    const mp = mpIn || { page1, page2 };
    const {
        log,
        enableFastBanners,
        getGameFrame,
        dumpTile
    } = lib;

    let frame2;

    if (mobile) {
        await joinBananaPartyLanPhoneGuest(page1, page2, roomId, { log });
        await deal.assertHostDealPool(page1, lib.EXPECTED_MP_2P_POOL, 'dump-lan-visible deal', mp);

        const ctx = buildMpCtx2p(page1, page2, { mobile: false });
        const { frames } = await bootMpPlaySessionThroughDeal(ctx, { mobile: false });
        await bootMpPlaySessionSplit(ctx, frames, { mobile: false });
        frame2 = await getGameFrame(page2);
    } else {
        const ctx = ctxIn || buildMpCtx2p(page1, page2, { mobile: false });
        await seedBananaParty({ ...scenarioCtx, ctx }, { dealLabel: 'dump-lan-visible host deal' });
        const { frames } = await bootMpPlaySessionN(ctx, { mobile: false });
        frame2 = frames[1];
    }

    await enableFastBanners(frame2);

    const dumpGuest = () => {
        if (mobile) {
            return holdDumpTouchPage(page2, frame2, -1);
        }
        return dumpTile(frame2, -1, { mobile: false, hostPage: page1 });
    };

    log(`dump-lan-visible: ${ROUNDS}× guest dump — stale onNetworkUpdate after spawns paint (${mobile ? 'LAN mobile' : 'desktop'})`);

    for (let i = 1; i <= ROUNDS; i++) {
        await runOneDumpLanVisibleRound({
            i,
            frame2,
            page1,
            mp,
            log,
            mobile,
            dumpGuest
        });
        if (mobile) {
            frame2 = await getGameFrame(page2);
        }
    }

    log(`SUCCESS: dump-lan-visible passed (${ROUNDS} dumps — spawns survived stale echo).`);
}

module.exports = defineMpScenario({
    id: 'dump-lan-visible',
    kind: 'micro-fixture',
    description: 'Guest hold-dump — 3 spawns visible after stale RTDB inventory echo',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['dump-lan-visible', 'dump-spawn-repro']
}, runDumpLanVisibleScenario);
