/**
 * Dev /b solve N — leave N tiles disconnected. Crossword body uses Game.solveAttempt (same as audits).
 */

const { Game } = require('./game');
const { boardPlacements } = require('./grid');

function comb(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    k = Math.min(k, n - k);
    let c = 1;
    for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
    return Math.round(c);
}

function chooseIndexSubsets(total, pick, maxOut) {
    if (pick === 0) return [[]];
    if (pick > total) return [];
    const out = [];
    const all = comb(total, pick);
    if (all <= maxOut) {
        const idx = Array.from({ length: pick }, (_, i) => i);
        while (true) {
            out.push(idx.slice());
            let i = pick - 1;
            while (i >= 0 && idx[i] === total - pick + i) i--;
            if (i < 0) break;
            idx[i]++;
            for (let j = i + 1; j < pick; j++) idx[j] = idx[j - 1] + 1;
        }
        return out;
    }
    const seen = new Set();
    while (out.length < maxOut) {
        const pickSet = new Set();
        while (pickSet.size < pick) pickSet.add(Math.floor(Math.random() * total));
        const key = [...pickSet].sort((a, b) => a - b).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([...pickSet].sort((a, b) => a - b));
    }
    return out;
}

function solveAttemptFromRackLetters(rackLetters, dictionary) {
    const game = new Game(dictionary, null, { handSize: rackLetters.length });
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
 * @param {string[]} letters
 * @param {number} stragglerCount
 * @param {object} dictionary
 * @param {{ maxSubsets?: number }} [opts]
 */
function solveWithStragglers(letters, stragglerCount, dictionary, opts = {}) {
    const pool = letters.map((c) => String(c).toUpperCase());
    const n = Number(stragglerCount) | 0;
    if (!Number.isFinite(n) || n < 0 || n > pool.length) return null;

    if (n === 0) {
        const result = solveAttemptFromRackLetters(pool, dictionary);
        if (!result.cleared) return null;
        return {
            placements: result.placements,
            stragglerIndices: []
        };
    }

    const maxSubsets = opts.maxSubsets ?? 120;
    const subsets = chooseIndexSubsets(pool.length, n, maxSubsets);
    for (const indices of subsets) {
        const skip = new Set(indices);
        const remaining = pool.filter((_, i) => !skip.has(i));
        const result = solveAttemptFromRackLetters(remaining, dictionary);
        if (!result.cleared) continue;
        return {
            placements: result.placements,
            stragglerIndices: indices.slice()
        };
    }
    return null;
}

module.exports = {
    solveWithStragglers,
    solveAttemptFromRackLetters,
    chooseIndexSubsets
};
