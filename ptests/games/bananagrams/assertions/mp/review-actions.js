/**
 * MP post-win review assertions — win banner, review layouts, pool-at-zero.
 * Extracted from mp-ai-playthrough so assertions never import runners.
 */
const { failWithSnapshot, failWithTargetedDiag } = require('../core/format-failure');
const {
    captureReviewLayoutFailureFromPages,
    enrichReviewLayoutDiagBundle,
    formatReviewLayoutFailure
} = require('../../lib/review-layout-failure-diag');
const { getPlaythroughContext } = require('../../lib/mp-playthrough-context');
const {
    mergeGuestLayoutOnHost,
    waitForHostReviewReady,
    assertGuestReviewVisibleWithoutInteraction,
    assertReviewBoardsFullyVisible,
    assertReviewViewportStable
} = require('./review');
const { isHubWinBannerDomVisible } = require('./sync-win-banner');
const { log, flushHostBananaInteractions, waitForDiag } = require('../../lib/mp-state');
const { mpVictoryWaitMs, mpReviewWaitMs } = require('../../../../shared/infra/speed-profiles');

/** Read + validate one player's board from their game frame. */
async function readPlayerWinBoardFromFrame(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        if (!g?._checker || typeof BananaGrid === 'undefined') {
            return { ok: false, reason: 'missing-game' };
        }
        const me = g._myUid();
        const tiles = (g.tiles || []).map((t) => ({
            id: t.id,
            letter: t.letter,
            x: t.x,
            y: t.y,
            faceUp: true
        }));
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const rackOpts = g._rackLayoutOptions();
        const allPlaced = typeof g._allTilesPlacedOn === 'function'
            ? g._allTilesPlacedOn(tiles)
            : BananaGrid.allTilesPlacedInGrid(tiles, origin, rackOpts);
        const grid = BananaGrid.validateGrid(tiles, g._checker);
        const connected = BananaGrid.isConnected(tiles);
        const unique = BananaGrid.eachTileOccupiesUniqueCell(tiles);
        const hasThree = (grid.words || []).some((w) => String(w || '').length >= 3);
        return {
            uid: me,
            tileCount: tiles.length,
            validWinBoard: !!(allPlaced && grid.ok && connected && unique && hasThree),
            allPlaced,
            gridOk: grid.ok,
            connected,
            words: grid.words || [],
            invalidReason: grid.ok ? null : (grid.reason || null)
        };
    });
}

async function assertActionsWinSnap(snap, label = 'actions win') {
    if (!snap) {
        failWithSnapshot(label, ['missing win snapshot'], { snap });
    }
    if (!snap.boardCells?.length && !snap.allPlaced) {
        failWithSnapshot(label, ['winner must have board tiles'], { snap });
    }
    if (snap.poolLen !== 0) {
        failWithSnapshot(label, [`bunch must be 0 at win (pool=${snap.poolLen})`], { snap });
    }
    if (!snap.allPlaced || !snap.gridOk) {
        failWithSnapshot(label, ['winner must have all tiles in a connected valid grid'], {
            allPlaced: snap.allPlaced,
            gridOk: snap.gridOk,
            rackLen: snap.rack?.length ?? 0
        });
    }
    log(`${label}: winner grid valid (${snap.boardCells?.length || snap.tileCount} cells, pool=0)`);
}

async function assertActionsWinBoards(winnerFrame, loserFrame, winnerUid, label = 'actions win') {
    const [winnerBoard, loserBoard] = await Promise.all([
        readPlayerWinBoardFromFrame(winnerFrame),
        readPlayerWinBoardFromFrame(loserFrame)
    ]);

    if (!winnerBoard?.validWinBoard) {
        failWithSnapshot(label, ['winner must have a fully connected valid board'], { winnerUid, winnerBoard });
    }

    const validPlayers = [winnerBoard, loserBoard].filter((p) => p?.validWinBoard);
    if (validPlayers.length !== 1) {
        failWithSnapshot(label, [`exactly one valid board expected, got ${validPlayers.length}`], {
            winnerBoard,
            loserBoard
        });
    }

    if (winnerBoard.uid !== winnerUid) {
        failWithSnapshot(label, ['valid-board player must be winner'], {
            winnerUid,
            validUid: winnerBoard.uid
        });
    }

    log(`${label}: winner ${winnerUid} has valid connected crossword `
        + `(${winnerBoard.words.slice(0, 8).join(', ')}${winnerBoard.words.length > 8 ? '…' : ''})`);
}

async function assertActionsPoolZero(hostPage, guestPage, mp, label = 'actions win') {
    await flushHostBananaInteractions(hostPage);
    const poolWaitMs = Math.max(mpVictoryWaitMs(), mpReviewWaitMs());

    await waitForDiag(hostPage, `${label} bunch=0 host`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const local = g?._tilePool?.length ?? -1;
        if (local !== 0) return false;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        if (Array.isArray(board?.pool)) return board.pool.length === 0;
        return true;
    }, {}, poolWaitMs, mp);
    await waitForDiag(guestPage, `${label} bunch=0 guest`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const local = g?._tilePool?.length ?? -1;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const inReview = board?.phase === 'review'
            || !!(g?._winnerUid || board?.winnerUid || g?._postGameReview);
        if (inReview) return local === 0;
        if (local !== 0) return false;
        if (Array.isArray(board?.pool)) return board.pool.length === 0;
        return true;
    }, {}, poolWaitMs, mp);
    log(`SUCCESS: ${label} — bunch=0 on host and guest`);
}

async function assertActionsWinInvariants(hostPage, guestPage, frame1, frame2, mp, label = 'actions win') {
    await assertActionsPoolZero(hostPage, guestPage, mp, label);
}

/** Review boards must stay visible on both clients (no flash/disappear after guest win). */
async function assertActionsReviewPersists(frames, pages, mp, label = 'actions review', opts = {}) {
    const minTilesPerOwner = opts.minTilesPerOwner ?? 6;
    const settleMs = Math.max(mpReviewWaitMs(), 400);
    await mergeGuestLayoutOnHost(frames[0], pages);
    await flushHostBananaInteractions(pages[0]);
    await frames[0].evaluate(() => {
        window.game._processBananaInteractions?.(window.game.roomData?.interactions?.banana);
    }).catch(() => {});
    await waitForHostReviewReady(frames[0], pages[0], mpReviewWaitMs());
    await assertGuestReviewVisibleWithoutInteraction(
        pages[0], `${label} host visible`, 2, minTilesPerOwner
    );
    await assertGuestReviewVisibleWithoutInteraction(
        pages[1], `${label} guest visible`, 2, minTilesPerOwner
    );
    for (let i = 0; i < frames.length; i++) {
        await assertReviewBoardsFullyVisible(frames[i], `${label} P${i + 1} fit`);
    }
    await new Promise((r) => setTimeout(r, settleMs));
    for (let i = 0; i < frames.length; i++) {
        await assertGuestReviewVisibleWithoutInteraction(
            pages[i], `${label} P${i + 1} persisted`, 2, minTilesPerOwner
        );
        await assertReviewViewportStable(frames[i], `${label} P${i + 1} viewport`);
        await assertReviewBoardsFullyVisible(frames[i], `${label} P${i + 1} persisted-fit`);
    }
    log(`SUCCESS: ${label} — review boards persisted on host and guest`);
}

/** Both hub clients show the win banner after victory (review transition). */
async function assertActionsWinBanner(pages, label = 'actions win banner') {
    const timeoutMs = mpVictoryWaitMs();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const states = await Promise.all(pages.map((p) => isHubWinBannerDomVisible(p)));
        if (states.every((s) => s.visible)) {
            log(`SUCCESS: ${label} — hub win banner visible on host and guest`);
            return;
        }
        await new Promise((r) => setTimeout(r, 40));
    }
    const states = await Promise.all(pages.map((p) => isHubWinBannerDomVisible(p)));
    failWithSnapshot(label, ['hub win banner not visible on both clients'], { states });
}

/** Validate review layouts: winner connected crossword, loser has straggler(s). */
async function assertActionsReviewLayouts(frame1, hostPage, mp, label = 'actions review') {
    const layoutWaitMs = mpReviewWaitMs();

    await mergeGuestLayoutOnHost(frame1, [hostPage], 8);
    await flushHostBananaInteractions(hostPage);
    await waitForHostReviewReady(frame1, hostPage, layoutWaitMs);

    await waitForDiag(hostPage, `${label} layouts ready`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const winnerUid = g?._winnerUid || board?.winnerUid;
        if (!winnerUid) return false;
        const layouts = board?.reviewLayoutsOrig || board?.reviewLayouts || g?._reviewLayouts || {};
        const roster = (typeof g?._getPlayerUids === 'function' ? g._getPlayerUids() : null)
            || board?.playerUids
            || Object.keys(room?.playerData || {}).filter(Boolean);
        return roster.length >= 2
            && roster.every((uid) => Array.isArray(layouts[uid]) && layouts[uid].length > 0);
    }, {}, layoutWaitMs, mp);

    const state = await frame1.evaluate(() => {
        const g = window.game;
        if (!g?._checker || typeof BananaGrid === 'undefined') {
            return { ok: false, reason: 'missing-game' };
        }
        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const winnerUid = g._winnerUid || board?.winnerUid || null;
        const layouts = board?.reviewLayoutsOrig || board?.reviewLayouts || g._reviewLayouts || {};
        const roster = ((typeof g._getPlayerUids === 'function' ? g._getPlayerUids() : null)
            || board?.playerUids
            || Object.keys(room?.playerData || {}).filter(Boolean)).sort();

        const validateLayout = (uid, tileList) => {
            if (!Array.isArray(tileList) || !tileList.length) {
                return { uid, validWinBoard: false, tileCount: 0, reason: 'no-layout' };
            }
            const tiles = tileList.map((t) => ({
                id: t.id,
                letter: t.letter,
                x: t.x,
                y: t.y,
                faceUp: true
            }));
            const fullGrid = BananaGrid.validateGrid(tiles, g._checker);
            const fullConnected = BananaGrid.isConnected(tiles);
            const unique = BananaGrid.eachTileOccupiesUniqueCell(tiles);
            const { tiles: mainTiles, disconnected } = BananaGrid.largestComponentTiles(tiles);
            const mainGrid = mainTiles.length
                ? BananaGrid.validateGrid(mainTiles, g._checker)
                : { ok: false, words: [] };
            const mainConnected = mainTiles.length >= 6 && BananaGrid.isConnected(mainTiles);
            return {
                uid,
                tileCount: tiles.length,
                stragglers: disconnected,
                validWinBoard: !!(fullGrid.ok && fullConnected && unique
                    && (fullGrid.words || []).some((w) => String(w || '').length >= 3)),
                connected: mainConnected,
                gridOk: mainGrid.ok,
                words: mainGrid.words || [],
                invalidReason: mainGrid.ok ? null : (mainGrid.reason || fullGrid.reason || null),
                invalidWord: mainGrid.word || fullGrid.word || null
            };
        };

        return {
            winnerUid,
            players: roster.map((uid) => validateLayout(uid, layouts[uid]))
        };
    });

    if (!state?.winnerUid) {
        failWithSnapshot(label, ['no winnerUid after review'], { state });
    }

    const winnerPlayer = (state.players || []).find((p) => p.uid === state.winnerUid);
    if (!winnerPlayer?.validWinBoard) {
        failWithSnapshot(label, ['winner must have a fully connected valid crossword'], { state });
    }

    const guestPage = mp?.page2 || mp?.pages?.[1] || null;

    for (const player of state.players || []) {
        if (player.uid === state.winnerUid) continue;
        if (!player.connected || !player.gridOk) {
            const diagBundle = enrichReviewLayoutDiagBundle(
                await captureReviewLayoutFailureFromPages(hostPage, guestPage),
                getPlaythroughContext()
            );
            const targetedText = formatReviewLayoutFailure(diagBundle);
            const verdict = targetedText.split('\n').find((l) => l.startsWith('VERDICT:'))?.slice(8).trim()
                || 'loser must show a connected valid crossword in review';
            failWithTargetedDiag(
                label,
                [verdict],
                { ...diagBundle, player },
                targetedText
            );
        }
    }

    const losers = (state.players || []).filter((p) => p.uid !== state.winnerUid);
    if (!losers.length) {
        failWithSnapshot(label, ['missing loser layout(s)'], { state });
    }
    for (const loser of losers) {
        if (!loser.tileCount) {
            failWithSnapshot(label, ['loser layout empty'], { loser });
        }
    }

    log(`${label}: winner review board connected (${winnerPlayer.tileCount} tiles)`);
    for (const loser of losers) {
        if (loser.validWinBoard) {
            log(`${label}: loser ${loser.uid} also has valid win board (${loser.tileCount} tiles) — lost race`);
        } else {
            log(`${label}: loser ${loser.uid} review board connected with straggler(s) `
                + `(${loser.tileCount} tiles)`);
        }
    }
    const playerWord = losers.length === 1 ? 'both players' : `all ${losers.length + 1} players`;
    log(`SUCCESS: ${label} — bunch=0; winner valid; connected review layouts for ${playerWord}`);
}

module.exports = {
    readPlayerWinBoardFromFrame,
    assertActionsWinSnap,
    assertActionsWinBoards,
    assertActionsPoolZero,
    assertActionsWinInvariants,
    assertActionsReviewPersists,
    assertActionsWinBanner,
    assertActionsReviewLayouts
};
