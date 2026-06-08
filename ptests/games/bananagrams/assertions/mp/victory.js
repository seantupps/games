/**
 * MP victory sync — capture board state, wait for settled win/review.
 */
const { flushHostBananaInteractions, waitForDiag, mpPollMs } = require('../../lib/mp-state');
const { mpVictoryWaitMs } = require('../../../../shared/infra/speed-profiles');

/** Capture pool/seq/phase/winner flags from one client. */
async function readMpBoardSyncState(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return {
            localPool: g?._tilePool?.length ?? -1,
            boardPool: Array.isArray(board?.pool) ? board.pool.length : -1,
            boardSeq: board?.seq ?? null,
            phase: board?.phase ?? null,
            winner: !!(g?._winnerUid || g?.isOver || g?._postGameReview
                || board?.phase === 'review' || board?.reviewPhase === true)
        };
    });
}

async function awaitMpVictorySettled(hostPage, guestPage, mp, label = 'AI win', opts = {}) {
    const requireWin = opts.requireWin !== false;
    const mpPages = { page1: hostPage, page2: guestPage };
    const victoryMs = mpVictoryWaitMs();
    await flushHostBananaInteractions(hostPage);
    try {
        await waitForDiag(hostPage, `${label} settled on host`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            return !!(g?._winnerUid || g?.isOver || g?._postGameReview
                || board?.phase === 'review' || board?.reviewPhase === true);
        }, {}, victoryMs, mpPages);
    } catch (err) {
        if (requireWin) throw err;
        return;
    }
    const syncDeadline = Date.now() + victoryMs;
    while (Date.now() < syncDeadline) {
        await flushHostBananaInteractions(hostPage);
        const [host, guest] = await Promise.all([
            readMpBoardSyncState(hostPage),
            readMpBoardSyncState(guestPage)
        ]);
        if (host.boardSeq != null && host.boardSeq === guest.boardSeq
            && host.localPool === guest.localPool && host.boardPool === guest.boardPool
            && (!opts.assertActionsWinInvariants || (host.localPool === 0 && host.boardPool === 0))) {
            break;
        }
        await new Promise((r) => setTimeout(r, mpPollMs()));
    }
}

module.exports = {
    readMpBoardSyncState,
    awaitMpVictorySettled
};
