/**
 * Strict post-game assertions: frozen timer HUD, multi-board review, host-only Done.
 */

const { STEP_MS } = require('../../../shared/infra/timeouts');

const TIMER_SAMPLE_MS = 200;
const REVIEW_VIEWPORT_MAX_PAN_DRIFT = 12;
const REVIEW_VIEWPORT_MAX_ZOOM_DRIFT = 0.04;
const REVIEW_VIEWPORT_MAX_FOCAL_DRIFT = 20;

async function assertTimerFrozenInReview(frame, label = 'review') {
    const before = await frame.evaluate(() => {
        const g = window.game;
        const timer = document.getElementById('banana-timer');
        return {
            text: timer?.textContent ?? null,
            elapsedMs: g?.elapsedMs ?? 0,
            timerFrozen: !!g?._timerFrozen,
            timerStart: g?._timerStart ?? null,
            timerRaf: g?._timerRaf ?? 0,
            inReview: g?.roomData?.global?.board?.phase === 'review'
                || g?.roomData?.global?.board?.reviewPhase === true
                || !!g?._postGameReview
        };
    });
    if (!before.inReview) {
        throw new Error(`${label}: expected to be in post-game review (${JSON.stringify(before)})`);
    }
    await frame.waitForTimeout(TIMER_SAMPLE_MS);
    const after = await frame.evaluate(() => {
        const g = window.game;
        const timer = document.getElementById('banana-timer');
        return {
            text: timer?.textContent ?? null,
            elapsedMs: g?.elapsedMs ?? 0,
            timerFrozen: !!g?._timerFrozen,
            timerStart: g?._timerStart ?? null
        };
    });
    const elapsedDrift = Math.abs((after.elapsedMs || 0) - (before.elapsedMs || 0));
    if (before.text !== after.text || elapsedDrift > 80) {
        throw new Error(
            `${label}: timer must stop during review (${JSON.stringify({ before, after, elapsedDrift })})`
        );
    }
    if (!after.timerFrozen || after.timerStart != null) {
        throw new Error(`${label}: timer should stay frozen (${JSON.stringify({ before, after })})`);
    }
}

async function assertMpReviewShowsAllBoards(frame, playerUids, label = 'mp-review', minPerPlayer = 1) {
    const state = await frame.evaluate(({ uids, min }) => {
        const g = window.game;
        const board = g?.roomData?.global?.board;
        const tiles = g?.tiles || [];
        const counts = {};
        uids.forEach((u) => { counts[u] = 0; });
        tiles.forEach((t) => {
            const o = t.ownerUid || g._myUid();
            if (counts[o] != null) counts[o] += 1;
        });
        const layoutKeys = Object.keys(board?.reviewLayouts || g?._reviewLayouts || {});
        const missing = uids.filter((u) => (counts[u] || 0) < min);
        return {
            counts,
            layoutKeys,
            missing,
            tileCount: tiles.length,
            postGame: board?.phase === 'review' || board?.reviewPhase === true
        };
    }, { uids: playerUids, min: minPerPlayer });
    if (!state.postGame) {
        throw new Error(`${label}: not in review (${JSON.stringify(state)})`);
    }
    if (state.missing.length) {
        throw new Error(
            `${label}: each player needs visible tiles in review (${JSON.stringify(state)})`
        );
    }
    if (state.layoutKeys.length < playerUids.length) {
        throw new Error(
            `${label}: reviewLayouts should include all players (${JSON.stringify(state)})`
        );
    }
}

/** Snapshot each client's own ending board before review transition (uid → tiles). */
async function capturePreReviewBoardsByPlayer(frames) {
    const byUid = {};
    for (const frame of frames) {
        const snap = await captureEndingLayoutFromFrame(frame);
        if (!snap?.uid) continue;
        byUid[snap.uid] = { uid: snap.uid, tiles: snap.tiles, color: snap.color };
    }
    return byUid;
}

/**
 * Grid-cell check for connected boards: each occupied cell keeps the same tile id + letter in review.
 * Catches letter scrambles that leave tiles on the same connected layout.
 */
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
        throw new Error(`${label}: not in review (${JSON.stringify(state)})`);
    }
    if (!state.ok) {
        throw new Error(`${label}: review scrambled connected boards (${JSON.stringify(state)})`);
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
async function captureEndingLayoutFromFrame(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const uid = g._myUid();
        const tiles = typeof g._captureEndingLayoutForUid === 'function'
            ? g._captureEndingLayoutForUid(uid)
            : (g.tiles || []).map((t) => ({
                id: t.id,
                letter: t.letter,
                x: Math.round(t.x),
                y: Math.round(t.y)
            }));
        return {
            uid,
            color: g.roomData?.playerData?.[uid]?.color || null,
            tiles
        };
    });
}

/** Apply crossword positions to guest local layout (simulates real play after host inventory bump). */
async function syncGuestLocalLayoutFromFixture(frame, tiles) {
    await frame.evaluate((fixtureTiles) => {
        const g = window.game;
        const layout = {};
        fixtureTiles.forEach((t) => {
            layout[t.id] = { x: t.x, y: t.y };
        });
        g._saveLocalLayout(layout);
        (g.tiles || []).forEach((t) => {
            const p = layout[t.id];
            if (p) {
                t.x = p.x;
                t.y = p.y;
                t.faceUp = true;
            }
        });
        g._persistMpLayout();
        g.requestRender?.();
    }, tiles);
}

/**
 * After review: every original tile id present with matching letter + relative layout (±2px).
 */
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

        const bounds = typeof g._reviewTilesBounds === 'function' ? g._reviewTilesBounds(g.tiles) : null;
        const focal = g._viewportFocal;

        return {
            ok: issues.length === 0,
            issues,
            summary,
            tileCount: g.tiles?.length ?? 0,
            bounds,
            focal,
            inReview: !!g._postGameReview || g.roomData?.global?.board?.phase === 'review'
        };
    }, { expected: preWinByUid });

    if (!state.inReview) {
        throw new Error(`${label}: not in review (${JSON.stringify(state)})`);
    }
    if (!state.ok) {
        throw new Error(`${label}: review must preserve ending boards (${JSON.stringify(state)})`);
    }
    if (!state.bounds || !state.focal) {
        throw new Error(`${label}: review should center on combined boards (${JSON.stringify(state)})`);
    }
    const cx = state.bounds.cx;
    const fy = state.focal.y;
    if (Math.abs(state.focal.x - cx) > 120 || Math.abs(fy - state.bounds.cy) > 120) {
        throw new Error(`${label}: viewport should center on review boards (${JSON.stringify(state)})`);
    }
}

/** Pan/zoom/focal must not drift while idle in review (no user pan/zoom). */
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
        throw new Error(`${label}: expected review (${JSON.stringify(first)})`);
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
        throw new Error(
            `${label}: viewport drifted without input (${bad.join(', ')} ${JSON.stringify({ first, second, third, d12 })})`
        );
    }
}

/** Single wait after host Done: both clients leave review, redeal face-down, victory cleared. */
async function waitMpResetAfterDone(frame, label = 'mp-reset', timeout) {
    const { finiteTimeout } = require('./bananagrams_mp_seed');
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
        throw new Error(`${label} reset after Done (${JSON.stringify(snap)}): ${err.message}`);
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
        throw new Error(
            `${label}: expected face-down racks after reset `
            + `(host=${JSON.stringify(hostLocal)}, guest=${JSON.stringify(guestLocal)})`
        );
    }
    if (hostLocal.gameStarted || guestLocal.gameStarted) {
        throw new Error(`${label}: game should not be started yet (${JSON.stringify({ hostLocal, guestLocal })})`);
    }
    if (hostLocal.tileCount < 3 || guestLocal.tileCount < 3) {
        throw new Error(`${label}: expected dealt hands (${JSON.stringify({ hostLocal, guestLocal })})`);
    }
    if (hostLocal.pool !== guestLocal.pool || hostLocal.boardPool !== guestLocal.boardPool) {
        throw new Error(`${label}: pool mismatch (${JSON.stringify({ hostLocal, guestLocal })})`);
    }

    if (hostLocal.positionsKey !== guestLocal.positionsKey
        && !positionsMatch(hostLocal.positions, guestLocal.positions)) {
        throw new Error(
            `${label}: host/guest rack world positions differ\n`
            + `host=${hostLocal.positionsKey}\n`
            + `guest=${guestLocal.positionsKey}`
        );
    }

    if (!positionsMatch(hostLocal.positions, authoritative.host)) {
        throw new Error(
            `${label}: host local rack != host authoritative\n`
            + `local=${hostLocal.positionsKey}\n`
            + `auth=${authoritative.hostKey}`
        );
    }
    if (!positionsMatch(guestLocal.positions, authoritative.guest)) {
        throw new Error(
            `${label}: guest local rack != host authoritative guest layout\n`
            + `guestLocal=${guestLocal.positionsKey}\n`
            + `hostAuthGuest=${authoritative.guestKey}`
        );
    }

    if (!viewportsMatch(hostLocal.viewport, guestLocal.viewport)) {
        throw new Error(
            `${label}: host/guest viewport mismatch after reset `
            + `(host=${JSON.stringify(hostLocal.viewport)}, guest=${JSON.stringify(guestLocal.viewport)})`
        );
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
        throw new Error(`${label}: not playable after reset (${JSON.stringify(pre)})`);
    }
    if (!pre.tileCount) {
        throw new Error(`${label}: no tiles after reset (${JSON.stringify(pre)})`);
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
        throw new Error(`${label}: split drag failed (${JSON.stringify(split)})`);
    }
    if (!split.dragBound) {
        throw new Error(`${label}: tile missing drag binding after reset (${JSON.stringify(split)})`);
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
        throw new Error(`${label}: game did not start after split (${JSON.stringify({ split, snap })}): ${err.message}`);
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
        throw new Error(`${label}: tile drag after split failed (${JSON.stringify({ pre, split, drag })})`);
    }
}

async function assertDoneButtonVisible(frame, expectVisible, label = 'done-btn') {
    const state = await frame.evaluate(() => {
        const btn = document.getElementById('banana-done-btn');
        return {
            visible: !!btn?.classList.contains('show'),
            disabled: !!btn?.disabled
        };
    });
    if (state.visible !== expectVisible) {
        throw new Error(`${label}: Done visible=${state.visible}, want ${expectVisible}`);
    }
    if (expectVisible && state.disabled) {
        throw new Error(`${label}: Done should be enabled (${JSON.stringify(state)})`);
    }
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
        throw new Error(`${label}: all review boards must fit viewport (${JSON.stringify(state)})`);
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
        throw new Error(`${label}: review boards should stack ${wantPortrait ? 'vertically' : 'horizontally'} (${JSON.stringify(state)})`);
    }
}

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
    throw new Error(`${label}: not all clients in review (${JSON.stringify(snaps)})`);
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
    throw new Error(`${label}: review boards not ready (${JSON.stringify(snaps)})`);
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
        throw new Error(`${label}: review viewport not settled (${err.message})`);
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
        throw new Error(`${label}: guest review not visible without touch (${JSON.stringify(diag)})`);
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
        throw new Error(
            `${label}: review board disappeared on host after both were visible `
            + `(${JSON.stringify(dips.slice(0, 3))})`
        );
    }
    if (!sawAll) {
        throw new Error(`${label}: never saw both review boards on host within ${maxMs}ms`);
    }
}

module.exports = {
    assertTimerFrozenInReview,
    assertMpReviewShowsAllBoards,
    capturePreReviewBoardsByPlayer,
    assertReviewPreservesGridCells,
    assertReviewPreservesPreWinBoards,
    assertMpReviewPreservesSnapshots,
    assertReviewViewportStable,
    assertReviewBoardsFullyVisible,
    assertReviewLayoutOrientation,
    mergeGuestLayoutOnHost,
    pushHostReviewStateToClients,
    forceRoomSyncToGameIframes,
    waitForHostReviewReady,
    waitMpClientsInReview,
    waitMpClientsPostWinReady,
    prepareGuestReviewViewport,
    assertGuestReviewVisibleWithoutInteraction,
    assertMpReviewBoardsStayVisible,
    waitMpResetAfterDone,
    assertMpResetHostGuestLayoutSynced,
    assertMpPlayableAfterReset,
    assertDoneButtonVisible,
    captureEndingLayoutFromFrame,
    syncGuestLocalLayoutFromFixture,
    TIMER_SAMPLE_MS
};
