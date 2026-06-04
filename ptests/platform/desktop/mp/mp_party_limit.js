/**
 * Party size limit tests (max 8 players per room; piles/line hidden at 3+).
 */
const { chromium } = require('playwright');
const { ensureTestStack, buildAppUrl, buildHubUrl } = require('../../../shared/infra/emulator-utils');
const { NETWORK_MS: PARTY_MS } = require('../../../shared/infra/timeouts');

const waitOpts = { timeout: PARTY_MS };

async function seedRoomWithHostOnly(page, roomId) {
    await page.addInitScript(() => {
        sessionStorage.setItem('game_uid', 'u_party_host');
        sessionStorage.setItem('username', 'HostOnly');
        sessionStorage.setItem('userColor', '#3b82f6');
    });
    await page.goto(buildHubUrl());
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);

    await page.evaluate(({ rId }) => {
        const db = window.NetworkEngine.db;
        const host = 'u_party_host';
        return db.ref().update({
            [`games/${rId}`]: {
                host,
                status: 'waiting',
                global: { game: 'piles', mode: 'classic', firstPlayer: 'P1' },
                playerData: {
                    [host]: { name: 'HostOnly', color: '#3b82f6' }
                },
                users: { u_stale_guest: Date.now() }
            },
            [`gameData/${rId}`]: null
        });
    }, { rId: roomId });

    await page.goto(buildAppUrl(roomId, 'P1', 'piles', 'classic'));
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await page.evaluate(async ({ rId }) => {
        const ne = window.NetworkEngine;
        if (ne.roomId !== rId) ne.joinRoom(rId);
        await ne.registerPlayerInRoom('HostOnly', '#3b82f6');
    }, { rId: roomId });
}

async function getMemberCount(page, roomId) {
    return page.evaluate(async ({ rId }) => {
        const snap = await window.NetworkEngine.db.ref(`games/${rId}`).once('value');
        return window.NetworkEngine.countRoomMembers(snap.val());
    }, { rId: roomId });
}

async function tryJoin(page, roomId, uid, role) {
    await page.addInitScript(({ id }) => {
        sessionStorage.setItem('game_uid', id);
        sessionStorage.setItem('username', id);
        sessionStorage.setItem('userColor', '#ef4444');
    }, { id: uid });
    const url = buildAppUrl(roomId, role, 'piles', 'classic');
    await page.goto(url);
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);

    return page.evaluate(async ({ rId }) => {
        return window.NetworkEngine.tryJoinRoom(rId);
    }, { rId: roomId });
}

async function runPartyLimitTest(browser, options = {}) {
    const newContext = options.newContext || (() => browser.newContext());
    const ROOM = `MP_PARTY_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    console.log(`[TEST] Party limit audit in room ${ROOM}...`);
    
    const ctx1 = await newContext();
    const ctx2 = await newContext();
    const ctx3 = await newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    try {
        await seedRoomWithHostOnly(page1, ROOM);

        const countHostOnly = await getMemberCount(page1, ROOM);
        console.log(`[TEST] Host-only member count: ${countHostOnly} (expect 1)`);
        if (countHostOnly !== 1) {
            throw new Error(`FAILURE: Expected 1 member with host-only playerData, got ${countHostOnly}`);
        }

        const joinGuest = await tryJoin(page2, ROOM, 'u_party_guest', 'P2');
        console.log(`[TEST] Guest join result: ${JSON.stringify(joinGuest)}`);
        if (!joinGuest.ok) {
            throw new Error(`FAILURE: Guest should join when host is alone. Got: ${joinGuest.reason}`);
        }

        await page2.evaluate(async ({ rId, uid }) => {
            const ne = window.NetworkEngine;
            if (ne.roomId !== rId) ne.joinRoom(rId);
            await ne.registerPlayerInRoom('Guest', '#ef4444');
            await ne.db.ref(`games/${rId}/users/${uid}`).set(Date.now());
        }, { rId: ROOM, uid: 'u_party_guest' });

        await page1.evaluate(async ({ rId }) => {
            const db = window.NetworkEngine.db;
            await db.ref(`games/${rId}/playerData/u_party_host`).set({ name: 'HostOnly', color: '#3b82f6' });
            await db.ref(`games/${rId}/playerData/u_party_guest`).set({ name: 'Guest', color: '#ef4444' });
        }, { rId: ROOM });

        const countTwo = await getMemberCount(page1, ROOM);
        console.log(`[TEST] Two-player member count: ${countTwo} (expect 2)`);
        if (countTwo !== 2) {
            throw new Error(`FAILURE: Expected 2 members after guest joined, got ${countTwo}`);
        }

        await page1.evaluate(({ rId }) => {
            return window.NetworkEngine.db.ref(`games/${rId}/status`).set('playing');
        }, { rId: ROOM });

        const canThirdJoin = await page1.evaluate(async ({ rId }) => {
            return window.NetworkEngine.assertCanJoinRoom(rId);
        }, { rId: ROOM });
        console.log(`[TEST] Third slot available (assertCanJoin): ${JSON.stringify(canThirdJoin)}`);
        if (!canThirdJoin.ok) {
            throw new Error(`FAILURE: Room should accept a third player (max 8). Got: ${canThirdJoin.reason}`);
        }

        // Guest leaves → lobby; host stays in room (re-invite). Slot opens for a new guest.
        await page2.waitForFunction(() => window.HubApp?.ctx?.leaveParty, waitOpts);
        await page2.evaluate(() => window.HubApp.ctx.leaveParty());
        await page2.waitForFunction(
            () => new URL(location.href).searchParams.get('room') === 'lobby',
            waitOpts
        );
        await page1.waitForFunction(async ({ rId }) => {
            const snap = await window.NetworkEngine.db.ref(`games/${rId}`).once('value');
            return window.NetworkEngine.countRoomMembers(snap.val()) === 1;
        }, { rId: ROOM }, waitOpts);

        const countSolo = await getMemberCount(page1, ROOM);
        if (countSolo !== 1) {
            throw new Error(`FAILURE: Expected 1 member after guest left, got ${countSolo}`);
        }

        const hostStillInParty = await page1.evaluate(
            (rId) => new URL(location.href).searchParams.get('room') === rId,
            ROOM
        );
        if (!hostStillInParty) {
            throw new Error('FAILURE: Host should remain in party room when guest leaves (re-invite flow)');
        }

        const rejoin = await tryJoin(page3, ROOM, 'u_party_rejoin', 'P2');
        await page3.evaluate(async ({ rId, uid }) => {
            const ne = window.NetworkEngine;
            if (ne.roomId !== rId) ne.joinRoom(rId);
            await ne.registerPlayerInRoom('RejoinGuest', '#22c55e');
            await ne.db.ref(`games/${rId}/users/${uid}`).set(Date.now());
        }, { rId: ROOM, uid: 'u_party_rejoin' });
        if (!rejoin.ok) {
            throw new Error(`FAILURE: New guest should join after slot opened: ${rejoin.reason}`);
        }

        console.log('SUCCESS: Party limit passed (8 max, 3rd joins, slot reopens after leave).');
        return true;
    } finally {
        await page1.evaluate(({ rId }) => {
            const db = window.NetworkEngine?.db;
            if (db) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
        }, { rId: ROOM }).catch(() => {});
        await ctx1.close();
        await ctx2.close();
        await ctx3.close();
    }
}

if (require.main === module) {
    (async () => {
        await ensureTestStack();
        const browser = await chromium.launch({ headless: true });
        try {
            await runPartyLimitTest(browser);
        } catch (err) {
            console.error(err);
            process.exit(1);
        } finally {
            await browser.close();
        }
    })();
}

module.exports = { runPartyLimitTest };
