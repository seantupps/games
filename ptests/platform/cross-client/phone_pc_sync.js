/**
 * PC + phone RTDB sync: one tab uses direct emulator (:9000), other uses rtdbUrl proxy (:8000).
 * Matches LAN setup: PC at localhost, phone via LAN Game URL.
 */
const { chromium } = require('playwright');
const { ensureTestStack, buildHubUrl } = require('../../shared/infra/emulator-utils');
const { buildLocalPhonePathUrl } = require('../../../scripts/test/phone-path-url');
const { assertCrossClientChat } = require('../mobile/lib/mobile_assertions');
const { waitForLobbyShowsName } = require('../mobile/lib/mobile-waits');
const { applyTouchDeviceMedia } = require('../mobile/lib/mobile-utils');

const MARKER_PATH = 'tests/phone_pc_sync_marker';
const MAX_STEP_MS = 3000;
const capMs = (envVal, fallback = MAX_STEP_MS) => {
    const n = Number(envVal);
    const v = Number.isFinite(n) && n > 0 ? n : fallback;
    return Math.min(v, MAX_STEP_MS);
};
const STEP_MS = capMs(process.env.FIVE_PHONE_SYNC_STEP_MS);
const LOBBY_MS = capMs(process.env.FIVE_PHONE_LOBBY_TIMEOUT_MS);

function logStep(msg) {
    console.log(`[sync] ${msg}`);
}

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitForNetwork(page) {
    await page.waitForFunction(
        () => window.NetworkEngine && window.NetworkEngine.isInitialized,
        { timeout: STEP_MS }
    );
}

async function waitForDbConnected(page, label) {
    await page.waitForFunction(async () => {
        const db = window.NetworkEngine?.db;
        if (!db) return false;
        try {
            const snap = await Promise.race([
                db.ref('.info/connected').once('value'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), STEP_MS))
            ]);
            return snap.val() === true;
        } catch (_) {
            return false;
        }
    }, { timeout: STEP_MS }).catch(() => {
        throw new Error(`${label}: Firebase never connected (check rtdbUrl / :8000 proxy)`);
    });
}

async function setupPlayer(page, uid, name, color) {
    await page.addInitScript(({ id, n, c }) => {
        sessionStorage.setItem('game_uid', id);
        sessionStorage.setItem('username', n);
        sessionStorage.setItem('userColor', c);
    }, { id: uid, n: name, c: color });
}

/** REST marker I/O — avoids SDK .once() hanging when tunnel URL was malformed. */
async function writeMarker(page, by) {
    await page.evaluate(async ({ path, by, timeoutMs }) => {
        const base = window.NetworkEngine?.config?.databaseURL || '';
        if (!base) throw new Error('no databaseURL');
        const q = base.includes('?') ? base.slice(base.indexOf('?')) : '';
        const root = base.split('?')[0].replace(/\/$/, '');
        const url = `${root}/${path}.json${q}`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ by, t: Date.now() }),
                signal: ctrl.signal
            });
            if (!r.ok) throw new Error(`PUT ${r.status}`);
        } finally {
            clearTimeout(t);
        }
    }, { path: MARKER_PATH, by, timeoutMs: STEP_MS });
}

async function readMarker(page) {
    return page.evaluate(async ({ path, timeoutMs }) => {
        const base = window.NetworkEngine?.config?.databaseURL || '';
        const q = base.includes('?') ? base.slice(base.indexOf('?')) : '';
        const root = base.split('?')[0].replace(/\/$/, '');
        const url = `${root}/${path}.json${q}`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(url, { signal: ctrl.signal });
            if (!r.ok) return null;
            return r.json();
        } finally {
            clearTimeout(t);
        }
    }, { path: MARKER_PATH, timeoutMs: STEP_MS });
}

async function runPhonePcSync() {
    logStep('ensure stack…');
    await ensureTestStack();

    const pcUrl = buildHubUrl('lobby');
    const phoneUrl = buildLocalPhonePathUrl('127.0.0.1', 8000);
    const uidPc = 'u_sync_pc';
    const uidPhone = 'u_sync_phone';
    const namePc = 'Sync PC';
    const namePhone = 'Sync Phone';

    const browser = await chromium.launch({ headless: true });
    const ctxPc = await browser.newContext();
    const ctxPhone = await browser.newContext({
        viewport: { width: 915, height: 412 },
        hasTouch: true
    });
    await applyTouchDeviceMedia(ctxPhone);
    const pagePc = await ctxPc.newPage();
    const pagePhone = await ctxPhone.newPage();

    try {
        await setupPlayer(pagePc, uidPc, namePc, '#3b82f6');
        await setupPlayer(pagePhone, uidPhone, namePhone, '#ef4444');

        logStep(`PC URL: ${pcUrl}`);
        logStep(`Phone URL: ${phoneUrl}`);

        logStep('loading PC…');
        await pagePc.goto(pcUrl, { waitUntil: 'domcontentloaded', timeout: STEP_MS });
        logStep('loading phone (rtdbUrl proxy)…');
        await pagePhone.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: STEP_MS });

        logStep('waiting NetworkEngine…');
        await Promise.all([waitForNetwork(pagePc), waitForNetwork(pagePhone)]);

        logStep('waiting Firebase connected…');
        await Promise.all([
            waitForDbConnected(pagePc, 'PC'),
            waitForDbConnected(pagePhone, 'phone')
        ]);

        const runtimePc = await pagePc.evaluate(() => ({
            target: window.FiveFirebaseEnv.resolveTarget(),
            dbUrl: window.NetworkEngine.config.databaseURL,
            useEmu: !window.FiveFirebaseEnv.getFirebaseRuntime().rtdbTunnelUrl
        }));
        const runtimePhone = await pagePhone.evaluate(() => ({
            target: window.FiveFirebaseEnv.resolveTarget(),
            dbUrl: window.NetworkEngine.config.databaseURL,
            tunnel: window.FiveFirebaseEnv.getRtdbTunnelUrl()
        }));
        logStep(`PC runtime: ${JSON.stringify(runtimePc)}`);
        logStep(`Phone runtime: ${JSON.stringify(runtimePhone)}`);

        if (runtimePc.target !== 'emulator' || runtimePhone.target !== 'emulator') {
            throw new Error('Both clients must use firebase=emulator');
        }
        if (!runtimePhone.tunnel) {
            throw new Error('Phone client missing rtdbUrl tunnel');
        }
        if (runtimePhone.dbUrl.includes('/?ns=')) {
            throw new Error('Phone databaseURL must not use /?ns= (use host:port?ns=)');
        }

        logStep('PC writes marker…');
        await writeMarker(pagePc, 'pc');
        await delay(100);

        logStep('phone reads marker…');
        let marker = await readMarker(pagePhone);
        if (!marker || marker.by !== 'pc') {
            throw new Error(`Phone did not see PC marker: ${JSON.stringify(marker)}`);
        }
        logStep(`phone saw: ${JSON.stringify(marker)}`);

        logStep('phone writes marker…');
        await writeMarker(pagePhone, 'phone');
        await delay(100);

        logStep('PC reads marker…');
        marker = await readMarker(pagePc);
        if (!marker || marker.by !== 'phone') {
            throw new Error(`PC did not see phone marker: ${JSON.stringify(marker)}`);
        }
        logStep(`PC saw: ${JSON.stringify(marker)}`);

        logStep('lobby presence (refresh + wait)…');
        await Promise.all([
            pagePc.evaluate(() => window.NetworkEngine.updatePresence()),
            pagePhone.evaluate(() => window.NetworkEngine.updatePresence())
        ]);
        await delay(200);
        await Promise.all([
            waitForLobbyShowsName(pagePc, namePhone, LOBBY_MS),
            waitForLobbyShowsName(pagePhone, namePc, LOBBY_MS)
        ]);
        logStep('lobby: both see each other');

        const chatMsg = `sync-${Date.now()}`;
        logStep('chat PC → phone…');
        await assertCrossClientChat(pagePc, pagePhone, namePc, chatMsg, STEP_MS);
        logStep('chat phone → PC…');
        await assertCrossClientChat(pagePhone, pagePc, namePhone, `reply-${Date.now()}`, STEP_MS);
        logStep('chat OK');
    } finally {
        await Promise.all([
            pagePc.evaluate(async ({ path }) => {
                if (window.NetworkEngine?.db) await window.NetworkEngine.db.ref(path).remove();
                await window.NetworkEngine?.clearPresence?.();
            }, { path: MARKER_PATH }).catch(() => {}),
            pagePhone.evaluate(() => window.NetworkEngine?.clearPresence?.()).catch(() => {})
        ]);
        await browser.close();
    }
}

module.exports = { runPhonePcSync };

if (require.main === module) {
    runPhonePcSync()
        .then(() => {
            console.log('\x1b[32mPASS\x1b[0m phone PC sync\n');
        })
        .catch((err) => {
            console.error('\x1b[31mFAIL\x1b[0m', err.message);
            process.exit(1);
        });
}
