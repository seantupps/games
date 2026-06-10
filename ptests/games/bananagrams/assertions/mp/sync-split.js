const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

/** Host reset → guest touches tile (SPLIT) → letters must not change for ~3s.
 */
const {
    captureTileStabilitySnapshot,
    assertExistingTilesStableAfterAction
} = require('../layout/tile-stability');

const WATCH_MS = Number(process.env.FIVE_MP_GUEST_SPLIT_WATCH_MS || 1200);
const WATCH_INTERVAL_MS = 100;

/** @param {import('playwright').Page} guestPage */
async function readGuestTileLetters(guestPage) {
    return guestPage.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        const doc = frame?.contentDocument;
        const model = (g?.tiles || [])
            .map((t) => ({ id: t.id, letter: String(t.letter || '').toUpperCase() }))
            .sort((a, b) => a.id.localeCompare(b.id));
        const dom = {};
        if (doc) {
            [...doc.querySelectorAll('.tile')].forEach((node) => {
                const id = node?.dataset?.tileId;
                if (!id) return;
                const text = node.textContent?.trim().toUpperCase() || '';
                dom[id] = text.length === 1 ? text : text.slice(0, 1);
            });
        }
        return {
            modelSig: model.map((t) => `${t.id}:${t.letter}`).join('|'),
            model,
            dom,
            gameStarted: !!g?.gameStarted,
            tileCount: model.length
        };
    });
}

/** Guest drag on first tile — starts SPLIT (Playwright mouse, same threshold as splitViaDrag). */
async function guestTouchTileToStart(guestPage, options = {}) {
    const { flushHostBananaInteractions } = require('../../../../shared/adapters/mp-client');
    const hostPage = options.hostPage || null;
    const timeoutMs = options.timeoutMs ?? 8000;
    const pollMs = options.pollMs ?? 16;

    const iframe = guestPage.frameLocator('#game-frame');
    const tile = iframe.locator('.tile').first();
    await tile.waitFor({ state: 'visible', timeout: 5000 });
    const box = await tile.boundingBox();
    if (!box) return { ok: false, reason: 'no-tile-box' };

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await guestPage.mouse.move(cx, cy);
    await guestPage.mouse.down({ button: 'left' });
    await guestPage.mouse.move(cx + 24, cy + 24, { steps: 4 });
    await guestPage.mouse.up({ button: 'left' });
    await guestPage.evaluate(() => new Promise((res) => {
        requestAnimationFrame(() => requestAnimationFrame(res));
    }));

    const deadline = Date.now() + timeoutMs;
    let last = { ok: false, reason: 'timeout' };
    while (Date.now() < deadline) {
        if (hostPage) await flushHostBananaInteractions(hostPage).catch(() => {});
        last = await guestPage.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board;
            const tileEl = document.getElementById('game-frame')?.contentDocument?.querySelector('.tile');
            const faceUp = tileEl && !tileEl.classList.contains('is-face-down');
            const boardStarted = !!board?.gameStarted;
            const localStarted = !!g?.gameStarted;
            return {
                ok: localStarted && boardStarted && faceUp,
                gameStarted: localStarted,
                boardGameStarted: boardStarted,
                faceUp: !!faceUp,
                tileId: tileEl?.dataset?.tileId || null
            };
        });
        if (last.ok) return last;
        await guestPage.waitForTimeout(pollMs);
    }
    return last;
}

/**
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 * @param {object} lib mp-lib exports
 * @param {{ mobile?: boolean, label?: string }} [options]
 */
async function waitForPreSplitHand(page, role, mp, lib) {
    const { waitForDiag } = lib;
    const timeoutMs = lib.RESET_WAIT_MS || lib.WAIT_MS || 6000;
    await waitForDiag(page, `${role} pre-SPLIT hand`, () => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        const rules = frame?.contentWindow?.BananaRules;
        const doc = frame?.contentDocument;
        const handSize = rules?.startingHandSize?.(2) ?? 21;
        const tiles = g?.tiles || [];
        const faceDown = doc
            && tiles.length > 0
            && [...doc.querySelectorAll('.tile')].every((n) => n.classList.contains('is-face-down'));
        return !!(g
            && g.started
            && !g.gameStarted
            && tiles.length === handSize
            && faceDown);
    }, {}, timeoutMs, mp);
}

async function assertGuestFirstSplitStableAfterReset(hostPage, guestPage, lib, options = {}) {
    const {
        getGameFrame,
        flushHostBananaInteractions,
        dismissBanners,
        log,
        WAIT_MS
    } = lib;

    const label = options.label || 'guest-first-split-after-host-reset';
    const mobile = !!options.mobile;
    const mp = { page1: hostPage, page2: guestPage };

    log(`${label}: (1) host reset`);
    const hostFrame = await getGameFrame(hostPage);
    await hostFrame.evaluate(() => {
        window.game.resetGame();
    });

    log(`${label}: wait for fresh pre-SPLIT deal on both players`);
    await flushHostBananaInteractions(hostPage).catch(() => {});
    if (typeof dismissBanners === 'function') {
        await dismissBanners(hostPage, guestPage).catch(() => {});
    }
    await Promise.all([
        waitForPreSplitHand(hostPage, 'P1', mp, lib),
        waitForPreSplitHand(guestPage, 'P2', mp, lib)
    ]);
    await flushHostBananaInteractions(hostPage).catch(() => {});

    const preTouch = await readGuestTileLetters(guestPage);
    if (!preTouch.tileCount || preTouch.gameStarted) {
        failWithSnapshot('assertion', [`${label}: expected face-down pre-SPLIT hand (${JSON.stringify(preTouch)})`], {});
    }

    const preGate = await guestPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board;
        return {
            canMutate: g?.canMutatePlayingBoard?.() ?? false,
            handMutate: g?._canMutatePlayingHand?.() ?? false,
            authorityReady: g?._mpGuestAuthorityReadyForPlay?.() ?? false,
            boardGameStarted: !!board?.gameStarted
        };
    });
    if (!preGate.canMutate) {
        failWithSnapshot('assertion', [`${label}: canMutatePlayingBoard must be true pre-SPLIT (${JSON.stringify(preGate)})`], {});
    }
    if (preGate.handMutate || preGate.authorityReady || preGate.boardGameStarted) {
        failWithSnapshot('assertion', [`${label}: guest hand mutations blocked pre-SPLIT (${JSON.stringify(preGate)})`], {});
    }

    log(`${label}: (2) guest touches tile to start game`);
    const touch = await guestTouchTileToStart(guestPage, { mobile, hostPage });
    if (!touch.ok || !touch.gameStarted || !touch.boardGameStarted) {
        failWithSnapshot('assertion', [`${label}: guest touch did not start game (${JSON.stringify(touch)})`], {});
    }

    const gateDeadline = Date.now() + (WAIT_MS || 6000);
    let postGate = { handMutate: false, authorityReady: false, inventorySynced: null };
    while (Date.now() < gateDeadline) {
        postGate = await guestPage.evaluate(() => {
            const win = document.getElementById('game-frame')?.contentWindow;
            const g = win?.game;
            const dbg = win?.__bananaMpDebug;
            const coh = typeof dbg?.coherence === 'function' ? dbg.coherence() : null;
            return {
                handMutate: g?._canMutatePlayingHand?.() ?? false,
                authorityReady: g?._mpGuestAuthorityReadyForPlay?.() ?? false,
                inventorySynced: coh?.inventorySynced ?? null
            };
        });
        if (postGate.handMutate && postGate.authorityReady) break;
        await guestPage.waitForTimeout(50);
    }
    if (!postGate.handMutate || !postGate.authorityReady) {
        failWithSnapshot('assertion', [`${label}: guest hand mutations must be allowed after SPLIT (${JSON.stringify(postGate)})`], {});
    }
    await flushHostBananaInteractions(hostPage).catch(() => {});

    const guestFrame = await getGameFrame(guestPage);

    await guestFrame.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    const baseline = await readGuestTileLetters(guestPage);
    if (!baseline.modelSig) {
        failWithSnapshot('assertion', [`${label}: no tile letters after guest touch`], {});
    }

    log(`${label}: (3) watch guest letters for ${WATCH_MS}ms (baseline ${baseline.modelSig.slice(0, 80)}…)`);

    const samples = [{ atMs: 0, ...baseline }];
    const started = Date.now();
    while (Date.now() - started < WATCH_MS) {
        await guestPage.waitForTimeout(WATCH_INTERVAL_MS);
        await flushHostBananaInteractions(hostPage).catch(() => {});
        const snap = await readGuestTileLetters(guestPage);
        samples.push({ atMs: Date.now() - started, ...snap });

        if (snap.modelSig !== baseline.modelSig) {
            failWithSnapshot(label, ['tile letters changed in model'], {
                before: baseline.modelSig,
                after: snap.modelSig,
                samples: samples.slice(-6)
            });
        }

        for (const t of baseline.model) {
            const domLetter = snap.dom[t.id];
            if (domLetter && domLetter !== t.letter) {
                failWithSnapshot(label, [`DOM letter changed for ${t.id} at ${snap.atMs}ms`], {
                    expected: t.letter,
                    got: domLetter
                });
            }
        }
    }

    const posBefore = await captureTileStabilitySnapshot(guestPage);
    await guestPage.waitForTimeout(80);
    const posAfter = await captureTileStabilitySnapshot(guestPage);
    assertExistingTilesStableAfterAction(posBefore, posAfter, `${label} positions`);

    log(`SUCCESS: ${label} — letters stable for ${WATCH_MS}ms after guest SPLIT`);
}

module.exports = {
    assertGuestFirstSplitStableAfterReset,
    readGuestTileLetters,
    guestTouchTileToStart,
    waitForPreSplitHand,
    WATCH_MS
};
