/**
 * Shared MP state capture — read host/player/client snapshots from the browser.
 * Assertions consume these; they never mutate game state.
 */
const { HOST_UID, GUEST_UID, playerUids } = require('../../lib/mp-ctx');

/**
 * @param {import('playwright').Page} page
 * @param {number|object} [playerIdxOrOpts]
 * @param {object} [legacyOpts]
 */
async function readMpBoardHealthState(page, playerIdxOrOpts, legacyOpts = {}) {
    let opts = {};
    if (typeof playerIdxOrOpts === 'number') {
        opts = {
            playerLabel: `P${playerIdxOrOpts}`,
            uids: [legacyOpts.hostUid || HOST_UID, legacyOpts.guestUid || GUEST_UID]
        };
    } else if (playerIdxOrOpts && typeof playerIdxOrOpts === 'object') {
        opts = playerIdxOrOpts;
    }
    const { playerLabel = 'P?', uids = [] } = opts;
    const uidList = uids.length ? uids : [HOST_UID, GUEST_UID];
    return page.evaluate(({ playerLabel: label, uids: list }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const activeUids = board?.playerUids || [];
        const owned = board?.tilesOwnedByPlayer || board?.hands || {};
        const me = g?._myUid?.() || null;
        const ownedByUid = {};
        for (const uid of list) {
            ownedByUid[uid] = Array.isArray(owned?.[uid]) ? owned[uid].length : 0;
        }
        return {
            player: label,
            uid: me,
            localPool: g?._tilePool?.length ?? -1,
            boardPool: Array.isArray(board?.pool) ? board.pool.length : -1,
            boardSeq: board?.seq ?? null,
            peelSeq: board?.peelSeq ?? null,
            dumpSeq: board?.dumpSeq ?? null,
            phase: board?.phase ?? null,
            activeUids,
            ownedByUid,
            localTileCount: g?.tiles?.length ?? 0
        };
    }, { playerLabel, uids: uidList });
}

/**
 * @param {import('../../lib/mp-ctx').MpCtx|{ players: object[] }} ctxOrLegacy
 * @param {object} [opts]
 */
async function readAllMpBoardHealthStates(ctxOrLegacy, opts = {}) {
    const players = ctxOrLegacy.players || [
        { page: ctxOrLegacy.page1 || ctxOrLegacy.host?.page, role: 'P1', uid: opts.hostUid || HOST_UID },
        { page: ctxOrLegacy.page2 || ctxOrLegacy.remotes?.[0]?.page, role: 'P2', uid: opts.guestUid || GUEST_UID }
    ];
    const uids = playerUids(ctxOrLegacy.players ? ctxOrLegacy : { players });
    return Promise.all(players.map((p, i) => readMpBoardHealthState(p.page, {
        playerLabel: p.role || `P${i + 1}`,
        uids: uids.length ? uids : [p.uid]
    })));
}

/**
 * @param {import('playwright').Page} page
 * @param {string} clientLabel
 * @param {string} action
 * @param {string[]} uids
 */
async function captureActionState(page, clientLabel, action, uids) {
    return page.evaluate(({ c, a, uidList }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const me = g?._myUid?.() || null;
        const owned = board?.tilesOwnedByPlayer || board?.hands || {};
        const boardPos = board?.tilePositionsByPlayer || {};
        const boardTileIds = Object.values(boardPos)
            .flat()
            .map((p) => p?.id)
            .filter(Boolean)
            .sort();
        const handIds = (g?.tiles || []).map((t) => t.id);
        const ownedCountsByUid = {};
        for (const uid of uidList) {
            ownedCountsByUid[uid] = Array.isArray(owned?.[uid]) ? owned[uid].length : 0;
        }
        const banner = doc?.getElementById('banana-banner');
        const doneBtn = doc?.querySelector('button#done-button,[data-action="done"],.done-button');
        return {
            client: c,
            uid: me,
            action: a,
            handIds,
            boardTileIds,
            pileCount: g?._tilePool?.length ?? -1,
            boardPileCount: Array.isArray(board?.pool) ? board.pool.length : -1,
            ownedCountsByUid,
            boardSeq: board?.seq ?? null,
            inventorySeq: g?._localInventorySeq ?? null,
            boardInventorySeq: board?.inventorySeq?.[me || ''] ?? null,
            peelSeq: board?.peelSeq ?? 0,
            dumpSeq: board?.dumpSeq ?? 0,
            bannerVisible: !!(banner && banner.classList.contains('is-visible')),
            bannerText: banner?.textContent?.trim() || '',
            winner: g?._winnerUid ?? board?.winnerUid ?? null,
            isOver: !!g?.isOver,
            reviewPhase: board?.phase ?? null,
            doneVisible: !!(doneBtn && doneBtn.offsetParent !== null)
        };
    }, { c: clientLabel, a: action, uidList: uids });
}

/**
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 * @param {string} [action]
 */
async function capturePlayerStates(ctx, action = 'snapshot') {
    const uids = ctx.uids;
    const players = await Promise.all(ctx.players.map((p, i) => captureActionState(
        p.page,
        p.role || `P${i + 1}`,
        action,
        uids
    )));

    /** @type {Record<string, typeof players[0]>} */
    const byUid = {};
    for (const snap of players) {
        if (snap?.uid) byUid[snap.uid] = snap;
    }

    return {
        action,
        players,
        byUid,
        /** @deprecated use byUid[ctx.host.uid] */
        host: players[0],
        /** @deprecated use byUid for remotes */
        guest: players[1]
    };
}

/** @deprecated use capturePlayerStates */
async function captureActionPair(page1, page2, action, opts = {}) {
    const { buildMpCtx2p } = require('../../lib/mp-ctx');
    const ctx = buildMpCtx2p(page1, page2);
    return capturePlayerStates(ctx, action);
}

/**
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 */
async function captureHealth(ctx) {
    const states = await readAllMpBoardHealthStates(ctx);
    return {
        at: Date.now(),
        playerCount: ctx.playerCount,
        uids: ctx.uids,
        players: states
    };
}

/**
 * @param {import('playwright').Frame} frame
 * @param {string[]} uids
 * @param {{ margin?: number, role?: string }} [opts]
 */
async function captureReviewStateFromFrame(frame, uids, opts = {}) {
    const margin = opts.margin ?? 12;
    return frame.evaluate(({ uids: list, margin: m, role }) => {
        const g = window.game;
        const board = g?.roomData?.global?.board;
        const tiles = g?.tiles || [];
        const counts = {};
        list.forEach((u) => { counts[u] = 0; });
        tiles.forEach((t) => {
            const o = t.ownerUid || g._myUid();
            if (counts[o] != null) counts[o] += 1;
        });
        const layoutKeys = Object.keys(board?.reviewLayouts || g?._reviewLayouts || {});
        const viewportBad = [];
        tiles.forEach((t) => {
            const node = document.querySelector(`[data-tile-id="${t.id}"]`);
            if (!node) return;
            const r = node.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) {
                viewportBad.push({ id: t.id, reason: 'tiny' });
            } else if (r.right < m || r.left > window.innerWidth - m
                || r.bottom < m || r.top > window.innerHeight - m) {
                viewportBad.push({
                    id: t.id,
                    rect: { left: r.left, top: r.top, width: r.width, height: r.height }
                });
            }
        });
        return {
            client: role || 'frame',
            counts,
            layoutKeys,
            missing: list.filter((u) => (counts[u] || 0) < 1),
            tileCount: tiles.length,
            postGame: board?.phase === 'review' || board?.reviewPhase === true || !!g?._postGameReview,
            viewportBad,
            vw: window.innerWidth,
            vh: window.innerHeight
        };
    }, { uids, margin, role: opts.role });
}

/**
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 * @param {{ margin?: number }} [opts]
 */
async function captureReviewState(ctx, opts = {}) {
    const { getGameFrame } = require('../../lib/mp-state');
    const frames = ctx.frames?.length
        ? ctx.frames
        : await Promise.all(ctx.players.map((p) => getGameFrame(p.page)));
    return Promise.all(frames.map((frame, i) => captureReviewStateFromFrame(frame, ctx.uids, {
        margin: opts.margin,
        role: ctx.players[i]?.role || `P${i + 1}`
    })));
}

/**
 * Read one board field from a hub page (peelSeq, dumpSeq, seq, etc.).
 * @param {import('playwright').Page} page
 * @param {string} field
 */
async function readBoardField(page, field) {
    return page.evaluate(({ f }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const val = board?.[f];
        if (val != null) return val;
        if (f === 'peelSeq' || f === 'dumpSeq') return 0;
        if (f === 'seq') return 0;
        return null;
    }, { f: field });
}

/** @param {import('playwright').Frame} frame */
async function readActionBanner(frame) {
    return frame.evaluate(() => {
        const el = document.getElementById('banana-banner');
        if (!el) return { ok: false, reason: 'no-banner-el' };
        const style = window.getComputedStyle(el);
        return {
            ok: true,
            visible: el.classList.contains('is-visible'),
            text: (el.textContent || '').trim(),
            color: el.style.color || style.color || ''
        };
    });
}

/**
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 */
async function captureAuthorityState(ctx) {
    const { getGameFrame } = require('../../lib/mp-state');
    const frames = ctx.frames?.length
        ? ctx.frames
        : await Promise.all(ctx.players.map((p) => getGameFrame(p.page)));
    const [banners, health] = await Promise.all([
        Promise.all(frames.map((frame, i) => readActionBanner(frame).then((b) => ({
            client: ctx.players[i]?.role || `P${i + 1}`,
            ...b
        })))),
        readAllMpBoardHealthStates(ctx)
    ]);
    return {
        at: Date.now(),
        uids: ctx.uids,
        banners,
        health
    };
}

/**
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 * @param {Record<string, { tiles?: object[] }>|null} [endingSnapshots]
 */
async function captureDistributionState(ctx, endingSnapshots = null) {
    const { getGameFrame } = require('../../lib/mp-state');
    const { readTileDistributionState } = require('../mp/distribution');
    const frame = ctx.frames?.[0] || await getGameFrame(ctx.host.page);
    const state = await readTileDistributionState(frame, endingSnapshots);
    return {
        at: Date.now(),
        playerCount: ctx.playerCount,
        uids: ctx.uids,
        ...state
    };
}

module.exports = {
    HOST_UID,
    GUEST_UID,
    readMpBoardHealthState,
    readAllMpBoardHealthStates,
    readBoardField,
    readActionBanner,
    captureActionState,
    capturePlayerStates,
    captureActionPair,
    captureHealth,
    captureReviewState,
    captureReviewStateFromFrame,
    captureAuthorityState,
    captureDistributionState
};
