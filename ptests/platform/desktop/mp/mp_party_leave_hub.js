/**
 * Two-player hub: guest leaves → host must stay in party room (not lobby).
 * Run: npm run test:mp:leave
 */
const { chromium } = require('playwright');
const { ensureTestStack, buildHubUrl } = require('../../../shared/infra/emulator-utils');

const MS = Number(process.env.FIVE_LC_STEP_MS || 8000);

async function main() {
    await ensureTestStack();
    const roomId = `MP_LEAVE_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    console.log(`[TEST] Hub party leave (${roomId})…`);

    const browser = await chromium.launch({ headless: true });
    const mk = async () => {
        const ctx = await browser.newContext();
        ctx.setDefaultTimeout(MS);
        ctx.setDefaultNavigationTimeout(MS);
        return { ctx, page: await ctx.newPage() };
    };

    const host = await mk();
    const guest = await mk();
    try {
        for (const [page, uid, name, color] of [
            [host.page, 'u_leave_host', 'LeaveHost', '#3b82f6'],
            [guest.page, 'u_leave_guest', 'LeaveGuest', '#ef4444']
        ]) {
            await page.addInitScript(({ id, n, c }) => {
                sessionStorage.setItem('game_uid', id);
                sessionStorage.setItem('username', n);
                sessionStorage.setItem('userColor', c);
            }, { id: uid, n: name, c: color });
        }

        await host.page.goto(buildHubUrl('lobby'), { waitUntil: 'domcontentloaded', timeout: MS });
        await host.page.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: MS });
        await host.page.evaluate(
            ({ rId }) => window.NetworkEngine.prepareInviteRoom(rId, 'piles', 'classic'),
            { rId: roomId }
        );

        const enter = async (page, role) => {
            const ok = await page.evaluate(
                async ({ rId, r }) => window.HubApp.ctx.enterPartyRoom(rId, { role: r, game: 'piles', mode: 'classic' }),
                { rId: roomId, r: role }
            );
            if (ok === false) throw new Error(`enterPartyRoom failed for ${role}`);
        };

        await host.page.waitForFunction(() => window.HubApp?.ctx?.enterPartyRoom, { timeout: MS });
        await guest.page.goto(buildHubUrl('lobby'), { waitUntil: 'domcontentloaded', timeout: MS });
        await guest.page.waitForFunction(() => window.HubApp?.ctx?.enterPartyRoom, { timeout: MS });

        await enter(host.page, 'P1');
        await enter(guest.page, 'P2');

        await host.page.waitForFunction(
            async ({ rId }) => {
                const snap = await window.NetworkEngine.db.ref(`games/${rId}`).once('value');
                return window.NetworkEngine.countRoomMembers(snap.val()) === 2;
            },
            { rId: roomId },
            { timeout: MS }
        );

        await guest.page.evaluate(async () => {
            if (typeof leaveParty === 'function') leaveParty();
            else if (window.HubApp?.ctx?.leaveParty) await window.HubApp.ctx.leaveParty();
        });

        await host.page.waitForFunction(
            ({ rId }) => new URL(location.href).searchParams.get('room') === rId,
            { rId: roomId },
            { timeout: MS }
        );

        const roomOk = await host.page.evaluate(async ({ rId }) => {
            const snap = await window.NetworkEngine.db.ref(`games/${rId}`).once('value');
            const room = snap.val();
            return {
                exists: !!room,
                count: window.NetworkEngine.countRoomMembers(room),
                url: new URL(location.href).searchParams.get('room')
            };
        }, { rId: roomId });

        if (roomOk.url !== roomId) {
            throw new Error(`Host sent to lobby/wrong room: ${roomOk.url}`);
        }
        if (!roomOk.exists) throw new Error('Room deleted when guest left');
        if (roomOk.count !== 1) throw new Error(`Expected 1 member on host, got ${roomOk.count}`);

        console.log('[TEST] Hub party leave OK — host still in party');
    } finally {
        await host.ctx.close().catch(() => {});
        await guest.ctx.close().catch(() => {});
        await browser.close();
    }
}

main().catch((e) => {
    console.error('[TEST] FAIL:', e.message);
    process.exit(1);
});
