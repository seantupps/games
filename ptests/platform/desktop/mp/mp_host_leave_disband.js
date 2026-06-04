/**
 * Host leave disbands party — all players return to lobby.
 * Usage: npm run test:mp:host-leave
 * Debug: FIVE_PARTY_DBG=1 npm run test:mp:host-leave
 */
const { chromium } = require('playwright');
const { ensureTestStack, buildAppUrl } = require('../../../shared/infra/emulator-utils');
const { STEP_MS } = require('../../../shared/infra/timeouts');

const DBG = process.env.FIVE_PARTY_DBG === '1';
const waitOpts = { timeout: STEP_MS };
const HOST_UID = 'u_host_leave_p1';
const GUEST_UID = 'u_host_leave_p2';

function attachConsole(page, label) {
    page.on('console', (msg) => {
        const text = msg.text();
        if (DBG || text.includes('[PARTY-DBG]') || text.includes('[HUB]')) {
            console.log(`[${label} console] ${text}`);
        }
    });
}

async function dumpPartyState(page, label) {
    return page.evaluate(({ label: tag }) => {
        const ne = window.NetworkEngine;
        const url = new URL(window.location.href);
        return {
            label: tag,
            urlRoom: url.searchParams.get('room'),
            ctxRoom: window.HubApp?.ctx?.roomId ?? null,
            neRoom: ne?.roomId ?? null,
            uid: ne?.uid ?? null,
            role: ne?.playerRole ?? null,
            roomStatus: ne?.roomData?.status ?? null,
            roomHost: ne?.roomData?.host ?? null,
            playerDataKeys: ne?.roomData?.playerData
                ? Object.keys(ne.roomData.playerData)
                : [],
            hasLeaveParty: typeof window.leaveParty === 'function',
            hasOnPartyRoomClosed: typeof window.onPartyRoomClosed === 'function'
        };
    }, { label });
}

async function seedRoom(page, roomId) {
    await page.addInitScript(({ uid, name, color, dbg }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
        if (dbg) localStorage.setItem('five_party_dbg', '1');
    }, { uid: HOST_UID, name: 'HostLeave', color: '#3b82f6', dbg: DBG });
    // Create room in RTDB before hub subscribes (avoids false dissolve on null snapshot).
    await page.goto(buildAppUrl('lobby', 'P1', 'bananagrams', 'multiplayer'), { waitUntil: 'domcontentloaded', timeout: waitOpts.timeout });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, undefined, waitOpts);
    await page.evaluate(({ rId, hostUid, guestUid }) => {
        const db = window.NetworkEngine.db;
        return db.ref().update({
            [`games/${rId}`]: {
                host: hostUid,
                status: 'playing',
                global: {
                    game: 'bananagrams',
                    mode: 'multiplayer',
                    resetCount: 1
                },
                playerData: {
                    [hostUid]: { name: 'HostLeave', color: '#3b82f6' },
                    [guestUid]: { name: 'GuestStay', color: '#ef4444' }
                }
            },
            [`gameData/${rId}`]: null
        });
    }, { rId: roomId, hostUid: HOST_UID, guestUid: GUEST_UID });
    await page.goto(buildAppUrl(roomId, 'P1', 'bananagrams', 'multiplayer'), { waitUntil: 'domcontentloaded', timeout: waitOpts.timeout });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, undefined, waitOpts);
    await page.evaluate(async ({ rId, uid, name, color }) => {
        const ne = window.NetworkEngine;
        if (ne.roomId !== rId) ne.joinRoom(rId);
        await ne.registerPlayerInRoom(name, color);
        await ne.db.ref(`games/${rId}/users/${uid}`).set(Date.now());
    }, { rId: roomId, uid: HOST_UID, name: 'HostLeave', color: '#3b82f6' });
}

async function joinGuest(page, roomId) {
    await page.addInitScript(({ uid, name, color, dbg }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
        if (dbg) localStorage.setItem('five_party_dbg', '1');
    }, { uid: GUEST_UID, name: 'GuestStay', color: '#ef4444', dbg: DBG });
    // Room already exists — guest can load party URL directly.
    await page.goto(buildAppUrl(roomId, 'P2', 'bananagrams', 'multiplayer'), { waitUntil: 'domcontentloaded', timeout: waitOpts.timeout });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, undefined, waitOpts);
    await page.evaluate(async ({ rId, uid, name, color }) => {
        const ne = window.NetworkEngine;
        if (ne.roomId !== rId) ne.joinRoom(rId);
        await ne.registerPlayerInRoom(name, color);
        await ne.db.ref(`games/${rId}/users/${uid}`).set(Date.now());
    }, { rId: roomId, uid: GUEST_UID, name: 'GuestStay', color: '#ef4444' });
}

async function waitHubReady(page, roomId) {
    await page.waitForFunction(({ rId }) => {
        const ne = window.NetworkEngine;
        return ne?.roomId === rId
            && typeof window.leaveParty === 'function'
            && typeof window.onPartyRoomClosed === 'function';
    }, { rId: roomId }, waitOpts);
}

async function assertInLobby(page, label) {
    await page.waitForFunction(() => {
        const ne = window.NetworkEngine;
        const urlRoom = new URL(window.location.href).searchParams.get('room') || 'lobby';
        return ne?.roomId === 'lobby' || urlRoom === 'lobby';
    }, undefined, waitOpts);
    const s = await page.evaluate(() => {
        const ne = window.NetworkEngine;
        const urlRoom = new URL(window.location.href).searchParams.get('room') || 'lobby';
        return {
            roomId: ne?.roomId,
            urlRoom,
            inLobby: (ne?.roomId === 'lobby' || urlRoom === 'lobby')
        };
    });
    if (!s.inLobby) {
        throw new Error(`${label}: expected lobby (${JSON.stringify(s)})`);
    }
}

async function main() {
    await ensureTestStack();
    const roomId = `MP_HOST_LEAVE_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const browser = await chromium.launch({ headless: true });
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const hostPage = await ctx1.newPage();
    const guestPage = await ctx2.newPage();
    hostPage.setDefaultTimeout(STEP_MS);
    guestPage.setDefaultTimeout(STEP_MS);
    attachConsole(hostPage, 'HOST');
    attachConsole(guestPage, 'GUEST');

    try {
        console.log(`[TEST] Host leave disbands party (room ${roomId}, dbg=${DBG})...`);
        await seedRoom(hostPage, roomId);
        await joinGuest(guestPage, roomId);
        await Promise.all([
            waitHubReady(hostPage, roomId),
            waitHubReady(guestPage, roomId)
        ]);

        console.log('[TEST] Before leave:', JSON.stringify({
            host: await dumpPartyState(hostPage, 'host-before'),
            guest: await dumpPartyState(guestPage, 'guest-before')
        }, null, 2));

        await hostPage.evaluate(() => window.leaveParty());

        console.log('[TEST] Right after leaveParty():', JSON.stringify({
            host: await dumpPartyState(hostPage, 'host-after-leave'),
            guest: await dumpPartyState(guestPage, 'guest-after-leave')
        }, null, 2));

        // Brief poll so RTDB can propagate before assert
        await guestPage.waitForTimeout(200);

        const guestRtdb = await guestPage.evaluate(async ({ rId }) => {
            const snap = await window.NetworkEngine.db.ref(`games/${rId}`).once('value');
            return { status: snap.val()?.status ?? null, host: snap.val()?.host ?? null };
        }, { rId: roomId });
        console.log('[TEST] Guest RTDB read:', JSON.stringify(guestRtdb));

        await Promise.all([
            assertInLobby(hostPage, 'host'),
            assertInLobby(guestPage, 'guest')
        ]);
        console.log('SUCCESS: Host leave returned all players to lobby.');
    } catch (err) {
        console.error('[TEST] FAILED:', err.message);
        try {
            console.error('[TEST] Final state:', JSON.stringify({
                host: await dumpPartyState(hostPage, 'host-final'),
                guest: await dumpPartyState(guestPage, 'guest-final')
            }, null, 2));
        } catch (_) { /* page may be closed */ }
        throw err;
    } finally {
        await Promise.all([ctx1.close(), ctx2.close()]);
        await browser.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
