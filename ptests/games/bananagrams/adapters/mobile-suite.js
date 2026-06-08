/**
 * Bananagrams mobile-only audit steps (solo + MP extras).
 * Desktop coverage lives in ptests/desktop/singleplayer/bananagrams.js and mp_bananagrams.js.
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { MP_BOARD_SYNC_MS } = require('../../../platform/mobile/lib/mobile-constants');
const {
    getGameFrame,
    assertFaceDownRack,
    assertBananagramsRackFitsViewport,
    touchPanBackground,
    touchTapBackgroundStable,
    touchDragTile,
    holdDump,
    assertSettingsEdgeSwipeDisabled,
    assertNoMarqueeOnMobile
} = require('./mobile-touch');
const { assertPinchZoomRange } = require('../../../platform/mobile/lib/mobile_assertions');

function log(msg) {
    console.log(`[TEST] ${msg}`);
}

async function readSoloDistributionState(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const bag = BananaRules.SOLO_FAST_TILE_BAG;
        const counts = {};
        const add = (entry) => {
            const ch = typeof entry === 'string'
                ? entry.toUpperCase()
                : String(entry?.letter || '').toUpperCase();
            if (!/^[A-Z]$/.test(ch)) return;
            counts[ch] = (counts[ch] || 0) + 1;
        };
        (g?.tiles || []).forEach(add);
        (g?._tilePool || []).forEach(add);

        const mismatches = [];
        const letters = new Set([...Object.keys(bag), ...Object.keys(counts)]);
        for (const letter of letters) {
            const got = counts[letter] || 0;
            const want = bag[letter] || 0;
            if (got !== want) mismatches.push({ letter, got, want });
        }

        return {
            pool: g?._tilePool?.length ?? 0,
            board: g?.tiles?.length ?? 0,
            total: (g?._tilePool?.length ?? 0) + (g?.tiles?.length ?? 0),
            mismatches,
            counts
        };
    });
}

async function waitBananagramsReady(page) {
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && g.started && g.tiles?.length >= 21 && g._dictReady && g._checker;
    }, { timeout: STEP_MS });
}

async function resetSoloHand(gameFrame) {
    await gameFrame.evaluate(() => {
        window.localStorage.clear();
        window.game.onGameReset();
    });
    await gameFrame.waitForFunction(() => {
        const g = window.game;
        return g && g.started && g.tiles.length >= 21 && !g.gameStarted
            && g._dictReady && !!g._checker;
    }, { timeout: STEP_MS });
}

const { sp, layout } = require('../assertions');
const { testBananasDevWinDoneTwice } = sp;

/** Full solo mobile audit (audit_base provides hub + iframe navigation). */
async function runBananagramsSpMobile(page) {
    log('Bananagrams solo mobile suite...');
    await waitBananagramsReady(page);
    let gameFrame = await getGameFrame(page);

    log('Mobile rack fits viewport after refreshMobileLayout...');
    await assertBananagramsRackFitsViewport(page, { ms: STEP_MS });
    log('SUCCESS: Rack visible inside mobile viewport.');

    log('Mobile solo settings Bananagrams reset matches refresh rack placement...');
    const { assertMobileSoloSettingsResetMatchesRefresh } = layout.mobileViewport;
    await assertMobileSoloSettingsResetMatchesRefresh(page, {
        label: 'solo mobile settings Bananagrams reset vs refresh',
        timeoutMs: STEP_MS
    });
    log('SUCCESS: Settings menu reset matches refresh rack placement on mobile.');

    log('Mobile rack auto-fits even with low persisted zoom...');
    const { assertBananagramsRackVisibleWithLowPersistedZoom } = layout.hub;
    await assertBananagramsRackVisibleWithLowPersistedZoom(page, { ms: STEP_MS });
    await waitBananagramsReady(page);
    gameFrame = await getGameFrame(page);
    log('SUCCESS: Rack visible without manual pinch after bad zoom.');

    log('Left-edge settings swipe disabled on bananagrams mobile...');
    await assertSettingsEdgeSwipeDisabled(page);
    log('SUCCESS: Settings edge swipe does not open sidebar.');

    log('Initial deal: letters hidden before first move (face-down)...');
    await assertFaceDownRack(gameFrame, 'initial deal');
    log('SUCCESS: Letters hidden on initial deal.');

    await resetSoloHand(gameFrame);

    log('After reset: letters hidden before first move (face-down)...');
    await assertFaceDownRack(gameFrame, 'fresh hand');
    log('SUCCESS: Face-down starting rack.');

    log('Solo fast bag (50 tiles, 29 bunch)...');
    const soloPool = await gameFrame.evaluate(() => ({
        fastTotal: BananaRules.poolTotal(BananaRules.SOLO_FAST_TILE_BAG),
        hand: BananaRules.SOLO_HAND,
        hud: document.getElementById('banana-pool-count')?.textContent,
        poolLen: window.game._tilePool.length,
        bagMode: window.game.serializeBoard?.()?.bagMode
    }));
    if (soloPool.fastTotal !== 50 || soloPool.hand !== 21 || soloPool.hud !== '29') {
        throw new Error(`Solo fast bag HUD wrong (${JSON.stringify(soloPool)})`);
    }
    log('SUCCESS: Solo fast bag + bunch HUD.');

    log('One-finger background pan (touch)...');
    const pan = await touchPanBackground(gameFrame);
    if (!pan.ok || !pan.panInit) {
        throw new Error(`Touch background pan failed (${JSON.stringify(pan)})`);
    }
    log(`SUCCESS: Touch pan moved board (${Math.round(pan.dist)}px).`);

    log('Background tap must not recenter view...');
    const tapStable = await touchTapBackgroundStable(gameFrame);
    if (!tapStable.ok) {
        throw new Error(`Background tap shifted view (${JSON.stringify(tapStable)})`);
    }
    log('SUCCESS: Background tap did not recenter pan.');

    log('Touch drag starts game (letters revealed)...');
    const start = await touchDragTile(gameFrame, 0, 36, 36);
    await gameFrame.waitForFunction(() => {
        const g = window.game;
        const el = document.querySelector('[data-tile-id="t-0"]');
        return g?.gameStarted && g.tiles.every((t) => t.faceUp)
            && el && !el.classList.contains('is-face-down');
    }, { timeout: STEP_MS });
    if (!start.ok) {
        throw new Error(`Touch drag should move a tile (${JSON.stringify(start)})`);
    }
    log('SUCCESS: Touch drag started game.');

    log('Refresh: solo mobile restores current in-progress board...');
    const soloBeforeRefresh = await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const tiles = (g?.tiles || []).map((t) => ({
            id: t.id,
            x: Math.round(t.x),
            y: Math.round(t.y),
            letter: t.letter
        }));
        tiles.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return {
            started: !!g?.started,
            gameStarted: !!g?.gameStarted,
            pool: g?._tilePool?.length ?? 0,
            count: tiles.length,
            sig: JSON.stringify(tiles)
        };
    });
    await page.reload({ waitUntil: 'load' });
    await waitBananagramsReady(page);
    gameFrame = await getGameFrame(page);
    const soloAfterRefresh = await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const tiles = (g?.tiles || []).map((t) => ({
            id: t.id,
            x: Math.round(t.x),
            y: Math.round(t.y),
            letter: t.letter
        }));
        tiles.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return {
            started: !!g?.started,
            gameStarted: !!g?.gameStarted,
            pool: g?._tilePool?.length ?? 0,
            count: tiles.length,
            sig: JSON.stringify(tiles)
        };
    });
    if (soloBeforeRefresh.sig !== soloAfterRefresh.sig
        || soloBeforeRefresh.pool !== soloAfterRefresh.pool
        || !soloAfterRefresh.started
        || !soloAfterRefresh.gameStarted) {
        throw new Error(`Solo refresh should restore in-progress board (${JSON.stringify({
            before: soloBeforeRefresh,
            after: soloAfterRefresh
        })})`);
    }
    await assertBananagramsRackFitsViewport(page, { ms: STEP_MS });
    log('SUCCESS: Solo refresh preserved board state and kept tiles in view.');

    log('Hold-to-dump (+3 off-rack)...');
    const dump = await holdDump(gameFrame, -1);
    if (!dump.ok) throw new Error(`Hold dump failed (${JSON.stringify(dump)})`);
    log('SUCCESS: Hold dump exchanged 1 for 3.');

    log('Distribution stability under repeated real touch dumps...');
    let dumpSteps = 1;
    for (let i = 0; i < 30; i++) {
        const canDump = await gameFrame.evaluate(() => {
            const g = window.game;
            return (g?._tilePool?.length ?? 0) >= 2 && (g?.tiles?.length ?? 0) > 0;
        });
        if (!canDump) break;
        const nextDump = await holdDump(gameFrame, -1);
        if (!nextDump.ok) {
            throw new Error(`Repeated hold dump failed at step ${dumpSteps + 1} (${JSON.stringify(nextDump)})`);
        }
        dumpSteps += 1;
        const state = await readSoloDistributionState(gameFrame);
        if (state.mismatches.length) {
            throw new Error(
                `Distribution mismatch after dump ${dumpSteps}: ${JSON.stringify({
                    board: state.board,
                    pool: state.pool,
                    total: state.total,
                    mismatches: state.mismatches.slice(0, 8)
                })}`
            );
        }
    }
    const finalDist = await readSoloDistributionState(gameFrame);
    if (finalDist.mismatches.length) {
        throw new Error(`Final distribution mismatch: ${JSON.stringify(finalDist.mismatches.slice(0, 12))}`);
    }
    log(
        `SUCCESS: Dump distribution stable through ${dumpSteps} dumps (board=${finalDist.board}, pool=${finalDist.pool}, total=${finalDist.total}).`
    );

    log('Marquee not available on mobile...');
    await assertNoMarqueeOnMobile(gameFrame);
    log('SUCCESS: No marquee selection on mobile.');

    log('Pinch zoom (two fingers)...');
    await assertPinchZoomRange(page, STEP_MS);
    log('SUCCESS: Pinch zoom in/out.');

    log('AI solver playthrough (placement, peel, dump)...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const { runSoloFullGameAudit } = require('../scenarios/sp/actions');
    await runSoloFullGameAudit(page);
    gameFrame = await getGameFrame(page);
    log('SUCCESS: AI solver playthrough complete.');

    await testBananasDevWinDoneTwice(page, gameFrame, { log, timeout: STEP_MS });
    log('SUCCESS: Bananagrams solo mobile suite passed.');
}

/** Extra checks at start of MP audit (both clients). */
async function runBananagramsMpMobileExtras(page1, page2) {
    const syncMs = MP_BOARD_SYNC_MS;
    log('MP mobile: rack fits viewport (host + guest)...');
    await assertBananagramsRackFitsViewport(page1, { ms: syncMs, minTiles: 3 });
    await assertBananagramsRackFitsViewport(page2, { ms: syncMs, minTiles: 3 });
    log('SUCCESS: MP racks fit mobile viewport.');

    const frame1 = await getGameFrame(page1);
    const frame2 = await getGameFrame(page2);
    log('MP mobile: letters hidden before SPLIT...');
    await assertFaceDownRack(frame1, 'host pre-SPLIT');
    await assertFaceDownRack(frame2, 'guest pre-SPLIT');
    log('SUCCESS: MP letters hidden before game starts.');

    log('MP mobile: pinch zoom on host...');
    await assertPinchZoomRange(page1, syncMs);
    log('SUCCESS: MP pinch zoom.');

    log('MP mobile: no marquee on host...');
    await assertNoMarqueeOnMobile(frame1);
    log('SUCCESS: MP no marquee on mobile.');
}

/** 3p+ mobile extras — host/guest checks plus each extra remote client. */
async function runMpMobileExtrasN(pages, frames, opts = {}) {
    const mobileAll = !!opts.mobileAll;
    const p3Mobile = !!opts.p3Mobile;
    if (!mobileAll && !p3Mobile) return;
    const syncMs = MP_BOARD_SYNC_MS;
    if (mobileAll && pages.length >= 2) {
        await runBananagramsMpMobileExtras(pages[0], pages[1]);
    }
    for (let i = 2; i < pages.length; i++) {
        const role = `P${i + 1}`;
        log(`MP mobile: ${role} rack fits viewport...`);
        await assertBananagramsRackFitsViewport(pages[i], { ms: syncMs, minTiles: 4 });
        await assertFaceDownRack(frames[i], `${role} pre-SPLIT`);
        log(`SUCCESS: ${role} mobile rack + face-down checks.`);
        log(`MP mobile: no marquee on ${role}...`);
        await assertNoMarqueeOnMobile(frames[i]);
        log(`SUCCESS: ${role} no marquee on mobile.`);
    }
}

module.exports = {
    runBananagramsSpMobile,
    runBananagramsMpMobileExtras,
    runMpMobileExtrasN,
    /** @deprecated use runMpMobileExtrasN */
    runMpMobileExtras3p: runMpMobileExtrasN
};
