/**
 * Generalized hub party setup — 2..N players, desktop/mobile/mixed topologies.
 */
const { buildAppUrl, buildHubUrl } = require('./emulator-utils');
const { STEP_MS } = require('./timeouts');
const { createAuditSession } = require('./audit-session');
const GameRegistry = require('../../../shared/games/registry');

const WAIT_MS = Number(process.env.FIVE_MP_PARTY_MS || STEP_MS);
/** Cap each in-page Firebase .once() so evaluate cannot hang past step timeout. */
const RTDB_OP_CAP_MS = Math.max(400, WAIT_MS - 150);

/**
 * @typedef {object} PartyPlayerDef
 * @property {string} uid
 * @property {string} name
 * @property {string} color
 * @property {string} role — P1, P2, P3, ...
 */

/**
 * @param {import('playwright').Page} page
 * @param {PartyPlayerDef} player
 */
async function setPlayerIdentity(page, player) {
    await page.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
    }, { uid: player.uid, name: player.name, color: player.color });
}

async function openHubLobby(page) {
    await page.goto(buildHubUrl('lobby'), { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: WAIT_MS });
    await page.waitForFunction(() => window.HubApp?.ctx?.enterPartyRoom, { timeout: WAIT_MS });
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {string} roomId
 * @param {string} gameId
 * @param {string} gameMode
 */
async function prepareInviteHost(hostPage, roomId, gameId, gameMode) {
    const hubMode = GameRegistry.hubModeFor(gameId, true);
    const mode = gameMode || hubMode;
    const prepared = await hostPage.evaluate(async ({ rId, gId, gMode, hubModeVal }) => {
        window.HubApp.ctx.currentGame = gId;
        window.HubApp.ctx.gameMode = gMode;
        localStorage.setItem(`${gId}_mode`, gMode);
        if (hubModeVal) localStorage.setItem(`${gId}_mode`, hubModeVal);
        return window.NetworkEngine.prepareInviteRoom(rId, gId, gMode);
    }, { rId: roomId, gId: gameId, gMode: mode, hubModeVal: hubMode });
    if (!prepared) throw new Error('prepareInviteRoom failed');

    const ok = await hostPage.evaluate(async ({ rId, gId, gMode, cap }) => {
        const race = (p) => Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error('rtdb-timeout')), cap))
        ]);
        try {
            return await race(window.HubApp.ctx.enterPartyRoom(rId, {
                role: 'P1',
                game: gId,
                mode: gMode,
                skipJoin: true
            }));
        } catch (_) {
            return false;
        }
    }, { rId: roomId, gId: gameId, gMode: mode, cap: RTDB_OP_CAP_MS });
    if (ok === false) throw new Error('Host failed to enter party room');
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 * @param {PartyPlayerDef} host
 * @param {PartyPlayerDef} guest
 * @param {string} roomId
 * @param {string} gameId
 * @param {string} gameMode
 */
async function inviteGuestIntoParty(hostPage, guestPage, host, guest, roomId, gameId, gameMode) {
    const mode = gameMode || GameRegistry.hubModeFor(gameId, true);
    await hostPage.evaluate(({ targetUid, rId, gId, gMode }) => {
        window.NetworkEngine.sendInvite(targetUid, { game: gId, mode: gMode, roomId: rId });
    }, { targetUid: guest.uid, rId: roomId, gId: gameId, gMode: mode });

    const ok = await guestPage.evaluate(async ({ hostUid, rId, gId, gMode, role, cap }) => {
        const race = (p) => Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error('rtdb-timeout')), cap))
        ]);
        try {
            const accepted = await race(window.NetworkEngine.acceptInvite(hostUid, rId));
            if (!accepted?.ok) return false;
            return await race(window.HubApp.ctx.enterPartyRoom(rId, {
                role,
                game: gId,
                mode: gMode,
                skipJoin: true
            }));
        } catch (_) {
            return false;
        }
    }, {
        hostUid: host.uid,
        rId: roomId,
        gId: gameId,
        gMode: mode,
        role: guest.role,
        cap: RTDB_OP_CAP_MS
    });
    if (ok === false) {
        throw new Error(`${guest.role} failed to accept invite / enter party room`);
    }
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {string} roomId
 * @param {number} count
 */
async function waitForRoomMembers(hostPage, roomId, count) {
    await hostPage.waitForFunction(
        async ({ rId, n, cap }) => {
            const db = window.NetworkEngine?.db;
            if (!db) return false;
            try {
                const snap = await Promise.race([
                    db.ref(`games/${rId}`).once('value'),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('rtdb-timeout')), cap))
                ]);
                return window.NetworkEngine.countRoomMembers(snap.val()) === n;
            } catch (_) {
                return false;
            }
        },
        { rId: roomId, n: count, cap: RTDB_OP_CAP_MS },
        { timeout: WAIT_MS }
    );
}

/**
 * Sequential invite: host in room, then each guest index in order.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} options
 * @param {string} options.gameId
 * @param {string} [options.gameMode]
 * @param {string} [options.roomId]
 * @param {PartyPlayerDef[]} options.players — length >= 2, index 0 = host
 * @param {number[]} [options.guestOrder] — indices into players (excluding 0)
 * @param {'desktop'|'mobile'|'mixed'} [options.topology]
 * @param {('desktop'|'mobile')[]} [options.mixedLayout]
 * @returns {Promise<{ roomId: string, session: import('./audit-session').AuditSession, cleanup: () => Promise<void> }>}
 */
async function setupHubParty(browser, options = {}) {
    const gameId = options.gameId || 'piles';
    const gameMode = options.gameMode || GameRegistry.hubModeFor(gameId, true) || GameRegistry.defaultModeFor(gameId);
    const players = options.players;
    if (!players?.length || players.length < 2) {
        throw new Error('setupHubParty requires at least 2 players');
    }

    const roomId = options.roomId || `HUB_PARTY_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const topology = options.topology || 'desktop';
    const mixedLayout = options.mixedLayout || [];
    const guestOrder = options.guestOrder ?? players.slice(1).map((_, i) => i + 1);

    const session = await createAuditSession(browser, {
        players: players.length,
        topology,
        mixedLayout
    });

    await Promise.all(session.pages.map((p, i) => setPlayerIdentity(p, players[i])));
    await Promise.all(session.pages.map((p) => openHubLobby(p)));

    const hostPage = session.pages[0];
    const host = players[0];

    await prepareInviteHost(hostPage, roomId, gameId, gameMode);
    await waitForRoomMembers(hostPage, roomId, 1);

    let memberCount = 1;
    for (const guestIdx of guestOrder) {
        const guest = players[guestIdx];
        await inviteGuestIntoParty(hostPage, session.pages[guestIdx], host, guest, roomId, gameId, gameMode);
        memberCount++;
        await waitForRoomMembers(hostPage, roomId, memberCount);
    }

    const cleanup = async () => {
        await session.cleanup();
    };

    return {
        roomId,
        gameId,
        gameMode,
        session,
        pages: session.pages,
        players,
        cleanup
    };
}

/**
 * Navigate all party members to in-room game URLs.
 */
async function gotoPartyGameUrls(party, { waitUntil = 'domcontentloaded' } = {}) {
    const { roomId, gameId, gameMode, session, players } = party;
    await Promise.all(players.map((pl, i) => {
        const url = buildAppUrl(roomId, pl.role, gameId, gameMode);
        return session.pages[i].goto(url, { waitUntil, timeout: WAIT_MS });
    }));
    await Promise.all(session.pages.map((p) => p.waitForSelector('#game-frame', { timeout: WAIT_MS })));
}

module.exports = {
    WAIT_MS,
    setPlayerIdentity,
    openHubLobby,
    prepareInviteHost,
    inviteGuestIntoParty,
    waitForRoomMembers,
    setupHubParty,
    gotoPartyGameUrls
};
