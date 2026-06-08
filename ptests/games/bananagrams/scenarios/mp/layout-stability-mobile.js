/**
 * Mobile MP full audit — peel/dump must not shift existing tiles on screen.
 */
const { MP_BOARD_SYNC_MS } = require('../../../../platform/mobile/lib/mobile-constants');
const {
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    dumpTile,
    waitForDiag,
    flushHostBananaInteractions,
    dismissBanners
} = require('../../lib/mp-state');
const { touchPanBackground } = require('../../adapters/mobile-touch');
const { peelGridInFrame } = require('../../fixtures/review-state');
const { readBoardField } = require('../../assertions/core/capture');
const { layout, authority } = require('../../assertions');
const { assertActionBannerOnBoth } = authority;
const {
    captureTileStabilitySnapshot,
    assertMobileTileStabilityAfterAction
} = layout.tileStability;

/**
 * @param {object} opts
 * @param {import('playwright').Page} opts.page1
 * @param {import('playwright').Page} opts.page2
 * @param {import('playwright').Frame} opts.frame1
 * @param {import('playwright').Frame} opts.frame2
 * @param {object} opts.mp
 * @param {Function} [opts.log]
 */
async function runBananagramsMpMobilePeelDumpTileStability(opts) {
    const {
        page1,
        page2,
        frame1,
        frame2,
        mp,
        log = (msg) => console.log(`[TEST] ${msg}`)
    } = opts;

    const settleOpts = { syncMs: MP_BOARD_SYNC_MS };

    log('MP mobile: pan boards before peel/dump tile stability...');
    await Promise.all([
        frame1.evaluate(async () => {
            const g = window.game;
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
                if (Math.abs((g.zoom ?? 1) - (g.targetZoom ?? 1)) < 0.001) break;
                await new Promise((r) => requestAnimationFrame(r));
            }
        }),
        frame2.evaluate(async () => {
            const g = window.game;
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
                if (Math.abs((g.zoom ?? 1) - (g.targetZoom ?? 1)) < 0.001) break;
                await new Promise((r) => requestAnimationFrame(r));
            }
        })
    ]);
    const [panHost, panGuest] = await Promise.all([
        touchPanBackground(frame1),
        touchPanBackground(frame2)
    ]);
    if (!panHost.ok || panHost.dist < 20) {
        throw new Error(`Host touch pan failed before stability checks (${JSON.stringify(panHost)})`);
    }
    if (!panGuest.ok || panGuest.dist < 20) {
        throw new Error(`Guest touch pan failed before stability checks (${JSON.stringify(panGuest)})`);
    }
    log('SUCCESS: Panned host + guest boards.');

    log('MP mobile: host dump must not shift existing tiles...');
    await flushHostBananaInteractions(page1);
    const [hostDumpBefore, guestDumpBefore] = await Promise.all([
        captureTileStabilitySnapshot(page1),
        captureTileStabilitySnapshot(page2)
    ]);
    const dumpSeqBefore = await readBoardField(page1, 'dumpSeq');
    const dumpRes = await dumpTile(frame1, -1, { mobile: true, hostPage: page1 });
    if (!dumpRes.ok) {
        throw new Error(`Mobile dump stability trigger failed (${JSON.stringify(dumpRes)})`);
    }
    await waitForDiag(page1, 'mobile dump stability seq', ({ seq, hostUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.dumpSeq || 0) > seq && board?.dumpActorUid === hostUid;
    }, { seq: dumpSeqBefore, hostUid: HOST_UID }, WAIT_MS, mp);
    await assertActionBannerOnBoth(page1, page2, 'Dump!', HOST_UID, 'mobile dump tile stability');
    await dismissBanners(page1, page2);
    await assertMobileTileStabilityAfterAction(
        page1,
        frame1,
        hostDumpBefore,
        'MP mobile host dump (host view)',
        settleOpts
    );
    await assertMobileTileStabilityAfterAction(
        page2,
        frame2,
        guestDumpBefore,
        'MP mobile host dump (guest view)',
        settleOpts
    );
    log('SUCCESS: Host dump did not shift existing tiles (host + guest).');

    log('MP mobile: host peel must not shift existing crossword tiles...');
    await flushHostBananaInteractions(page1);
    const peelSetup = await frame1.evaluate(peelGridInFrame);
    if (!peelSetup.placed || !peelSetup.valid) {
        throw new Error(`Mobile peel stability fixture invalid (${JSON.stringify(peelSetup)})`);
    }
    const [hostPeelBefore, guestPeelBefore] = await Promise.all([
        captureTileStabilitySnapshot(page1),
        captureTileStabilitySnapshot(page2)
    ]);
    const peelSeqBefore = await readBoardField(page1, 'peelSeq');
    const peelRes = await frame1.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        g._checkPeel();
        return { banner: g._bannerText, count: g.tiles.length };
    });
    if (peelRes.banner !== 'Peel!') {
        throw new Error(`Mobile peel stability trigger failed (${JSON.stringify(peelRes)})`);
    }
    await waitForDiag(page1, 'mobile peel stability seq', ({ seq, hostUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === hostUid;
    }, { seq: peelSeqBefore, hostUid: HOST_UID }, WAIT_MS, mp);
    await assertActionBannerOnBoth(page1, page2, 'Peel!', HOST_UID, 'mobile peel tile stability');
    await dismissBanners(page1, page2);
    await assertMobileTileStabilityAfterAction(
        page1,
        frame1,
        hostPeelBefore,
        'MP mobile host peel (host view)',
        settleOpts
    );
    await assertMobileTileStabilityAfterAction(
        page2,
        frame2,
        guestPeelBefore,
        'MP mobile host peel (guest view)',
        settleOpts
    );
    log('SUCCESS: Host peel did not shift existing tiles (host + guest).');
}

module.exports = {
    runBananagramsMpMobilePeelDumpTileStability
};
