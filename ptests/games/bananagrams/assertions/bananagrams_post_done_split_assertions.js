/**
 * After post-game Done (face-down redeal): host SPLIT must sync gameStarted + face-up on both clients.
 */
const { waitForPreSplitHand } = require('./bananagrams_guest_first_split_assertions');

/**
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 * @param {object} lib mp-lib exports (getGameFrame, splitViaDrag, waitForDiag, flushHostBananaInteractions, log, WAIT_MS)
 * @param {{ mobile?: boolean, label?: string }} [options]
 */
async function assertHostSplitSyncsBothAfterPostGameReset(hostPage, guestPage, lib, options = {}) {
    const {
        getGameFrame,
        splitViaDrag,
        waitForDiag,
        flushHostBananaInteractions,
        log,
        WAIT_MS
    } = lib;

    const label = options.label || 'post-Done host SPLIT';
    const mobile = !!options.mobile;
    const mp = { page1: hostPage, page2: guestPage };

    log(`${label}: wait face-down pre-SPLIT hands on host and guest`);
    await flushHostBananaInteractions(hostPage).catch(() => {});
    await Promise.all([
        waitForPreSplitHand(hostPage, 'P1', mp, lib),
        waitForPreSplitHand(guestPage, 'P2', mp, lib)
    ]);

    const hostFrame = await getGameFrame(hostPage);
    const guestFrame = await getGameFrame(guestPage);
    const readPreSplit = () => hostFrame.evaluate(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board;
        return {
            gameStarted: !!g?.gameStarted,
            started: !!g?.started,
            postGameReview: !!g?._postGameReview,
            phase: g?.deriveGamePhase?.() ?? null,
            boardPhase: board?.phase ?? null,
            boardGameStarted: !!board?.gameStarted,
            canMutate: g?.canMutatePlayingBoard?.() ?? null,
            tileCount: g?.tiles?.length ?? 0,
            faceDown: (g?.tiles || []).every((t) => !t.faceUp)
        };
    });

    const preSplit = {
        host: await readPreSplit(),
        guest: await guestFrame.evaluate(() => {
            const g = window.game;
            const board = g?.roomData?.global?.board;
            return {
                gameStarted: !!g?.gameStarted,
                started: !!g?.started,
                postGameReview: !!g?._postGameReview,
                phase: g?.deriveGamePhase?.() ?? null,
                boardPhase: board?.phase ?? null,
                boardGameStarted: !!board?.gameStarted,
                canMutate: g?.canMutatePlayingBoard?.() ?? null,
                tileCount: g?.tiles?.length ?? 0,
                faceDown: (g?.tiles || []).every((t) => !t.faceUp)
            };
        })
    };

    if (preSplit.host.gameStarted || preSplit.guest.gameStarted) {
        throw new Error(`${label}: expected gameStarted=false before host SPLIT (${JSON.stringify(preSplit)})`);
    }
    if (preSplit.host.postGameReview || preSplit.guest.postGameReview) {
        throw new Error(`${label}: still in postGameReview before SPLIT (${JSON.stringify(preSplit)})`);
    }
    if (!preSplit.host.canMutate || !preSplit.guest.canMutate) {
        throw new Error(`${label}: canMutatePlayingBoard must be true before SPLIT (${JSON.stringify(preSplit)})`);
    }

    log(`${label}: host drags tile to SPLIT`);
    await flushHostBananaInteractions(hostPage);
    const splitHost = await splitViaDrag(hostFrame, { mobile });
    if (!splitHost.ok || !splitHost.gameStarted) {
        throw new Error(`${label}: host SPLIT failed (${JSON.stringify({ splitHost, preSplit })})`);
    }

    await Promise.all([
        waitForDiag(hostPage, `${label} host started`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            return g?.gameStarted && !!doc?.getElementById('banana-timer');
        }, undefined, WAIT_MS, mp),
        waitForDiag(guestPage, `${label} guest synced`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            const tiles = doc ? [...doc.querySelectorAll('.tile')] : [];
            const faceUp = tiles.length > 0 && tiles.every((t) => !t.classList.contains('is-face-down'));
            return g?.gameStarted && faceUp;
        }, undefined, WAIT_MS, mp)
    ]).catch(async (err) => {
        const snap = await guestPage.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board;
            const doc = document.getElementById('game-frame')?.contentDocument;
            const tiles = doc ? [...doc.querySelectorAll('.tile')] : [];
            return {
                gameStarted: !!g?.gameStarted,
                boardGameStarted: !!board?.gameStarted,
                boardSeq: board?.seq ?? null,
                phase: g?.deriveGamePhase?.() ?? null,
                postGameReview: !!g?._postGameReview,
                faceUpModel: (g?.tiles || []).every((t) => t.faceUp),
                faceUpDom: tiles.every((t) => !t.classList.contains('is-face-down')),
                tileCount: tiles.length
            };
        }).catch(() => null);
        throw new Error(`${label}: guest did not sync host SPLIT (${JSON.stringify(snap)}): ${err.message}`);
    });

    const guestSplit = await guestFrame.evaluate(() => {
        const doc = document;
        const tiles = [...doc.querySelectorAll('.tile')];
        const g = window.game;
        return {
            faceUp: tiles.every((t) => !t.classList.contains('is-face-down')),
            hasTimer: !!doc.getElementById('banana-timer'),
            gameStarted: !!g?.gameStarted,
            boardGameStarted: !!g?.roomData?.global?.board?.gameStarted
        };
    });
    if (!guestSplit.faceUp || !guestSplit.gameStarted) {
        throw new Error(`${label}: guest SPLIT incomplete (${JSON.stringify(guestSplit)})`);
    }

    log(`SUCCESS: ${label} — host SPLIT synced on both clients (timer + face-up)`);
}

module.exports = {
    assertHostSplitSyncsBothAfterPostGameReset
};
