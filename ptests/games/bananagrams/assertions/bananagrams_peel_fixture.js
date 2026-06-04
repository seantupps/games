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
    const placements = [
        { id: 'c', letter: 'C', x: ox, y: y0 },
        { id: 'a', letter: 'A', x: ox, y: y0 + gap },
        { id: 't-v', letter: 'T', x: ox, y: y0 + gap * 2 },
        { id: 't-h', letter: 'T', x: ox + gap, y: y0 + gap }
    ];
    g.tiles = placements.map((p) => ({
        id: p.id,
        letter: p.letter,
        x: p.x,
        y: p.y,
        faceUp: true
    }));
    if (typeof g._hostSetPlayerTiles === 'function') {
        g._hostSetPlayerTiles(g._myUid(), g.tiles, true);
    }
    g.requestRender();
    const origin = { x: g.ORIGIN, y: g.ORIGIN };
    const placed = BananaGrid.allTilesPlacedInGrid(g.tiles, origin, opts);
    const valid = BananaGrid.validateGrid(g.tiles, g._checker);
    return { placed, valid: valid.ok, words: valid.words };
}

module.exports = {
    PEEL_CROSSWORD_Y0,
    peelCrosswordPlacements,
    peelGridInFrame
};
