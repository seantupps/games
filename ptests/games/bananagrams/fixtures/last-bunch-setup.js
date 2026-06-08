/**
 * Last-bunch peel fixtures — host setup for peel-ready / win-ready grids.
 */
const {
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    log,
    flushHostBananaInteractions,
    getGameFrame,
    waitPoolBoth
} = require('../lib/mp-state');
const { peelGridInFrame } = require('./review-state');
const { patchMpThreeLetterChecker } = require('./mp-four-tile');

const LAST_BUNCH = 2;
const PARTY_SIZE = 2;

/** Host: 3-letter checker + peel-ready CAT grids for both players + bunch=2. */
async function setupLastBunchPeelReady(frame1, page1, page2, mp) {
    const frame2 = await getGameFrame(page2);
    await patchMpThreeLetterChecker([frame1, frame2]);

    const setup = await frame1.evaluate(({ hostUid, guestUid, bunch }) => {
        const g = window.game;
        if (!g?.isHost?.()) return { ok: false, reason: 'not-host' };

        const patchLetters = (ids, letters) => {
            g._mpEnsureCanonicalMap?.();
            if (!g._mpCanonicalById) g._mpCanonicalById = {};
            ids.forEach((id, i) => {
                g._mpCanonicalById[id] = letters[i];
            });
        };

        const buildPeelGridTiles = (uid, originX) => {
            const owned = [...(g._mpOwned?.[uid] || [])];
            if (owned.length < 4) return { ok: false, reason: `short-owned-${uid}`, len: owned.length };
            const ids = owned.slice(0, 4).map((t) => t.id || t);
            const letters = ['C', 'A', 'T', 'T'];
            patchLetters(ids, letters);
            const gap = window.BananaRules.TILE_GAP;
            const y0 = 2200;
            const tiles = [
                { id: ids[0], letter: 'C', x: originX, y: y0, faceUp: true },
                { id: ids[1], letter: 'A', x: originX, y: y0 + gap, faceUp: true },
                { id: ids[2], letter: 'T', x: originX, y: y0 + gap * 2, faceUp: true },
                { id: ids[3], letter: 'T', x: originX + gap, y: y0 + gap, faceUp: true }
            ];
            if (typeof g._hostSetPlayerTiles === 'function') {
                g._hostSetPlayerTiles(uid, tiles, true, { allowTilesToOwned: true, source: 'last-bunch' });
            } else {
                g._hostEnsureMpStores?.();
                g._mpOwned[uid] = tiles.map((t) => ({ id: t.id, faceUp: true }));
                if (!g._mpPlayerLayouts) g._mpPlayerLayouts = {};
                g._mpPlayerLayouts[uid] = Object.fromEntries(tiles.map((t) => [t.id, { x: t.x, y: t.y }]));
                if (uid === g._myUid()) {
                    g.tiles = g._mpHydrateTiles?.(tiles) || tiles;
                }
            }
            const hand = uid === g._myUid() ? g.tiles : tiles;
            const grid = window.BananaGrid.validateGrid(hand, g._checker);
            const placed = window.BananaGrid.allTilesPlacedInGrid(
                hand,
                { x: g.ORIGIN, y: g.ORIGIN },
                {
                    cols: window.BananaRules.COLS,
                    gap: window.BananaRules.TILE_GAP,
                    tileSize: window.BananaRules.TILE_SIZE,
                    handBelowCenter: window.BananaRules.HAND_BELOW_CENTER,
                    handSize: window.BananaRules.startingHandSize(2)
                }
            );
            return { ok: placed && grid.ok, placed, valid: grid.ok, words: grid.words || [] };
        };

        const hostGrid = buildPeelGridTiles(hostUid, g.ORIGIN);
        const guestGrid = buildPeelGridTiles(guestUid, g.ORIGIN + 600);
        if (!hostGrid.ok || !guestGrid.ok) {
            return { ok: false, reason: 'grid-setup', hostGrid, guestGrid };
        }

        const poolIds = [...(g._tilePool || [])];
        if (poolIds.length < bunch) {
            return { ok: false, reason: 'short-pool', poolLen: poolIds.length };
        }
        g._tilePool = poolIds.slice(0, bunch);
        g._lastPeelDraws = null;
        if (typeof g._hostWriteBoard === 'function') {
            g._hostWriteBoard('playing');
        } else {
            g._hostSyncBoard({ immediate: true });
        }
        g.requestRender?.();
        return {
            ok: true,
            pool: g._tilePool.length,
            hostGrid,
            guestGrid
        };
    }, { hostUid: HOST_UID, guestUid: GUEST_UID, bunch: LAST_BUNCH });

    if (!setup?.ok) {
        throw new Error(`last-bunch setup failed (${JSON.stringify(setup)})`);
    }

    await flushHostBananaInteractions(page1);
    await waitPoolBoth(page1, page2, LAST_BUNCH, WAIT_MS);

    const guestGrid = await frame2.evaluate((fnStr) => {
        const peelGridInFrame = new Function(`return (${fnStr})`)();
        const result = peelGridInFrame();
        window.game._persistMpLayout?.();
        return result;
    }, peelGridInFrame.toString());
    if (!guestGrid?.placed || !guestGrid?.valid) {
        throw new Error(`last-bunch guest peel grid failed (${JSON.stringify(guestGrid)})`);
    }
    await flushHostBananaInteractions(page1);
    log(`SUCCESS: last-bunch setup — peel-ready grids, bunch=${LAST_BUNCH}`);
    return setup;
}

/** Host: complete CAT grids for both players + empty bunch (pool=0). */
async function setupLastBunchWinReady(frame1, page1, page2) {
    await Promise.all([frame1, (await getGameFrame(page2))].map((f) => f.evaluate(() => {
        const g = window.game;
        if (!g?._checker || g._checker._threeLetterPatched) return false;
        const base = g._checker;
        g._checker = {
            _threeLetterPatched: true,
            isPrefix(str) {
                const s = String(str || '').toLowerCase();
                if (/^[a-z]+$/.test(s) && s.length <= 3) return true;
                return base.isPrefix(s);
            },
            isWord(str) {
                const s = String(str || '').toLowerCase();
                if (/^[a-z]{3}$/.test(s)) return true;
                return base.isWord(s);
            }
        };
        return true;
    })));

    const setup = await frame1.evaluate(({ hostUid, guestUid }) => {
        const g = window.game;
        if (!g?.isHost?.()) return { ok: false, reason: 'not-host' };

        const patchLetters = (ids, letters) => {
            g._mpEnsureCanonicalMap?.();
            if (!g._mpCanonicalById) g._mpCanonicalById = {};
            ids.forEach((id, i) => {
                g._mpCanonicalById[id] = letters[i];
            });
        };

        const buildWinGridTiles = (uid, originX) => {
            const owned = [...(g._mpOwned?.[uid] || [])];
            if (owned.length < 4) return { ok: false, reason: `short-owned-${uid}`, len: owned.length };
            const ids = owned.slice(0, 4).map((t) => t.id || t);
            const letters = ['C', 'A', 'T', 'T'];
            patchLetters(ids, letters);
            const gap = window.BananaRules.TILE_GAP;
            const y0 = 2200;
            const tiles = [
                { id: ids[0], letter: 'C', x: originX, y: y0, faceUp: true },
                { id: ids[1], letter: 'A', x: originX, y: y0 + gap, faceUp: true },
                { id: ids[2], letter: 'T', x: originX, y: y0 + gap * 2, faceUp: true },
                { id: ids[3], letter: 'T', x: originX + gap, y: y0 + gap, faceUp: true }
            ];
            if (typeof g._hostSetPlayerTiles === 'function') {
                g._hostSetPlayerTiles(uid, tiles, true, { allowTilesToOwned: true, source: 'last-bunch-win' });
            } else {
                g._hostEnsureMpStores?.();
                g._mpOwned[uid] = tiles.map((t) => ({ id: t.id, faceUp: true }));
                if (!g._mpPlayerLayouts) g._mpPlayerLayouts = {};
                g._mpPlayerLayouts[uid] = Object.fromEntries(tiles.map((t) => [t.id, { x: t.x, y: t.y }]));
                if (uid === g._myUid()) {
                    g.tiles = g._mpHydrateTiles?.(tiles) || tiles;
                }
            }
            const hand = uid === g._myUid() ? g.tiles : tiles;
            const grid = window.BananaGrid.validateGrid(hand, g._checker);
            const placed = window.BananaGrid.allTilesPlacedInGrid(
                hand,
                { x: g.ORIGIN, y: g.ORIGIN },
                {
                    cols: window.BananaRules.COLS,
                    gap: window.BananaRules.TILE_GAP,
                    tileSize: window.BananaRules.TILE_SIZE,
                    handBelowCenter: window.BananaRules.HAND_BELOW_CENTER,
                    handSize: window.BananaRules.startingHandSize(2)
                }
            );
            return { ok: placed && grid.ok, placed, valid: grid.ok, words: grid.words || [] };
        };

        const hostGrid = buildWinGridTiles(hostUid, g.ORIGIN);
        const guestGrid = buildWinGridTiles(guestUid, g.ORIGIN + 600);
        if (!hostGrid.ok || !guestGrid.ok) {
            return { ok: false, reason: 'grid-setup', hostGrid, guestGrid };
        }

        g._tilePool = [];
        g._lastPeelDraws = null;
        if (typeof g._hostWriteBoard === 'function') {
            g._hostWriteBoard('playing');
        } else {
            g._hostSyncBoard({ immediate: true });
        }
        g.requestRender?.();
        return { ok: true, pool: g._tilePool.length, hostGrid, guestGrid };
    }, { hostUid: HOST_UID, guestUid: GUEST_UID });

    if (!setup?.ok) {
        throw new Error(`last-bunch win setup failed (${JSON.stringify(setup)})`);
    }

    await waitPoolBoth(page1, page2, 0, WAIT_MS);

    const frame2 = await getGameFrame(page2);
    const guestGrid = await frame2.evaluate((fnStr) => {
        const peelGridInFrame = new Function(`return (${fnStr})`)();
        const result = peelGridInFrame();
        window.game._persistMpLayout?.();
        return result;
    }, peelGridInFrame.toString());
    if (!guestGrid?.placed || !guestGrid?.valid) {
        throw new Error(`last-bunch guest win grid failed (${JSON.stringify(guestGrid)})`);
    }

    log('SUCCESS: last-bunch win setup — complete grids, bunch=0');
    return { frame2, setup };
}

async function triggerPeel(frame, label) {
    return frame.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        const poolBefore = g._tilePool?.length ?? -1;
        const peeled = g._checkPeel();
        return {
            peeled,
            banner: g._bannerText,
            poolAfter: g._tilePool?.length ?? -1,
            poolBefore,
            authBunch: typeof g._mpAuthoritativeBunchLen === 'function'
                ? g._mpAuthoritativeBunchLen()
                : poolBefore
        };
    });
}

module.exports = {
    LAST_BUNCH,
    PARTY_SIZE,
    setupLastBunchPeelReady,
    setupLastBunchWinReady,
    triggerPeel
};
