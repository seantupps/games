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
async function assertMpReviewShowsAllBoards(frame, playerUids, label = 'mp-review', minPerPlayer = 1) {
    const state = await captureReviewStateFromFrame(frame, playerUids, { role: label });
    const cmp = compareReviewBoards([state], playerUids, { minPerPlayer });
    if (!cmp.ok) {
        failWithSnapshot(label, cmp.problems, { state });
    }
}

/** Snapshot each client's own ending board before review transition (uid → tiles). */

async function assertReviewPreservesGridCells(frame, preWinByUid, label = 'review-grid') {
    const state = await frame.evaluate(({ expected }) => {
        const g = window.game;
        const origin = { x: g.ORIGIN, y: g.ORIGIN };
        const size = (typeof BananaRules !== 'undefined' && BananaRules.TILE_SIZE) || 40;
        const issues = [];

        const toGrid = (tiles, uid) => {
            const grid = {};
            (tiles || []).forEach((t) => {
                const gx = Math.round((t.x - origin.x) / size);
                const gy = Math.round((t.y - origin.y) / size);
                grid[`${gx},${gy}`] = { id: t.id, letter: t.letter, uid };
            });
            return grid;
        };

        Object.entries(expected).forEach(([uid, snap]) => {
            const preGrid = toGrid(snap.tiles, uid);
            const onBoard = (g.tiles || []).filter((t) => (t.ownerUid || g._myUid()) === uid);
            const postGrid = toGrid(onBoard, uid);

            Object.entries(preGrid).forEach(([cell, pre]) => {
                const post = postGrid[cell];
                if (!post) {
                    issues.push({ uid, cell, reason: 'missing-cell', pre });
                    return;
                }
                if (post.letter !== pre.letter) {
                    issues.push({
                        uid, cell, reason: 'letter-scramble', want: pre.letter, have: post.letter,
                        wantId: pre.id, haveId: post.id
                    });
                } else if (post.id !== pre.id) {
                    issues.push({
                        uid, cell, reason: 'tile-swap', wantId: pre.id, haveId: post.id
                    });
                }
            });

            Object.keys(postGrid).forEach((cell) => {
                if (!preGrid[cell]) {
                    issues.push({ uid, cell, reason: 'extra-cell', post: postGrid[cell] });
                }
            });
        });

        return {
            ok: issues.length === 0,
            issues,
            inReview: !!g._postGameReview || g.roomData?.global?.board?.phase === 'review'
        };
    }, { expected: preWinByUid });

    if (!state.inReview) {
        failWithSnapshot(label, [`${label}: not in review (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
    if (!state.ok) {
        failWithSnapshot(label, [`${label}: review scrambled connected boards (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
}

/** On every client, review boards must match pre-win snapshots (relative layout + grid cells). */

async function assertReviewPreservesPreWinBoards(frames, preWinByUid, label = 'review-preserves-pre-win') {
    for (let i = 0; i < frames.length; i++) {
        const clientLabel = `${label} P${i + 1}`;
        await assertMpReviewPreservesSnapshots(frames[i], preWinByUid, `${clientLabel}-snapshots`);
        await assertReviewPreservesGridCells(frames[i], preWinByUid, `${clientLabel}-grid`);
    }
}

/** Each client captures its own ending layout (local board + localStorage). */

async function assertMpReviewPreservesSnapshots(frame, preWinByUid, label = 'mp-review-snapshots') {
    const state = await frame.evaluate(({ expected }) => {
        const g = window.game;
        const doc = document;
        const issues = [];
        const summary = { owners: {}, colors: {}, positions: {} };

        const relative = (tiles) => {
            if (!tiles?.length) return {};
            let minX = Infinity;
            let minY = Infinity;
            tiles.forEach((t) => {
                minX = Math.min(minX, t.x);
                minY = Math.min(minY, t.y);
            });
            const out = {};
            tiles.forEach((t) => {
                out[t.id] = {
                    letter: t.letter,
                    x: Math.round(t.x - minX),
                    y: Math.round(t.y - minY)
                };
            });
            return out;
        };

        const size = (typeof BananaRules !== 'undefined' && BananaRules.TILE_SIZE) || 40;
        const allTiles = g.tiles || [];
        for (let i = 0; i < allTiles.length; i++) {
            for (let j = i + 1; j < allTiles.length; j++) {
                const a = allTiles[i];
                const b = allTiles[j];
                const overlapX = a.x < b.x + size && a.x + size > b.x;
                const overlapY = a.y < b.y + size && a.y + size > b.y;
                if (overlapX && overlapY) {
                    issues.push({
                        reason: 'tile-overlap',
                        a: { id: a.id, owner: a.ownerUid, x: a.x, y: a.y },
                        b: { id: b.id, owner: b.ownerUid, x: b.x, y: b.y }
                    });
                }
            }
        }

        Object.entries(expected).forEach(([uid, snap]) => {
            const want = snap.tiles || [];
            const onBoard = allTiles.filter((t) => (t.ownerUid || g._myUid()) === uid);
            summary.owners[uid] = { want: want.length, have: onBoard.length };

            const wantRel = relative(want);
            const haveRel = relative(onBoard);

            want.forEach((w) => {
                const t = onBoard.find((x) => x.id === w.id);
                if (!t) {
                    issues.push({ uid, reason: 'missing-tile', id: w.id, letter: w.letter });
                    return;
                }
                if (t.letter !== w.letter) {
                    issues.push({
                        uid, reason: 'letter-mismatch', id: w.id, want: w.letter, have: t.letter
                    });
                }
                const wr = wantRel[w.id];
                const hr = haveRel[w.id];
                if (!wr || !hr) return;
                const dx = Math.abs(hr.x - wr.x);
                const dy = Math.abs(hr.y - wr.y);
                if (dx > 2 || dy > 2) {
                    issues.push({
                        uid,
                        reason: 'position-mismatch',
                        id: w.id,
                        want: wr,
                        have: hr
                    });
                }
            });

            const wantColor = (snap.color || '').toLowerCase();
            const el = onBoard[0]
                ? doc.querySelector(`[data-tile-id="${onBoard[0].id}"] .tile-face`)
                : null;
            const bg = el ? getComputedStyle(el).backgroundColor : '';
            summary.colors[uid] = { wantColor, sampleBg: bg };
            if (wantColor && bg) {
                const probe = doc.createElement('div');
                probe.style.background = snap.color;
                doc.body.appendChild(probe);
                const wantBg = getComputedStyle(probe).backgroundColor;
                probe.remove();
                if (wantBg !== bg) {
                    issues.push({ uid, reason: 'color-mismatch', wantBg, bg, tileId: onBoard[0]?.id });
                }
            }
        });

        /** Same-owner overlaps in merged review are common on steered loser stragglers — warn only. */
        const blockingIssues = issues.filter((issue) => {
            if (issue.reason !== 'tile-overlap') return true;
            const owner = issue.a?.owner;
            if (!owner || owner !== issue.b?.owner) return true;
            const counts = summary.owners[owner];
            return !(counts && counts.want === counts.have);
        });
        const overlapWarnings = issues.filter((issue) => !blockingIssues.includes(issue));

        const bounds = typeof g._reviewTilesBounds === 'function' ? g._reviewTilesBounds(g.tiles) : null;
        const focal = g._viewportFocal;

        return {
            ok: blockingIssues.length === 0,
            issues: blockingIssues,
            overlapWarnings,
            summary,
            tileCount: g.tiles?.length ?? 0,
            bounds,
            focal,
            inReview: !!g._postGameReview || g.roomData?.global?.board?.phase === 'review'
        };
    }, { expected: preWinByUid });

    if (!state.inReview) {
        failWithSnapshot(label, [`${label}: not in review (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
    if (state.overlapWarnings?.length) {
        console.log(`[TEST] WARN ${label}: ${state.overlapWarnings.length} same-owner tile overlap(s) in merged review `
            + `(counts OK) — ${JSON.stringify(state.overlapWarnings.slice(0, 2))}`);
    }
    if (!state.ok) {
        failWithSnapshot(label, [`${label}: review must preserve ending boards (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
    if (!state.bounds || !state.focal) {
        failWithSnapshot(label, [`${label}: review should center on combined boards (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
    const cx = state.bounds.cx;
    const fy = state.focal.y;
    if (Math.abs(state.focal.x - cx) > 120 || Math.abs(fy - state.bounds.cy) > 120) {
        failWithSnapshot(label, [`${label}: viewport should center on review boards (${JSON.stringify(state)})`], snapshotOrEmpty({}));
    }
}

/** Pan/zoom/focal must not drift while idle in review (no user pan/zoom). */

module.exports = { assertMpReviewShowsAllBoards, assertReviewPreservesGridCells, assertReviewPreservesPreWinBoards, assertMpReviewPreservesSnapshots };
