/**
 * Last-bunch peel sync — pool=partySize (2 in 2p) must drain to 0 on host AND guest
 * without flush/retry masking. Catches manual bugs: bunch stuck at 2, guest desync, win blocked.
 */
const {
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    log,
    waitForDiag,
    flushHostBananaInteractions,
    enableFastBanners,
    getGameFrame,
    joinBananaPartyViaInvite,
    assertHostDealPool,
    EXPECTED_MP_2P_POOL,
    readPoolSyncState,
    assertPoolSyncedBothStrict,
    assertPoolSyncedBothNatural,
    waitPoolBoth,
    captureBothMpStates,
    mpVictoryWaitMs,
    mpReviewWaitMs
} = require('../lib/mp-lib');
const { bootMpPlaySession } = require('../desktop-mp/audit/mp-play-boot');
const { peelGridInFrame } = require('../assertions/bananagrams_peel_fixture');
const {
    assertActionsReviewPersists,
    assertActionsWinBanner
} = require('../desktop-mp/audit/mp-ai-playthrough');
const {
    assertGuestReviewVisibleWithoutInteraction,
    waitMpClientsInReview
} = require('../assertions/bananagrams_postgame_assertions');
const { assertHubWinBannerVisibleSameTime } = require('../assertions/bananagrams_mp_win_banner_sync_assertions');

const LAST_BUNCH = 2;
const PARTY_SIZE = 2;

/** Host: 3-letter checker + peel-ready CAT grids for both players + bunch=2. */
async function setupLastBunchPeelReady(frame1, page1, page2, mp) {
    const frame2 = await getGameFrame(page2);
    await Promise.all([frame1, frame2].map((f) => f.evaluate(() => {
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
    await assertPoolSyncedBothStrict(page1, page2, LAST_BUNCH, 'last-bunch pre-peel bunch=2');

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
    await assertPoolSyncedBothStrict(page1, page2, 0, 'last-bunch pre-win bunch=0');

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

const LAST_BUNCH_TILES_PER_PLAYER = 4;

async function assertBothClientsEnterReviewImmediate(pages, frames, mp, label) {
    const reviewMs = Math.min(mpReviewWaitMs(), 2500);
    await waitMpClientsInReview(frames, `${label} in-review`, reviewMs, pages);
    await Promise.all(pages.map((p, i) =>
        assertGuestReviewVisibleWithoutInteraction(
            p, `${label} P${i + 1} immediate`, 2, LAST_BUNCH_TILES_PER_PLAYER
        )));
    log(`SUCCESS: ${label} — both clients in review immediately`);
}

async function runLastBunchGuestWinReviewTests(page1, page2, frame1, frame2, mp) {
    log('Last-bunch: guest win at pool=0 — hub banner + review must appear on both clients...');
    const winSetup = await setupLastBunchWinReady(frame1, page1, page2);
    frame2 = winSetup.frame2 || frame2;

    const winLabel = 'last-bunch guest win';
    await assertHubWinBannerVisibleSameTime({
        page1,
        page2,
        label: `${winLabel} hub win banner`,
        maxSkewMs: 350,
        timeoutMs: Math.min(mpVictoryWaitMs(), 3500),
        assertLayout: false,
        triggerWin: async () => {
            const claimed = await frame2.evaluate(() => {
                window.game._bannerText = '';
                return window.game._checkPeel();
            });
            if (!claimed) {
                throw new Error(`${winLabel}: guest _checkPeel did not claim win at pool=0`);
            }
        }
    });

    await assertBothClientsEnterReviewImmediate([page1, page2], [frame1, frame2], mp, winLabel);
    await assertActionsWinBanner([page1, page2], `${winLabel} hub win banner persisted`);
    await assertActionsReviewPersists(
        [frame1, frame2], [page1, page2], mp, winLabel, { minTilesPerOwner: LAST_BUNCH_TILES_PER_PLAYER }
    );
    log('SUCCESS: last-bunch guest win — banner + review persisted on host and guest');
}

async function readPeelSeq(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return board?.peelSeq || 0;
    });
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

async function assertPeelDrainedStrict(hostPage, guestPage, label) {
    await assertPoolSyncedBothNatural(hostPage, guestPage, 0, `${label} immediate`, 150);
    log(`SUCCESS: ${label} — bunch=0 synced host+guest (strict, no flush)`);
}

async function assertWinBlockedOnGuestWhenDesynced(guestPage, guestFrame, label) {
    const guestState = await readPoolSyncState(guestPage);
    if (guestState.authBunch === 0 && guestState.localPool === 0) return;

    const blocked = await guestFrame.evaluate(() => {
        const g = window.game;
        const before = !!(g._winnerUid || g._victoryRegistered || g.isOver);
        const hand = typeof g._snapHandForValidation === 'function'
            ? g._snapHandForValidation(g.tiles)
            : g.tiles;
        const allPlaced = typeof g._allTilesPlacedOn === 'function'
            ? g._allTilesPlacedOn(hand)
            : false;
        const gridOk = window.BananaGrid?.validateGrid(hand, g._checker)?.ok;
        const auth = typeof g._mpAuthoritativeBunchLen === 'function'
            ? g._mpAuthoritativeBunchLen()
            : (g._tilePool?.length ?? -1);
        g._bannerText = '';
        const claimed = g._checkPeel();
        const after = !!(g._winnerUid || g._victoryRegistered || g.isOver);
        return {
            claimed,
            before,
            after,
            authBunch: auth,
            allPlaced,
            gridOk,
            won: after && !before
        };
    });

    if (blocked.won) {
        throw new Error(
            `${label}: guest claimed win while bunch authority=${guestState.authBunch} `
            + `(local=${guestState.localPool}, board=${guestState.boardPool}) `
            + `${JSON.stringify(blocked)}`
        );
    }
    log(`${label}: guest win correctly blocked while bunch authority=${guestState.authBunch}`);
}

/**
 * @param {import('playwright').Page} page1 host
 * @param {import('playwright').Page} page2 guest
 * @param {import('playwright').Frame} frame1
 * @param {import('playwright').Frame} frame2
 * @param {{ page1: import('playwright').Page, page2: import('playwright').Page }} mp
 * @param {{ includeGuestWin?: boolean }} [options]
 */
async function runLastBunchPeelTests(page1, page2, frame1, frame2, mp, options = {}) {
    log('Last-bunch: host peel at bunch=2 must drain to 0 on both clients...');
    await setupLastBunchPeelReady(frame1, page1, page2, mp);

    const peelSeqBefore = await readPeelSeq(page1);
    const hostPeel = await triggerPeel(frame1, 'host last-bunch peel');
    if (!hostPeel.peeled) {
        throw new Error(`host last-bunch peel failed (${JSON.stringify(hostPeel)})`);
    }
    if (hostPeel.poolBefore !== LAST_BUNCH) {
        throw new Error(`host peel expected poolBefore=${LAST_BUNCH}, got ${hostPeel.poolBefore}`);
    }
    if (hostPeel.poolAfter !== 0) {
        throw new Error(`host peel did not drain local pool in-frame (${JSON.stringify(hostPeel)})`);
    }

    await waitForDiag(page2, 'host last-bunch peel seq on guest', ({ seq, uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
    }, { seq: peelSeqBefore, uid: HOST_UID }, WAIT_MS, mp);

    await assertPeelDrainedStrict(page1, page2, 'host last-bunch peel');

    const postHostPeel = await captureBothMpStates(page1, page2, 'after host last-bunch peel');
    const hostOwned = postHostPeel.host.ownedLen ?? 0;
    const guestOwned = postHostPeel.guest.ownedLen ?? 0;
    if (hostOwned !== 5 || guestOwned !== 5) {
        throw new Error(
            `last-bunch host peel accounting: expected 5 owned each (4 grid + 1 peel), `
            + `got host=${hostOwned} guest=${guestOwned}\n${JSON.stringify(postHostPeel, null, 2)}`
        );
    }

    log('Last-bunch: re-setup and guest peel at bunch=2...');
    await setupLastBunchPeelReady(frame1, page1, page2, mp);
    await flushHostBananaInteractions(page1);

    const guestPeelSeqBefore = await readPeelSeq(page1);
    const guestPeel = await triggerPeel(frame2, 'guest last-bunch peel');
    if (!guestPeel.peeled) {
        const guestDiag = await page2.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const grid = document.getElementById('game-frame')?.contentWindow?.BananaGrid;
            const hand = typeof g?._snapHandForValidation === 'function'
                ? g._snapHandForValidation(g.tiles)
                : g?.tiles;
            const result = grid?.validateGrid(hand, g?._checker);
            return {
                tiles: g?.tiles?.length ?? 0,
                pool: g?._tilePool?.length ?? -1,
                auth: typeof g?._mpAuthoritativeBunchLen === 'function'
                    ? g._mpAuthoritativeBunchLen() : null,
                allPlaced: typeof g?._allTilesPlacedOn === 'function'
                    ? g._allTilesPlacedOn(hand) : null,
                gridOk: !!result?.ok
            };
        });
        throw new Error(`guest last-bunch peel failed (${JSON.stringify({ guestPeel, guestDiag })})`);
    }

    await flushHostBananaInteractions(page1);
    await waitForDiag(page1, 'guest last-bunch peel on host', ({ seq, uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
    }, { seq: guestPeelSeqBefore, uid: GUEST_UID }, WAIT_MS, mp);

    await assertPeelDrainedStrict(page1, page2, 'guest last-bunch peel');

    log('Last-bunch: verify guest cannot win while perceiving stale bunch...');
    const guestSnap = await readPoolSyncState(page2);
    if (guestSnap.authBunch > 0) {
        await assertWinBlockedOnGuestWhenDesynced(page2, frame2, 'last-bunch guest win guard');
    }

    log('SUCCESS: last-bunch peel sync audit — host + guest peels drain bunch=2→0 on both clients');

    if (options.includeGuestWin !== false) {
        await runLastBunchGuestWinReviewTests(page1, page2, frame1, frame2, mp);
    }
}

/**
 * @param {import('playwright').Page} page1 host
 * @param {import('playwright').Page} page2 guest
 * @param {{ roomId?: string, mobile?: boolean, skipSeed?: boolean }} [options]
 */
async function runLastBunchPeelSyncAudit(page1, page2, options = {}) {
    const roomId = options.roomId || `MP_LAST_BUNCH_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const mp = { page1, page2 };

    if (!options.skipSeed) {
        await joinBananaPartyViaInvite(page1, page2, roomId);
        await assertHostDealPool(page1, EXPECTED_MP_2P_POOL, 'last-bunch host deal bunch', mp);
    }

    const { frame1, frame2 } = await bootMpPlaySession(page1, page2, { mobile: !!options.mobile });
    await Promise.all([enableFastBanners(frame1), enableFastBanners(frame2)]);

    await runLastBunchPeelTests(page1, page2, frame1, frame2, mp, {
        includeGuestWin: options.includeGuestWin !== false
    });
}

module.exports = {
    LAST_BUNCH,
    PARTY_SIZE,
    runLastBunchPeelSyncAudit,
    runLastBunchPeelTests,
    runLastBunchGuestWinReviewTests,
    setupLastBunchPeelReady,
    setupLastBunchWinReady,
    assertPoolSyncedBothStrict,
    assertPeelDrainedStrict
};
