/**
 * MP peel scenario — spawn sync timing (host + guest peel) on both platforms.
 */
const { getGameFrame } = require('../../../../shared/platform/mp-waits');
const {
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    waitForDiag,
    flushHostBananaInteractions,
    dismissBanners
} = require('../../lib/mp-state');
const { peelGridInFrame } = require('../../fixtures/review-state');
const { sync, authority } = require('../../assertions');
const { readBoardField } = require('../../assertions/core/capture');
const { assertActionBannerOnBoth } = authority;

async function settleMpRender(page1, page2) {
    await Promise.all([page1, page2].map((page) => page.evaluate(async () => {
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        await nextFrame();
        await nextFrame();
    })));
}

async function collectTileIdsBeforePeel(frame1, page2) {
    return Promise.all([
        frame1.evaluate(() => [...window.game.tiles.map((t) => t.id)]),
        page2.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return [...(g?.tiles || []).map((t) => t.id)];
        })
    ]);
}

async function waitPeelSeq(page, label, { seq, actorUid }, mp) {
    await waitForDiag(page, label, ({ seq: before, uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > before && board?.peelActorUid === uid;
    }, { seq, uid: actorUid }, WAIT_MS, mp);
}

async function runHostPeelSpawnSync(opts) {
    const {
        page1,
        page2,
        frame1,
        mp,
        labelPrefix = 'MP host peel spawn sync',
        skipGridSetup = false,
        log = () => {}
    } = opts;

    const { setupHostPeelGrid } = require('../../fixtures/peel-grid');

    await flushHostBananaInteractions(page1);
    if (!skipGridSetup) {
        await setupHostPeelGrid(frame1);
    }

    const [hostBeforeIds, guestBeforeIds] = await collectTileIdsBeforePeel(frame1, page2);
    const peelSeqBefore = await readBoardField(page1, 'peelSeq');

    const timing = await sync.assertPeelSpawnVisibleSameTime({
        page1,
        page2,
        frame1,
        hostBeforeIds,
        guestBeforeIds,
        label: labelPrefix
    });

    await waitPeelSeq(page1, `${labelPrefix} seq`, { seq: peelSeqBefore, actorUid: HOST_UID }, mp);
    await assertActionBannerOnBoth(page1, page2, 'Peel!', HOST_UID, labelPrefix);
    await dismissBanners(page1, page2);

    log(`SUCCESS: Host peel spawn synced (host=${timing.hostMs}ms, guest=${timing.guestMs}ms, `
        + `skew=${timing.skew}ms, max=${timing.maxSkewMs}ms).`);
    return timing;
}

async function runGuestPeelSpawnSync(opts) {
    const {
        page1,
        page2,
        frame1,
        frame2,
        mp,
        fixtureSuffix = 'spawn',
        labelPrefix = 'MP guest peel spawn sync',
        skipGuestGridPrep = false,
        microFixture = false,
        log = () => {}
    } = opts;

    const {
        setGuestPeelFixtureOnHost,
        prepareGuestPeelGridOnClient
    } = require('../../fixtures/peel-grid');

    await flushHostBananaInteractions(page1);
    if (microFixture) {
        const { installSymmetricFourTileFixture } = require('../../fixtures/mp-four-tile');
        await installSymmetricFourTileFixture(frame1, page2, mp, {
            guestLayout: 'peel',
            source: 'mp-peel-spawn-guest-fixture'
        });
        await prepareGuestPeelGridOnClient(frame2);
    } else {
        await setGuestPeelFixtureOnHost({
            frame1,
            page2,
            mp,
            suffix: fixtureSuffix,
            source: 'mp-guest-peel-spawn'
        });
        if (!skipGuestGridPrep) {
            await prepareGuestPeelGridOnClient(frame2);
        }
    }
    await flushHostBananaInteractions(page1);
    await settleMpRender(page1, page2);

    const [hostBeforeIds, guestBeforeIds] = await Promise.all([
        frame1.evaluate(() => [...window.game.tiles.map((t) => t.id)]),
        frame2.evaluate(() => [...window.game.tiles.map((t) => t.id)])
    ]);
    const peelSeqBefore = await readBoardField(page1, 'peelSeq');

    const timing = await sync.assertPeelSpawnVisibleSameTime({
        page1,
        page2,
        frame1,
        peelFrame: frame2,
        hostBeforeIds,
        guestBeforeIds,
        label: labelPrefix,
        flushHost: () => flushHostBananaInteractions(page1),
        peelEvaluate: () => frame2.evaluate(() => {
            const g = window.game;
            g._bannerText = '';
            const peeled = g._checkPeel();
            return { banner: g._bannerText, count: g.tiles.length, peeled };
        })
    });

    await waitPeelSeq(page1, `${labelPrefix} seq`, { seq: peelSeqBefore, actorUid: GUEST_UID }, mp);
    await assertActionBannerOnBoth(page1, page2, 'Peel!', GUEST_UID, labelPrefix);
    await dismissBanners(page1, page2);

    log(`SUCCESS: Guest peel spawn synced (host=${timing.hostMs}ms, guest=${timing.guestMs}ms, `
        + `skew=${timing.skew}ms, max=${timing.maxSkewMs}ms).`);
    return timing;
}

async function runMpPeelSpawnSyncAudit(opts) {
    const {
        page1,
        page2,
        frame1,
        frame2,
        mp,
        microFixture = false,
        log = (msg) => console.log(`[TEST] ${msg}`)
    } = opts;

    if (microFixture) {
        const { installSymmetricFourTileFixture } = require('../../fixtures/mp-four-tile');
        await installSymmetricFourTileFixture(frame1, page2, mp, {
            guestLayout: 'peel',
            source: 'mp-peel-spawn-host-fixture'
        });
    }

    log('MP peel spawn visible at same time on host + guest (host peel)...');
    await runHostPeelSpawnSync({
        page1,
        page2,
        frame1,
        mp,
        labelPrefix: 'MP host peel spawn sync',
        skipGridSetup: microFixture,
        log
    });

    log('MP peel spawn visible at same time on host + guest (guest peel)...');
    await runGuestPeelSpawnSync({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        fixtureSuffix: 'mobile-spawn',
        labelPrefix: 'MP guest peel spawn sync',
        skipGuestGridPrep: microFixture,
        microFixture,
        log
    });
}

/**
 * @param {object} opts
 * @param {import('playwright').Page} opts.page1
 * @param {import('playwright').Page} opts.page2
 * @param {import('playwright').Frame} [opts.frame1]
 * @param {import('playwright').Frame} [opts.frame2]
 * @param {object} opts.mp
 * @param {boolean} [opts.mobile]
 * @param {Function} [opts.log]
 */
async function runMpPeelSpawnScenario(opts) {
    const {
        page1,
        page2,
        frame1: frame1In,
        frame2: frame2In,
        mp,
        mobile = false,
        microFixture = false,
        log = (msg) => console.log(`[TEST] ${msg}`)
    } = opts;

    const frame1 = frame1In || await getGameFrame(page1);
    const frame2 = frame2In || await getGameFrame(page2);

    log('MP peel spawn visible at same time on host + guest...');
    await runMpPeelSpawnSyncAudit({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        microFixture,
        log
    });

    if (mobile && process.env.FIVE_MP_MOBILE_TILE_STABILITY === '1') {
        const { runBananagramsMpMobilePeelDumpTileStability } = require('./layout-stability-mobile');
        await runBananagramsMpMobilePeelDumpTileStability({
            page1,
            page2,
            frame1,
            frame2,
            mp,
            log
        });
    } else if (mobile) {
        log('MP mobile: skip peel/dump tile stability (set FIVE_MP_MOBILE_TILE_STABILITY=1 to enable).');
    }

    return { frame1, frame2 };
}

module.exports = {
    runMpPeelSpawnScenario,
    runMpPeelSpawnSyncAudit,
    runHostPeelSpawnSync,
    runGuestPeelSpawnSync
};
