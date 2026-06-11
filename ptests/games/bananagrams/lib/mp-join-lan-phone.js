/**
 * 2p invite join matching npm run phone:lan:urls:
 *   host (PC)  → http://127.0.0.1:8000/?room=lobby&firebase=emulator
 *   guest      → http://<LAN-IP>:8000/?room=lobby&firebase=emulator
 */
const { buildHubUrl } = require('../../../shared/infra/emulator-utils');
const { DESKTOP_VIEWPORT } = require('../../../shared/infra/viewport-constants');
const { getLanIpv4, buildLanGameUrl } = require('../../../../scripts/dev/lan-urls');
const { waitForDbConnected } = require('../../../shared/infra/rtdb-waits');
const {
    prepareInviteHost,
    inviteGuestIntoParty,
    waitForRoomMembers
} = require('../../../shared/infra/hub-party');
const GameRegistry = require('../../../../shared/games/registry');
const { BANANA_2P_PLAYERS } = require('./mp-ctx');
const { log, WAIT_MS } = require('./mp-state');
const { waitJoinedPlayersReady2p } = require('./mp-join');
const { withTimeout } = require('../../../platform/mobile/lib/mobile-timeouts');

const GAME_ID = 'bananagrams';

function resolveLanGuestIp() {
    const detected = getLanIpv4();
    if (!detected) {
        throw new Error('LAN guest IP unknown — run npm run phone:lan:urls and use that Wi‑Fi IPv4');
    }
    return detected;
}

/** PC host viewport + mobile guest (matches LAN play: desktop + phone). */
async function applyPcHostMobileGuest(page1, page2) {
    await page1.setViewportSize(DESKTOP_VIEWPORT);
    await page1.evaluate(() => {
        document.documentElement.classList.remove('five-mobile');
        window.FiveViewport?.syncHubViewport?.();
    });
    await page2.evaluate(() => window.FiveViewport?.syncHubViewport?.());
}

async function openLanPhoneLobby(page, lanIp) {
    const url = buildLanGameUrl(lanIp, 'lobby');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: WAIT_MS });
    await page.waitForFunction(() => window.HubApp?.ctx?.enterPartyRoom, { timeout: WAIT_MS });
    return url;
}

async function openHubLobby(page) {
    const url = buildHubUrl('lobby');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: WAIT_MS });
    await page.waitForFunction(() => window.HubApp?.ctx?.enterPartyRoom, { timeout: WAIT_MS });
    return url;
}

/**
 * Desktop host on 127.0.0.1, mobile guest on LAN IP (same query string as real phone).
 */
async function joinBananaPartyLanPhoneGuest(page1, page2, roomId, opts = {}) {
    const logFn = opts.log || log;
    const gameMode = GameRegistry.hubModeFor(GAME_ID, true);
    const joinCapMs = WAIT_MS * 8;
    const lanIp = resolveLanGuestIp();

    await withTimeout((async () => {
        logFn(`LAN join: PC host 127.0.0.1, mobile guest ${lanIp} → ${roomId}...`);

        page1.setDefaultTimeout(WAIT_MS);
        page2.setDefaultTimeout(WAIT_MS);

        await applyPcHostMobileGuest(page1, page2);

        await Promise.all([page1, page2].map((p, i) => p.addInitScript(({ uid, name, color }) => {
            sessionStorage.setItem('game_uid', uid);
            sessionStorage.setItem('username', name);
            sessionStorage.setItem('userColor', color);
            window.__FIVE_TEST_MODE__ = true;
        }, BANANA_2P_PLAYERS[i])));

        logFn('LAN join: loading lobbies (parallel)...');
        const [hostUrl, guestUrl] = await Promise.all([
            openHubLobby(page1),
            openLanPhoneLobby(page2, lanIp)
        ]);
        logFn(`LAN join: host ${hostUrl}`);
        logFn(`LAN join: guest ${guestUrl}`);

        logFn('LAN join: waiting RTDB connected...');
        await Promise.all([
            waitForDbConnected(page1, 'host 127.0.0.1'),
            waitForDbConnected(page2, `guest LAN ${lanIp}`)
        ]);
        await Promise.all([
            page1.evaluate(() => window.NetworkEngine.updatePresence()),
            page2.evaluate(() => window.NetworkEngine.updatePresence())
        ]);

        const [host, guest] = BANANA_2P_PLAYERS;
        logFn('LAN join: host prepare + invite...');
        await prepareInviteHost(page1, roomId, GAME_ID, gameMode);
        await waitForRoomMembers(page1, roomId, 1);
        await inviteGuestIntoParty(page1, page2, host, guest, roomId, GAME_ID, gameMode);

        await waitJoinedPlayersReady2p([page1, page2], [0, 1], roomId, 'LAN phone invite', opts);
        logFn(`SUCCESS: LAN phone join in ${roomId}.`);
    })(), joinCapMs, 'LAN phone join');
}

module.exports = {
    joinBananaPartyLanPhoneGuest,
    openLanPhoneLobby,
    applyPcHostMobileGuest,
    resolveLanGuestIp
};
