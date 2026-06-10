/**
 * dump-spawn — post-win guest dump spawn visibility (real hold-dump on game 2).
 *
 * Flow:
 *   invite 2p → deal → SPLIT → quick game-1 dumps → /win → Done → SPLIT
 *   → N× guest hold-dump (spawn must be DOM-visible) → host dump
 *   → optional: sequential trade-stress dumps (default 40, alternating guest/host)
 *
 * Game 2 guest dumps use real banner timing + hold gesture + strict spawn assert.
 * Setup (game 1, win, review, Done) uses fast/instant banners to keep runtime down.
 * Trade-stress phase runs after game 2 with fast banners — sequential 1-for-3 audits.
 *
 *   node ptests/run.js mp --game=bananagrams --scenario=dump-spawn --topology=mobile
 *   FIVE_MP_DUMP_TRADE_SEQ=0 node ptests/run.js mp ...            # skip trade-stress phase
 *   FIVE_MP_DUMP_SPAWN_GUEST_DUMPS=5 node ptests/run.js mp ...   # more game-2 guest dumps only
 *   FIVE_MP_SPAWN_DEBUG=1 node ptests/run.js mp ...
 */
const { defineMpScenario } = require('./contract');
const { applySpeedProfile } = require('../../../../shared/infra/speed-profiles');
const lib = require('../../lib/mp-state');
const { buildMpCtx2p } = require('../../lib/mp-ctx');
const { bootMpPlaySessionThroughDeal, bootMpPlaySessionSplit } = require('../../lib/mp-session-boot');
const { seedBananaParty } = require('./seed-party');
const { sync } = require('../../assertions');
const { readBoardField } = require('../../assertions/core/capture');
const { assertDumpSpawnQuick, assertDumpTradeIntegrity } = require('../../assertions/spawn/dump');
const { assertGuestDumpSpawnActionable } = sync;
const { waitMpClientsInReview } = require('../../assertions/mp/review-sync');
const { waitMpResetAfterDone } = require('../../assertions/mp/review-reset');
const { assertHostSplitSyncsBothAfterPostGameReset } = require('../../assertions/mp/review-done-split');
const { clickDone } = require('../../assertions/sp/review');

const GAME2_GUEST_DUMPS = Math.max(1, Number(process.env.FIVE_MP_DUMP_SPAWN_GUEST_DUMPS || 3));
/** Sequential trade-stress dumps after game 2 (alternating guest/host). 0 = skip. */
const TRADE_SEQ_DUMPS = Math.max(0, Number(process.env.FIVE_MP_DUMP_TRADE_SEQ ?? 40));
const SPAWN_AUTHORITY_MS = Number(process.env.FIVE_MP_DUMP_AUTHORITY_MS || 6000);
const SPAWN_PAINT_MS = Number(process.env.FIVE_MP_DUMP_PAINT_MS || 4500);

/** After spawn visibility: strict 1-for-3 trade (dumped removed, 3 draws visible). */
async function assertDumpTradeAfterSpawn(frame, beforeIds, dumpRes, label, opts = {}) {
    await assertDumpTradeIntegrity(frame, beforeIds, dumpRes.dumpedTileId, label, {
        timeoutMs: opts.timeoutMs ?? SPAWN_AUTHORITY_MS,
        dumpSeqBefore: opts.dumpSeqBefore ?? null,
        hostPage: opts.hostPage ?? null,
        mobile: !!opts.mobile
    });
}

/** Game 1 setup dump — real hold/right-click, no spawn audit (not the repro surface). */
async function quickSetupDump(frame, mobile, label) {
    const { dumpTile } = lib;
    const res = await dumpTile(frame, -1, { mobile, syncAuthority: false });
    if (!res.ok) {
        throw new Error(`${label}: dump trigger failed (${JSON.stringify(res)})`);
    }
}

/**
 * Sequential trade-stress: alternating guest/host dumps with 1-for-3 integrity checks.
 * Runs after game-2 repro; uses fast banners (not the spawn-visibility repro surface).
 */
async function runSequentialTradeStress(ctx) {
    const {
        page1,
        page2,
        frame1,
        frame2,
        mobile,
        dumpTile,
        log,
        enableFastBanners
    } = ctx;
    if (!TRADE_SEQ_DUMPS) return;

    log(`MP dump-spawn: trade-stress — ${TRADE_SEQ_DUMPS} sequential dumps (guest/host alternating)...`);
    await Promise.all([enableFastBanners(frame1), enableFastBanners(frame2)]);

    for (let n = 1; n <= TRADE_SEQ_DUMPS; n++) {
        const isGuestTurn = n % 2 === 1;
        const role = isGuestTurn ? 'guest' : 'host';
        const frame = isGuestTurn ? frame2 : frame1;
        const dumpMobile = isGuestTurn ? mobile : false;

        if (!isGuestTurn) {
            await frame.waitForFunction(() => {
                const g = window.game;
                return g?.gameStarted && g?.canMutatePlayingBoard?.();
            }, {}, { timeout: 5000 });
        }

        const beforeIds = await frame.evaluate(() => [...new Set(window.game.tiles.map((t) => t.id))]);
        const dumpSeqBefore = await readBoardField(page1, 'dumpSeq');
        const dumpRes = await dumpTile(frame, -1, {
            mobile: dumpMobile,
            syncAuthority: false
        });
        if (!dumpRes.ok) {
            throw new Error(`trade-stress dump ${n}/${TRADE_SEQ_DUMPS} (${role}) failed (${JSON.stringify(dumpRes)})`);
        }

        const labelBase = `trade-stress ${n}/${TRADE_SEQ_DUMPS} ${role}`;
        if (isGuestTurn) {
            await assertGuestDumpSpawnActionable({
                guestFrame: frame2,
                beforeIds,
                dumpSeqBefore,
                label: `${labelBase} spawn`,
                mobile,
                phase: `sequential trade-stress dump ${n}`,
                authorityWaitMs: SPAWN_AUTHORITY_MS,
                paintWaitMs: SPAWN_PAINT_MS
            });
        } else {
            const spawn = await assertDumpSpawnQuick(frame1, beforeIds, `${labelBase} spawn`, {
                mobile,
                dumpSeqBefore,
                stableMs: 0,
                timeoutMs: SPAWN_AUTHORITY_MS,
                noRenderNudge: true
            });
            if (!spawn.ok) {
                throw new Error(`${labelBase} spawn failed (${JSON.stringify(spawn)})`);
            }
        }

        await assertDumpTradeAfterSpawn(frame, beforeIds, dumpRes, `${labelBase} trade`, {
            dumpSeqBefore,
            hostPage: page1,
            mobile: dumpMobile
        });
        log(`SUCCESS: trade-stress dump ${n}/${TRADE_SEQ_DUMPS} (${role}) spawn + trade ok.`);
    }

    log(`SUCCESS: trade-stress — ${TRADE_SEQ_DUMPS} sequential dumps passed.`);
}

async function runWinAndDone(page1, page2, frame1, frame2, log) {
    const {
        dismissBanners,
        enableInstantBanners,
        WAIT_MS,
        RESET_WAIT_MS
    } = lib;

    await Promise.all([enableInstantBanners(frame1), enableInstantBanners(frame2)]);

    log('MP dump-spawn: host dev /win...');
    const won = await frame1.evaluate(() => window.game._hostDevWinForPlayer(window.game._myUid()));
    if (!won) {
        throw new Error('dump-spawn: host dev /win failed');
    }
    await dismissBanners(page1, page2);
    await waitMpClientsInReview(
        [frame1, frame2],
        'dump-spawn post-win review',
        WAIT_MS,
        [page1, page2],
        frame1
    );

    log('MP dump-spawn: host Done...');
    await clickDone(frame1);
    const resetMs = Math.min(WAIT_MS, RESET_WAIT_MS);
    await Promise.all([
        waitMpResetAfterDone(frame1, 'dump-spawn post-win host', resetMs),
        waitMpResetAfterDone(frame2, 'dump-spawn post-win guest', resetMs)
    ]);
}

async function runDumpSpawnScenario(scenarioCtx) {
    applySpeedProfile('dump-spawn', { scenario: 'dump-spawn' });

    const {
        page1,
        page2,
        mobile = false,
        mp: mpIn = null
    } = scenarioCtx;
    const mp = mpIn || { page1, page2 };
    const {
        log,
        dumpTile,
        getGameFrame,
        enableFastBanners,
        setBannerDurationCap
    } = lib;

    if (!scenarioCtx.skipSeed) {
        await seedBananaParty(scenarioCtx, { dealLabel: 'dump-spawn invite + deal' });
    }

    const ctx = buildMpCtx2p(page1, page2, { mobile });
    log('MP dump-spawn: invite → deal → SPLIT (fast banners for setup)...');
    const { frames } = await bootMpPlaySessionThroughDeal(ctx, { mobile });
    await bootMpPlaySessionSplit(ctx, frames, { mobile });
    let frame1 = frames[0];
    let frame2 = frames[1];

    log('MP dump-spawn: game-1 quick dumps (setup only)...');
    await quickSetupDump(frame1, mobile, 'game-1 host dump');
    await quickSetupDump(frame2, mobile, 'game-1 guest dump');

    await runWinAndDone(page1, page2, frame1, frame2, log);

    log('MP dump-spawn: second game — host SPLIT after Done...');
    await assertHostSplitSyncsBothAfterPostGameReset(page1, page2, lib, {
        mobile,
        label: 'post-win Done'
    });
    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);
    await Promise.all([
        enableFastBanners(frame1),
        setBannerDurationCap(frame2, null)
    ]);

    log(`MP dump-spawn: game-2 guest dumps (${GAME2_GUEST_DUMPS}× real hold-dump → spawn visible)...`);
    for (let i = 1; i <= GAME2_GUEST_DUMPS; i++) {
        const guestBefore = await frame2.evaluate(() => [...new Set(window.game.tiles.map((t) => t.id))]);
        const guestDumpSeqBefore = await readBoardField(page1, 'dumpSeq');
        const guestDump = await dumpTile(frame2, -1, { mobile, syncAuthority: false });
        if (!guestDump.ok) {
            throw new Error(`game-2 guest dump ${i}/${GAME2_GUEST_DUMPS} trigger failed (${JSON.stringify(guestDump)})`);
        }

        await assertGuestDumpSpawnActionable({
            guestFrame: frame2,
            beforeIds: guestBefore,
            dumpSeqBefore: guestDumpSeqBefore,
            label: `game-2 guest dump spawn ${i}/${GAME2_GUEST_DUMPS}`,
            mobile,
            phase: `second game after win→Done, guest dump ${i}/${GAME2_GUEST_DUMPS}`,
            authorityWaitMs: SPAWN_AUTHORITY_MS,
            paintWaitMs: SPAWN_PAINT_MS
        });
        log(`SUCCESS: game-2 guest dump ${i}/${GAME2_GUEST_DUMPS} spawn visible.`);
    }

    log('MP dump-spawn: game-2 host dump...');
    await enableFastBanners(frame2);
    await frame1.waitForFunction(() => {
        const g = window.game;
        return g?.gameStarted && g?.canMutatePlayingBoard?.();
    }, {}, { timeout: 5000 });
    const hostBefore = await frame1.evaluate(() => [...new Set(window.game.tiles.map((t) => t.id))]);
    const hostDumpSeqBefore = await readBoardField(page1, 'dumpSeq');
    const hostDump = await dumpTile(frame1, -1, { mobile: false, syncAuthority: false });
    if (!hostDump.ok) {
        throw new Error(`game-2 host dump trigger failed (${JSON.stringify(hostDump)})`);
    }
    const hostSpawn = await assertDumpSpawnQuick(frame1, hostBefore, 'game-2 host dump spawn', {
        mobile,
        dumpSeqBefore: hostDumpSeqBefore,
        stableMs: 0,
        timeoutMs: SPAWN_AUTHORITY_MS,
        noRenderNudge: true
    });
    if (!hostSpawn.ok) {
        throw new Error(`game-2 host dump spawn failed (${JSON.stringify(hostSpawn)})`);
    }
    log('SUCCESS: game-2 host dump spawn visible.');
    log('SUCCESS: dump-spawn post-win second-game dump repro passed.');

    await runSequentialTradeStress({
        page1,
        page2,
        frame1,
        frame2,
        mobile,
        dumpTile,
        log,
        enableFastBanners
    });
}

module.exports = defineMpScenario({
    id: 'dump-spawn',
    kind: 'micro-fixture',
    description: `Invite 2p → win → Done → SPLIT → game-2 spawn repro`
        + (TRADE_SEQ_DUMPS ? ` → ${TRADE_SEQ_DUMPS} sequential trade-stress dumps` : ''),
    platforms: ['desktop', 'mobile'],
    playerCounts: [2],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['dump-spawn', 'guest-dump-visible', 'dump-trade-integrity', 'post-win-dump-repro']
}, runDumpSpawnScenario);
