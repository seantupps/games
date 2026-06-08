const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

/** After post-game Done (face-down redeal): host SPLIT must sync gameStarted + face-up on both clients.
 */
const { waitForPreSplitHand } = require('./sync-split');

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
        failWithSnapshot('assertion', [`${label}: expected gameStarted=false before host SPLIT (${JSON.stringify(preSplit)})`], {});
    }
    if (preSplit.host.postGameReview || preSplit.guest.postGameReview) {
        failWithSnapshot('assertion', [`${label}: still in postGameReview before SPLIT (${JSON.stringify(preSplit)})`], {});
    }
    if (!preSplit.host.canMutate || !preSplit.guest.canMutate) {
        failWithSnapshot('assertion', [`${label}: canMutatePlayingBoard must be true before SPLIT (${JSON.stringify(preSplit)})`], {});
    }

    log(`${label}: host drags tile to SPLIT`);
    await flushHostBananaInteractions(hostPage);
    const splitHost = await splitViaDrag(hostFrame, { mobile });
    if (!splitHost.ok || !splitHost.gameStarted) {
        failWithSnapshot('assertion', [`${label}: host SPLIT failed (${JSON.stringify({ splitHost, preSplit })})`], {});
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
        failWithSnapshot('assertion', [`${label}: guest did not sync host SPLIT (${JSON.stringify(snap)}): ${err.message}`], {});
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
        failWithSnapshot('assertion', [`${label}: guest SPLIT incomplete (${JSON.stringify(guestSplit)})`], {});
    }

    log(`SUCCESS: ${label} — host SPLIT synced on both clients (timer + face-up)`);
}

/**
 * N-player: after post-game Done, host SPLIT must sync gameStarted + face-up on every client.
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {object} lib mp-state exports
 * @param {{ mobile?: boolean, label?: string }} [options]
 */
async function assertHostSplitSyncsAllAfterPostGameReset(ctx, lib, options = {}) {
    const {
        getGameFrame,
        splitViaDrag,
        waitForDiag,
        flushHostBananaInteractions,
        log,
        WAIT_MS
    } = lib;
    const { waitForPreSplitHand } = require('./sync-split');

    const label = options.label || 'post-Done host SPLIT';
    const mobile = !!options.mobile;
    const mp = ctx.mp;

    log(`${label}: wait face-down pre-SPLIT hands on all clients`);
    await flushHostBananaInteractions(ctx.host.page).catch(() => {});
    await Promise.all(ctx.players.map((p, i) =>
        waitForPreSplitHand(p.page, p.role || `P${i + 1}`, mp, lib)
    ));

    const hostFrame = await getGameFrame(ctx.host.page);
    const readPreSplit = (frame) => frame.evaluate(() => {
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

    const preSplit = await Promise.all([
        readPreSplit(hostFrame),
        ...ctx.remotes.map((r) => getGameFrame(r.page).then(readPreSplit))
    ]);

    for (let i = 0; i < preSplit.length; i++) {
        const s = preSplit[i];
        const role = ctx.players[i]?.role || `P${i + 1}`;
        if (s.gameStarted) {
            failWithSnapshot('assertion', [`${label}: ${role} gameStarted=true before host SPLIT (${JSON.stringify(s)})`], {});
        }
        if (s.postGameReview) {
            failWithSnapshot('assertion', [`${label}: ${role} still in postGameReview (${JSON.stringify(s)})`], {});
        }
        if (!s.canMutate) {
            failWithSnapshot('assertion', [`${label}: ${role} canMutatePlayingBoard must be true (${JSON.stringify(s)})`], {});
        }
    }

    log(`${label}: host drags tile to SPLIT`);
    await flushHostBananaInteractions(ctx.host.page);
    const splitHost = await splitViaDrag(hostFrame, { mobile });
    if (!splitHost.ok || !splitHost.gameStarted) {
        failWithSnapshot('assertion', [`${label}: host SPLIT failed (${JSON.stringify({ splitHost, preSplit })})`], {});
    }

    await Promise.all(ctx.pages.map((page, i) => waitForDiag(
        page,
        `${label} P${i + 1} synced`,
        ({ needTimer }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            const tiles = doc ? [...doc.querySelectorAll('.tile')] : [];
            const faceUp = tiles.length > 0 && tiles.every((t) => !t.classList.contains('is-face-down'));
            return g?.gameStarted && faceUp && (!needTimer || !!doc?.getElementById('banana-timer'));
        },
        { needTimer: true },
        WAIT_MS,
        mp
    )));

    log(`SUCCESS: ${label} — host SPLIT synced on all ${ctx.playerCount} clients (timer + face-up)`);
}

module.exports = {
    assertHostSplitSyncsBothAfterPostGameReset,
    assertHostSplitSyncsAllAfterPostGameReset
};
