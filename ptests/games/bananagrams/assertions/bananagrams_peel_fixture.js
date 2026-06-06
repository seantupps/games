/**
 * Shared CAT↓ + AT→ peel crossword (solo + MP + mobile audits).
 * Coords match ptests/desktop/multiplayer/mp_bananagrams.js peelGridScript.
 */
const PEEL_CROSSWORD_Y0 = 2200;

function peelCrosswordPlacements(originX = 2400) {
    const gap = 40;
    const y0 = PEEL_CROSSWORD_Y0;
    return [
        { id: 'c', letter: 'C', x: originX, y: y0 },
        { id: 'a', letter: 'A', x: originX, y: y0 + gap },
        { id: 't-v', letter: 'T', x: originX, y: y0 + gap * 2 },
        { id: 't-h', letter: 'T', x: originX + gap, y: y0 + gap }
    ];
}

/** In-frame: build 4-tile peel grid; returns { placed, valid, words }. */
function peelGridInFrame() {
    const g = window.game;
    const opts = {
        cols: BananaRules.COLS,
        gap: BananaRules.TILE_GAP,
        tileSize: BananaRules.TILE_SIZE,
        handBelowCenter: BananaRules.HAND_BELOW_CENTER,
        handSize: typeof BananaRules.startingHandSize === 'function'
            ? BananaRules.startingHandSize(2)
            : BananaRules.SOLO_HAND
    };
    const gap = BananaRules.TILE_GAP;
    const ox = g.ORIGIN;
    const y0 = 2200;
    const hand = [...(g.tiles || [])];
    if (hand.length < 4) return { placed: false, valid: false, words: [] };

    const pick = hand.slice(0, 4);
    const letters = ['C', 'A', 'T', 'T'];
    if (g._mpEnsureCanonicalMap) g._mpEnsureCanonicalMap();
    if (!g._mpCanonicalById) g._mpCanonicalById = {};
    pick.forEach((t, i) => {
        g._mpCanonicalById[t.id] = letters[i];
    });

    const gridCoords = [
        { x: ox, y: y0 },
        { x: ox, y: y0 + gap },
        { x: ox, y: y0 + gap * 2 },
        { x: ox + gap, y: y0 + gap }
    ];
    g.tiles = pick.map((t, i) => ({
        id: t.id,
        letter: letters[i],
        x: gridCoords[i].x,
        y: gridCoords[i].y,
        faceUp: true
    }));
    const uid = g._myUid?.();
    if (uid && typeof g._hostSetPlayerTiles === 'function') {
        g._hostSetPlayerTiles(uid, g.tiles, true, { allowTilesToOwned: true });
    } else if (uid) {
        g._hostEnsureMpStores?.();
        if (!g._mpPlayerLayouts) g._mpPlayerLayouts = {};
        const layout = { ...(g._mpPlayerLayouts[uid] || {}) };
        g.tiles.forEach((t) => {
            layout[t.id] = { x: t.x, y: t.y };
        });
        g._mpPlayerLayouts[uid] = layout;
    }
    g.requestRender();
    const origin = { x: g.ORIGIN, y: g.ORIGIN };
    const placed = BananaGrid.allTilesPlacedInGrid(g.tiles, origin, opts);
    const valid = BananaGrid.validateGrid(g.tiles, g._checker);
    return { placed, valid: valid.ok, words: valid.words };
}

/** Same-frame setup + peel (self-contained for frame.evaluate). */
function peelGridAndTriggerInFrame() {
    const setup = peelGridInFrame();
    if (!setup.placed || !setup.valid) {
        return { ok: false, step: 'setup', setup };
    }
    const g = window.game;
    g._bannerText = '';
    const peeled = g._checkPeel();
    return {
        ok: peeled && g._bannerText === 'Peel!',
        banner: g._bannerText,
        count: g.tiles?.length ?? 0,
        pool: g._tilePool?.length ?? 0,
        peeled,
        setup
    };
}

/** Browser bundle: setup + peel in one evaluate (nested fns are not serialized). */
function peelGridAndTriggerInFrameStandalone() {
    const g = window.game;
    const opts = {
        cols: BananaRules.COLS,
        gap: BananaRules.TILE_GAP,
        tileSize: BananaRules.TILE_SIZE,
        handBelowCenter: BananaRules.HAND_BELOW_CENTER,
        handSize: typeof BananaRules.startingHandSize === 'function'
            ? BananaRules.startingHandSize(2)
            : BananaRules.SOLO_HAND
    };
    const gap = BananaRules.TILE_GAP;
    const ox = g.ORIGIN;
    const y0 = 2200;
    const hand = [...(g.tiles || [])];
    if (hand.length < 4) {
        return { ok: false, step: 'setup', setup: { placed: false, valid: false, words: [] } };
    }
    const pick = hand.slice(0, 4);
    const letters = ['C', 'A', 'T', 'T'];
    if (g._mpEnsureCanonicalMap) g._mpEnsureCanonicalMap();
    if (!g._mpCanonicalById) g._mpCanonicalById = {};
    pick.forEach((t, i) => {
        g._mpCanonicalById[t.id] = letters[i];
    });
    const gridCoords = [
        { x: ox, y: y0 },
        { x: ox, y: y0 + gap },
        { x: ox, y: y0 + gap * 2 },
        { x: ox + gap, y: y0 + gap }
    ];
    g.tiles = pick.map((t, i) => ({
        id: t.id,
        letter: letters[i],
        x: gridCoords[i].x,
        y: gridCoords[i].y,
        faceUp: true
    }));
    const uid = g._myUid?.();
    if (uid && typeof g._hostSetPlayerTiles === 'function') {
        g._hostSetPlayerTiles(uid, g.tiles, true, { allowTilesToOwned: true });
    }
    const origin = { x: g.ORIGIN, y: g.ORIGIN };
    const placed = BananaGrid.allTilesPlacedInGrid(g.tiles, origin, opts);
    const valid = BananaGrid.validateGrid(g.tiles, g._checker);
    const setup = { placed, valid: valid.ok, words: valid.words };
    if (!setup.placed || !setup.valid) {
        return { ok: false, step: 'setup', setup };
    }
    g._bannerText = '';
    const peeled = g._checkPeel();
    return {
        ok: peeled && g._bannerText === 'Peel!',
        banner: g._bannerText,
        count: g.tiles?.length ?? 0,
        pool: g._tilePool?.length ?? 0,
        peeled,
        setup
    };
}

module.exports = {
    PEEL_CROSSWORD_Y0,
    peelCrosswordPlacements,
    peelGridInFrame,
    peelGridAndTriggerInFrame,
    peelGridAndTriggerInFrameStandalone
};
