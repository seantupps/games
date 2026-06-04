/**
 * Tile bag + pool helpers — mirrors build/bananagrams/ai/banana/rules.py
 */

const TILE_BAG = Object.freeze({
    A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3,
    I: 12, J: 2, K: 2, L: 5, M: 3, N: 8, O: 11, P: 3,
    Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3, W: 3, X: 2,
    Y: 3, Z: 2
});

const POOL_SIZE = Object.values(TILE_BAG).reduce((s, n) => s + n, 0);
const MIN_WORD_LEN = 2;

function fullPool() {
    const pool = [];
    for (const [letter, count] of Object.entries(TILE_BAG)) {
        for (let i = 0; i < count; i++) pool.push(letter);
    }
    return pool;
}

function buildShuffledPool(rng) {
    const pool = fullPool();
    rng.shuffle(pool);
    return pool;
}

function verifyPoolContents(tiles) {
    if (tiles.length !== POOL_SIZE) return false;
    const counts = {};
    for (const ch of tiles) {
        counts[ch] = (counts[ch] || 0) + 1;
    }
    for (const [letter, count] of Object.entries(TILE_BAG)) {
        if (counts[letter] !== count) return false;
    }
    return true;
}

function verifyHandFromPool(rack, bunch) {
    return rack.length + bunch.length <= POOL_SIZE && verifyPoolContents([...rack, ...bunch]);
}

function verifyAllTiles(rack, bunch, boardLetters) {
    return verifyPoolContents([...rack, ...bunch, ...boardLetters]);
}

/** Minimal RNG matching Python random.Random interface used by Game. */
function makeRng(seed) {
    // Mulberry32 — deterministic shuffle/deal for tests (not byte-identical to Python).
    let s = seed >>> 0;
    const next = () => {
        s += 0x6D2B79F5;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        randrange(n) {
            return Math.floor(next() * n);
        },
        shuffle(arr) {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
        }
    };
}

module.exports = {
    TILE_BAG,
    POOL_SIZE,
    MIN_WORD_LEN,
    fullPool,
    buildShuffledPool,
    verifyPoolContents,
    verifyHandFromPool,
    verifyAllTiles,
    makeRng
};
