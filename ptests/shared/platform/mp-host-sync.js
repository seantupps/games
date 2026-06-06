/**
 * Host-authoritative MP sync — flush interactions, publish board, guest mirror.
 * Bananagrams uses interactions.banana; pattern applies to other host-authoritative games.
 */
const { WAIT_MS, captureMpState, captureBothMpStates, timeoutError, getGameFrame } = require('./mp-waits');
const { mpPollMs } = require('../infra/speed-profiles');

async function hostPublishPartyBoard(hostPage) {
    await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?.isHost?.()) return;
        g._hostReconcileOwnedFromRoomBoard?.();
        const board = (typeof RtdbSchema !== 'undefined' && g.roomData)
            ? RtdbSchema.readBoardFromRoom(g.roomData)
            : g.roomData?.global?.board;
        const hands = board?.tilesOwnedByPlayer || {};
        g._getPlayerUids().forEach((uid) => {
            if (g._mpOwned?.[uid]?.length) return;
            if (hands[uid]?.length) g._hostSetOwned(uid, hands[uid], false);
        });
        g._hostSyncBoard?.({ immediate: true });
    });
}

async function syncGuestInventoryToHost(hostPage, guestPage, guestUid) {
    const deadline = Date.now() + WAIT_MS;
    let tiles = [];
    while (Date.now() < deadline) {
        tiles = await guestPage.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return (g?.tiles || []).map((t) => ({
                id: t.id,
                letter: t.letter,
                faceUp: !!t.faceUp,
                x: t.x,
                y: t.y
            }));
        });
        if (tiles.length) break;
        await guestPage.waitForTimeout(80);
    }
    if (!tiles.length) {
        throw new Error('Guest has no tiles to sync to host');
    }
    await hostPage.evaluate(({ uid, tiles: owned }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?.isHost?.()) return;
        const hostLetters = {};
        (g._mpOwned?.[uid] || []).forEach((o) => {
            if (o?.id) hostLetters[o.id] = o.letter;
        });
        const boardOwned = g.roomData?.global?.board?.tilesOwnedByPlayer?.[uid]
            || g.roomData?.state?.board?.tilesOwnedByPlayer?.[uid]
            || [];
        boardOwned.forEach((o) => {
            if (o?.id && hostLetters[o.id] == null) hostLetters[o.id] = o.letter;
        });
        const synced = owned.map((t) => ({
            ...t,
            letter: hostLetters[t.id] ?? t.letter
        }));
        const onGrid = synced.every((t) => typeof t.x === 'number' && typeof t.y === 'number');
        if (onGrid && typeof g._hostSetPlayerTiles === 'function') {
            g._hostSetPlayerTiles(uid, synced, false, { allowTilesToOwned: true });
        } else {
            g._hostSetOwned(uid, synced, false);
        }
    }, { uid: guestUid, tiles });
    await hostPublishPartyBoard(hostPage);
}

async function syncGuestPoolFromHost(hostPage, guestPage) {
    const hostState = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (g?.isHost?.()) {
            return {
                pool: [...(g._tilePool || [])],
                nextTileId: g._nextTileId ?? null
            };
        }
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return {
            pool: Array.isArray(board?.pool) ? [...board.pool] : [...(g?._tilePool || [])],
            nextTileId: board?.nextTileId ?? g?._nextTileId ?? null
        };
    });
    await guestPage.evaluate(({ pool, nextTileId }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g || g.isHost?.()) return;
        g._tilePool = [...pool];
        if (g.roomData?.global?.board) {
            g.roomData.global.board.pool = [...pool];
        }
        if (Number.isFinite(nextTileId)) g._nextTileId = nextTileId;
    }, hostState);
}

async function syncGuestLettersFromHost(hostPage, guestPage, guestUid) {
    const owned = await hostPage.evaluate(({ uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.tilesOwnedByPlayer?.[uid] || g?._mpOwned?.[uid] || [])
            .map((t) => ({ id: t.id, letter: t.letter }));
    }, { uid: guestUid });
    if (!owned.length) return;
    await guestPage.evaluate(({ tiles }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g || g.isHost?.()) return;
        const letterById = {};
        tiles.forEach((t) => { if (t?.id) letterById[t.id] = t.letter; });
        (g.tiles || []).forEach((t) => {
            if (letterById[t.id]) t.letter = letterById[t.id];
        });
        g.requestRender?.();
    }, { tiles: owned });
}

async function syncGuestFromHost(hostPage, guestPage, guestUid) {
    await syncGuestPoolFromHost(hostPage, guestPage);
    await syncGuestLettersFromHost(hostPage, guestPage, guestUid);
    await syncGuestInventoryToHost(hostPage, guestPage, guestUid);
    await flushHostBananaInteractions(hostPage);
}

async function flushHostBananaInteractions(hostPage) {
    await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?.isHost?.()) return;
        g._processBananaInteractions?.(g.roomData?.interactions?.banana);
    });
    await hostPublishPartyBoard(hostPage);
}

/**
 * Stage guest tile positions on the host (_mpPlayerLayouts only — no owned/membership writes).
 * Matches real play where peel/drag banana messages carry layout snapshots.
 */
async function publishGuestLayoutToHost(hostPage, guestPage, guestUid) {
    const layout = await guestPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const out = {};
        (g?.tiles || []).forEach((t) => {
            if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
                out[t.id] = { x: Math.round(t.x), y: Math.round(t.y) };
            }
        });
        return out;
    });
    if (!Object.keys(layout).length) {
        throw new Error('publishGuestLayoutToHost: guest has no positioned tiles');
    }
    await hostPage.evaluate(({ uid, positions }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?.isHost?.()) return;
        g._hostEnsureMpStores?.();
        if (!g._mpPlayerLayouts) g._mpPlayerLayouts = {};
        g._mpPlayerLayouts[uid] = positions;
        if (typeof g._hostSyncBoard === 'function') {
            g._hostSyncBoard({ immediate: true });
        } else if (typeof g._hostWriteBoard === 'function') {
            g._hostWriteBoard('playing');
        }
    }, { uid: guestUid, positions: layout });
}

async function waitGuestDumpResult(guestPage, hostPage, role, beforeIds, mp) {
    const label = `dump result (${role})`;
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        await flushHostBananaInteractions(hostPage);
        const ready = await guestPage.evaluate(({ idList, r }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!(g && g.playerRole === r && g.tiles.length === idList.length + 2);
        }, { idList: beforeIds, r: role });
        if (ready) {
            return guestPage.evaluate((ids) => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                return {
                    count: g.tiles.length,
                    netPlusTwo: g.tiles.length === ids.length + 2
                };
            }, beforeIds);
        }
        await guestPage.waitForTimeout(mpPollMs());
    }
    const frame = await getGameFrame(guestPage);
    const detail = await frame.evaluate(({ idList, r }) => {
        const g = window.game;
        const idSet = new Set(idList);
        return {
            role: g.playerRole,
            wantRole: r,
            before: idList.length,
            after: g.tiles.length,
            added: g.tiles.filter((t) => !idSet.has(t.id)).length
        };
    }, { idList: beforeIds, r: role });
    const snaps = await captureBothMpStates(mp.page1, mp.page2, label);
    throw timeoutError(label, WAIT_MS, { ...snaps, dumpDetail: detail }, 'guest dump not applied');
}

async function waitDumpResult(page, role, beforeIds, mpPages = null) {
    if (!Array.isArray(beforeIds) || !beforeIds.length) {
        throw new Error('waitDumpResult: missing beforeIds');
    }
    const label = `dump result (${role})`;
    const frame = await getGameFrame(page);
    try {
        await frame.waitForFunction(({ idList, r }) => {
            const g = window.game;
            if (!g || g.playerRole !== r || !idList?.length) return false;
            return g.tiles.length === idList.length + 2;
        }, { idList: beforeIds, r: role }, { timeout: WAIT_MS });
    } catch (err) {
        const snaps = mpPages?.page1 && mpPages?.page2
            ? await captureBothMpStates(mpPages.page1, mpPages.page2, label)
            : { label, target: await captureMpState(page, label) };
        const detail = await frame.evaluate(({ idList, r }) => {
            const g = window.game;
            if (!g) return { error: 'no game' };
            const idSet = new Set(idList);
            const added = g.tiles.filter((t) => !idSet.has(t.id));
            return {
                role: g.playerRole,
                wantRole: r,
                before: idList.length,
                after: g.tiles.length,
                added: added.length,
                addedIds: added.map((t) => t.id)
            };
        }, { idList: beforeIds, r: role });
        throw timeoutError(label, WAIT_MS, { ...snaps, dumpDetail: detail }, err.message);
    }
    return frame.evaluate((ids) => {
        const g = window.game;
        const idSet = new Set(ids);
        const drawnOnly = g.tiles.filter((t) => !idSet.has(t.id));
        return {
            count: drawnOnly.length,
            after: g.tiles.length,
            netPlusTwo: g.tiles.length === ids.length + 2
        };
    }, beforeIds);
}

module.exports = {
    hostPublishPartyBoard,
    syncGuestInventoryToHost,
    syncGuestPoolFromHost,
    syncGuestLettersFromHost,
    syncGuestFromHost,
    flushHostBananaInteractions,
    publishGuestLayoutToHost,
    waitGuestDumpResult,
    waitDumpResult
};