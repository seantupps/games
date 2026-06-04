/**
 * Node port of build/bananagrams/ai/banana — mirrors play.py + game.py.
 */

const { getDictionary } = require('./dictionary');
const { Board, boardPlacements, validateFull } = require('./grid');
const { findBestPlacement } = require('./solver');
const { Game } = require('./game');
const { makeRng, POOL_SIZE, buildShuffledPool } = require('./rules');

/**
 * One solve attempt on a rack (empty board) — same as Python Game._solve_attempt after load_rack.
 */
function solveAttemptFromRack(rackLetters, options = {}) {
    const dict = getDictionary(options.dictPath);
    const game = new Game(dict, options.rng, { handSize: rackLetters.length });
    game.loadRack(rackLetters);
    const [cleared] = game.solveAttempt();
    return {
        cleared,
        placements: boardPlacements(game.board),
        rackLeft: [...game.rack],
        reorgs: game.reorgs
    };
}

/**
 * One solve pass from live browser board + rack (mid-game safe).
 * @param {{ boardCells: {gx:number,gy:number,letter:string}[], rackLetters: string[] }} state
 */
function solveAttemptFromBrowserState(state, options = {}) {
    const dict = getDictionary(options.dictPath);
    const rackLetters = state.rackLetters || [];
    const game = new Game(dict, options.rng, { handSize: Math.max(rackLetters.length, 1) });
    for (const { gx, gy, letter } of state.boardCells || []) {
        game.board.setCell(gx, gy, letter);
    }
    game.rack = rackLetters.map((c) => String(c).toUpperCase());
    const [cleared, changed] = game.solveAttempt();
    const stuck = !cleared && !changed;
    return {
        cleared,
        changed,
        stuck,
        placements: boardPlacements(game.board),
        rackLeft: [...game.rack],
        reorgs: game.reorgs
    };
}

/**
 * Full play.py-style session in Node (deal + peel/dump loop).
 */
function runGame(options = {}) {
    const {
        seed = Date.now() & 0x7fffffff,
        handSize = 4,
        maxTurns = null,
        timeoutMs = 5000,
        dictPath = null,
        log = null
    } = options;
    const dict = getDictionary(dictPath);
    const game = new Game(dict, makeRng(seed), { handSize, log });
    return game.run({ maxTurns, deadlineMs: timeoutMs > 0 ? timeoutMs : null });
}

/**
 * Apply solver grid placements to browser tile objects (world coords).
 * @param {object[]} tiles — game.tiles
 * @param {{gx,gy,letter}[]} placements
 * @param {number} origin — game.ORIGIN (x and y; square board origin)
 * @param {number} gap — BananaRules.TILE_GAP
 */
function applyPlacementsToTiles(tiles, placements, origin, gap) {
    const used = new Set();
    for (const p of placements) {
        const tile = tiles.find(
            (t) => !used.has(t.id) && t.letter.toUpperCase() === p.letter.toUpperCase()
        );
        if (!tile) {
            throw new Error(`No unused tile for letter ${p.letter}`);
        }
        used.add(tile.id);
        tile.x = origin + p.gx * gap;
        tile.y = origin + p.gy * gap;
        tile.faceUp = true;
    }
    return used.size;
}

/** @deprecated Use solveAttemptFromRack */
function solveFullHand(rackLetters, options = {}) {
    const result = solveAttemptFromRack(rackLetters, options);
    if (!result.cleared || !result.placements.length) return null;
    return {
        coords: result.placements.map((p) => ({ x: p.gx, y: p.gy, letter: p.letter }))
    };
}

function solve(boardTiles, rackLetters, options = {}) {
    const dict = getDictionary(options.dictPath);
    const board = new Board();
    if (boardTiles?.length) {
        for (const t of boardTiles) {
            board.setCell(t.x ?? t.gx, t.y ?? t.gy, t.letter);
        }
    }
    const hit = findBestPlacement(board, rackLetters, dict);
    if (!hit) return null;
    const [word, coords] = hit;
    return {
        word,
        coords: coords.map(([x, y]) => ({ x, y }))
    };
}

module.exports = {
    solve,
    solveFullHand,
    solveAttemptFromRack,
    solveAttemptFromBrowserState,
    runGame,
    applyPlacementsToTiles,
    Game,
    Board,
    getDictionary,
    findBestPlacement,
    boardPlacements,
    validateFull,
    makeRng,
    POOL_SIZE,
    buildShuffledPool,
    Transcript: require('./transcript').Transcript
};
