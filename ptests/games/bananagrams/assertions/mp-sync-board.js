/**
 * Shared MP board invariants — pool sync, convergence, peel accounting.
 * Topology-agnostic: pass MpCtx or legacy page1/page2 (2p compat).
 */
const { HOST_UID, GUEST_UID, playerUids } = require('../lib/mp-ctx');

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
 * @param {import('../lib/mp-ctx').MpCtx|{ players: object[] }} ctxOrLegacy
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
 * Global: pool + boardSeq match on every client.
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 */
async function assertAllPlayersPoolSynced(ctx, label, { expectedPool = null, skipExpectedPool = false } = {}) {
    const states = await readAllMpBoardHealthStates(ctx);
    const ref = states[0];
    for (let i = 1; i < states.length; i++) {
        const s = states[i];
        if (s.localPool !== ref.localPool || s.boardPool !== ref.boardPool || s.boardSeq !== ref.boardSeq) {
            throw new Error(`${label} pool/seq mismatch (${JSON.stringify(states)})`);
        }
    }
    const pool = skipExpectedPool ? null : (expectedPool ?? ctx.bag?.expectedPoolAfterDeal);
    if (pool != null && (ref.localPool !== pool || ref.boardPool !== pool)) {
        throw new Error(`${label} expected pool=${pool}, got ${JSON.stringify(states)}`);
    }
    return states;
}

/**
 * Wait until every client sees the same board seq (host authority).
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 */
async function waitAllPlayersBoardSynced(ctx, label) {
    const { WAIT_MS, waitForDiag } = require('../lib/mp-state');
    const hostSeq = await ctx.host.page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return board?.seq ?? 0;
    });
    await Promise.all(ctx.players.map((p, i) => waitForDiag(
        p.page,
        `${label} P${i + 1} boardSeq=${hostSeq}`,
        ({ seq }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return (board?.seq ?? 0) === seq;
        },
        { seq: hostSeq },
        WAIT_MS,
        ctx.mp
    )));
}

/** @deprecated use assertAllPlayersPoolSynced */
async function assertPoolSynced(page1, page2, label, opts = {}) {
    const { buildMpCtx2p } = require('../lib/mp-ctx');
    const ctx = buildMpCtx2p(page1, page2, {
        bag: { expectedPoolAfterDeal: opts.expectedPool }
    });
    if (opts.expectedPool != null) {
        ctx.bag.expectedPoolAfterDeal = opts.expectedPool;
    }
    return assertAllPlayersPoolSynced(ctx, label, { expectedPool: opts.expectedPool });
}

/**
 * Global: pool synced + every player has owned tiles + active on board.
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 */
async function assertAllPlayerInventoriesValid(ctx, label) {
    const states = await assertAllPlayersPoolSynced(ctx, label);
    const hostState = states[0];
    for (const uid of ctx.uids) {
        const owned = hostState.ownedByUid?.[uid] ?? 0;
        if (owned <= 0) {
            throw new Error(`${label} missing owned tiles for ${uid} (${JSON.stringify(states)})`);
        }
        if (!hostState.activeUids.includes(uid)) {
            throw new Error(`${label} board missing active player ${uid} (${JSON.stringify(states)})`);
        }
    }
    for (let i = 1; i < ctx.players.length; i++) {
        if ((states[i].localTileCount ?? 0) <= 0) {
            throw new Error(`${label} ${ctx.players[i].role} has no local tiles (${JSON.stringify(states)})`);
        }
    }
}

/** @deprecated */
async function assertBoardStatesHealthy(page1, page2, label, opts = {}) {
    const { buildMpCtx2p } = require('../lib/mp-ctx');
    const ctx = buildMpCtx2p(page1, page2);
    return assertAllPlayerInventoriesValid(ctx, label);
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
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {string} action
 */
async function capturePlayerStates(ctx, action) {
    const uids = ctx.uids;
    const snapshots = await Promise.all(ctx.players.map((p, i) => captureActionState(
        p.page,
        p.role || `P${i + 1}`,
        action,
        uids
    )));
    return {
        action,
        players: snapshots,
        /** @deprecated 2p compat */
        host: snapshots[0],
        guest: snapshots[1]
    };
}

/** @deprecated use capturePlayerStates */
async function captureActionPair(page1, page2, action, opts = {}) {
    const { buildMpCtx2p } = require('../lib/mp-ctx');
    const ctx = buildMpCtx2p(page1, page2);
    return capturePlayerStates(ctx, action);
}

/**
 * Global sync: boardSeq, pool, phase, winner, owned counts agree on all clients.
 * @param {object} snapshot — from capturePlayerStates
 */
function assertAllPlayersSynced(snapshot, label) {
    const { players } = snapshot;
    if (!players?.length) {
        throw new Error(`${label}: empty player snapshot`);
    }
    const ref = players[0];
    const problems = [];
    const uids = Object.keys(ref.ownedCountsByUid || {});

    for (let i = 1; i < players.length; i++) {
        const p = players[i];
        if (ref.boardSeq !== p.boardSeq) problems.push(`boardSeq mismatch P1 vs P${i + 1}`);
        if (ref.pileCount !== p.pileCount) problems.push(`local pile mismatch P1 vs P${i + 1}`);
        if (ref.boardPileCount !== p.boardPileCount) problems.push(`board pile mismatch P1 vs P${i + 1}`);
        if (ref.reviewPhase !== p.reviewPhase) problems.push(`phase mismatch P1 vs P${i + 1}`);
        if (ref.winner !== p.winner) problems.push(`winner mismatch P1 vs P${i + 1}`);
    }

    for (const uid of uids) {
        const counts = players.map((p) => p.ownedCountsByUid?.[uid] ?? -1);
        if (!counts.every((c) => c === counts[0])) {
            problems.push(`owned mismatch for ${uid}: ${counts.join(' vs ')}`);
        }
    }

    if (problems.length) {
        throw new Error(`${label} divergence: ${problems.join(', ')}\n${JSON.stringify(snapshot, null, 2)}`);
    }
}

/** @deprecated */
function assertConverged(pair, label) {
    assertAllPlayersSynced(
        pair.players ? pair : { players: [pair.host, pair.guest] },
        label
    );
}

/**
 * Peel: pool -= N, each player owned += 1.
 * Supports (ctx, before, after, label) or legacy (beforePair, afterPair, label, opts).
 */
function assertPeelAccounting(a, b, c, d) {
    if (a && typeof a.playerCount === 'number' && Array.isArray(a.uids)) {
        return assertPeelAccountingForCtx(a, b, c);
    }
    const opts = d || {};
    const ctx = {
        playerCount: 2,
        uids: [opts.hostUid || HOST_UID, opts.guestUid || GUEST_UID]
    };
    return assertPeelAccountingForCtx(ctx, a, b, c);
}

function assertPeelAccountingForCtx(ctx, beforeSnapshot, afterSnapshot, label) {
    const n = ctx.playerCount;
    const beforeHost = beforeSnapshot.players?.[0] || beforeSnapshot.host;
    const afterHost = afterSnapshot.players?.[0] || afterSnapshot.host;
    const poolDelta = (afterHost.pileCount ?? -1) - (beforeHost.pileCount ?? -1);
    const problems = [];

    if (poolDelta !== -n) {
        problems.push(`pool expected -${n}, got ${poolDelta}`);
    }

    for (const uid of ctx.uids) {
        const beforeOwned = beforeHost.ownedCountsByUid?.[uid] ?? 0;
        const afterOwned = afterHost.ownedCountsByUid?.[uid] ?? 0;
        const delta = afterOwned - beforeOwned;
        if (delta !== 1) {
            problems.push(`${uid} owned expected +1, got ${delta >= 0 ? '+' : ''}${delta}`);
        }
    }

    if (problems.length) {
        throw new Error(`${label} peel accounting mismatch: ${problems.join('; ')}\n${JSON.stringify({
            before: beforeSnapshot,
            after: afterSnapshot
        }, null, 2)}`);
    }
}

/**
 * Pairwise: each remote client's owned counts for every uid match host view.
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {object} snapshot
 */
function assertRemotesMatchHostBoard(ctx, snapshot, label) {
    const hostSnap = snapshot.players?.[0] || snapshot.host;
    for (let i = 1; i < (snapshot.players?.length || 0); i++) {
        const remoteSnap = snapshot.players[i];
        for (const uid of ctx.uids) {
            const hostCount = hostSnap.ownedCountsByUid?.[uid] ?? -1;
            const remoteCount = remoteSnap.ownedCountsByUid?.[uid] ?? -2;
            if (hostCount !== remoteCount) {
                throw new Error(
                    `${label}: ${ctx.players[i].role} owned mismatch for ${uid} `
                    + `(host=${hostCount}, remote=${remoteCount})`
                );
            }
        }
    }
}

module.exports = {
    HOST_UID,
    GUEST_UID,
    readMpBoardHealthState,
    readAllMpBoardHealthStates,
    assertAllPlayersPoolSynced,
    waitAllPlayersBoardSynced,
    assertPoolSynced,
    assertAllPlayerInventoriesValid,
    assertBoardStatesHealthy,
    captureActionState,
    capturePlayerStates,
    captureActionPair,
    assertAllPlayersSynced,
    assertConverged,
    assertPeelAccounting,
    assertPeelAccountingForCtx,
    assertRemotesMatchHostBoard
};
