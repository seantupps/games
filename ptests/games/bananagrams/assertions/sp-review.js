/**
 * Solo Bananagrams: victory → post-game review → Done → new face-down hand.
 * Shared by desktop and mobile audits.
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const {
    assertTimerFrozenInReview,
    assertDoneButtonVisible
} = require('./mp-review');
const { assertTileDistributionInReview } = require('./mp-distribution');

function defaultLog(msg) {
    console.log(`[TEST] ${msg}`);
}

async function enableFastBanners(gameFrame) {
    await gameFrame.evaluate(() => {
        const g = window.game;
        if (!g || g._bannerFast) return;
        g._bannerFast = true;
        const orig = g._showBanner.bind(g);
        g._showBanner = (text, ms = 2200, bannerOpts) => orig(text, Math.min(ms, 400), bannerOpts);
    });
}

/** Hub chat `/win` path — postMessage dev-win into the game iframe. */
async function triggerDevWin(page) {
    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        if (win) win.postMessage({ type: 'dev-win' }, '*');
    });
}

async function ensureFreshSoloHand(gameFrame) {
    await gameFrame.evaluate(() => {
        const g = window.game;
        g._victoryRegistered = false;
        g._postGameReview = false;
        g._reviewDone = {};
        g._timerFrozen = false;
        g._bannerText = '';
        g._bannerUntil = 0;
        try {
            window.localStorage.removeItem(g.getPersistKey());
        } catch (_) { /* ignore */ }
        g.onGameReset();
    });
    await gameFrame.waitForFunction(() => {
        const g = window.game;
        return g && g._dictReady && g._checker && g.started && g.tiles?.length >= 21;
    }, { timeout: STEP_MS });
}

/**
 * Place a valid 4-tile crossword using tiles already in hand (keeps real tile ids/letters).
 */
async function setupSoloWinBoardFromHand(gameFrame) {
    return gameFrame.evaluate(() => {
        const g = window.game;
        if (!g?._checker || !BananaGrid) return { ok: false, reason: 'no-checker' };

        const gap = BananaRules.TILE_GAP;
        const y0 = g.ORIGIN - 200;

        const tryOnce = () => {
            if (!g.gameStarted) g.gameStarted = true;
            g.tiles.forEach((t) => { t.faceUp = true; });
            const hand = [...g.tiles];
            const used = new Set();
            const pick = (letter) => {
                const t = hand.find((x) => x.letter === letter && !used.has(x));
                if (t) used.add(t);
                return t || null;
            };
            const c = pick('C');
            const a = pick('A');
            const tv = pick('T');
            const th = hand.find((x) => x.letter === 'T' && !used.has(x)) || null;
            if (th) used.add(th);
            if (!c || !a || !tv || !th) return null;

            c.x = g.ORIGIN;
            c.y = y0;
            c.faceUp = true;
            a.x = g.ORIGIN;
            a.y = y0 + gap;
            a.faceUp = true;
            tv.x = g.ORIGIN;
            tv.y = y0 + gap * 2;
            tv.faceUp = true;
            th.x = g.ORIGIN + gap;
            th.y = y0 + gap;
            th.faceUp = true;
            g.tiles = [c, a, tv, th];

            if (!g._allTilesPlaced()) return null;
            const valid = BananaGrid.validateGrid(g.tiles, g._checker);
            if (!valid.ok) return null;

            return g.tiles.map((t) => ({
                id: t.id,
                letter: t.letter,
                x: t.x,
                y: t.y
            }));
        };

        for (let attempt = 0; attempt < 100; attempt++) {
            const snapshot = tryOnce();
            if (snapshot) return { ok: true, snapshot, attempts: attempt + 1 };
            g.setupNewHand();
            g.beginGame();
        }
        return {
            ok: false,
            reason: 'could-not-build-valid-board-from-hand',
            letters: g.tiles.map((t) => t.letter)
        };
    });
}

async function startSoloTimer(gameFrame) {
    await gameFrame.evaluate(() => {
        const g = window.game;
        if (!g.gameStarted) {
            g.gameStarted = true;
            g._timerFrozen = false;
            g._timerStart = Date.now() - 1200;
            g.elapsedMs = 1200;
            g._startTimer();
            g._updateHudEl();
        }
    });
}

async function assertReviewShowsPlayerBoard(gameFrame, snapshot, label) {
    const state = await gameFrame.evaluate((snap) => {
        const g = window.game;
        if (!g?._postGameReview) return { ok: false, reason: 'not-in-review' };
        const onBoard = (g.tiles || []).map((t) => ({
            id: t.id,
            letter: t.letter,
            x: t.x,
            y: t.y
        }));
        if (onBoard.length !== snap.length) {
            return { ok: false, reason: 'count', onBoard, snap };
        }
        const mismatch = snap.find((s) => {
            const t = onBoard.find((x) => x.id === s.id);
            return !t || t.letter !== s.letter;
        });
        if (mismatch) return { ok: false, reason: 'tile-mismatch', mismatch, onBoard, snap };
        return { ok: true, onBoard };
    }, snapshot);
    if (!state.ok) {
        throw new Error(`${label}: review must show your board (${JSON.stringify(state)})`);
    }
}

async function waitSoloPostGameReview(gameFrame, timeout) {
    await gameFrame.waitForFunction(() => {
        const g = window.game;
        const btn = document.getElementById('banana-done-btn');
        return g?._postGameReview && g.isOver && g._victoryRegistered
            && g._timerFrozen && btn?.classList.contains('show');
    }, { timeout });
}

async function clickDone(gameFrame) {
    await gameFrame.evaluate(() => {
        const g = window.game;
        const btn = document.getElementById('banana-done-btn');
        if (!btn?.classList.contains('show')) throw new Error('Done button not visible');
        if (typeof g._onDonePressed === 'function') g._onDonePressed();
        else btn.click();
    });
}

async function waitSoloFaceDownHand(gameFrame, timeout) {
    await gameFrame.waitForFunction(() => {
        const g = window.game;
        const minHand = typeof BananaRules !== 'undefined' ? BananaRules.SOLO_HAND : 21;
        const hand = g?.tiles || [];
        const btn = document.getElementById('banana-done-btn');
        return g && !g._postGameReview && !g.isOver && !g._victoryRegistered
            && hand.length >= minHand
            && hand.every((t) => !t.faceUp)
            && !btn?.classList.contains('show');
    }, { timeout });
}

function looksLikeTimer(text) {
    return /^\d+:\d{2}$/.test(String(text || '').trim());
}

async function testBananasDevWinDoneTwice(page, gameFrame, opts = {}) {
    const log = opts.log || defaultLog;
    const timeout = opts.timeout ?? STEP_MS;
    await enableFastBanners(gameFrame);
    await ensureFreshSoloHand(gameFrame);
    await startSoloTimer(gameFrame);

    for (let round = 1; round <= 2; round++) {
        log(`Solo dev /win round ${round}: snapshot board, trigger victory...`);
        const setup = await gameFrame.evaluate(() => {
            const g = window.game;
            if (!g?.tiles?.length) return { ok: false, reason: 'no-tiles' };
            return {
                ok: true,
                snapshot: g.tiles.map((t) => ({
                    id: t.id,
                    letter: t.letter,
                    x: t.x,
                    y: t.y
                }))
            };
        });
        if (!setup.ok) {
            throw new Error(`Round ${round}: no tiles to snapshot (${JSON.stringify(setup)})`);
        }

        await triggerDevWin(page);
        await waitSoloPostGameReview(gameFrame, timeout);
        await assertReviewShowsPlayerBoard(gameFrame, setup.snapshot, `round-${round}-review`);
        await assertDoneButtonVisible(gameFrame, true, `round-${round}-solo-done`);
        await assertTimerFrozenInReview(gameFrame, `round-${round}-solo-timer`);
        const dist = await assertTileDistributionInReview(gameFrame, `round-${round}-distribution`);
        log(`SUCCESS: Round ${round} — tile distribution matches bag (${dist.bagLabel}, ${dist.actualTotal} tiles).`);

        const review = await gameFrame.evaluate(() => ({
            banner: window.game._bannerText,
            tileIds: (window.game.tiles || []).map((t) => t.id)
        }));
        if (review.banner) {
            throw new Error(`Round ${round}: no in-game win banner (${JSON.stringify(review)})`);
        }
        log(`SUCCESS: Round ${round} — review + frozen timer (${review.tileIds.length} tiles).`);

        await clickDone(gameFrame);
        await waitSoloFaceDownHand(gameFrame, timeout);
        log(`SUCCESS: Round ${round} — Done dealt new face-down hand.`);
    }
}

async function testBananasVictoryDone(page, gameFrame, opts = {}) {
    const log = opts.log || defaultLog;
    const timeout = opts.timeout ?? STEP_MS;
    await enableFastBanners(gameFrame);
    await ensureFreshSoloHand(gameFrame);
    await startSoloTimer(gameFrame);

    log('Victory + Done (natural peel win via empty bunch)...');
    const setup = await setupSoloWinBoardFromHand(gameFrame);
    if (!setup.ok) {
        throw new Error(`Win board setup failed (${JSON.stringify(setup)})`);
    }
    const win = await gameFrame.evaluate(() => {
        const g = window.game;
        g._tilePool = [];
        const peeled = g._checkPeel();
        return {
            peeled,
            banner: g._bannerText,
            isOver: g.isOver,
            victoryRegistered: g._victoryRegistered,
            postGameReview: g._postGameReview,
            timerFrozen: g._timerFrozen
        };
    });
    if (!win.peeled || win.banner) {
        throw new Error(`Expected peel win without BANANAS banner (${JSON.stringify(win)})`);
    }
    if (!win.isOver || !win.victoryRegistered || !win.postGameReview || !win.timerFrozen) {
        throw new Error(`Victory / review / timer freeze not entered (${JSON.stringify(win)})`);
    }
    await assertReviewShowsPlayerBoard(gameFrame, setup.snapshot, 'natural-peel-review');
    await assertDoneButtonVisible(gameFrame, true, 'solo-peel-done');
    await assertTimerFrozenInReview(gameFrame, 'solo-peel-timer');
    log('SUCCESS: Peel win — board in review, timer frozen, Done visible.');

    const hubBanner = await page.evaluate(() => {
        const banner = document.getElementById('global-win-banner');
        return {
            visible: banner?.classList.contains('visible') ?? false,
            text: banner?.innerText ?? ''
        };
    });
    if (!hubBanner.visible || !looksLikeTimer(hubBanner.text)) {
        throw new Error(`Solo hub banner should show elapsed time (${JSON.stringify(hubBanner)})`);
    }
    log(`SUCCESS: Hub victory banner shows time (${hubBanner.text}).`);

    await clickDone(gameFrame);
    await waitSoloFaceDownHand(gameFrame, timeout);
    log('SUCCESS: Done reset — new face-down hand (split on first touch).');
}

module.exports = {
    testBananasVictoryDone,
    testBananasDevWinDoneTwice,
    ensureFreshSoloHand,
    setupSoloWinBoardFromHand,
    assertReviewShowsPlayerBoard,
    triggerDevWin,
    clickDone,
    waitSoloFaceDownHand,
    waitSoloPostGameReview
};
