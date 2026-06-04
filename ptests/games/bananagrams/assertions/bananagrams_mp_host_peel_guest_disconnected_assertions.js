/**
 * MP actions — when the host peels, guest disconnected board tiles must not move.
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
const { peelGridInFrame } = require('./bananagrams_peel_fixture');
const {
    captureTileStabilitySnapshot,
    assertExistingTilesStableAfterAction,
    waitMobilePeelDumpSettle
} = require('./bananagrams_tile_stability_assertions');

/** In-frame: crossword + disconnected stragglers (works with MP_HAND_OVERRIDE=4). */
function setupGuestDisconnectedBoardInFrame() {
    const g = window.game;
    if (!g?._checker || typeof BananaGrid === 'undefined' || typeof BananaRules === 'undefined') {
        return { ok: false, reason: 'missing-game' };
    }
    const gap = BananaRules.TILE_GAP;
    const ox = g.ORIGIN;
    const y0 = 2800;
    const tiles = [...(g.tiles || [])];
    if (tiles.length < 4) return { ok: false, reason: 'short-hand', count: tiles.length };

    const pair = tiles.slice(0, 2);
    pair[0].letter = 'C';
    pair[0].x = ox + 400;
    pair[0].y = y0;
    pair[0].faceUp = true;
    pair[1].letter = 'A';
    pair[1].x = ox + 400;
    pair[1].y = y0 + gap;
    pair[1].faceUp = true;

    const disconnected = tiles.slice(2, 4);
    disconnected[0].x = ox + 800;
    disconnected[0].y = y0;
    disconnected[0].faceUp = true;
    disconnected[1].x = ox + 800;
    disconnected[1].y = y0 + gap * 3;
    disconnected[1].faceUp = true;

    if (!BananaGrid.isConnected(tiles)) {
        g._persistMpLayout?.();
        g.requestRender?.();
        return {
            ok: true,
            disconnectedIds: disconnected.map((t) => t.id),
            boardTileIds: tiles.map((t) => t.id),
            tileCount: tiles.length
        };
    }
    return { ok: false, reason: 'expected-disconnected-board' };
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
        settleMs = Number(process.env.FIVE_MP_PEEL_STABILITY_SETTLE_MS || 60),
        extraPages = [],
        log = (msg) => console.log(`[TEST] ${msg}`)
    } = opts;

    log('MP actions: guest disconnected tiles stable when host peels...');

    const guestSetup = await frame2.evaluate(setupGuestDisconnectedBoardInFrame);
    if (!guestSetup.ok) {
        throw new Error(`Guest disconnected board fixture failed (${JSON.stringify(guestSetup)})`);
    }
    log(`Guest board: ${guestSetup.boardTileIds.length} placed tiles, `
        + `${guestSetup.disconnectedIds.length} disconnected stragglers.`);

    // Do not sync guest layout to host — board echo keeps stale split rack positions.
    await flushHostBananaInteractions(page1);

    const hostPeelSetup = await frame1.evaluate(peelGridInFrame);
    if (!hostPeelSetup.placed || !hostPeelSetup.valid) {
        throw new Error(`Host peel fixture invalid (${JSON.stringify(hostPeelSetup)})`);
    }

    const guestBefore = await captureTileStabilitySnapshot(page2);
    const peelSeqBefore = await readPeelSeq(page1);

    const peelRes = await frame1.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        g._checkPeel();
        return { banner: g._bannerText, count: g.tiles.length };
    });
    if (peelRes.banner !== 'Peel!') {
        throw new Error(`Host peel trigger failed (${JSON.stringify(peelRes)})`);
    }

    await waitForDiag(page2, 'host peel on guest', ({ seq, hostUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === hostUid;
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

    await assertActionBannerOnBoth(page1, page2, 'Peel!', hostUid, 'actions host peel guest stability');
    await dismissBanners(page1, page2);

    if (mobile) {
        await waitMobilePeelDumpSettle(page2, frame2, { syncMs: settleMs });
    } else {
        await page2.waitForTimeout(settleMs);
    }

    const guestAfter = await captureTileStabilitySnapshot(page2);
    const label = 'MP actions host peel (guest disconnected tiles)';
    const stabilityOpts = extraPages.length > 0 && mobile
        ? { screenTolerance: 9999, maxPanDelta: 9999, maxFocalDelta: 9999, maxZoomDelta: 1 }
        : {};
    assertExistingTilesStableAfterAction(guestBefore, guestAfter, label, stabilityOpts);

    const disconnectedMoved = guestSetup.disconnectedIds.filter((id) => {
        const b = guestBefore.world[id];
        const a = guestAfter.world[id];
        if (!b || !a) return true;
        return Math.abs((a.dx ?? 0) - (b.dx ?? 0)) > 0
            || Math.abs((a.dy ?? 0) - (b.dy ?? 0)) > 0;
    });
    if (disconnectedMoved.length) {
        throw new Error(`${label}: disconnected tiles moved (${JSON.stringify(disconnectedMoved)})`);
    }

    const addedIds = (guestAfter.tileIds || []).filter((id) => !(guestBefore.tileIds || []).includes(id));
    if (addedIds.length !== 1) {
        throw new Error(`${label}: expected exactly one new peel tile on guest (${JSON.stringify({ addedIds })})`);
    }

    log('SUCCESS: Host peel did not move guest disconnected board tiles.');

    await Promise.all([frame1, frame2].map((f) => f.evaluate(() => {
        window.game._clearLocalLayout?.();
    })));
}

async function clearMpLocalLayouts(frames) {
    await Promise.all(frames.map((f) => f.evaluate(() => {
        window.game._clearLocalLayout?.();
    })));
}

module.exports = {
    setupGuestDisconnectedBoardInFrame,
    assertHostPeelGuestDisconnectedTilesStable,
    clearMpLocalLayouts
};
