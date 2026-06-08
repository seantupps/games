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
async function waitMpResetAfterDone(frame, label = 'mp-reset', timeout) {
    const { finiteTimeout } = require('./distribution-seed');
    const cap = finiteTimeout(timeout, STEP_MS);
    await frame.waitForFunction(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board;
        const minHand = typeof BananaRules !== 'undefined'
            ? BananaRules.startingHandSize(2)
            : 11;
        const hand = g?.tiles || [];
        const inReview = !!g?._postGameReview
            || board?.phase === 'review'
            || board?.reviewPhase === true;
        return !!(g
            && !inReview
            && !g._winnerUid
            && !board?.winnerUid
            && !g._victoryRegistered
            && !g.isOver
            && hand.length >= minHand
            && hand.every((t) => !t.faceUp));
    }, undefined, { timeout: cap }).catch(async (err) => {
        const snap = await frame.evaluate(() => {
            const g = window.game;
            const board = g?.roomData?.global?.board;
            const hand = g?.tiles || [];
            return {
                postGameReview: !!g?._postGameReview,
                phase: board?.phase ?? null,
                reviewPhase: board?.reviewPhase ?? null,
                winnerUid: g?._winnerUid || board?.winnerUid || null,
                victoryRegistered: !!g?._victoryRegistered,
                isOver: !!g?.isOver,
                tileCount: hand.length,
                faceDown: hand.length > 0 && hand.every((t) => !t.faceUp)
            };
        }).catch(() => null);
        failWithSnapshot(label, [`${label} reset after Done (${JSON.stringify(snap)}): ${err.message}`], snapshotOrEmpty({}));
    });
}

/** Rack + viewport snapshot after host Done (pre-split face-down hand). */

async function captureMpResetLayoutFromPage(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const tiles = (g?.tiles || [])
            .map((t) => ({
                id: t.id,
                letter: t.letter,
                x: Math.round(t.x),
                y: Math.round(t.y),
                faceUp: !!t.faceUp
            }))
            .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
        const positions = tiles.map(({ x, y }) => ({ x, y }));
        return {
            role: g?.playerRole ?? null,
            uid: g?._myUid?.() || null,
            tileCount: tiles.length,
            tiles,
            positions,
            positionsKey: JSON.stringify(positions),
            faceDown: tiles.length > 0 && tiles.every((t) => !t.faceUp),
            gameStarted: !!g?.gameStarted,
            pool: g?._tilePool?.length ?? -1,
            boardPool: Array.isArray(board?.pool) ? board.pool.length : -1,
            viewport: {
                panX: Math.round(g?.canvasPanX || 0),
                panY: Math.round(g?.canvasPanY || 0),
                zoom: Number((g?.zoom ?? 1).toFixed(4)),
                targetZoom: Number((g?.targetZoom ?? 1).toFixed(4)),
                focalX: Number.isFinite(g?._viewportFocal?.x) ? Math.round(g._viewportFocal.x) : null,
                focalY: Number.isFinite(g?._viewportFocal?.y) ? Math.round(g._viewportFocal.y) : null
            }
        };
    });
}

/** Host authoritative tile positions per uid (from board or host layout store). */

async function captureHostAuthoritativeLayouts(hostPage, hostUid, guestUid) {
    return hostPage.evaluate(({ hostUid: hUid, guestUid: gUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const positionsFor = (uid) => {
            const fromBoard = board?.tilePositionsByPlayer?.[uid];
            if (Array.isArray(fromBoard) && fromBoard.length) {
                return fromBoard
                    .map((t) => ({ x: Math.round(t.x), y: Math.round(t.y) }))
                    .sort((a, b) => a.y - b.y || a.x - b.x);
            }
            const map = g?._mpPlayerLayouts?.[uid] || {};
            return Object.values(map)
                .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
                .sort((a, b) => a.y - b.y || a.x - b.x);
        };
        return {
            host: positionsFor(hUid),
            guest: positionsFor(gUid),
            hostKey: JSON.stringify(positionsFor(hUid)),
            guestKey: JSON.stringify(positionsFor(gUid))
        };
    }, { hostUid, guestUid });
}


function positionsMatch(a, b, tol = 2) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i].x - b[i].x) > tol || Math.abs(a[i].y - b[i].y) > tol) return false;
    }
    return true;
}


function viewportsMatch(a, b, { panTol = 2, focalTol = 2, zoomTol = 0.02 } = {}) {
    if (!a || !b) return false;
    if (Math.abs((a.panX || 0) - (b.panX || 0)) > panTol) return false;
    if (Math.abs((a.panY || 0) - (b.panY || 0)) > panTol) return false;
    if (Math.abs((a.zoom || 1) - (b.zoom || 1)) > zoomTol) return false;
    if (a.focalX != null && b.focalX != null
        && Math.abs(a.focalX - b.focalX) > focalTol) return false;
    if (a.focalY != null && b.focalY != null
        && Math.abs(a.focalY - b.focalY) > focalTol) return false;
    return true;
}

/**
 * After Done reset: host/guest racks share the same world layout and viewport framing
 * before split/drag checks.
 */

async function assertMpResetHostGuestLayoutSynced(hostPage, guestPage, opts = {}) {
    const hostUid = opts.hostUid || 'u_banana_host';
    const guestUid = opts.guestUid || 'u_banana_guest';
    const label = opts.label || 'post-reset layout';

    const [hostLocal, guestLocal, authoritative] = await Promise.all([
        captureMpResetLayoutFromPage(hostPage),
        captureMpResetLayoutFromPage(guestPage),
        captureHostAuthoritativeLayouts(hostPage, hostUid, guestUid)
    ]);

    if (!hostLocal.faceDown || !guestLocal.faceDown) {
        failWithSnapshot(label, ['expected face-down racks after reset'], { hostLocal, guestLocal });
    }
    if (hostLocal.gameStarted || guestLocal.gameStarted) {
        failWithSnapshot(label, [`${label}: game should not be started yet (${JSON.stringify({ hostLocal, guestLocal })})`], snapshotOrEmpty({}));
    }
    if (hostLocal.tileCount < 3 || guestLocal.tileCount < 3) {
        failWithSnapshot(label, [`${label}: expected dealt hands (${JSON.stringify({ hostLocal, guestLocal })})`], snapshotOrEmpty({}));
    }
    if (hostLocal.pool !== guestLocal.pool || hostLocal.boardPool !== guestLocal.boardPool) {
        failWithSnapshot(label, [`${label}: pool mismatch (${JSON.stringify({ hostLocal, guestLocal })})`], snapshotOrEmpty({}));
    }

    if (hostLocal.positionsKey !== guestLocal.positionsKey
        && !positionsMatch(hostLocal.positions, guestLocal.positions)) {
        failWithSnapshot(label, ['host/guest rack world positions differ'], {
            host: hostLocal.positionsKey,
            guest: guestLocal.positionsKey
        });
    }

    if (!positionsMatch(hostLocal.positions, authoritative.host)) {
        failWithSnapshot(label, ['host local rack != host authoritative'], {
            local: hostLocal.positionsKey,
            auth: authoritative.hostKey
        });
    }
    if (!positionsMatch(guestLocal.positions, authoritative.guest)) {
        failWithSnapshot(label, ['guest local rack != host authoritative guest layout'], {
            guestLocal: guestLocal.positionsKey,
            hostAuthGuest: authoritative.guestKey
        });
    }

    if (!viewportsMatch(hostLocal.viewport, guestLocal.viewport)) {
        failWithSnapshot(label, ['host/guest viewport mismatch after reset'], { hostLocal, guestLocal });
    }
}

/** After host Done: client can split (face-up) and drag tiles (P1 + P2). */

async function assertMpPlayableAfterReset(frame, label = 'playable', opts = {}) {
    const pointerType = opts.pointerType || 'touch';
    const pre = await frame.evaluate(() => {
        const g = window.game;
        return {
            postGameReview: !!g?._postGameReview,
            frozen: !!document.querySelector('.board-pan-layer.is-review-frozen'),
            reviewTile: !!document.querySelector('.tile.is-review-tile'),
            isOver: !!g?.isOver,
            victoryRegistered: !!g?._victoryRegistered,
            tileCount: g?.tiles?.length ?? 0,
            gameStarted: !!g?.gameStarted
        };
    });
    if (pre.postGameReview || pre.frozen || pre.reviewTile || pre.isOver || pre.victoryRegistered) {
        failWithSnapshot(label, [`${label}: not playable after reset (${JSON.stringify(pre)})`], snapshotOrEmpty({}));
    }
    if (!pre.tileCount) {
        failWithSnapshot(label, [`${label}: no tiles after reset (${JSON.stringify(pre)})`], snapshotOrEmpty({}));
    }

    const split = await frame.evaluate(async ({ pointerType }) => {
        const g = window.game;
        const tile = document.querySelector('.tile');
        if (!tile) return { ok: false, reason: 'no-tile' };
        const dragBound = tile.dataset.bananaDragBound === '1';
        const r = tile.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        tile.dispatchEvent(mk('pointerdown', cx, cy));
        tile.dispatchEvent(mk('pointermove', cx + 28, cy + 28));
        tile.dispatchEvent(mk('pointerup', cx + 28, cy + 28));
        await new Promise((res) => requestAnimationFrame(res));
        return { ok: true, dragBound, role: g.playerRole };
    }, { pointerType });
    if (!split.ok) {
        failWithSnapshot(label, [`${label}: split drag failed (${JSON.stringify(split)})`], snapshotOrEmpty({}));
    }
    if (!split.dragBound) {
        failWithSnapshot(label, [`${label}: tile missing drag binding after reset (${JSON.stringify(split)})`], snapshotOrEmpty({}));
    }

    const syncMs = opts.syncMs ?? STEP_MS;
    await frame.waitForFunction(() => {
        const g = window.game;
        const faceUp = g?.tiles?.length > 0 && g.tiles.every((t) => t.faceUp);
        const domFaceUp = g?.gameStarted
            && ![...document.querySelectorAll('.tile')].some((n) => n.classList.contains('is-face-down'));
        return !!(g?.gameStarted && (faceUp || domFaceUp));
    }, undefined, { timeout: syncMs }).catch(async (err) => {
        const snap = await frame.evaluate(() => ({
            role: window.game?.playerRole,
            gameStarted: !!window.game?.gameStarted,
            faceUp: window.game?.tiles?.every((t) => t.faceUp),
            dragBound: document.querySelector('.tile')?.dataset?.bananaDragBound
        })).catch(() => null);
        failWithSnapshot(label, [`${label}: game did not start after split (${JSON.stringify({ split, snap })}): ${err.message}`], snapshotOrEmpty({}));
    });

    const drag = await frame.evaluate(async ({ pointerType }) => {
        const g = window.game;
        const tile = g.tiles?.[0];
        const node = tile
            ? document.querySelector(`[data-tile-id="${tile.id}"]`)
            : document.querySelector('.tile');
        if (!node || !tile) return { ok: false, reason: 'no-tile' };
        const r = node.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const before = { x: tile.x, y: tile.y };
        node.dispatchEvent(mk('pointerdown', x0, y0));
        node.dispatchEvent(mk('pointermove', x0 + 72, y0 + 56));
        node.dispatchEvent(mk('pointerup', x0 + 72, y0 + 56));
        await new Promise((res) => requestAnimationFrame(res));
        const after = { x: tile.x, y: tile.y };
        return {
            ok: true,
            moved: Math.hypot(after.x - before.x, after.y - before.y) > 12,
            before,
            after
        };
    }, { pointerType });
    if (!drag.ok || !drag.moved) {
        failWithSnapshot(label, [`${label}: tile drag after split failed (${JSON.stringify({ pre, split, drag })})`], snapshotOrEmpty({}));
    }
}


module.exports = { waitMpResetAfterDone, captureMpResetLayoutFromPage, captureHostAuthoritativeLayouts, positionsMatch, viewportsMatch, assertMpResetHostGuestLayoutSynced, assertMpPlayableAfterReset };
