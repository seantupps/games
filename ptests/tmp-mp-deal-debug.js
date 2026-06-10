/**
 * One-off: reproduce MP deal timeout with full debug capture.
 * node ptests/tmp-mp-deal-debug.js
 */
require('./shared/infra/bootstrap');
const { chromium } = require('playwright');
const { ensureTestStack } = require('./shared/infra/emulator-utils');
const { joinBananaPartyViaInvite } = require('./games/bananagrams/lib/mp-join');
const { readMpDebugSnapshot } = require('./games/bananagrams/lib/mp-debug-bridge');
const { DESKTOP_VIEWPORT } = require('./shared/infra/viewport-constants');

const WAIT_MS = 8000;
const roomId = `MP_DEBUG_DEAL_${Date.now().toString(36).slice(-6).toUpperCase()}`;

async function readHostAuthority(page) {
    return page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return { error: 'no game' };
        const proto = Object.getPrototypeOf(g);
        const PG = win.BananagramsGame?.prototype;
        const checks = {
            _boardInventorySeq_onInstance: typeof g._boardInventorySeq,
            _boardInventorySeq_onClassProto: typeof PG?._boardInventorySeq,
            _hostValidateDealTxn: typeof g._hostValidateDealTxn,
            _seedMpAppliedResetFromRoom: typeof g._seedMpAppliedResetFromRoom,
            _applyMpInventoryAxis: typeof g._applyMpInventoryAxis,
            _hostSyncBoard: typeof g._hostSyncBoard,
            BananagramsGameInFrame: typeof win.BananagramsGame,
            mpDebugLoaded: typeof win.__bananaMpDebug?.snapshot,
            scriptsLoaded: [...(win.document?.scripts || [])]
                .map((s) => s.src?.split('/').pop())
                .filter((n) => n?.startsWith('mp-'))
        };
        const board = (typeof RtdbSchema !== 'undefined' && g.roomData)
            ? RtdbSchema.readBoardFromRoom(g.roomData)
            : g.roomData?.global?.board;
        const uids = g._getPlayerUids?.() || [];
        const mpOwned = {};
        Object.keys(g._mpOwned || {}).forEach((uid) => {
            mpOwned[uid] = (g._mpOwned[uid] || []).length;
        });
        const handSize = g._handSizeForParty?.() ?? null;
        let dealFailureReason = null;
        if (typeof g._hostDealTxnFailureReason === 'function' && uids.length >= 2 && handSize) {
            const dealBoard = typeof g._hostAuthorityBoardSnapshot === 'function'
                ? g._hostAuthorityBoardSnapshot(uids)
                : null;
            const txn = {
                uids,
                handSize,
                deckSize: uids.length * handSize + (g._tilePool?.length || 0),
                pool: [...(g._tilePool || [])],
                tilesOwnedByPlayer: dealBoard?.tilesOwnedByPlayer || {},
                inventorySeq: dealBoard?.inventorySeq || g._mpInventorySeq || {}
            };
            dealFailureReason = g._hostDealTxnFailureReason(txn);
        }
        return {
            checks,
            started: g.started,
            gameStarted: g.gameStarted,
            tiles: g.tiles?.length ?? 0,
            pool: g._tilePool?.length ?? 0,
            mpOwned,
            uids,
            handSize,
            hostDealInFlight: !!g._hostInitialDealInFlight,
            lastInventoryApply: g._lastMpInventoryApply ? { ...g._lastMpInventoryApply } : null,
            boardHands: Object.fromEntries(
                Object.entries(board?.tilesOwnedByPlayer || {}).map(([u, h]) => [u, h?.length ?? 0])
            ),
            boardSeq: board?.seq ?? null,
            dealFailureReason,
            validateDealOk: typeof g._hostValidateDealTxn === 'function' && uids.length >= 2 && handSize
                ? g._hostValidateDealTxn({
                    uids,
                    handSize,
                    deckSize: uids.length * handSize + (g._tilePool?.length || 0),
                    pool: [...(g._tilePool || [])],
                    tilesOwnedByPlayer: (typeof g._hostAuthorityBoardSnapshot === 'function'
                        ? g._hostAuthorityBoardSnapshot(uids)
                        : {})?.tilesOwnedByPlayer || {},
                    inventorySeq: g._mpInventorySeq || {}
                })
                : null
        };
    });
}

async function main() {
    await ensureTestStack();
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });

    // Baseline: load game iframe directly — are mixins on prototype?
    const probe = await ctx.newPage();
    const probeErrors = [];
    probe.on('pageerror', (e) => probeErrors.push(e.message));
    probe.on('console', (msg) => {
        if (msg.type() === 'error') probeErrors.push(msg.text());
    });
    await probe.goto('http://127.0.0.1:8000/games/bananagrams/index.html?mode=multiplayer', {
        waitUntil: 'networkidle'
    });
    const directLoad = await probe.evaluate(async () => {
        const errors = [];
        const orig = console.error;
        console.error = (...a) => errors.push(a.map(String).join(' '));
        const scripts = [...document.scripts].map((s) => s.src?.split('/').pop()).filter(Boolean);
        return {
            seq: typeof BananagramsGame.prototype._boardInventorySeq,
            epoch: typeof BananagramsGame.prototype._seedMpAppliedResetFromRoom,
            txn: typeof BananagramsGame.prototype._hostValidateDealTxn,
            board: typeof BananagramsGame.prototype._applyMpInventoryAxis,
            gameBoot: typeof window.game?._boardInventorySeq,
            scripts,
            errors: window.__mpLoadErrors || errors
        };
    });
    console.log('\n=== DIRECT IFRAME LOAD (prototype probe) ===');
    console.log(JSON.stringify(directLoad, null, 2));
    if (probeErrors.length) {
        console.log('\n--- direct load page errors ---');
        probeErrors.forEach((e) => console.log(e));
    }
    await probe.close();

    const page1 = await ctx.newPage();
    const page2 = await ctx.newPage();

    const consoleLines = [];
    for (const [page, label] of [[page1, 'P1'], [page2, 'P2']]) {
        page.on('console', (msg) => {
            const text = msg.text();
            if (text.includes('Bananagrams') || text.includes('deal') || text.includes('inventory')
                || text.includes('HOST') || msg.type() === 'error') {
                consoleLines.push(`[${label} ${msg.type()}] ${text}`);
            }
        });
        page.on('pageerror', (e) => consoleLines.push(`[${label} PAGEERROR] ${e.message}`));
    }

    try {
        await joinBananaPartyViaInvite(page1, page2, roomId, { log: (m) => console.log(`[JOIN] ${m}`) });
        console.log('\n=== JOIN SUCCEEDED (unexpected) ===');
    } catch (err) {
        console.log('\n=== JOIN FAILED (expected repro) ===');
        console.log(err.message);
    }

    console.log('\n--- browser console (filtered) ---');
    consoleLines.forEach((l) => console.log(l));

    const [auth, snap] = await Promise.all([
        readHostAuthority(page1),
        readMpDebugSnapshot(page1)
    ]);

    console.log('\n--- host authority ---');
    console.log(JSON.stringify(auth, null, 2));
    console.log('\n--- host __bananaMpDebug.snapshot (full) ---');
    console.log(JSON.stringify(snap, null, 2));

    await browser.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
