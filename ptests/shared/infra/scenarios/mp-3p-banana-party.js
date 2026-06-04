/**
 * Bananagrams 3p hub party join — shared session + sequential invites.
 * Game-specific deal/visibility assertions stay in mp_bananagrams_3p.js.
 */
const { createAuditSession } = require('../audit-session');
const {
    setPlayerIdentity,
    openHubLobby,
    prepareInviteHost,
    inviteGuestIntoParty,
    waitForRoomMembers
} = require('../hub-party');

const BANANA_GAME_ID = 'bananagrams';
const BANANA_GAME_MODE = 'multiplayer';

const BANANA_3P_PLAYERS = [
    { uid: 'u_banana_p1', name: 'BananaP1', color: '#3b82f6', role: 'P1' },
    { uid: 'u_banana_p2', name: 'BananaP2', color: '#ef4444', role: 'P2' },
    { uid: 'u_banana_p3', name: 'BananaP3', color: '#22c55e', role: 'P3' }
];

const BANANA_HOST = BANANA_3P_PLAYERS[0];

/**
 * @param {import('playwright').Browser} browser
 * @param {{ mobileAll?: boolean, p3Mobile?: boolean }} opts
 */
async function createBanana3pSession(browser, opts = {}) {
    const mobileAll = !!opts.mobileAll;
    const p3Mobile = !!opts.p3Mobile;
    const topology = mobileAll ? 'mobile' : (p3Mobile ? 'mixed' : 'desktop');
    const mixedLayout = p3Mobile ? ['desktop', 'desktop', 'mobile'] : [];
    const session = await createAuditSession(browser, {
        players: 3,
        topology,
        mixedLayout
    });
    return {
        contexts: session.contexts,
        pages: session.pages,
        session,
        mobilePageIndices: mobileAll ? [0, 1, 2] : (p3Mobile ? [2] : [])
    };
}

/**
 * Sequential P1 → guests; calls assertJoinedPlayersReady after each join.
 *
 * @param {import('playwright').Page[]} pages
 * @param {string} roomId
 * @param {number[]} guestOrderIndices
 * @param {object} opts
 * @param {(pages: import('playwright').Page[], joined: number[], roomId: string, label: string, opts: object) => Promise<void>} opts.assertJoinedPlayersReady
 * @param {number[]} [opts.mobilePageIndices]
 * @param {(msg: string) => void} [opts.log]
 */
async function joinBananaPartySequentially(pages, roomId, guestOrderIndices, opts = {}) {
    const { assertJoinedPlayersReady, mobilePageIndices = [], log = () => {} } = opts;
    if (typeof assertJoinedPlayersReady !== 'function') {
        throw new Error('joinBananaPartySequentially requires opts.assertJoinedPlayersReady');
    }

    const orderLabel = ['P1', ...guestOrderIndices.map((i) => BANANA_3P_PLAYERS[i].role)].join(' → ');
    log(`Sequential join: ${orderLabel}...`);

    await Promise.all(pages.map((p, i) => setPlayerIdentity(p, BANANA_3P_PLAYERS[i])));
    await Promise.all(pages.map((p) => openHubLobby(p)));

    if (mobilePageIndices.length) {
        const { enableMobileHub } = require('../../../platform/mobile/lib/mobile_assertions');
        for (const i of mobilePageIndices) {
            await enableMobileHub(pages[i]);
            await pages[i].evaluate(() => window.FiveViewport?.syncHubViewport?.());
        }
    }

    const hostPage = pages[0];
    await prepareInviteHost(hostPage, roomId, BANANA_GAME_ID, BANANA_GAME_MODE);
    const joined = [0];
    await assertJoinedPlayersReady(pages, joined, roomId, 'after host', { mobilePageIndices });

    for (const guestIdx of guestOrderIndices) {
        const guest = BANANA_3P_PLAYERS[guestIdx];
        await inviteGuestIntoParty(
            hostPage,
            pages[guestIdx],
            BANANA_HOST,
            guest,
            roomId,
            BANANA_GAME_ID,
            BANANA_GAME_MODE
        );
        await hostPage.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (g?.isHost?.()) g._maybeSetupMultiplayer?.();
        });
        joined.push(guestIdx);
        await assertJoinedPlayersReady(
            pages,
            joined,
            roomId,
            `after ${guest.role} join`,
            { mobilePageIndices }
        );
    }

    log(`SUCCESS: Sequential join ${orderLabel}.`);
}

module.exports = {
    BANANA_GAME_ID,
    BANANA_GAME_MODE,
    BANANA_3P_PLAYERS,
    BANANA_HOST,
    createBanana3pSession,
    joinBananaPartySequentially,
    waitForRoomMembers
};
