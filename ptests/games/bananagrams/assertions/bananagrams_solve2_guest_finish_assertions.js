/**
 * After /b solve 2: guest finishes via applyPlacements (same helpers as AI playthrough).
 * Repro: guest connects straggler + places peel tile — win + review must trigger (~1/4 flaky).
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { getGameFrame } = require('../../../shared/platform/game-harness');
const { solveAttemptFromBrowserState } = require('../ai');
const {
    injectSnapshot,
    applyPlacements,
    awaitMpVictorySettled,
    assertActionsReviewLayouts
} = require('../desktop-mp/audit/mp-ai-playthrough');
const {
    flushHostBananaInteractions,
    waitForDiag,
    waitPoolBoth,
    WAIT_MS,
    log
} = require('../lib/mp-lib');

async function readGuestSnapWithHostPool(guestFrame, hostPage) {
    const snap = await guestFrame.evaluate(() => window.snapshotMpAiState());
    const hostPool = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?._tilePool?.length ?? -1;
    });
    if (hostPool >= 0) snap.poolLen = hostPool;
    return snap;
}

/** Full client snapshot for failure reports (host + guest). */
async function collectMpClientDiag(page, role = 'client') {
    return page.evaluate((clientRole) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const hand = g?.tiles || [];
        const grid = window.BananaGrid;
        const snapHand = typeof g?._snapHandForValidation === 'function'
            ? g._snapHandForValidation(hand)
            : hand;
        let gridDiag = null;
        if (g?._checker && grid && snapHand?.length) {
            const v = grid.validateGrid(snapHand, g._checker);
            const { disconnected, tiles: mainTiles } = grid.largestComponentTiles(snapHand);
            gridDiag = {
                ok: v.ok,
                reason: v.reason ?? null,
                wordCount: (v.words || []).length,
                words: (v.words || []).slice(0, 12),
                connected: grid.isConnected(snapHand),
                unique: grid.eachTileOccupiesUniqueCell(snapHand),
                disconnected,
                mainComponent: mainTiles.length,
                allPlaced: typeof g._allTilesPlacedOn === 'function'
                    ? g._allTilesPlacedOn(snapHand)
                    : null,
                winGridReady: typeof g._mpWinGridReady === 'function'
                    ? g._mpWinGridReady(snapHand)
                    : null,
                bunchEmpty: typeof g._mpBunchEmptyForWin === 'function'
                    ? g._mpBunchEmptyForWin()
                    : null
            };
        }
        const banana = room?.interactions?.banana;
        const bananaKeys = banana && typeof banana === 'object' ? Object.keys(banana) : [];
        const onBoard = hand.filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
        return {
            role: clientRole,
            uid: g?._myUid?.() ?? null,
            isHost: !!g?.isHost?.(),
            derivePhase: g?.deriveGamePhase?.() ?? null,
            storedPhase: g?._gamePhase ?? null,
            gameStarted: !!g?.gameStarted,
            started: !!g?.started,
            winnerUid: g?._winnerUid ?? board?.winnerUid ?? null,
            postGameReview: !!g?._postGameReview,
            isOver: !!g?.isOver,
            victoryRegistered: !!g?._victoryRegistered,
            hostReviewTransition: !!g?._hostReviewTransitionActive,
            hostReviewCompleting: !!g?._hostReviewCompleting,
            localPool: g?._tilePool?.length ?? null,
            boardPool: Array.isArray(board?.pool) ? board.pool.length : null,
            boardSeq: board?.seq ?? null,
            localBoardSeq: g?._boardSeq ?? null,
            peelSeq: board?.peelSeq ?? null,
            dumpSeq: board?.dumpSeq ?? null,
            devSolveSeq: board?.devSolveSeq ?? null,
            boardPhase: board?.phase ?? null,
            boardGameStarted: !!board?.gameStarted,
            reviewEpoch: board?.reviewEpoch ?? null,
            tileCount: hand.length,
            onBoardCount: onBoard.length,
            faceUp: hand.length > 0 && hand.every((t) => t.faceUp),
            grid: gridDiag,
            pendingBananaKeys: bananaKeys.length,
            bananaSample: bananaKeys.slice(0, 6),
            bannerText: g?._bannerText ?? null
        };
    }, role).catch((err) => ({ role, readError: String(err) }));
}

async function collectFailureDiag(hostPage, guestPage, guestFrame, context = {}) {
    const [host, guest, guestSnap] = await Promise.all([
        collectMpClientDiag(hostPage, 'host'),
        collectMpClientDiag(guestPage, 'guest'),
        readGuestSnapWithHostPool(guestFrame, hostPage).catch(() => null)
    ]);
    return { host, guest, context, guestSnap };
}

function formatSolve2GuestFailure(label, step, err, diag) {
    const lines = [
        `${label} FAILED at step "${step}": ${err.message}`,
        '',
        '--- host ---',
        JSON.stringify(diag.host, null, 2),
        '',
        '--- guest ---',
        JSON.stringify(diag.guest, null, 2)
    ];
    if (diag.guestSnap) {
        lines.push('', '--- guest AI snap ---', JSON.stringify(diag.guestSnap, null, 2));
    }
    if (diag.context && Object.keys(diag.context).length) {
        lines.push('', '--- step context ---', JSON.stringify(diag.context, null, 2));
    }
    log(lines.join('\n'));
    return new Error(lines.join('\n'));
}

async function failStep(label, step, err, hostPage, guestPage, guestFrame, context = {}) {
    const diag = await collectFailureDiag(hostPage, guestPage, guestFrame, { step, ...context });
    throw formatSolve2GuestFailure(label, step, err, diag);
}

async function gridPeelReady(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        if (!g?._checker || typeof BananaGrid === 'undefined') return false;
        const hand = typeof g._snapHandForValidation === 'function'
            ? g._snapHandForValidation(g.tiles)
            : g.tiles;
        const grid = BananaGrid.validateGrid(hand, g._checker);
        if (!grid.ok) return false;
        if (!BananaGrid.isConnected(hand)) return false;
        if (!BananaGrid.eachTileOccupiesUniqueCell(hand)) return false;
        const hasThree = (grid.words || []).some((w) => String(w || '').length >= 3);
        if (!hasThree) return false;
        return typeof g._allTilesPlacedOn === 'function' ? g._allTilesPlacedOn(hand) : true;
    });
}

async function guestCheckPeel(frame, hostPage) {
    const result = await frame.evaluate(() => {
        window.game._bannerText = '';
        const claimed = window.game._checkPeel();
        return {
            claimed,
            gameStarted: !!window.game.gameStarted,
            winnerUid: window.game._winnerUid ?? null,
            localPool: window.game._tilePool?.length ?? null
        };
    });
    if (result.claimed) await flushHostBananaInteractions(hostPage);
    return result;
}

/**
 * Guest finishes /b solve 2 with two placement rounds: connect straggler, peel, place last tile.
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 * @param {import('playwright').Frame} guestFrame
 * @param {{ page1: import('playwright').Page, page2: import('playwright').Page }} mp
 * @param {string} [label]
 * @param {{ round?: number, rounds?: number }} [meta]
 */
async function assertGuestWinAfterSolve2Placements(hostPage, guestPage, guestFrame, mp, label = 'solve-2 guest placements', meta = {}) {
    const roundTag = meta.round != null && meta.rounds != null
        ? ` (round ${meta.round}/${meta.rounds})`
        : '';
    const fullLabel = `${label}${roundTag}`;

    try {
        await injectSnapshot([guestFrame]);
    } catch (err) {
        await failStep(fullLabel, 'injectSnapshot', err, hostPage, guestPage, guestFrame, meta);
    }

    let snap;
    try {
        snap = await readGuestSnapWithHostPool(guestFrame, hostPage);
    } catch (err) {
        await failStep(fullLabel, 'read pre-placement snap', err, hostPage, guestPage, guestFrame, meta);
    }

    let solved;
    try {
        solved = solveAttemptFromBrowserState({
            boardCells: snap.boardCells,
            rackLetters: (snap.rack || []).map((r) => r.letter)
        });
        if (!solved.changed || !solved.placements?.length) {
            throw new Error(`solver could not connect straggler (stuck=${solved.stuck})`);
        }
    } catch (err) {
        await failStep(fullLabel, 'solver straggler connect', err, hostPage, guestPage, guestFrame, {
            ...meta,
            preSnap: { boardCells: snap.boardCells?.length, rack: snap.rack?.length, poolLen: snap.poolLen }
        });
    }

    let applied1;
    try {
        applied1 = await applyPlacements(guestFrame, snap, solved);
        if (!applied1.ok || !applied1.placed) {
            throw new Error(`applyPlacements returned ${JSON.stringify(applied1)}`);
        }
        await guestFrame.evaluate(() => {
            window.game._persistMpLayout?.();
            window.game.requestRender?.();
        });
        await flushHostBananaInteractions(hostPage);
    } catch (err) {
        await failStep(fullLabel, 'placement 1 (connect straggler)', err, hostPage, guestPage, guestFrame, {
            ...meta,
            solver: { placements: solved.placements?.length, rackLeft: solved.rackLeft }
        });
    }

    if (!(await gridPeelReady(guestFrame))) {
        await failStep(
            fullLabel,
            'grid peel-ready after placement 1',
            new Error('guest grid not peel-ready'),
            hostPage,
            guestPage,
            guestFrame,
            meta
        );
    }

    snap = await readGuestSnapWithHostPool(guestFrame, hostPage);
    if (snap.poolLen !== 2) {
        await failStep(
            fullLabel,
            'pool before peel',
            new Error(`expected pool=2, got ${snap.poolLen}`),
            hostPage,
            guestPage,
            guestFrame,
            { ...meta, snap: { poolLen: snap.poolLen, rack: snap.rack?.length } }
        );
    }

    let peelResult;
    try {
        peelResult = await guestCheckPeel(guestFrame, hostPage);
        if (!peelResult.claimed) {
            throw new Error(`_checkPeel returned false (${JSON.stringify(peelResult)})`);
        }
    } catch (err) {
        await failStep(fullLabel, 'guest peel at pool=2', err, hostPage, guestPage, guestFrame, {
            ...meta,
            peelResult
        });
    }

    try {
        await waitPoolBoth(hostPage, guestPage, 0, WAIT_MS);
    } catch (err) {
        await failStep(fullLabel, 'wait pool=0 after peel', err, hostPage, guestPage, guestFrame, meta);
    }

    snap = await readGuestSnapWithHostPool(guestFrame, hostPage);
    if (snap.poolLen !== 0) {
        await failStep(
            fullLabel,
            'pool after peel',
            new Error(`expected pool=0, got ${snap.poolLen}`),
            hostPage,
            guestPage,
            guestFrame,
            { ...meta, snap: { poolLen: snap.poolLen, rack: snap.rack } }
        );
    }
    if (!snap.rack?.length) {
        await failStep(
            fullLabel,
            'rack after peel',
            new Error('expected rack tile after peel'),
            hostPage,
            guestPage,
            guestFrame,
            { ...meta, snap }
        );
    }

    try {
        solved = solveAttemptFromBrowserState({
            boardCells: snap.boardCells,
            rackLetters: (snap.rack || []).map((r) => r.letter)
        });
        if (!solved.changed || !solved.placements?.length) {
            throw new Error(`solver stuck on final rack tile (stuck=${solved.stuck})`);
        }
    } catch (err) {
        await failStep(fullLabel, 'solver final rack tile', err, hostPage, guestPage, guestFrame, {
            ...meta,
            snap: { rack: snap.rack, boardCells: snap.boardCells?.length }
        });
    }

    let applied2;
    try {
        applied2 = await applyPlacements(guestFrame, snap, solved);
        if (!applied2.ok) {
            throw new Error(`applyPlacements returned ${JSON.stringify(applied2)}`);
        }
        await guestFrame.evaluate(() => {
            window.game._persistMpLayout?.();
            window.game.requestRender?.();
            window.game._schedulePeelAfterDragRelease?.();
        });
        await flushHostBananaInteractions(hostPage);
        await guestPage.waitForTimeout(50);
    } catch (err) {
        await failStep(fullLabel, 'placement 2 (final rack tile)', err, hostPage, guestPage, guestFrame, {
            ...meta,
            solver: { placements: solved.placements?.length }
        });
    }

    const hostWinner = (await collectMpClientDiag(hostPage, 'host')).winnerUid;
    if (!hostWinner) {
        const peelWin = await guestCheckPeel(guestFrame, hostPage).catch(() => null);
        if (!peelWin?.claimed) {
            await failStep(
                fullLabel,
                'guest win after placement 2',
                new Error('no winnerUid on host after placement 2 and retry _checkPeel failed'),
                hostPage,
                guestPage,
                guestFrame,
                { ...meta, retryPeel: peelWin, applied2 }
            );
        }
    }

    try {
        await awaitMpVictorySettled(hostPage, guestPage, mp, fullLabel);
    } catch (err) {
        await failStep(fullLabel, 'awaitMpVictorySettled', err, hostPage, guestPage, guestFrame, meta);
    }

    try {
        await waitForDiag(hostPage, `${fullLabel} review host`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board;
            return board?.phase === 'review' || !!g?._postGameReview;
        }, {}, Math.max(WAIT_MS, STEP_MS), mp);
        await waitForDiag(guestPage, `${fullLabel} review guest`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board;
            return board?.phase === 'review' || !!g?._postGameReview;
        }, {}, Math.max(WAIT_MS, STEP_MS), mp);
    } catch (err) {
        await failStep(fullLabel, 'wait for review UI', err, hostPage, guestPage, guestFrame, meta);
    }

    try {
        const hostFrame = await getGameFrame(hostPage);
        await assertActionsReviewLayouts(hostFrame, hostPage, mp, fullLabel);
    } catch (err) {
        await failStep(fullLabel, 'assertActionsReviewLayouts', err, hostPage, guestPage, guestFrame, meta);
    }

    log(`SUCCESS: ${fullLabel} — guest win + review after straggler connect + final tile`);
}

module.exports = {
    assertGuestWinAfterSolve2Placements,
    collectMpClientDiag,
    collectFailureDiag
};
