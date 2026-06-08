/**
 * Shared RTDB seed + instant MP deal (all waits capped at STEP_MS / 3s).
 */
const { buildAppUrl } = require('../../../../shared/infra/emulator-utils');
const { STEP_MS } = require('../../../../shared/infra/timeouts');

const DEAL_WAIT_MS = STEP_MS;
const NET_WAIT_MS = STEP_MS;
const HAND = 11;

function finiteTimeout(ms, fallback = STEP_MS) {
    const n = Number(ms);
    const v = Number.isFinite(n) && n > 0 ? n : fallback;
    return Math.min(v, STEP_MS);
}

function buildDealtBoard(hostUid, guestUid, origin = 2400) {
    const mk = (prefix, ox) => Array.from({ length: HAND }, (_, i) => ({
        id: `${prefix}-${i}`,
        letter: 'CATDOGHIJKL'[i % 11],
        x: ox + i * 44,
        y: origin,
        faceUp: true
    }));
    return {
        version: 4,
        seq: 1,
        playerUids: [hostUid, guestUid],
        phase: 'playing',
        reviewPhase: false,
        gameStarted: true,
        started: true,
        startedAt: Date.now(),
        handSize: HAND,
        pool: Array.from({ length: 122 }, (_, i) => ({ id: `pool-${i}`, letter: 'E' })),
        tilesOwnedByPlayer: {
            [hostUid]: mk('h', origin),
            [guestUid]: mk('g', origin + 320)
        },
        inventorySeq: { [hostUid]: 1, [guestUid]: 1 },
        scores: { [hostUid]: 0, [guestUid]: 0 },
        nextTileId: HAND * 2
    };
}

async function seedBananaRoom(page, roomId, { hostUid, guestUid, hostName = 'BananaHost', guestName = 'BananaGuest' }) {
    await page.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
    }, { uid: hostUid, name: hostName, color: '#3b82f6' });
    await page.goto(buildAppUrl(roomId, 'P1', 'bananagrams', 'multiplayer'), { waitUntil: 'domcontentloaded', timeout: NET_WAIT_MS });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, undefined, { timeout: NET_WAIT_MS });
    await page.evaluate(({ rId, hostUid, guestUid, hostName: hName, guestName: gName }) => {
        const db = window.NetworkEngine.db;
        return db.ref().update({
            [`games/${rId}`]: {
                host: hostUid,
                status: 'playing',
                global: {
                    game: 'bananagrams',
                    mode: 'multiplayer',
                    firstPlayer: 'P1',
                    resetCount: 1,
                    turn: 'P1'
                },
                playerData: {
                    [hostUid]: { name: hName, color: '#3b82f6' },
                    [guestUid]: { name: gName, color: '#ef4444' }
                }
            },
            [`gameData/${rId}`]: null
        });
    }, { rId: roomId, hostUid, guestUid, hostName, guestName });
}

async function joinGuest(page, roomId, { guestUid, guestName = 'BananaGuest' }) {
    await page.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
    }, { uid: guestUid, name: guestName, color: '#ef4444' });
    await page.goto(buildAppUrl(roomId, 'P2', 'bananagrams', 'multiplayer'), { waitUntil: 'domcontentloaded', timeout: NET_WAIT_MS });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, undefined, { timeout: NET_WAIT_MS });
    await page.evaluate(async ({ rId, uid, name, color }) => {
        const ne = window.NetworkEngine;
        if (ne.roomId !== rId) ne.joinRoom(rId);
        await ne.registerPlayerInRoom(name, color);
        await ne.db.ref(`games/${rId}/users/${uid}`).set(Date.now());
    }, { rId: roomId, uid: guestUid, name: guestName, color: '#ef4444' });
}

async function pushAndApplyDealtBoard(page, roomId, board) {
    await page.evaluate(async ({ rId, board: b }) => {
        const ne = window.NetworkEngine;
        const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
        if (S?.expandRelativeWrites) {
            await ne.db.ref().update(S.expandRelativeWrites(rId, 'state/board', b));
        } else {
            await ne.db.ref(`games/${rId}/global/board`).set(b);
        }
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return;
        const frameWin = document.getElementById('game-frame')?.contentWindow;
        const params = new URLSearchParams(frameWin?.location?.search || '');
        if (params.get('room')) g.roomId = params.get('room');
        if (ne.roomData) g.roomData = ne.roomData;
        g.mode = 'multiplayer';
        g.isMultiplayer = !!g.roomId && g.roomId !== 'lobby';
        if (typeof g._reconcileMpMode === 'function') g._reconcileMpMode();
        g._mpAppliedResetCount = 1;
        g._boardSeq = 0;
        if (!g.roomData) g.roomData = { global: { resetCount: 1 }, meta: { resetCount: 1 } };
        if (!g.roomData.global) g.roomData.global = { resetCount: 1 };
        g.roomData.global.board = b;
        if (!g.roomData.state) g.roomData.state = {};
        g.roomData.state.board = b;
        g.started = true;
        g.gameStarted = true;
        g._applyMultiplayerBoard(b, { force: true, reset: true });
    }, { rId: roomId, board });
}

async function waitForDeal(page) {
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && (g.tiles?.length || 0) > 0;
    }, undefined, { timeout: DEAL_WAIT_MS });
}

async function seedJoinAndDeal(hostPage, guestPage, roomId, uids) {
    const board = buildDealtBoard(uids.hostUid, uids.guestUid);
    await seedBananaRoom(hostPage, roomId, uids);
    await joinGuest(guestPage, roomId, uids);
    await hostPage.waitForFunction(
        () => document.getElementById('game-frame')?.contentWindow?.game,
        undefined,
        { timeout: DEAL_WAIT_MS }
    );
    await pushAndApplyDealtBoard(hostPage, roomId, board);
    await Promise.all([
        waitForDeal(hostPage),
        waitForDeal(guestPage)
    ]);
}

module.exports = {
    DEAL_WAIT_MS,
    finiteTimeout,
    buildDealtBoard,
    seedBananaRoom,
    joinGuest,
    pushAndApplyDealtBoard,
    waitForDeal,
    seedJoinAndDeal
};
