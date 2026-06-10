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
 * Host-authoritative CAT↓+AT→ fixture (same as focus guest-peel rounds).
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

    const setup = await frame1.evaluate(({ uid, src }) => {
        const g = window.game;
        const gap = window.BananaRules.TILE_GAP;
        const y0 = 2200;
        const x0 = g.ORIGIN;
        const letters = ['C', 'A', 'T', 'T'];
        const owned = [...(g._mpOwned?.[uid] || [])];
        if (owned.length < 4) {
            return { ok: false, reason: 'short-owned', owned: owned.length };
        }
        const ids = owned.slice(0, 4).map((t) => t.id);
        g._mpEnsureCanonicalMap?.();
        if (!g._mpCanonicalById) g._mpCanonicalById = {};
        ids.forEach((id, idx) => { g._mpCanonicalById[id] = letters[idx]; });
        const tiles = ids.map((id, idx) => ({
            id,
            letter: letters[idx],
            x: idx === 3 ? x0 + gap : x0,
            y: idx === 3 ? y0 + gap : y0 + idx * gap,
            faceUp: true
        }));
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
        return { ok: true, ids };
    }, { uid: guestUid, src: source });

    if (setup?.ok === false) {
        throw new Error(`setGuestPeelFixtureOnHost failed (${JSON.stringify(setup)})`);
    }

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

module.exports = {
    setGuestPeelFixtureOnHost,
    prepareGuestPeelGridOnClient,
    setupHostPeelGrid
};
