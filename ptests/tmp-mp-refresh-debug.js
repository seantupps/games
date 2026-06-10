/**
 * Debug P2 refresh layout SSOT.
 * node ptests/tmp-mp-refresh-debug.js
 */
require('./shared/infra/bootstrap');
const { chromium } = require('playwright');
const { ensureTestStack } = require('./shared/infra/emulator-utils');
const { joinBananaPartyViaInvite } = require('./games/bananagrams/lib/mp-join');
const { splitViaDrag, dumpTile } = require('./games/bananagrams/lib/mp-input');
const { getGameFrame } = require('./shared/platform/mp-waits');
const { dragTileByIndex } = require('./games/bananagrams/lib/mp-input');
const { hostPublishPartyBoard, flushHostBananaInteractions } = require('./shared/adapters/mp-client');
const { DESKTOP_VIEWPORT } = require('./shared/infra/viewport-constants');

const roomId = `MP_DEBUG_REFRESH_${Date.now().toString(36).slice(-6).toUpperCase()}`;

async function layoutDiag(page, label) {
    return page.evaluate(({ lbl }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board;
        const uid = g?._myUid?.();
        const owned = g?._boardAuthoritativeOwned?.(board, uid) || [];
        const tile = g?.tiles?.find((t) => t.id === '4:t-1') || g?.tiles?.[1];
        const localLayout = g?._loadLocalLayout?.() || {};
        const handRec = g?._loadLocalHandRecord?.() || {};
        return {
            label: lbl,
            layoutKey: g?.getLayoutPersistKey?.(),
            handKey: g?.getHandPersistKey?.(),
            roomId: g?.roomId,
            tile: tile ? { id: tile.id, x: tile.x, y: tile.y } : null,
            localTile: tile ? localLayout[tile.id] : null,
            authority: g?._lastMpLayoutAuthority,
            cacheStale: g?._localCacheStaleForBoard?.(board),
            actionRefresh: g?._isActionInventoryRefresh?.(board),
            layoutMatches: g?._localLayoutMatchesOwned?.(owned, g?._loadLocalHand?.() || [], localLayout),
            wireTile: board?.tilePositionsByPlayer?.[uid]?.find((p) => p.id === tile?.id),
            ownedLen: owned.length,
            tilesLen: g?.tiles?.length,
            handRec: { resetCount: handRec.resetCount, inventorySeq: handRec.inventorySeq, handLen: handRec.hand?.length },
            clientInv: g?._mpClientInventorySeq?.(uid),
            boardInv: g?._boardInventorySeq?.(board, uid),
            lastDumpSeq: g?._lastDumpSeq,
            boardDumpSeq: board?.dumpSeq
        };
    }, { lbl: label });
}

async function main() {
    await ensureTestStack();
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const page1 = await ctx.newPage();
    const page2 = await ctx.newPage();

    await joinBananaPartyViaInvite(page1, page2, roomId, { log: () => {} });
    const frame1 = await getGameFrame(page1);
    const frame2 = await getGameFrame(page2);
    await splitViaDrag(frame1);
    await page1.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.gameStarted;
    }, { timeout: 12000 });

    await dragTileByIndex(frame2, 1, -70, 50);
    await dumpTile(frame1, -1, { hostPage: page1 });
    await flushHostBananaInteractions(page1);
    await hostPublishPartyBoard(page1);
    await page2.waitForTimeout(500);

    console.log('--- after dump+publish (guest) ---');
    console.log(JSON.stringify(await layoutDiag(page2, 'after-publish'), null, 2));

    await frame2.evaluate(() => window.game._persistMpLayout?.());
    console.log('--- after persist (guest) ---');
    console.log(JSON.stringify(await layoutDiag(page2, 'after-persist'), null, 2));

    await page2.reload({ waitUntil: 'load' });
    await page2.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: 15000 });
    await page2.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.identitySynced && g.isMultiplayer && g.mode === 'multiplayer';
    }, { timeout: 15000 });

    const preApply = await page2.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const layoutKey = g?.getLayoutPersistKey?.();
        const handKey = g?.getHandPersistKey?.();
        const rawLayout = layoutKey ? localStorage.getItem(layoutKey) : null;
        const rawHand = handKey ? localStorage.getItem(handKey) : null;
        return { rawLayout: rawLayout ? JSON.parse(rawLayout)['2:t-1'] : null, rawHand: rawHand ? JSON.parse(rawHand) : null };
    });
    console.log('--- localStorage before tiles (guest) ---');
    console.log(JSON.stringify(preApply, null, 2));

    await page2.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.tiles?.length > 0;
    }, { timeout: 15000 });

    console.log('--- after reload (guest) ---');
    const after = await layoutDiag(page2, 'after-reload');
    const extra = await page2.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board;
        const uid = g?._myUid?.();
        const owned = g?._boardAuthoritativeOwned?.(board, uid) || [];
        return {
            guestAuthLayout: g?._guestHasAuthoritativeLocalLayout?.(owned),
            shouldCoerce: g?._shouldCoerceGuestToRackLayout?.(
                board, uid, owned,
                g?._loadLocalLayout?.(),
                g?._lastMpLayoutAuthority?.source,
                {}
            ),
            handTile: (g?._loadLocalHandRecord?.().hand || []).find((t) => t.id === '2:t-1'),
            clientLayoutTile: g?._mpClientLayout?.['2:t-1']
        };
    });
    console.log(JSON.stringify({ ...after, ...extra }, null, 2));

    await browser.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
