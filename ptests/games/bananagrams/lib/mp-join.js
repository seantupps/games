/**
 * MP room join mechanics — invite flow, join readiness waits (no pass/fail verdicts).
 */
const mpWaits = require('../../../shared/platform/mp-waits');
const {
    openHubLobby,
    prepareInviteHost,
    inviteGuestIntoParty,
    waitForRoomMembers
} = require('../../../shared/infra/hub-party');
const { BANANA_2P_PLAYERS } = require('./mp-ctx');
const { log } = require('./mp-log');

const { WAIT_MS, waitForDiag, timeoutError } = mpWaits;

/**
 * Real hub invite flow — host lobby → invite → accept → both in party room.
 * Scenarios own post-join truth checks (deal.assertHostDealPool, etc.).
 */
async function joinBananaPartyViaInvite(page1, page2, roomId, opts = {}) {
    const logFn = opts.log || log;
    const gameId = 'bananagrams';
    const gameMode = 'multiplayer';
    logFn(`Realistic invite join: host lobby → invite → accept → deal in ${roomId}...`);

    await Promise.all([page1, page2].map((p, i) => p.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
        window.__FIVE_TEST_MODE__ = true;
    }, BANANA_2P_PLAYERS[i])));
    await Promise.all([page1, page2].map((p) => openHubLobby(p)));

    const [host, guest] = BANANA_2P_PLAYERS;
    await prepareInviteHost(page1, roomId, gameId, gameMode);
    await waitForRoomMembers(page1, roomId, 1);
    await inviteGuestIntoParty(page1, page2, host, guest, roomId, gameId, gameMode);

    await page1.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.isMultiplayer && g?.mode === 'multiplayer' && g?.isHost?.();
    }, undefined, { timeout: WAIT_MS });

    await waitJoinedPlayersReady2p([page1, page2], [0, 1], roomId, 'after invite accept', opts);
    logFn(`SUCCESS: Realistic invite join in ${roomId}.`);
}

/**
 * Wait until joined players have dealt hands (mechanical readiness, not truth audit).
 */
async function waitJoinedPlayersReady(pages, playerIndices, roomId, label, opts = {}) {
    const defs = opts.playerDefs || BANANA_2P_PLAYERS;
    const hostPage = pages[0];
    try {
        await waitForRoomMembers(hostPage, roomId, playerIndices.length);
    } catch (err) {
        throw timeoutError(`${label}: room members`, WAIT_MS, null, err.message);
    }

    const mpSnap = { pages };

    await waitForDiag(hostPage, `${label}: host dealt board`, ({ n }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?._dictReady || !g?._checker) return false;
        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const hands = board?.tilesOwnedByPlayer || {};
        return Object.values(hands).filter((h) => h?.length > 0).length >= n;
    }, { n: playerIndices.length }, WAIT_MS, mpSnap);

    for (const idx of playerIndices) {
        const player = defs[idx];
        const page = pages[idx];
        await waitForDiag(page, `${label}: ${player.role} deal`, ({ u }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g
                && g.isMultiplayer
                && g.mode === 'multiplayer'
                && g._dictReady
                && g._checker
                && g.tiles?.length > 0
                && g._myUid?.() === u;
        }, { u: player.uid }, WAIT_MS, mpSnap);
    }
}

async function waitJoinedPlayersReady2p(pages, playerIndices, roomId, label, opts = {}) {
    return waitJoinedPlayersReady(pages, playerIndices, roomId, label, {
        ...opts,
        playerDefs: BANANA_2P_PLAYERS
    });
}

/**
 * Push each remote player's inventory to host authority (N-player).
 * @param {import('./mp-ctx').MpCtx} ctx
 */
async function syncRemotesInventoriesToHost(ctx) {
    const { hostPublishPartyBoard } = require('../../../shared/adapters/mp-client');
    for (const remote of ctx.remotes) {
        const owned = await remote.page.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return (g?.tiles || []).map((t) => ({
                id: t.id,
                letter: t.letter,
                faceUp: !!t.faceUp
            }));
        });
        if (!owned.length) {
            throw new Error(`${remote.role} has no tiles to sync to host`);
        }
        await ctx.host.page.evaluate(({ uid, tiles }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g?.isHost?.()) return;
            g._hostSetOwned(uid, tiles, false);
        }, { uid: remote.uid, tiles: owned });
    }
    await hostPublishPartyBoard(ctx.host.page);
}

module.exports = {
    joinBananaPartyViaInvite,
    waitJoinedPlayersReady,
    waitJoinedPlayersReady2p,
    syncRemotesInventoriesToHost
};
