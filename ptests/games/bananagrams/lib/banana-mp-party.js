/**
 * Bananagrams MP hub party — session creation + sequential invite join.
 */
const { createAuditSession } = require('../../../shared/infra/audit-session');
const {
    setPlayerIdentity,
    openHubLobby,
    prepareInviteHost,
    inviteGuestIntoParty
} = require('../../../shared/infra/hub-party');
const { bananaPlayerDefs } = require('./mp-ctx');

const BANANA_GAME_ID = 'bananagrams';
const BANANA_GAME_MODE = 'multiplayer';

/**
 * @param {import('playwright').Browser} browser
 * @param {{ playerCount?: number, mobileAll?: boolean, p3Mobile?: boolean }} opts
 */
async function createBananaMpSession(browser, opts = {}) {
    const playerCount = opts.playerCount ?? 3;
    const mobileAll = !!opts.mobileAll;
    const p3Mobile = !!opts.p3Mobile;
    const topology = mobileAll ? 'mobile' : (p3Mobile ? 'mixed' : 'desktop');
    const mixedLayout = p3Mobile
        ? Array.from({ length: playerCount }, (_, i) => (i === playerCount - 1 ? 'mobile' : 'desktop'))
        : [];
    const session = await createAuditSession(browser, {
        players: playerCount,
        topology,
        mixedLayout
    });
    return {
        contexts: session.contexts,
        pages: session.pages,
        session,
        mobilePageIndices: mobileAll
            ? session.pages.map((_, i) => i)
            : (p3Mobile ? [playerCount - 1] : [])
    };
}

/**
 * Sequential P1 → guests; calls waitJoinedPlayersReady after each join.
 *
 * @param {import('playwright').Page[]} pages
 * @param {string} roomId
 * @param {number[]} guestOrderIndices
 * @param {object} opts
 * @param {(pages: import('playwright').Page[], joined: number[], roomId: string, label: string, opts: object) => Promise<void>} opts.waitJoinedPlayersReady
 * @param {number[]} [opts.mobilePageIndices]
 * @param {(msg: string) => void} [opts.log]
 */
async function joinBananaPartySequentially(pages, roomId, guestOrderIndices, opts = {}) {
    const { waitJoinedPlayersReady, mobilePageIndices = [], log = () => {} } = opts;
    const playerDefs = opts.playerDefs || bananaPlayerDefs(pages.length);
    if (typeof waitJoinedPlayersReady !== 'function') {
        throw new Error('joinBananaPartySequentially requires opts.waitJoinedPlayersReady');
    }

    const orderLabel = ['P1', ...guestOrderIndices.map((i) => playerDefs[i].role)].join(' → ');
    log(`Sequential join: ${orderLabel}...`);

    await Promise.all(pages.map((p, i) => setPlayerIdentity(p, playerDefs[i])));
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
    await waitJoinedPlayersReady(pages, joined, roomId, 'after host', { mobilePageIndices });

    for (const guestIdx of guestOrderIndices) {
        const guest = playerDefs[guestIdx];
        await inviteGuestIntoParty(
            hostPage,
            pages[guestIdx],
            playerDefs[0],
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
        await waitJoinedPlayersReady(
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
    createBananaMpSession,
    joinBananaPartySequentially
};
