/**
 * Shared MP peel spawn sync — host + guest peel tiles visible on both clients within skew.
 * Used by mobile audit extras and any desktop path that wants the same timing check.
 */
const {
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    waitForDiag,
    flushHostBananaInteractions,
    dismissBanners,
    assertActionBannerOnBoth
} = require('../lib/mp-state');
const { peelGridInFrame } = require('./review-state');
const { assertPeelSpawnVisibleSameTime } = require('../assertions/mp-sync-peel-spawn');

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

async function settleMpRender(page1, page2) {
    await Promise.all([page1, page2].map((page) => page.evaluate(async () => {
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        await nextFrame();
        await nextFrame();
    })));
}

/**
 * Host-authoritative CAT↓+AT→ fixture (same as focus guest-peel rounds).
 * @param {object} opts
 * @param {import('playwright').Frame} opts.frame1
 * @param {import('playwright').Page} opts.page2
 * @param {object} opts.mp
 * @param {string} opts.suffix unique id suffix for fixture tile ids
 * @param {string} [opts.guestUid]
 * @param {string} [opts.source]
 * @param {string} [opts.waitLabel]
 */
async function setGuestPeelFixtureOnHost(opts) {
    const {
        frame1,
        page2,
        mp,
        suffix,
        guestUid = GUEST_UID,
        source = 'guest-peel-fixture',
        waitLabel = `guest peel fixture ${suffix}`
    } = opts;

    await frame1.evaluate(({ uid, s, src }) => {
        const g = window.game;
        const gap = window.BananaRules.TILE_GAP;
        const y0 = 2200;
        const x0 = 2400;
        const letters = ['C', 'A', 'T', 'T'];
        const tiles = letters.map((letter, idx) => ({
            id: `gfix-${s}-${idx}`,
            letter,
            x: idx === 3 ? x0 + gap : x0,
            y: idx === 3 ? y0 + gap : y0 + idx * gap,
            faceUp: true
        }));
        g._mpEnsureCanonicalMap?.();
        if (!g._mpCanonicalById) g._mpCanonicalById = {};
        tiles.forEach((t) => { g._mpCanonicalById[t.id] = t.letter; });
        if (typeof g._hostSetPlayerTiles === 'function') {
            g._hostSetPlayerTiles(uid, tiles, true, {
                allowTilesToOwned: true,
                source: src
            });
        } else {
            g._hostSetOwned(uid, tiles.map((t) => ({
                id: t.id, letter: t.letter, faceUp: true
            })), true);
        }
        g._hostSyncBoard({ immediate: true });
    }, { uid: guestUid, s: suffix, src: source });

    await waitForDiag(page2, waitLabel, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return (g?.tiles?.length ?? 0) === 4;
    }, {}, WAIT_MS, mp);
}

/** Guest client grid layout + persist (matches focus guest-peel prep). */
async function prepareGuestPeelGridOnClient(frame2) {
    const setup = await frame2.evaluate((fnStr) => {
        const peelGridInFrame = new Function(`return (${fnStr})`)();
        const result = peelGridInFrame();
        window.game._persistMpLayout?.();
        return result;
    }, peelGridInFrame.toString());
    if (!setup?.placed || !setup?.valid) {
        throw new Error(`Guest peel grid invalid (${JSON.stringify(setup)})`);
    }
    return setup;
}

async function setupHostPeelGrid(frame1) {
    const setup = await frame1.evaluate(peelGridInFrame);
    if (!setup.placed || !setup.valid) {
        throw new Error(`Host peel grid invalid (${JSON.stringify(setup)})`);
    }
    return setup;
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

/**
 * Host peel + both clients see spawn within skew (optional mobile timing gate).
 */
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

    await flushHostBananaInteractions(page1);
    if (!skipGridSetup) {
        await setupHostPeelGrid(frame1);
    }

    const [hostBeforeIds, guestBeforeIds] = await collectTileIdsBeforePeel(frame1, page2);
    const peelSeqBefore = await readPeelSeq(page1);

    const timing = await assertPeelSpawnVisibleSameTime({
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

/**
 * Guest peel + both clients see spawn within skew (same prep as focus guest peel).
 */
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

    await flushHostBananaInteractions(page1);
    if (microFixture) {
        const { installSymmetricFourTileFixture } = require('./mp-four-tile');
        await installSymmetricFourTileFixture(frame1, page2, mp, {
            guestLayout: 'peel',
            source: 'mp-peel-spawn-guest-fixture'
        });
        // Host owns membership; guest aligns CAT grid coords for peel validation (same as last-bunch).
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
    const peelSeqBefore = await readPeelSeq(page1);

    const timing = await assertPeelSpawnVisibleSameTime({
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

/**
 * Full host + guest peel spawn sync audit (mobile adds this after SPLIT; desktop may opt in).
 */
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
        const { installSymmetricFourTileFixture } = require('./mp-four-tile');
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

module.exports = {
    readPeelSeq,
    settleMpRender,
    setGuestPeelFixtureOnHost,
    prepareGuestPeelGridOnClient,
    setupHostPeelGrid,
    runHostPeelSpawnSync,
    runGuestPeelSpawnSync,
    runMpPeelSpawnSyncAudit
};
