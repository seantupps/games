/** Extracted review assertion module. */
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const { captureReviewStateFromFrame, captureReviewState } = require('../core/capture');
const { compareReviewBoards } = require('../core/compare');
const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

function snapshotOrEmpty(o) { return o || {}; }

const TIMER_SAMPLE_MS = 200;
const REVIEW_VIEWPORT_MAX_PAN_DRIFT = 12;
const REVIEW_VIEWPORT_MAX_ZOOM_DRIFT = 0.04;
const REVIEW_VIEWPORT_MAX_FOCAL_DRIFT = 20;
async function pushHostReviewStateToClients(hostFrame, pages) {
    if (!hostFrame) return;
    await hostFrame.evaluate(() => {
        const g = window.game;
        g._processBananaInteractions?.(g.roomData?.interactions?.banana);
    }).catch(() => {});
    const hostSnap = await hostFrame.evaluate(() => {
        const g = window.game;
        const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
        let board = S?.readBoardFromRoom ? S.readBoardFromRoom(g.roomData) : g.roomData?.global?.board;
        if ((g._isBoardInReview?.() || g._hostReviewTransitionActive || g._postGameReview) && board) {
            board = { ...board };
            board.phase = 'review';
            board.reviewPhase = true;
            board.winnerUid = board.winnerUid || g._winnerUid || null;
            const orig = g._reviewLayouts || board.reviewLayoutsOrig || board.reviewLayouts || {};
            if (typeof g._displayReviewLayoutsFromOrig === 'function') {
                board.reviewLayoutsOrig = JSON.parse(JSON.stringify(orig));
                board.reviewLayouts = g._displayReviewLayoutsFromOrig(orig);
            } else if (Object.keys(orig).length) {
                board.reviewLayoutsOrig = JSON.parse(JSON.stringify(orig));
                board.reviewLayouts = orig;
            }
        }
        let boardJson = null;
        try {
            boardJson = board ? JSON.parse(JSON.stringify(board)) : null;
        } catch (_) {
            boardJson = board || null;
        }
        return {
            winnerUid: g._winnerUid || board?.winnerUid || null,
            board: boardJson,
            host: g.roomData?.host || null
        };
    }).catch(() => null);
    if (!hostSnap?.winnerUid || !hostSnap?.board) return;

    await Promise.all((pages || []).map((page) => page.evaluate((snap) => {
        const ne = window.NetworkEngine;
        if (!ne?.roomId || ne.roomId === 'lobby') return;
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return;
        const base = g.roomData && typeof g.roomData === 'object' ? g.roomData : {};
        const payload = {
            ...base,
            winnerUid: snap.winnerUid,
            host: snap.host || base.host,
            global: { ...(base.global || {}), board: snap.board },
            state: { ...(base.state || {}), board: snap.board }
        };
        ne.roomData = payload;
        g.roomData = payload;
        g._winnerUid = snap.winnerUid;
        g.isOver = true;
        if (typeof g.onNetworkUpdate === 'function') g.onNetworkUpdate(payload);
        if (typeof g._applyMultiplayerBoard === 'function') {
            g._applyMultiplayerBoard(snap.board, { force: true, _traceCaller: 'ptest-host-push' });
        }
        if (!g.isHost?.() && snap.winnerUid && typeof g._registerVictoryWithoutAutoReset === 'function') {
            let hubWinner = 'P1';
            if (typeof window.NetworkEngine?._partyRoleForUid === 'function') {
                hubWinner = window.NetworkEngine._partyRoleForUid(snap.winnerUid) || hubWinner;
            } else if (snap.winnerUid !== snap.host) {
                hubWinner = 'P2';
            }
            g._registerVictoryWithoutAutoReset(hubWinner, { winnerUid: snap.winnerUid });
        }
    }, hostSnap).catch(() => {})));
}


async function forceRoomSyncToGameIframes(pages, hostFrame = null) {
    let hostSnap = null;
    if (hostFrame) {
        hostSnap = await hostFrame.evaluate(() => {
            const g = window.game;
            const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
            let board = S?.readBoardFromRoom ? S.readBoardFromRoom(g.roomData) : g.roomData?.global?.board;
            if ((g._isBoardInReview?.() || g._hostReviewTransitionActive) && board) {
                board = { ...board };
                board.phase = 'review';
                board.reviewPhase = true;
                board.winnerUid = board.winnerUid || g._winnerUid || null;
            }
            let boardJson = null;
            try {
                boardJson = board ? JSON.parse(JSON.stringify(board)) : null;
            } catch (_) {
                boardJson = board || null;
            }
            return {
                winnerUid: g._winnerUid || board?.winnerUid || null,
                board: boardJson,
                boardSeq: board?.seq ?? 0,
                review: !!(g._postGameReview || board?.phase === 'review' || board?.reviewPhase)
            };
        }).catch(() => null);
    }

    await Promise.all((pages || []).map((page) => page.evaluate(async (host) => {
        const ne = window.NetworkEngine;
        if (!ne?.db || !ne.roomId || ne.roomId === 'lobby') return;
        const snap = await ne.db.ref(`games/${ne.roomId}`).once('value');
        const raw = snap.val();
        if (!raw) return;
        const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
        let payload = S?.normalizeRoomSnapshot ? S.normalizeRoomSnapshot(raw) : raw;

        const useHost = !!(host?.review && host?.board);
        if (useHost) {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g) return;
            const base = g.roomData && typeof g.roomData === 'object' ? g.roomData : {};
            payload = {
                ...base,
                winnerUid: host.winnerUid || base.winnerUid,
                global: { ...(base.global || {}), board: host.board },
                state: { ...(base.state || {}), board: host.board }
            };
        }

        ne.roomData = payload;
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return;
        g.roomData = payload;
        if (host?.winnerUid) {
            g._winnerUid = host.winnerUid;
            g.isOver = true;
        }
        if (typeof g.onNetworkUpdate === 'function') g.onNetworkUpdate(payload);
        const board = useHost ? host.board : (S?.readBoardFromRoom ? S.readBoardFromRoom(payload) : payload?.global?.board);
        const skipStalePlaying = !useHost && host?.review
            && board?.phase === 'playing'
            && typeof g._isStalePlayingBoardWhileInReview === 'function'
            && g._isStalePlayingBoardWhileInReview(board, {});
        if (!skipStalePlaying && board?.version >= 2 && typeof g._applyMultiplayerBoard === 'function') {
            g._applyMultiplayerBoard(board, { force: true, _traceCaller: 'ptest-force-sync' });
        }
        if (g.isHost?.() && payload?.interactions?.banana) {
            g._processBananaInteractions?.(payload.interactions.banana);
        }
    }, hostSnap).catch(() => {})));
}


async function waitForHostReviewReady(hostFrame, _hostPage, timeout = STEP_MS) {
    await hostFrame.waitForFunction(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board;
        return !!(
            g?._winnerUid
            && (board?.phase === 'review' || board?.reviewPhase === true)
        );
    }, undefined, { timeout });
}


async function mergeGuestLayoutOnHost(hostFrame, pages, rounds = 4) {
    if (!hostFrame) return;
    const minLayouts = Math.max(2, (pages || []).length);
    for (let i = 0; i < rounds; i++) {
        // Pull latest room snapshot first so host sees freshly posted guest victory-layout interactions.
        await forceRoomSyncToGameIframes(pages, hostFrame);
        await hostFrame.evaluate(() => {
            const g = window.game;
            g._processBananaInteractions?.(g.roomData?.interactions?.banana);
        }).catch(() => {});
        await pushHostReviewStateToClients(hostFrame, pages);
        const merged = await hostFrame.evaluate(({ min }) => {
            const g = window.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            const keys = board?.reviewLayouts ? Object.keys(board.reviewLayouts) : [];
            return keys.length >= min;
        }, { min: minLayouts }).catch(() => false);
        if (merged) return;
        await new Promise((r) => setTimeout(r, 100));
    }
}


async function waitMpClientsInReview(frames, label = 'in-review', timeout = STEP_MS, pages = [], hostFrame = null) {
    const pollMs = 60;
    const deadline = Date.now() + timeout;

    const inReviewOnFrame = (frame) => frame.evaluate(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        const winnerUid = g?._winnerUid || board?.winnerUid || g?.roomData?.winnerUid;
        if (!winnerUid) return false;
        return board?.phase === 'review'
            || board?.reviewPhase === true
            || !!g?._postGameReview;
    });

    while (Date.now() < deadline) {
        const states = await Promise.all(frames.map((frame) => inReviewOnFrame(frame)));
        if (states.every(Boolean)) return;
        await new Promise((r) => setTimeout(r, pollMs));
    }

    const snaps = await Promise.all(frames.map((frame, i) => frame.evaluate((playerIndex) => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        return {
            player: playerIndex + 1,
            postGameReview: !!g?._postGameReview,
            winnerUid: g?._winnerUid ?? null,
            phase: board?.phase ?? null,
            layoutPublished: !!g?._myEndingLayoutPublished
        };
    }, i).catch(() => ({ player: i + 1, error: true }))));
    failWithSnapshot(label, [`${label}: not all clients in review (${JSON.stringify(snaps)})`], snapshotOrEmpty({}));
}

/** All MP clients show merged review boards (both players' tiles or reviewLayouts). */

async function waitMpClientsPostWinReady(frames, playerUids, label = 'post-win-ready', timeout = STEP_MS, pages = [], hostFrame = null) {
    const pollMs = 60;
    const deadline = Date.now() + timeout;

    const readyOnFrame = async (frame) => frame.evaluate(({ uids }) => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        const inReview = board?.phase === 'review' || board?.reviewPhase === true;
        if (!inReview || !g?._winnerUid) return false;
        const layoutKeys = board?.reviewLayouts ? Object.keys(board.reviewLayouts) : [];
        if (layoutKeys.length >= uids.length) return true;
        const countsEarly = {};
        uids.forEach((u) => { countsEarly[u] = 0; });
        (g.tiles || []).forEach((t) => {
            const o = t.ownerUid || (typeof g._myUid === 'function' ? g._myUid() : null);
            if (o && countsEarly[o] != null) countsEarly[o] += 1;
        });
        const allOwnersVisible = uids.every((u) => (countsEarly[u] || 0) >= 1);
        if (g._reviewViewportSettled && allOwnersVisible) return true;
        const counts = {};
        uids.forEach((u) => { counts[u] = 0; });
        (g.tiles || []).forEach((t) => {
            const o = t.ownerUid || (typeof g._myUid === 'function' ? g._myUid() : null);
            if (o && counts[o] != null) counts[o] += 1;
        });
        return uids.every((u) => (counts[u] || 0) >= 6);
    }, { uids: playerUids });

    while (Date.now() < deadline) {
        const states = await Promise.all(frames.map((frame) => readyOnFrame(frame)));
        if (states.every(Boolean)) return;
        await new Promise((r) => setTimeout(r, pollMs));
    }

    const snaps = await Promise.all(frames.map((frame, i) => frame.evaluate(({ uids, playerIndex }) => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        const counts = {};
        uids.forEach((u) => { counts[u] = 0; });
        (g?.tiles || []).forEach((t) => {
            const o = t.ownerUid || g._myUid?.();
            if (o && counts[o] != null) counts[o] += 1;
        });
        return {
            player: playerIndex + 1,
            postGameReview: !!g?._postGameReview,
            reviewSettled: !!g?._reviewViewportSettled,
            winnerUid: g?._winnerUid ?? null,
            phase: board?.phase ?? null,
            layoutKeys: board?.reviewLayouts ? Object.keys(board.reviewLayouts) : [],
            counts,
            tileCount: g?.tiles?.length ?? 0
        };
    }, { uids: playerUids, playerIndex: i }).catch(() => ({ player: i + 1, error: true }))));
    failWithSnapshot(label, [`${label}: review boards not ready (${JSON.stringify(snaps)})`], snapshotOrEmpty({}));
}


async function prepareGuestReviewViewport(page, label = 'guest-review-viewport') {
    await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return;
        const board = (typeof RtdbSchema !== 'undefined' && g.roomData)
            ? RtdbSchema.readBoardFromRoom(g.roomData)
            : g.roomData?.global?.board;
        if (board && typeof g._applyMpReviewFromBoard === 'function') {
            g._applyMpReviewFromBoard(board);
        }
        if (typeof g._arrangeReviewLayoutsForDisplay === 'function') {
            g._arrangeReviewLayoutsForDisplay();
        }
        g?._scheduleReviewViewportBurst?.('prepareGuestReviewViewport');
    });
    try {
        await page.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!g?._reviewViewportSettled;
        }, undefined, { timeout: STEP_MS });
    } catch (err) {
        failWithSnapshot(label, [`${label}: review viewport not settled (${err.message})`], snapshotOrEmpty({}));
    }
}


async function assertGuestReviewVisibleWithoutInteraction(
    page,
    label = 'guest-review-visible',
    minOwners = 2,
    minTilesPerOwner = 6
) {
    await prepareGuestReviewViewport(page, `${label}-viewport`);
    const minTotalTiles = Math.max(minTilesPerOwner, minOwners * minTilesPerOwner);
    try {
        await page.waitForFunction(({ min, minPerOwner, minTotal }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g) return false;
            const board = g.roomData?.global?.board || g.roomData?.state?.board;
            const layoutOwners = board?.reviewLayouts
                ? Object.keys(board.reviewLayouts).filter((u) => board.reviewLayouts[u]?.length >= minPerOwner)
                : [];
            const counts = {};
            (g.tiles || []).forEach((t) => {
                const o = t.ownerUid || (typeof g._myUid === 'function' ? g._myUid() : null);
                if (o) counts[o] = (counts[o] || 0) + 1;
            });
            const ownersWithTiles = Object.keys(counts).filter((u) => counts[u] >= minPerOwner);
            const ownerCount = Math.max(ownersWithTiles.length, layoutOwners.length);
            return (g.tiles?.length || 0) >= minTotal
                && ownerCount >= min
                && (!!g._postGameReview || !!g._reviewViewportSettled);
        }, { min: minOwners, minPerOwner: minTilesPerOwner, minTotal: minTotalTiles }, { timeout: STEP_MS });
    } catch (err) {
        const diag = await page.evaluate(() => {
            const win = document.getElementById('game-frame')?.contentWindow;
            const doc = win?.document;
            const g = win?.game;
            const canvas = doc?.getElementById('board-canvas');
            const tiles = doc ? [...doc.querySelectorAll('.tile')] : [];
            const sample = tiles.slice(0, 3).map((t) => {
                const r = t.getBoundingClientRect();
                return { id: t.dataset.tileId, left: r.left, top: r.top, w: r.width, h: r.height };
            });
            return {
                hasGame: !!g,
                postGameReview: !!g?._postGameReview,
                reviewSettled: !!g?._reviewViewportSettled,
                tileCount: tiles.length,
                zoom: g?.zoom ?? null,
                panX: g?.canvasPanX ?? null,
                panY: g?.canvasPanY ?? null,
                focal: g?._viewportFocal ?? null,
                canvas: canvas ? {
                    cw: canvas.clientWidth,
                    ch: canvas.clientHeight,
                    transform: canvas.style.transform?.slice(0, 80) || ''
                } : null,
                iframe: { w: win?.innerWidth, h: win?.innerHeight },
                sample
            };
        });
        failWithSnapshot(label, [`${label}: guest review not visible without touch (${JSON.stringify(diag)})`], snapshotOrEmpty({}));
    }
}

/**
 * Poll host client during review settle — catches loser board flashing then disappearing (guest win).
 * Run in parallel with play-to-win; holds visibility once both players' tiles are on screen.
 *
 * @param {import('playwright').Page} page host page (game iframe)
 * @param {string[]} playerUids
 * @param {string} label
 * @param {{ minPerPlayer?: number, pollMs?: number, maxMs?: number, holdMs?: number }} [options]
 */

async function assertMpReviewBoardsStayVisible(page, playerUids, label = 'review-stable', options = {}) {
    const minPerPlayer = options.minPerPlayer ?? 6;
    const pollMs = options.pollMs ?? 40;
    const maxMs = options.maxMs ?? 15000;
    const holdMs = options.holdMs ?? 1500;
    const start = Date.now();
    let sawAll = false;
    let holdStart = null;
    const dips = [];

    while (Date.now() - start < maxMs) {
        const snap = await page.evaluate(({ uids, min }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board;
            const counts = {};
            uids.forEach((u) => { counts[u] = 0; });
            (g?.tiles || []).forEach((t) => {
                const o = t.ownerUid || g._myUid?.();
                if (counts[o] != null) counts[o] += 1;
            });
            return {
                inReview: !!(g?._postGameReview || board?.phase === 'review'),
                counts,
                tileCount: g?.tiles?.length ?? 0,
                phase: board?.phase ?? null
            };
        }, { uids: playerUids, min: minPerPlayer });

        if (snap.inReview) {
            const allPresent = playerUids.every((u) => (snap.counts[u] || 0) >= minPerPlayer);
            if (allPresent) {
                if (!sawAll) {
                    sawAll = true;
                    holdStart = Date.now();
                }
            } else if (sawAll) {
                dips.push({ counts: snap.counts, tileCount: snap.tileCount, phase: snap.phase });
            }
            if (sawAll && holdStart && Date.now() - holdStart >= holdMs) {
                return;
            }
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }

    if (dips.length) {
        failWithSnapshot(label, ['review board disappeared on host after both were visible'], { dips: dips.slice(0, 3) });
    }
    if (!sawAll) {
        failWithSnapshot(label, [`${label}: never saw both review boards on host within ${maxMs}ms`], snapshotOrEmpty({}));
    }
}


module.exports = { pushHostReviewStateToClients, forceRoomSyncToGameIframes, waitForHostReviewReady, mergeGuestLayoutOnHost, waitMpClientsInReview, waitMpClientsPostWinReady, prepareGuestReviewViewport, assertGuestReviewVisibleWithoutInteraction, assertMpReviewBoardsStayVisible };
