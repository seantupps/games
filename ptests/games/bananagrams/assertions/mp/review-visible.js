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
async function assertReviewBoardsVisible(ctx, label, opts = {}) {
    const states = await captureReviewState(ctx, opts);
    const cmp = compareReviewBoards(states, ctx.uids, opts);
    if (!cmp.ok) failWithSnapshot(label, cmp.problems, { states, uids: ctx.uids });
    return states;
}
async function assertReviewBoardsFullyVisible(frame, label = 'review-visible', margin = 12) {
    const state = await frame.evaluate(({ margin: m }) => {
        const tiles = [...document.querySelectorAll('.tile')];
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const bad = [];
        tiles.forEach((t) => {
            const r = t.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) bad.push({ id: t.dataset.tileId, reason: 'tiny' });
            if (r.right < m || r.left > vw - m || r.bottom < m || r.top > vh - m) {
                bad.push({
                    id: t.dataset.tileId,
                    rect: { left: r.left, top: r.top, width: r.width, height: r.height }
                });
            }
        });
        const bounds = typeof window.game?._reviewTilesBounds === 'function'
            ? window.game._reviewTilesBounds(window.game.tiles)
            : null;
        return {
            ok: tiles.length > 0 && !bad.length,
            bad,
            count: tiles.length,
            vw,
            vh,
            bounds,
            zoom: window.game?.zoom ?? null
        };
    }, { margin });
    if (!state.ok) {
        failWithSnapshot(label, [`${label}: all review boards must fit viewport (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
}


async function assertReviewLayoutOrientation(frame, playerUids, wantPortrait, label = 'review-orient') {
    const state = await frame.evaluate(({ uids, wantPortrait: portrait }) => {
        const g = window.game;
        const centers = uids.map((uid) => {
            const tiles = (g.tiles || []).filter((t) => t.ownerUid === uid);
            if (!tiles.length) return null;
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            tiles.forEach((t) => {
                minX = Math.min(minX, t.x);
                minY = Math.min(minY, t.y);
                maxX = Math.max(maxX, t.x);
                maxY = Math.max(maxY, t.y);
            });
            return { uid, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, minX, minY };
        }).filter(Boolean);
        if (centers.length < 2) return { ok: false, reason: 'need-2-players', centers };
        centers.sort((a, b) => (portrait ? a.cy - b.cy : a.cx - b.cx));
        let monotonic = true;
        for (let i = 1; i < centers.length; i++) {
            if (portrait) {
                if (centers[i].minY <= centers[i - 1].minY + 40) monotonic = false;
            } else if (centers[i].minX <= centers[i - 1].minX + 40) {
                monotonic = false;
            }
        }
        const spreadX = Math.max(...centers.map((c) => c.cx)) - Math.min(...centers.map((c) => c.cx));
        const spreadY = Math.max(...centers.map((c) => c.cy)) - Math.min(...centers.map((c) => c.cy));
        const oriented = portrait ? spreadY > spreadX : spreadX > spreadY;
        return { ok: monotonic && oriented, centers, spreadX, spreadY, portrait };
    }, { uids: playerUids, wantPortrait });
    if (!state.ok) {
        failWithSnapshot(label, [`${label}: review boards should stack ${wantPortrait ? 'vertically' : 'horizontally'} (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
}


async function assertReviewViewportStable(frame, label = 'review-viewport') {
    const readViewport = () => frame.evaluate(() => {
        const g = window.game;
        return {
            panX: g?.canvasPanX ?? 0,
            panY: g?.canvasPanY ?? 0,
            zoom: g?.zoom ?? 1,
            targetZoom: g?.targetZoom ?? 1,
            focalX: g?._viewportFocal?.x ?? null,
            focalY: g?._viewportFocal?.y ?? null,
            settled: !!g?._reviewViewportSettled,
            inReview: g?.roomData?.global?.board?.phase === 'review'
                || g?.roomData?.global?.board?.reviewPhase === true
                || !!g?._postGameReview
        };
    });

    const first = await readViewport();
    if (!first.inReview) {
        failWithSnapshot(label, [`${label}: expected review (${JSON.stringify(first)})`], snapshotOrEmpty({}));
    }
    if (!first.settled) {
        await frame.waitForFunction(() => window.game?._reviewViewportSettled === true, undefined, {
            timeout: STEP_MS
        }).catch(() => {});
    }

    await frame.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const second = await readViewport();
    await frame.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const third = await readViewport();

    const drift = (a, b) => ({
        panX: Math.abs((a.panX || 0) - (b.panX || 0)),
        panY: Math.abs((a.panY || 0) - (b.panY || 0)),
        zoom: Math.abs((a.zoom || 0) - (b.zoom || 0)),
        targetZoom: Math.abs((a.targetZoom || 0) - (b.targetZoom || 0)),
        focalX: a.focalX != null && b.focalX != null ? Math.abs(a.focalX - b.focalX) : 0,
        focalY: a.focalY != null && b.focalY != null ? Math.abs(a.focalY - b.focalY) : 0
    });

    const d12 = drift(second, third);
    const bad = [];
    if (d12.panX > REVIEW_VIEWPORT_MAX_PAN_DRIFT || d12.panY > REVIEW_VIEWPORT_MAX_PAN_DRIFT) {
        bad.push('pan');
    }
    if (d12.zoom > REVIEW_VIEWPORT_MAX_ZOOM_DRIFT || d12.targetZoom > REVIEW_VIEWPORT_MAX_ZOOM_DRIFT) {
        bad.push('zoom');
    }
    if (d12.focalX > REVIEW_VIEWPORT_MAX_FOCAL_DRIFT || d12.focalY > REVIEW_VIEWPORT_MAX_FOCAL_DRIFT) {
        bad.push('focal');
    }
    if (bad.length) {
        failWithSnapshot(label, [`viewport drifted without input (${bad.join(', ')})`], { first, second, third, d12 });
    }
}

/** Single wait after host Done: both clients leave review, redeal face-down, victory cleared. */

async function assertDoneButtonVisible(frame, expectVisible, label = 'done-btn') {
    const state = await frame.evaluate(() => {
        const btn = document.getElementById('banana-done-btn');
        return {
            visible: !!btn?.classList.contains('show'),
            disabled: !!btn?.disabled
        };
    });
    if (state.visible !== expectVisible) {
        failWithSnapshot(label, [`${label}: Done visible=${state.visible}, want ${expectVisible}`], snapshotOrEmpty({}));
    }
    if (expectVisible && state.disabled) {
        failWithSnapshot(label, [`${label}: Done should be enabled (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
}


module.exports = { assertReviewBoardsVisible, assertReviewBoardsFullyVisible, assertReviewLayoutOrientation, assertReviewViewportStable, assertDoneButtonVisible };
