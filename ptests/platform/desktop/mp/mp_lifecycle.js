/**

 * MP lifecycle suite. Run: npm run test:mp:lifecycle

 *

 * - Partner leave: RTDB policy (room survives when guest leaves)

 * - Two full Line games in a hub party (both players)

 * - Victory dwell: optional --victory

 */

const { chromium } = require('playwright');

const { ensureTestStack, buildHubUrl } = require('../../../shared/infra/emulator-utils');

const { runMultiplayerAudit } = require('../../../shared/infra/multiplayer_base');



/** Hard cap for quick RTDB / timer checks. */

const MS = Number(process.env.FIVE_LC_STEP_MS || 5000);

/** Per-step timeout for full Line party games. */

const LINE_MS = Number(process.env.FIVE_LC_LINE_MS || 15000);

const LINE_TOTAL_MS = Number(process.env.FIVE_LC_LINE_TOTAL_MS || 180000);



function log(msg) {

    console.log(`[lifecycle] ${msg}`);

}



async function newPage(browser, timeoutMs = MS) {

    const ctx = await browser.newContext();

    ctx.setDefaultTimeout(timeoutMs);

    ctx.setDefaultNavigationTimeout(timeoutMs);

    return { ctx, page: await ctx.newPage() };

}



async function launchBrowser() {

    log('launching chromium…');

    return Promise.race([

        chromium.launch({ headless: true }),

        new Promise((_, reject) =>

            setTimeout(() => reject(new Error(`chromium.launch timed out after ${MS}ms`)), MS)

        )

    ]);

}



async function openHub(page, room = 'lobby') {

    await page.goto(buildHubUrl(room), { waitUntil: 'domcontentloaded', timeout: MS });

    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: MS });

}



/** Wait for Line boards in hub iframes (no drag UI test). */

async function slimLineBeforeLoop(page1, page2) {
    await Promise.all([
        page1.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.nodes?.length > 0 && g.playerRole === 'P1' && !g.isOver;
        }, { timeout: LINE_MS }),
        page2.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.nodes?.length > 0 && g.playerRole === 'P2' && !g.isOver;
        }, { timeout: LINE_MS })
    ]);
}



async function waitForLineGameReady(page, role, roomId) {

    const deadline = Date.now() + LINE_MS;

    while (Date.now() < deadline) {

        const status = await page.evaluate(({ rId }) => {

            const g = document.getElementById('game-frame')?.contentWindow?.game;

            if (!g) return 'no game';

            return {

                role: g.playerRole,

                roomId: g.roomId,

                nodes: g.nodes?.length || 0,

                isOver: g.isOver

            };

        }, { rId: roomId });

        if (status?.role === role && status.roomId === roomId && status.nodes > 0 && !status.isOver) {

            return;

        }

        await page.waitForTimeout(120);

    }

    throw new Error(`Line game not ready for ${role} in ${roomId}`);

}



/** Hub party → play Line to completion twice (victory + auto-reset between). */

async function runTwoLinePartyGames(browser) {

    const roomId = `MP_LC_LINE_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    log(`two Line party games (${roomId})…`);



    if (process.env.FIVE_STEP_TIMEOUT_MS == null) {

        process.env.FIVE_STEP_TIMEOUT_MS = String(LINE_MS);

    }

    if (process.env.FIVE_AUTO_RESET_WAIT_MS == null) {

        process.env.FIVE_AUTO_RESET_WAIT_MS = String(Math.max(LINE_MS, 8000));

    }



    const host = await newPage(browser, LINE_MS);

    const guest = await newPage(browser, LINE_MS);

    const auditBase = {

        browser,

        context1: host.ctx,

        context2: guest.ctx,

        page1: host.page,

        page2: guest.page,

        roomId,

        gameMode: 'classic',

        skipStackCheck: true,

        manageContexts: false,

        skipBootstrap: true,

        skipCleanup: true,

        beforeLoop: slimLineBeforeLoop,

        initialMoveCount: 0

    };



    try {

        for (const [page, uid, name, color] of [

            [host.page, 'u_lc_line_host', 'LcLineHost', '#3b82f6'],

            [guest.page, 'u_lc_line_guest', 'LcLineGuest', '#ef4444']

        ]) {

            await page.addInitScript(({ id, n, c }) => {

                sessionStorage.setItem('game_uid', id);

                sessionStorage.setItem('username', n);

                sessionStorage.setItem('userColor', c);

            }, { id: uid, n: name, c: color });

        }



        await host.page.goto(buildHubUrl('lobby'), { waitUntil: 'domcontentloaded', timeout: LINE_MS });

        await host.page.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: LINE_MS });

        await host.page.evaluate(

            ({ rId }) => window.NetworkEngine.prepareInviteRoom(rId, 'line', 'classic'),

            { rId: roomId }

        );



        const enter = async (page, role) => {

            const ok = await page.evaluate(

                async ({ rId, r }) => window.HubApp.ctx.enterPartyRoom(rId, { role: r, game: 'line', mode: 'classic' }),

                { rId: roomId, r: role }

            );

            if (ok === false) throw new Error(`enterPartyRoom failed for ${role}`);

        };



        await host.page.waitForFunction(() => window.HubApp?.ctx?.enterPartyRoom, { timeout: LINE_MS });

        await guest.page.goto(buildHubUrl('lobby'), { waitUntil: 'domcontentloaded', timeout: LINE_MS });

        await guest.page.waitForFunction(() => window.HubApp?.ctx?.enterPartyRoom, { timeout: LINE_MS });



        await enter(host.page, 'P1');

        await enter(guest.page, 'P2');



        await host.page.waitForFunction(

            async ({ rId }) => {

                const snap = await window.NetworkEngine.db.ref(`games/${rId}`).once('value');

                return window.NetworkEngine.countRoomMembers(snap.val()) === 2;

            },

            { rId: roomId },

            { timeout: LINE_MS }

        );



        await Promise.all([

            host.page.waitForSelector('#game-frame', { timeout: LINE_MS }),

            guest.page.waitForSelector('#game-frame', { timeout: LINE_MS })

        ]);

        await Promise.all([

            waitForLineGameReady(host.page, 'P1', roomId),

            waitForLineGameReady(guest.page, 'P2', roomId)

        ]);



        log('game 1…');

        await runMultiplayerAudit('line', { ...auditBase, skipScoreVerify: false });



        log('waiting for game 2 board…');

        const waitGame2 = (page) => page.waitForFunction(

            ({ rId }) => {

                const g = document.getElementById('game-frame')?.contentWindow?.game;

                const rc = g?.roomData?.global?.resetCount ?? 0;

                return g && g.roomId === rId && !g.isOver && g.nodes?.length > 0 && rc >= 2;

            },

            { rId: roomId },

            { timeout: LINE_MS }

        );

        await Promise.all([waitGame2(host.page), waitGame2(guest.page)]);



        log('game 2…');

        await runMultiplayerAudit('line', {

            ...auditBase,

            skipScoreVerify: true,

            beforeLoop: slimLineBeforeLoop

        });



        log('two Line party games OK');

    } finally {
        await host.page.evaluate((rId) => {
            const db = window.NetworkEngine?.db;
            if (!db) return;
            const updates = {};
            updates[`games/${rId}`] = null;
            updates[`gameData/${rId}`] = null;
            return db.ref().update(updates);
        }, roomId).catch(() => {});
        await host.ctx.close().catch(() => {});
        await guest.ctx.close().catch(() => {});
    }

}



/** One player leaves → room row stays (2-player party is not nuked for the host). */

async function runPartnerLeaveTest(browser) {

    const roomId = `MP_LC_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    log(`partner leave (${roomId})…`);

    const { ctx, page } = await newPage(browser);

    try {

        await page.addInitScript(() => {

            sessionStorage.setItem('game_uid', 'u_lc_host');

            sessionStorage.setItem('username', 'LcHost');

        });

        await openHub(page);



        const r = await page.evaluate(async ({ rId }) => {

            const db = window.NetworkEngine.db;

            const host = 'u_lc_host';

            const guest = 'u_lc_guest';

            await db.ref().update({

                [`games/${rId}`]: {

                    host,

                    status: 'playing',

                    global: { game: 'piles', mode: 'classic', resetCount: 1 },

                    playerData: {

                        [host]: { name: 'LcHost', color: '#3b82f6' },

                        [guest]: { name: 'LcGuest', color: '#ef4444' }

                    }

                },

                [`gameData/${rId}`]: null

            });

            const S = window.RtdbSchema;

            await db.ref(S.paths.playerData(rId, guest)).remove();

            await db.ref(S.paths.users(rId, guest)).remove();

            await window.NetworkEngine.evaluateRoomLifecycleAfterLeave(rId);

            const room = (await db.ref(`games/${rId}`).once('value')).val();

            return {

                exists: !!room,

                count: window.NetworkEngine.countRoomMembers(room),

                dissolve: window.NetworkEngine.shouldDissolveSoloParty(room)

            };

        }, { rId: roomId });



        if (!r.exists) throw new Error('room deleted when guest left');

        if (r.count !== 1) throw new Error(`expected 1 member, got ${r.count}`);

        if (r.dissolve) throw new Error('shouldDissolveSoloParty should be false with 1 member');

        log('partner leave OK');

    } finally {

        await ctx.close().catch(() => {});

    }

}



/** Optional: host schedules auto-reset after setGameOver (no iframe game load). */

async function runVictoryTimerTest(browser) {

    const roomId = `MP_LC_WIN_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    log(`victory timer (${roomId})…`);

    const { ctx, page } = await newPage(browser);

    try {

        await page.addInitScript(() => {

            sessionStorage.setItem('game_uid', 'u_lc_host');

            window.FIVE_VICTORY_DWELL_MS = 1500;

        });

        await openHub(page);

        await page.evaluate(

            ({ rId }) => window.NetworkEngine.prepareInviteRoom(rId, 'line', 'classic'),

            { rId: roomId }

        );

        await openHub(page, roomId);



        await page.waitForSelector('#game-frame', { timeout: MS });

        const win = await page.evaluate(() => {

            const g = document.getElementById('game-frame')?.contentWindow?.game;

            if (!g?.setGameOver) return { err: 'game not ready' };

            g._victoryRegistered = false;

            g.clearAutoReset?.();

            g.setGameOver('P1');

            return { isOver: g.isOver, hasTimer: !!g.autoResetTimer };

        });

        if (win.err) throw new Error(win.err);

        if (!win.isOver || !win.hasTimer) throw new Error('setGameOver did not schedule win + auto-reset');

        log('victory timer OK');

    } finally {

        await ctx.close().catch(() => {});

    }

}



async function main() {
    const withVictory = process.argv.includes('--victory');
    const skipLine = process.argv.includes('--no-line');
    const suiteCap = Number(
        process.env.FIVE_LC_TOTAL_MS || (skipLine ? 30000 : LINE_TOTAL_MS)
    );

    let suiteTimer;
    const suiteTimeout = new Promise((_, reject) => {
        suiteTimer = setTimeout(
            () => reject(new Error(`suite timed out after ${suiteCap}ms`)),
            suiteCap
        );
    });

    try {
        await Promise.race([
            (async () => {
                await ensureTestStack();
                const browser = await launchBrowser();
                try {
                    await runPartnerLeaveTest(browser);
                    if (!skipLine) await runTwoLinePartyGames(browser);
                    if (withVictory) await runVictoryTimerTest(browser);
                } finally {
                    await browser.close().catch(() => {});
                }
                log('done');
            })(),
            suiteTimeout
        ]);
    } catch (err) {
        console.error(`[lifecycle] FAIL: ${err.message}`);
        process.exit(1);
    } finally {
        clearTimeout(suiteTimer);
    }
}



if (require.main === module) main();



module.exports = {

    runPartnerLeaveTest,

    runVictoryTimerTest,

    runTwoLinePartyGames,

    main

};


