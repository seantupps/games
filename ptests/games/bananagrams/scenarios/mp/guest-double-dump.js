/**
 * guest-double-dump — repro flaky LAN bug: one hold-dump sometimes fires twice.
 *
 * Matches real setup (same as dump-lan-visible LAN phone join):
 *   - PC host @ 127.0.0.1 (desktop viewport)
 *   - Phone guest @ LAN IP (mobile touch hold, 450ms — same as gameplay)
 *   - Each hold must advance dumpSeq by exactly 1 and hand by exactly +2
 *   - Fresh split when bunch pool can no longer supply 3 tiles for a dump
 *
 *   npm run mp:banana:guest-double-dump:mobile
 */
const { defineMpScenario } = require('./contract');
const { applySpeedProfile } = require('../../../../shared/infra/speed-profiles');
const lib = require('../../lib/mp-state');
const { buildMpCtx2p } = require('../../lib/mp-ctx');
const { bootMpPlaySessionThroughDeal, bootMpPlaySessionSplit } = require('../../lib/mp-session-boot');
const { deal } = require('../../assertions');
const { spawn } = require('../../assertions');
const { readBoardField } = require('../../assertions/core/capture');
const { assertExactlyOneGuestDump, readGuestBunchLen, MIN_DUMP_POOL } = spawn.dump;
const { joinBananaPartyLanPhoneGuest } = require('../../lib/mp-join-lan-phone');
const { holdDumpTouchPage } = require('../../adapters/mobile-touch');
const { resetMpForAiPlaythrough } = require('./ai-playthrough');

const ROUNDS = 30;

async function restartPlayingGame(ctx, page1, page2, log, gameNum) {
    const frame1 = await lib.getGameFrame(page1);
    const frame2 = await lib.getGameFrame(page2);
    log(`guest-double-dump: bunch depleted — fresh game #${gameNum}`);
    const reset = await resetMpForAiPlaythrough({
        ctx,
        pages: [page1, page2],
        frames: [frame1, frame2],
        mobile: false,
        instantBanners: true
    });
    return reset.frame2;
}

async function ensureGuestCanDump(frame2, ctx, page1, page2, log, gameNumRef) {
    let pool = await readGuestBunchLen(frame2);
    while (pool < MIN_DUMP_POOL) {
        gameNumRef.n += 1;
        frame2 = await restartPlayingGame(ctx, page1, page2, log, gameNumRef.n);
        pool = await readGuestBunchLen(frame2);
    }
    return frame2;
}

async function runGuestDoubleDumpScenario(scenarioCtx) {
    const {
        page1,
        page2,
        roomId,
        mobile = false,
        mp: mpIn = null
    } = scenarioCtx;
    const mp = mpIn || { page1, page2 };
    const {
        log,
        enableInstantBanners,
        getGameFrame,
        GUEST_UID
    } = lib;

    if (!mobile) {
        throw new Error('guest-double-dump is mobile-only');
    }

    applySpeedProfile('ci', { scenario: 'guest-double-dump' });

    await joinBananaPartyLanPhoneGuest(page1, page2, roomId, { log });
    await deal.assertHostDealPool(page1, lib.EXPECTED_MP_2P_POOL, 'guest-double-dump deal', mp);

    const ctx = buildMpCtx2p(page1, page2, { mobile: false });
    const { frames } = await bootMpPlaySessionThroughDeal(ctx, { mobile: false });
    await bootMpPlaySessionSplit(ctx, frames, { mobile: false });
    let frame2 = await getGameFrame(page2);
    await Promise.all([enableInstantBanners(frames[0]), enableInstantBanners(frame2)]);

    const gameNumRef = { n: 1 };
    log(`guest-double-dump: mobile guest hold-dump ×${ROUNDS} (exactly one dump each, game #${gameNumRef.n})`);

    for (let i = 1; i <= ROUNDS; i++) {
        frame2 = await ensureGuestCanDump(frame2, ctx, page1, page2, log, gameNumRef);

        const guestBefore = await frame2.evaluate(() => [...window.game.tiles.map((t) => t.id)]);
        const dumpSeqBefore = await readBoardField(page1, 'dumpSeq');

        const guestDump = await holdDumpTouchPage(page2, frame2, -1);
        if (!guestDump.ok || !guestDump.heldTileId) {
            throw new Error(`guest dump ${i}/${ROUNDS} gesture failed (${JSON.stringify(guestDump)})`);
        }

        const result = await assertExactlyOneGuestDump(
            page1,
            frame2,
            guestBefore,
            dumpSeqBefore,
            `guest single-dump r${i}/${ROUNDS}`,
            { guestUid: GUEST_UID, fast: true }
        );
        if (!result.ok) {
            throw new Error(
                `${result.label} failed (${result.reason}): ${JSON.stringify(result, null, 2)}`
            );
        }

        if (i % 10 === 0 || i === ROUNDS) {
            log(`SUCCESS: guest single-dump r${i}/${ROUNDS} — dumpSeq +1, hand +2 (game #${gameNumRef.n}).`);
        }
    }

    log(`SUCCESS: guest-double-dump passed (${ROUNDS} single dumps, ${gameNumRef.n} game(s), no doubles).`);
}

module.exports = defineMpScenario({
    id: 'guest-double-dump',
    kind: 'micro-fixture',
    description: 'LAN mobile guest hold-dump ×30 — exactly one dump per hold (no double-dump)',
    platforms: ['mobile'],
    playerCounts: [2],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['guest-double-dump', 'single-dump-authority']
}, runGuestDoubleDumpScenario);
