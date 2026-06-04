/**
 * Mobile MP extras: lobby visibility, invite toast, turn indicator, piles sync.
 */
const { buildHubUrl, buildAppUrl } = require('../../../shared/infra/emulator-utils');
const { createMobileContext } = require('../lib/mobile-utils');
const { gotoHub, waitForNetwork, waitForGameFrame, withTimeout } = require('../lib/mobile-timeouts');
const { MP_INVITE_MS } = require('../lib/mobile-constants');
const INVITE_MS = MP_INVITE_MS;
const {
    assertNaturalMobileViewport,
    assertLobbyPlayerVisibility,
    assertTurnIndicatorVisible
} = require('../lib/mobile_assertions');

async function setupPlayer(page, uid, name, color) {
    await page.addInitScript(({ id, n, c }) => {
        sessionStorage.setItem('game_uid', id);
        sessionStorage.setItem('username', n);
        sessionStorage.setItem('userColor', c);
    }, { id: uid, n: name, c: color });
}

async function runMobileInviteParty(browser, pair = null) {
    const roomId = `MP_INV_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const uidHost = 'u_mob_host';
    const uidGuest = 'u_mob_guest';
    const nameHost = 'MobHost';
    const nameGuest = 'MobGuest';

    const ownPair = !pair;
    if (!pair) {
        const a = await createMobileContext(browser);
        const b = await createMobileContext(browser);
        pair = { context1: a.context, page1: a.page, context2: b.context, page2: b.page };
    }
    const { context1: c1, context2: c2, page1, page2 } = pair;

    try {
        await setupPlayer(page1, uidHost, nameHost, '#3b82f6');
        await setupPlayer(page2, uidGuest, nameGuest, '#ef4444');

        await gotoHub(page1, buildHubUrl('lobby'));
        await gotoHub(page2, buildHubUrl('lobby'));
        await Promise.all([waitForNetwork(page1), waitForNetwork(page2)]);
        await assertNaturalMobileViewport(page1);
        await assertNaturalMobileViewport(page2);

        await assertLobbyPlayerVisibility(page1, page2, nameHost, nameGuest);
        console.log('[MOBILE] Lobby player visibility OK');

        await withTimeout(
            page1.evaluate(({ targetUid, roomId }) => {
                return window.NetworkEngine.prepareInviteRoom(roomId, 'piles', 'classic').then((prepared) => {
                    if (!prepared) throw new Error('prepareInviteRoom failed');
                    window.NetworkEngine.sendInvite(
                        targetUid,
                        { game: 'piles', mode: 'classic', roomId },
                        (acceptedRoomId) => {
                            window.HubApp.ctx.enterPartyRoom(acceptedRoomId, {
                                role: 'P1',
                                game: 'piles',
                                mode: 'classic',
                                skipJoin: true
                            });
                        }
                    );
                });
            }, { targetUid: uidGuest, roomId }),
            INVITE_MS,
            'send invite'
        );

        const hostStillLobby = await page1.evaluate(() => {
            const r = new URL(location.href).searchParams.get('room');
            return r === 'lobby' || !r;
        });
        if (!hostStillLobby) {
            throw new Error('Host should stay in lobby until invite is accepted');
        }

        await withTimeout(
            page2.waitForSelector('#invite-toast.show', { timeout: INVITE_MS }),
            INVITE_MS,
            'invite toast'
        );

        await withTimeout(page2.locator('#btn-accept-invite').tap(), INVITE_MS, 'accept invite');
        await withTimeout(
            Promise.all([
                page1.waitForFunction(
                    ({ r }) => new URL(location.href).searchParams.get('room') === r,
                    { r: roomId },
                    { timeout: INVITE_MS }
                ),
                page2.waitForFunction(
                    ({ r }) => new URL(location.href).searchParams.get('room') === r,
                    { r: roomId },
                    { timeout: INVITE_MS }
                ),
                page1.waitForFunction(
                    () => window.NetworkEngine?.roomId && window.NetworkEngine.roomId !== 'lobby',
                    { timeout: INVITE_MS }
                )
            ]),
            INVITE_MS,
            'both transported to room after accept'
        );
        console.log('[MOBILE] Invite accept OK');

        await Promise.all([waitForGameFrame(page1), waitForGameFrame(page2)]);
        await Promise.all([waitForGameFrame(page1), waitForGameFrame(page2)]);

        await assertTurnIndicatorVisible(page1);
        await assertTurnIndicatorVisible(page2);
        console.log('[MOBILE] Turn indicator OK');

        await Promise.all([waitForGameFrame(page1), waitForGameFrame(page2)]);
        const [p1Keys, p2Keys] = await Promise.all([
            page1.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                if (!g?.piles) return '';
                return Object.keys(g.piles).sort().join(',');
            }),
            page2.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                if (!g?.piles) return '';
                return Object.keys(g.piles).sort().join(',');
            })
        ]);
        if (!p1Keys || !p2Keys) throw new Error('Piles game not ready for board sync check');
        if (p1Keys !== p2Keys) throw new Error(`Piles board desync: ${p1Keys} vs ${p2Keys}`);
        console.log('[MOBILE] Piles board sync OK');

        await Promise.all([
            page1.waitForFunction(
                () =>
                    getComputedStyle(document.documentElement).getPropertyValue('--opponent-color')
                        .trim()
                        .toLowerCase() === '#ef4444',
                { timeout: INVITE_MS }
            ),
            page2.waitForFunction(
                () =>
                    getComputedStyle(document.documentElement).getPropertyValue('--opponent-color')
                        .trim()
                        .toLowerCase() === '#3b82f6',
                { timeout: INVITE_MS }
            )
        ]);
        console.log('[MOBILE] MP opponent colors OK');
    } finally {
        if (ownPair) {
            await c1.close().catch(() => {});
            await c2.close().catch(() => {});
        }
    }
}

module.exports = { runMobileInviteParty };
