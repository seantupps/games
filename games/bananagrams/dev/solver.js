/**
 * Dev /b solve only — not used by peel, dump, or normal play.
 */
(function (global) {
    const Dev = global.BananaDev = global.BananaDev || {};

    function tryRack(rack, dictionary) {
        const direct = global.BananaAi.solveAttemptFromRack(rack, dictionary);
        if (direct.cleared) return direct;
        const built = global.BananaAi.rebuild(rack, dictionary, 28, 72);
        if (built && !built[1].length) {
            return {
                cleared: true,
                placements: global.BananaAi.boardPlacements(built[0]),
                rackLeft: [],
                reorgs: 0
            };
        }
        return null;
    }

    Dev.solveDevCrossword = function solveDevCrossword(letters, dictionary) {
        const pool = letters.map((c) => String(c).toUpperCase());
        if (pool.length < 2) {
            return { cleared: pool.length === 0, placements: [], rackLeft: [...pool], reorgs: 0 };
        }

        const first = tryRack(pool, dictionary);
        if (first) return first;

        const shuffled = [...pool];
        let s = pool.length * 7919;
        for (let i = shuffled.length - 1; i > 0; i--) {
            s = (s * 1103515245 + 12345) | 0;
            const j = (s >>> 0) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const second = tryRack(shuffled, dictionary);
        if (second) return second;

        return global.BananaAi.solveAttemptFromRack(pool, dictionary);
    };
})(typeof window !== 'undefined' ? window : global);
