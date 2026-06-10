/**
 * Reproduce host dump failure after SPLIT.
 * node ptests/tmp-mp-dump-debug.js
 */
require('./shared/infra/bootstrap');
const { chromium } = require('playwright');
const { ensureTestStack } = require('./shared/infra/emulator-utils');
const { joinBananaPartyViaInvite } = require('./games/bananagrams/lib/mp-join');
const { splitViaDrag } = require('./games/bananagrams/lib/mp-input');
const { getGameFrame } = require('./shared/platform/mp-waits');
const { DESKTOP_VIEWPORT } = require('./shared/infra/viewport-constants');

const roomId = `MP_DEBUG_DUMP_${Date.now().toString(36).slice(-6).toUpperCase()}`;

async function probeDump(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const tile = g.tiles?.[g.tiles.length - 1];
        const uid = g._myUid?.();
        if (!g || !tile || !uid) return { error: 'no game/tile/uid' };
        let commitOk = false;
        let commitErr = null;
        try {
            commitOk = !!g._hostCommitDumpTransaction(uid, tile.id);
        } catch (e) {
            commitErr = e?.message || String(e);
        }
        return {
            tileId: tile.id,
            commitOk,
            commitErr,
            tiles: g.tiles?.length ?? 0,
            mpOwned: (g._mpOwned?.[uid] || []).length,
            dumpSeq: g._dumpSeq ?? 0,
            recentReset: g._isRecentProgrammaticReset?.() ?? null,
            gameStarted: g.gameStarted
        };
    });
}

async function main() {
    await ensureTestStack();
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const page1 = await ctx.newPage();
    const page2 = await ctx.newPage();

    const logs = [];
    for (const [page, label] of [[page1, 'P1'], [page2, 'P2']]) {
        page.on('console', (msg) => {
            const text = msg.text();
            if (text.includes('dump') || text.includes('invariant') || text.includes('POOL')
                || text.includes('authority') || msg.type() === 'error') {
                logs.push(`[${label}] ${text}`);
            }
        });
        page.on('pageerror', (e) => logs.push(`[${label} PAGEERROR] ${e.message}`));
    }

    await joinBananaPartyViaInvite(page1, page2, roomId, { log: () => {} });
    const frame1 = await getGameFrame(page1);
    await splitViaDrag(frame1);
    await page1.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.gameStarted && (g.roomData?.global?.board?.dumpSeq ?? 0) === 0;
    }, { timeout: 8000 });

    const result = await probeDump(page1);
    console.log(JSON.stringify(result, null, 2));
    console.log('\n--- console ---');
    logs.forEach((l) => console.log(l));

    await browser.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
