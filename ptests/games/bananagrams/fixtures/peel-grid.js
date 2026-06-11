/**
 * MP peel grid fixtures — host-authoritative tile writers + in-frame CAT grid setup.
 */
const {
    GUEST_UID,
    WAIT_MS,
    waitForDiag
} = require('../lib/mp-state');
const { peelGridInFrame } = require('./review-state');
const { core } = require('../assertions');
const { readBoardField } = core;


/**
 * Guest dump guards block host-authoritative fixture shrinks (e.g. focus after dump rounds).
 */
async function clearGuestDumpInventoryGuards(frame2) {
    await frame2.evaluate(() => {
        const g = window.game;
        g._guestDumpHandFloor = null;
        g._guestDumpSpawnLock = null;
        g._lastGuestDumpLayoutSeq = 0;
        g._guestPreDumpSnapshot = null;
        g._guestOptimisticDumpRemovedId = null;
        g._guestPendingDumpTile = null;
        g._guestDumpSeqAtSend = null;
    });
}

/**
 * Host-authoritative CAT↓+AT→ fixture (same as focus guest-peel rounds).
 */
async function setGuestPeelFixtureOnHost(opts) {
    const {
        frame1,
        frame2,
        page2,
        mp,
        suffix,
        guestUid = GUEST_UID,
        source = 'guest-peel-fixture',
        waitLabel = `guest peel fixture ${suffix}`
    } = opts;

    if (frame2) {
        await clearGuestDumpInventoryGuards(frame2);
    }

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

module.exports = {    setGuestPeelFixtureOnHost,
    prepareGuestPeelGridOnClient,
    setupHostPeelGrid
};
