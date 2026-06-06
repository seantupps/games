/**
 * MP sync invariant — when the host peels, guest disconnected board tiles must not move.
 * Host-authoritative 4-tile symmetric fixture (no guest teleport / no asymmetric owned).
 */
const {
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    waitForDiag,
    flushHostBananaInteractions,
    dismissBanners
} = require('../lib/mp-state');
const { assertActionBannerAllPlayers } = require('../../../shared/assertions/mp-authority');
const { buildMpCtx2p } = require('../lib/mp-ctx');
const { installSymmetricFourTileFixture } = require('../fixtures/mp-four-tile');
const {
    captureTileStabilitySnapshot,
    assertExistingTilesStableAfterAction,
    waitMobilePeelDumpSettle
} = require('./layout-tile-stability');
const { peelStabilitySettleMs } = require('../../../shared/infra/speed-profiles');

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
 * @param {boolean} [opts.mobile]
 * @param {string} [opts.hostUid]
 * @param {number} [opts.settleMs]
 * @param {import('playwright').Page[]} [opts.extraPages] — other clients to await peel sync (3p P3)
 * @param {Function} [opts.log]
 */
async function assertHostPeelGuestDisconnectedTilesStable(opts) {
    const {
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile = false,
        hostUid = HOST_UID,
        guestUid = GUEST_UID,
        settleMs = peelStabilitySettleMs(),
        extraPages = [],
        log = (msg) => console.log(`[TEST] ${msg}`)
    } = opts;

    log('MP sync: guest disconnected tiles stable when host peels...');

    const fixture = await installSymmetricFourTileFixture(frame1, page2, mp, {
        hostUid,
        guestUid,
        guestLayout: 'stragglers',
        source: 'sync-disconnected-stragglers'
    });
    log(`Host fixture: ${fixture.disconnectedIds.length} guest disconnected stragglers.`);

    await flushHostBananaInteractions(page1);
    if (mobile) {
        await waitMobilePeelDumpSettle(page2, frame2, { syncMs: settleMs });
    }

    const guestBefore = await captureTileStabilitySnapshot(page2);
    const peelSeqBefore = await readPeelSeq(page1);

    const peelRes = await frame1.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        const peeled = g._checkPeel();
        return { banner: g._bannerText, count: g.tiles.length, peeled };
    });
    if (!peelRes.peeled && peelRes.banner !== 'Peel!') {
        throw new Error(`Host peel trigger failed (${JSON.stringify(peelRes)})`);
    }

    await waitForDiag(page2, 'host peel on guest', ({ seq, hostUid: uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
    }, { seq: peelSeqBefore, hostUid }, WAIT_MS, mp);

    for (const extraPage of extraPages) {
        await waitForDiag(extraPage, 'host peel on extra guest', ({ seq, uid }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
        }, { seq: peelSeqBefore, uid: hostUid }, WAIT_MS, mp);
    }

    await assertActionBannerAllPlayers(
        opts.ctx || buildMpCtx2p(page1, page2, { mp }),
        'Peel!',
        hostUid,
        'sync host peel guest stability'
    );
    await dismissBanners(page1, page2);
    await flushHostBananaInteractions(page1);

    if (mobile) {
        await waitMobilePeelDumpSettle(page2, frame2, { syncMs: settleMs });
    } else {
        await waitMobilePeelDumpSettle(page2, frame2, { syncMs: Math.max(settleMs, 200) });
    }

    const guestAfter = await captureTileStabilitySnapshot(page2);
    const label = 'MP sync host peel (guest disconnected tiles)';
    assertExistingTilesStableAfterAction(guestBefore, guestAfter, label, {
        screenTolerance: 9999,
        maxPanDelta: 9999,
        maxFocalDelta: 9999,
        maxZoomDelta: 1
    });

    const worldTol = 1;
    const disconnectedMoved = fixture.disconnectedIds.filter((id) => {
        const b = guestBefore.world[id];
        const a = guestAfter.world[id];
        if (!b || !a) return true;
        return Math.abs((a.dx ?? 0) - (b.dx ?? 0)) > worldTol
            || Math.abs((a.dy ?? 0) - (b.dy ?? 0)) > worldTol;
    });
    if (disconnectedMoved.length) {
        throw new Error(`${label}: disconnected tiles moved (${JSON.stringify(disconnectedMoved)})`);
    }

    const addedIds = (guestAfter.tileIds || []).filter((id) => !(guestBefore.tileIds || []).includes(id));
    if (addedIds.length !== 1) {
        throw new Error(`${label}: expected exactly one new peel tile on guest (${JSON.stringify({ addedIds })})`);
    }

    log('SUCCESS: Host peel did not move guest disconnected board tiles.');
}

async function clearMpLocalLayouts(frames) {
    await Promise.all(frames.map((f) => f.evaluate(() => {
        window.game._clearLocalLayout?.();
    })));
}

module.exports = {
    assertHostPeelGuestDisconnectedTilesStable,
    clearMpLocalLayouts
};
