/**
 * Shared helpers for production RTDB Playwright tests.
 * Requires: npm run serve (local) or FIVE_BASE_URL (Pages).
 */
process.env.FIVE_FIREBASE_TARGET = 'production';

const { chromium } = require('playwright');
const { ensureTestStack, buildAppUrl, buildHubUrl, FIREBASE_TARGET } = require('../../shared/infra/emulator-utils');

const RUN_ID = process.env.FIVE_PROD_RUN_ID || Date.now().toString(36).slice(-6).toUpperCase();

function assertProduction() {
    if (process.env.FIVE_FIREBASE_TARGET !== 'production') {
        process.env.FIVE_FIREBASE_TARGET = 'production';
    }
    if (FIREBASE_TARGET !== 'production') {
        throw new Error('Production tests require FIVE_FIREBASE_TARGET=production');
    }
}

function prodRoom(suffix) {
    return `PW_PROD_${suffix}_${RUN_ID}`;
}

function prodUid(role) {
    return `PW_PROD_${role}_${RUN_ID}`;
}

async function ensureProdStack() {
    assertProduction();
    console.warn('[PROD] *** Live RTDB (games-fad3a) — rooms prefixed PW_PROD_ ***');
    return ensureTestStack();
}

function launchOptions() {
    return {
        headless: process.env.FIVE_HEADED !== '1',
        slowMo: process.env.FIVE_HEADED === '1' ? 60 : 0
    };
}

async function launchBrowser() {
    return chromium.launch(launchOptions());
}

async function setupPlayerPage(page, uid, name, color, label = '') {
    await page.addInitScript(({ id, user, c }) => {
        sessionStorage.setItem('game_uid', id);
        sessionStorage.setItem('username', user);
        sessionStorage.setItem('userColor', c);
    }, { id: uid, user: name, c: color });

    page.on('console', (msg) => {
        const text = msg.text();
        const tags = ['[Network]', '[ENGINE]', 'FAILURE', 'SUCCESS', 'Presence', 'HOST:', 'WINNER'];
        if (tags.some((t) => text.includes(t))) {
            console.log(`[browser${label ? ` ${label}` : ''}] ${text}`);
        }
    });
}

async function waitForNetwork(page) {
    await page.goto(buildHubUrl('lobby'));
    await page.waitForFunction(() => window.NetworkEngine && window.NetworkEngine.isInitialized, { timeout: 20000 });
    const target = await page.evaluate(() => window.NetworkEngine?.firebaseTarget);
    if (target !== 'production') {
        throw new Error(`Expected firebaseTarget production, got ${target}`);
    }
}

async function seedRoom(page, { roomId, gameId, gameMode, hostUid, guestUid, hostName, guestName }) {
    const err = await page.evaluate(async ({ rId, gId, gMode, hUid, gUid, hName, gName }) => {
        const db = window.NetworkEngine.db;
        try {
            await db.ref(`games/${rId}`).set({
                host: hUid,
                status: 'playing',
                global: { game: gId, mode: gMode, firstPlayer: 'P1' },
                playerData: {
                    [hUid]: { name: hName, color: '#3b82f6' },
                    [gUid]: { name: gName, color: '#ef4444' }
                }
            });
            await db.ref(`gameData/${rId}`).remove();
            return null;
        } catch (e) {
            return e.message || String(e);
        }
    }, {
        rId: roomId,
        gId: gameId,
        gMode: gameMode,
        hUid: hostUid,
        gUid: guestUid,
        hName: hostName,
        gName: guestName
    });
    if (err) {
        throw new Error(`seedRoom failed: ${err}`);
    }
}

async function joinRoom(page1, page2, roomId, gameId, gameMode) {
    const p1Url = buildAppUrl(roomId, 'P1', gameId, gameMode);
    const p2Url = buildAppUrl(roomId, 'P2', gameId, gameMode);
    await Promise.all([page1.goto(p1Url), page2.goto(p2Url)]);
    await Promise.all([page1.waitForSelector('#game-frame'), page2.waitForSelector('#game-frame')]);
}

async function waitForGameReady(page, role, roomId, gameId) {
    for (let i = 0; i < 30; i++) {
        const status = await page.evaluate(({ rId, gId }) => {
            const frame = document.getElementById('game-frame');
            if (!frame?.contentWindow?.game) return null;
            const g = frame.contentWindow.game;
            if (g.roomId !== rId || g.gameName !== gId) return null;
            const hasPiles = g.piles && Object.values(g.piles).some((arr) => arr.length > 0);
            const hasNodes = g.nodes && g.nodes.length > 0;
            const resetCount = g.roomData?.global?.resetCount ?? 0;
            return {
                playerRole: g.playerRole,
                resetCount,
                ready: resetCount >= 1 && (hasPiles || hasNodes || g.identitySynced)
            };
        }, { rId: roomId, gId: gameId });
        if (status?.playerRole === role && status.ready) return;
        await page.waitForTimeout(500);
    }
    throw new Error(`Timeout waiting for game ready (${role}, room ${roomId})`);
}

async function waitForGameMode(page, role, gameName, mode) {
    await page.waitForFunction(({ gName, m }) => {
        const frame = document.getElementById('game-frame');
        const game = frame?.contentWindow?.game;
        if (!game || game.gameName !== gName || game.mode !== m) return false;
        if (gName === 'piles') {
            return game.piles && game.piles['B']?.length > 0;
        }
        if (gName === 'line') {
            return game.nodes && game.nodes.length > 0;
        }
        return true;
    }, { gName: gameName, m: mode }, { timeout: 15000 });
    await page.waitForTimeout(600);
}

async function cleanupRoom(page, roomId) {
    if (!roomId) return;
    await page.evaluate(async ({ rId }) => {
        const db = window.NetworkEngine?.db;
        if (!db) return;
        await db.ref().update({
            [`games/${rId}`]: null,
            [`gameData/${rId}`]: null
        });
    }, { rId: roomId }).catch(() => {});
}

async function cleanupPresence(page, uids) {
    if (!uids?.length) return;
    await page.evaluate(async ({ ids }) => {
        const db = window.NetworkEngine?.db;
        if (!db) return;
        const updates = {};
        ids.forEach((id) => { updates[id] = null; });
        await db.ref('presence').update(updates);
    }, { ids: uids }).catch(() => {});
}

/** @param {import('playwright').Page} page */
async function getLobbyPlayerNames(page) {
    return page.evaluate(() => {
        const list = document.getElementById('player-list');
        if (!list) return [];
        return Array.from(list.querySelectorAll('.player-name')).map((el) => el.innerText.trim());
    });
}

/**
 * Both lobby tabs must see the other player in #player-list (live presence).
 * @param {import('playwright').Page} pageA
 * @param {import('playwright').Page} pageB
 * @param {string} nameA
 * @param {string} nameB
 * @param {{ timeoutMs?: number, settleMs?: number }} [opts]
 */
async function assertLobbyPlayerCrossVisibility(pageA, pageB, nameA, nameB, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 15000;
    const settleMs = opts.settleMs ?? 3000;
    if (settleMs > 0) {
        await pageA.waitForTimeout(settleMs);
    }

    const deadline = Date.now() + timeoutMs;
    let namesA = [];
    let namesB = [];
    while (Date.now() < deadline) {
        [namesA, namesB] = await Promise.all([
            getLobbyPlayerNames(pageA),
            getLobbyPlayerNames(pageB)
        ]);
        const aSeesB = namesA.some((n) => n.includes(nameB));
        const bSeesA = namesB.some((n) => n.includes(nameA));
        if (aSeesB && bSeesA) {
            return { namesA, namesB };
        }
        await pageA.waitForTimeout(500);
    }

    throw new Error(
        `Lobby player cross-visibility failed. `
        + `A(${nameA}) sees: ${JSON.stringify(namesA)}; `
        + `B(${nameB}) sees: ${JSON.stringify(namesB)}`
    );
}

module.exports = {
    RUN_ID,
    prodRoom,
    prodUid,
    assertProduction,
    ensureProdStack,
    launchBrowser,
    setupPlayerPage,
    waitForNetwork,
    seedRoom,
    joinRoom,
    waitForGameReady,
    waitForGameMode,
    cleanupRoom,
    cleanupPresence,
    getLobbyPlayerNames,
    assertLobbyPlayerCrossVisibility,
    buildHubUrl,
    buildAppUrl
};
