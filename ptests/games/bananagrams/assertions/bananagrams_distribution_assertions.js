/**
 * Assert board + pool letter counts match the starting tile bag (solo or MP).
 * Intended after post-game review — all tiles should still be accounted for.
 */

/** @param {import('playwright').Frame} frame @param {Record<string, { tiles?: { id?: string, letter?: string }[] }>|null} [endingSnapshots] */
async function readTileDistributionState(frame, endingSnapshots = null) {
    return frame.evaluate((snaps) => {
        const g = window.game;
        const rules = typeof BananaRules !== 'undefined' ? BananaRules : null;
        if (!g || !rules) {
            return { ok: false, reason: 'missing-game-or-rules' };
        }

        const cfg = rules.resolveBagConfig(new URLSearchParams(window.location.search));
        const mode = g._isMultiplayerMode?.() ? 'multiplayer' : 'solo';
        const bag = rules.getTileBag(mode, cfg);
        const bagLabel = mode === 'multiplayer' ? 'scrabble-mp' : (cfg.soloVariant === 'classic' ? 'solo-classic' : 'solo-fast');

        const counts = {};
        const add = (entry) => {
            const ch = typeof entry === 'string'
                ? entry.toUpperCase()
                : String(entry?.letter || '').toUpperCase();
            if (!/^[A-Z]$/.test(ch)) return;
            counts[ch] = (counts[ch] || 0) + 1;
        };

        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const inReview = !!(
            g._postGameReview
            || g._inReviewExperience?.()
            || board?.phase === 'review'
            || board?.reviewPhase === true
        );
        const reviewLayoutsOrig = board?.reviewLayoutsOrig || null;
        const reviewLayouts = board?.reviewLayouts || g._reviewLayouts || null;
        const ownedByPlayer = board?.tilesOwnedByPlayer
            || (typeof g.isHost === 'function' && g.isHost() && g._mpOwned ? g._mpOwned : null);
        const useReviewLayouts = mode === 'multiplayer'
            && inReview
            && (reviewLayoutsOrig || reviewLayouts)
            && Object.values(reviewLayoutsOrig || reviewLayouts).some((list) => list?.length);

        const expectedTotal = rules.poolTotal(bag);
        const ownedTotal = ownedByPlayer
            ? Object.values(ownedByPlayer).reduce((n, list) => n + (list?.length || 0), 0)
            : 0;

        const addUniqueTiles = (lists) => {
            const seenIds = new Set();
            Object.values(lists || {}).forEach((list) => {
                (list || []).forEach((t) => {
                    const id = t?.id;
                    if (id) {
                        if (seenIds.has(id)) return;
                        seenIds.add(id);
                    }
                    add(t);
                });
            });
            return seenIds.size || Object.values(lists || {}).reduce((n, list) => n + (list?.length || 0), 0);
        };

        let countSource = 'runtime';
        let countedTiles = 0;
        const snapLayouts = snaps && typeof snaps === 'object'
            ? Object.fromEntries(
                Object.values(snaps)
                    .filter((s) => s?.uid && s?.tiles?.length)
                    .map((s) => [s.uid, s.tiles])
            )
            : null;
        const snapTotal = snapLayouts
            ? Object.values(snapLayouts).reduce((n, list) => n + (list?.length || 0), 0)
            : 0;
        const preferReviewLayouts = snaps === null;
        if (mode === 'multiplayer' && inReview && !preferReviewLayouts && snapLayouts && snapTotal >= expectedTotal) {
            const letterById = {};
            if (ownedByPlayer) {
                Object.values(ownedByPlayer).forEach((list) => {
                    (list || []).forEach((t) => {
                        if (t?.id) letterById[t.id] = t.letter;
                    });
                });
            }
            const canonicalSnaps = Object.fromEntries(
                Object.entries(snapLayouts).map(([uid, list]) => [
                    uid,
                    (list || []).map((t) => ({
                        ...t,
                        letter: letterById[t.id] ?? t.letter
                    }))
                ])
            );
            countedTiles = addUniqueTiles(canonicalSnaps);
            countSource = 'ending-snapshots';
        } else if (mode === 'multiplayer' && inReview && ownedByPlayer && ownedTotal >= expectedTotal) {
            countedTiles = addUniqueTiles(ownedByPlayer);
            countSource = 'owned';
        } else if (useReviewLayouts && reviewLayoutsOrig) {
            countedTiles = addUniqueTiles(reviewLayoutsOrig);
            countSource = 'review-orig';
        } else if (useReviewLayouts) {
            countedTiles = addUniqueTiles(reviewLayouts);
            countSource = 'review-display';
        } else {
            (g.tiles || []).forEach((t) => add(t));
            const pool = Array.isArray(g._tilePool) ? g._tilePool : [];
            pool.forEach((l) => add(l));
            countedTiles = (g.tiles?.length ?? 0) + pool.length;
            countSource = 'runtime';
        }

        const mismatches = [];
        const letters = new Set([...Object.keys(bag), ...Object.keys(counts)]);
        for (const letter of letters) {
            const got = counts[letter] || 0;
            const want = bag[letter] || 0;
            if (got !== want) mismatches.push({ letter, got, want });
        }

        const actualTotal = Object.values(counts).reduce((sum, n) => sum + n, 0);

        return {
            ok: mismatches.length === 0 && actualTotal === expectedTotal,
            bagLabel,
            mode,
            expectedTotal,
            actualTotal,
            countSource,
            boardTiles: countedTiles,
            poolLen: countSource === 'runtime' && Array.isArray(g._tilePool) ? g._tilePool.length : 0,
            mismatches,
            counts
        };
    }, endingSnapshots);
}

/** @param {import('playwright').Frame} frame @param {string} [label] @param {{ endingSnapshots?: Record<string, { tiles?: { id?: string, letter?: string }[] }>, requireReviewLayouts?: boolean }} [opts] */
async function assertTileDistributionInReview(frame, label = 'tile-distribution', opts = {}) {
    const inReview = await frame.evaluate(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        return !!(
            g?._postGameReview
            || g?._inReviewExperience?.()
            || board?.phase === 'review'
            || board?.reviewPhase === true
        );
    });
    if (!inReview) {
        throw new Error(`${label}: expected post-game review before distribution check`);
    }

    const snapArg = opts.requireReviewLayouts ? null : (opts.endingSnapshots || null);
    const state = await readTileDistributionState(frame, snapArg);
    if (!state.ok) {
        throw new Error(
            `${label}: tile distribution must match starting bag (${JSON.stringify({
                bag: state.bagLabel,
                mode: state.mode,
                expectedTotal: state.expectedTotal,
                actualTotal: state.actualTotal,
                boardTiles: state.boardTiles,
                poolLen: state.poolLen,
                countSource: state.countSource,
                mismatches: (state.mismatches || []).slice(0, 12)
            })})`
        );
    }
    return state;
}

module.exports = {
    readTileDistributionState,
    assertTileDistributionInReview
};
