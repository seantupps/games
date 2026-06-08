/**
 * Mobile MP post-game review — wait/click/diag mechanics.
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { review } = require('../assertions');
const { waitMpResetAfterDone } = review;
const SYNC_MS = STEP_MS;

function log(msg) {
    console.log(`[TEST] ${msg}`);
}

/** resetCount (epoch) + board.seq + phase for host and guest iframes. */
async function dumpBoardEpoch(pages, label) {
    const states = await Promise.all(pages.map((page, i) => page.evaluate((playerIndex) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
        const board = S?.readBoardFromRoom ? S.readBoardFromRoom(room) : room?.global?.board;
        const epoch = S?.readResetCount ? S.readResetCount(room) : (room?.global?.resetCount ?? null);
        return {
            player: playerIndex + 1,
            role: g?.playerRole ?? null,
            resetCount: epoch,
            mpAppliedResetCount: g?._mpAppliedResetCount ?? null,
            localBoardSeq: g?._boardSeq ?? null,
            boardSeq: board?.seq ?? null,
            phase: board?.phase ?? null,
            reviewPhase: board?.reviewPhase ?? null,
            postGameReview: !!g?._postGameReview,
            tileCount: g?.tiles?.length ?? 0
        };
    }, i).catch((err) => ({ player: i + 1, diagError: err.message }))));
    states.forEach((s) => log(`[DIAG epoch ${label}] P${s.player} ${JSON.stringify(s)}`));
    return states;
}

async function dumpPostGameDiag(pages, label) {
    const states = await Promise.all(pages.map((page, i) => page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        const board = g?.roomData?.global?.board;
        const btn = frame?.contentDocument?.getElementById('banana-done-btn');
        const tileEls = frame?.contentDocument ? [...frame.contentDocument.querySelectorAll('.tile')] : [];
        return {
            postGameFlag: !!g?._postGameReview,
            isOver: !!g?.isOver,
            winnerUid: g?._winnerUid || null,
            boardSeq: board?.seq ?? null,
            boardPhase: board?.phase,
            boardReviewPhase: board?.reviewPhase,
            boardReviewLayouts: board?.reviewLayouts ? Object.keys(board.reviewLayouts) : [],
            boardReviewDone: board?.reviewDone || {},
            localReviewLayouts: g?._reviewLayouts ? Object.keys(g._reviewLayouts) : [],
            doneVisible: !!btn?.classList.contains('show'),
            doneDisabled: !!btn?.disabled,
            tileCount: g?.tiles?.length ?? 0,
            tileDomCount: tileEls.length
        };
    }).catch((err) => ({ diagError: err.message }))));
    states.forEach((s, i) => {
        log(`[DIAG ${label}] P${i + 1} ${JSON.stringify(s)}`);
    });
}

async function waitPostGameReview(page, label, { hostOnly = false } = {}) {
    if (hostOnly) {
        await page.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board;
            const btn = document.getElementById('game-frame')?.contentDocument?.getElementById('banana-done-btn');
            const inReview = board?.phase === 'review' || board?.reviewPhase === true || !!g?._postGameReview;
            return inReview && g?.isOver && g?.isHost?.() && btn?.classList.contains('show');
        }, undefined, { timeout: SYNC_MS }).catch(async (err) => {
            await dumpPostGameDiag([page], `wait-review-${label}`);
            throw new Error(`${label} post-game review timeout: ${err.message}`);
        });
        return;
    }

    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board;
        const inReview = board?.phase === 'review' || board?.reviewPhase === true || !!g?._postGameReview;
        return inReview && g?.isOver;
    }, undefined, { timeout: SYNC_MS }).catch(async (err) => {
        await dumpPostGameDiag([page], `wait-review-${label}`);
        throw new Error(`${label} post-game review timeout: ${err.message}`);
    });
}

async function readReviewState(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const owners = new Set((g.tiles || []).map((t) => t.ownerUid).filter(Boolean));
        const board = g.roomData?.global?.board;
        const layoutUids = board?.reviewLayouts ? Object.keys(board.reviewLayouts) : [];
        return {
            postGame: board?.phase === 'review' || board?.reviewPhase === true,
            tileCount: g.tiles?.length ?? 0,
            ownerCount: owners.size,
            owners: [...owners],
            layoutUidCount: layoutUids.length,
            reviewLayouts: layoutUids,
            reviewDone: board?.reviewDone || {},
            frozenLayer: !!document.querySelector('.board-pan-layer.is-review-frozen'),
            doneVisible: !!document.getElementById('banana-done-btn')?.classList.contains('show')
        };
    });
}

function boardInReview(board) {
    if (!board) return false;
    if (board.phase === 'review' || board.reviewPhase === true) return true;
    if (board.phase === 'playing' || board.phase === 'idle') return false;
    return board.reviewPhase === true;
}

async function clickDone(frame) {
    await frame.evaluate(() => {
        const g = window.game;
        if (!g) throw new Error('game not ready in iframe');
        if (typeof g._onDonePressed === 'function') {
            g._onDonePressed();
            return;
        }
        document.getElementById('banana-done-btn')?.click();
    });
}

async function waitHostSeesGuestsDone(hostFrame, guestUids, label) {
    await hostFrame.waitForFunction(({ uids }) => {
        const done = window.game?.roomData?.global?.board?.reviewDone || {};
        return uids.every((u) => done[u] === true);
    }, { uids: guestUids }, { timeout: SYNC_MS }).catch((err) => {
        throw new Error(`${label} host board.reviewDone missing guest: ${err.message}`);
    });
}

async function waitReviewExitedOnFrame(frame, label, timeout = SYNC_MS) {
    return waitMpResetAfterDone(frame, label, timeout);
}

/** @deprecated use waitMpResetAfterDone — kept for test exports. */
async function waitRedealtAfterDone(frames, timeout) {
    await Promise.all(frames.map((frame, i) =>
        waitMpResetAfterDone(frame, `P${i + 1}`, timeout)));
}

module.exports = {
    SYNC_MS,
    log,
    dumpBoardEpoch,
    dumpPostGameDiag,
    waitPostGameReview,
    readReviewState,
    boardInReview,
    clickDone,
    waitHostSeesGuestsDone,
    waitReviewExitedOnFrame,
    waitRedealtAfterDone
};
