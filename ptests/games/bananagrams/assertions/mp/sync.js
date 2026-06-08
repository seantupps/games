/**
 * MP sync invariants — pool, board seq, phase, remotes match host.
 * Pattern: capture → compare → assert
 */
const { assertOk } = require('../core/assert-ok');
const { failWithSnapshot } = require('../core/format-failure');
const {
    comparePoolLengths,
    compareOwnedCounts,
    compareRemoteToHost,
    assertNoDrift
} = require('../core/compare');
const {
    readAllMpBoardHealthStates,
    capturePlayerStates,
    captureHealth
} = require('../core/capture');

/**
 * Global: pool + boardSeq match on every client.
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 */
async function assertAllPlayersPoolSynced(ctx, label, { expectedPool = null, skipExpectedPool = false } = {}) {
    const states = await readAllMpBoardHealthStates(ctx);
    const poolCmp = comparePoolLengths(states);
    assertNoDrift(`${label}: pool/seq`, poolCmp, { states });

    const pool = skipExpectedPool ? null : (expectedPool ?? ctx.bag?.expectedPoolAfterDeal);
    if (pool != null) {
        const ref = states[0];
        assertOk(
            ref.localPool === pool && ref.boardPool === pool,
            `${label}: expected pool=${pool}`,
            { states, expectedPool: pool }
        );
    }
    return states;
}

/**
 * Wait until every client sees the same board seq (host authority).
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 */
async function waitAllPlayersBoardSynced(ctx, label) {
    const { WAIT_MS, waitForDiag } = require('../../lib/mp-state');
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


/**
 * Global: pool synced + every player has owned tiles + active on board.
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 */
async function assertAllPlayerInventoriesValid(ctx, label) {
    const states = await assertAllPlayersPoolSynced(ctx, label);
    const hostState = states[0];
    for (const uid of ctx.uids) {
        const owned = hostState.ownedByUid?.[uid] ?? 0;
        assertOk(owned > 0, `${label}: missing owned tiles for ${uid}`, { states, uid });
        assertOk(
            hostState.activeUids.includes(uid),
            `${label}: board missing active player ${uid}`,
            { states, uid }
        );
    }
    for (let i = 1; i < ctx.players.length; i++) {
        assertOk(
            (states[i].localTileCount ?? 0) > 0,
            `${label}: ${ctx.players[i].role} has no local tiles`,
            { states, player: ctx.players[i].role }
        );
    }
}


function hostSnapFromSnapshot(snapshot, ctx) {
    return snapshot.byUid?.[ctx.host.uid] || snapshot.players?.[0];
}

/**
 * Global sync: boardSeq, pool, phase, winner, owned counts agree on all clients.
 * @param {import('../../lib/mp-ctx').MpCtx|object} ctxOrSnapshot
 * @param {string} [label]
 * @param {object} [snapshot] — optional pre-captured snapshot (ctx mode only)
 */
async function assertAllPlayersSynced(ctxOrSnapshot, label = 'sync', snapshot = null) {
    if (ctxOrSnapshot?.players && !ctxOrSnapshot?.uids && typeof label === 'string' && snapshot == null) {
        assertAllPlayersSyncedFromSnapshot(ctxOrSnapshot, label);
        return ctxOrSnapshot;
    }

    const ctx = ctxOrSnapshot;
    const snap = snapshot || await capturePlayerStates(ctx, label);
    const host = hostSnapFromSnapshot(snap, ctx);
    assertOk(!!host, `${label}: missing host snapshot`, { snap, hostUid: ctx.host.uid });

    const remoteCmp = compareRemoteToHost(snap, host, ctx.remotes, ctx.uids);
    assertNoDrift(label, remoteCmp, { states: snap });

    const ownedCmp = compareOwnedCounts(snap.players, ctx.uids);
    assertNoDrift(label, ownedCmp, { states: snap });

    return snap;
}

function assertAllPlayersSyncedFromSnapshot(snapshot, label) {
    const { players } = snapshot;
    assertOk(players?.length, `${label}: empty player snapshot`, { snapshot });
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

    const ownedCmp = compareOwnedCounts(players, uids);
    if (!ownedCmp.ok) problems.push(...ownedCmp.problems);

    if (problems.length) {
        failWithSnapshot(label, problems, { snapshot });
    }
}


/**
 * Pairwise: each remote client's owned counts for every uid match host view.
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 * @param {object} snapshot
 */
function assertRemotesMatchHostBoard(ctx, snapshot, label) {
    const hostSnap = hostSnapFromSnapshot(snapshot, ctx);
    const cmp = compareRemoteToHost(snapshot, hostSnap, ctx.remotes, ctx.uids);
    assertNoDrift(label, cmp, { snapshot });
}

/**
 * 2p pool HUD + local + board pool must match expected (strict, no settle retry).
 * @param {import('playwright').Page} hostPage
 * @param {import('playwright').Page} guestPage
 * @param {number} expected
 * @param {string} label
 */
async function assertPoolBothStrict(hostPage, guestPage, expected, label) {
    const { readPoolSyncState } = require('../../lib/mp-state');
    const [host, guest] = await Promise.all([
        readPoolSyncState(hostPage),
        readPoolSyncState(guestPage)
    ]);
    const problems = [];
    for (const [side, state] of [['host', host], ['guest', guest]]) {
        if (state.localPool !== expected) {
            problems.push(`${side} localPool=${state.localPool} expected ${expected}`);
        }
        if (state.hud !== expected) {
            problems.push(`${side} hud=${state.hud} expected ${expected}`);
        }
        if (state.boardPool >= 0 && state.boardPool !== expected) {
            problems.push(`${side} boardPool=${state.boardPool} expected ${expected}`);
        }
    }
    if (host.localPool !== guest.localPool) {
        problems.push(`localPool mismatch host=${host.localPool} guest=${guest.localPool}`);
    }
    if (host.boardPool !== guest.boardPool
        && host.boardPool >= 0 && guest.boardPool >= 0) {
        problems.push(`boardPool mismatch host=${host.boardPool} guest=${guest.boardPool}`);
    }
    if (host.hud !== guest.hud) {
        problems.push(`hud mismatch host=${host.hud} guest=${guest.hud}`);
    }
    if (problems.length) {
        failWithSnapshot(label, problems, { expected, host, guest });
    }
    return { host, guest };
}

/**
 * Same as assertPoolBothStrict with brief settle retry (natural RTDB lag).
 */
async function assertPoolBothNatural(hostPage, guestPage, expected, label, settleMs = 120) {
    const deadline = Date.now() + settleMs;
    let lastErr;
    while (Date.now() <= deadline) {
        try {
            return await assertPoolBothStrict(hostPage, guestPage, expected, label);
        } catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 20));
    }
    throw lastErr;
}

/** Last-bunch peel must drain bunch to 0 on both clients (brief natural settle). */
async function assertPeelDrainedStrict(hostPage, guestPage, label) {
    await assertPoolBothNatural(hostPage, guestPage, 0, `${label} immediate`, 150);
}

/** Guest must not claim win while perceiving stale bunch authority. */
async function assertWinBlockedOnGuestWhenDesynced(guestPage, guestFrame, label) {
    const { readPoolSyncState } = require('../../lib/mp-pool-waits');
    const guestState = await readPoolSyncState(guestPage);
    if (guestState.authBunch === 0 && guestState.localPool === 0) return;

    const blocked = await guestFrame.evaluate(() => {
        const g = window.game;
        const before = !!(g._winnerUid || g._victoryRegistered || g.isOver);
        const hand = typeof g._snapHandForValidation === 'function'
            ? g._snapHandForValidation(g.tiles)
            : g.tiles;
        const allPlaced = typeof g._allTilesPlacedOn === 'function'
            ? g._allTilesPlacedOn(hand)
            : false;
        const gridOk = window.BananaGrid?.validateGrid(hand, g._checker)?.ok;
        const auth = typeof g._mpAuthoritativeBunchLen === 'function'
            ? g._mpAuthoritativeBunchLen()
            : (g._tilePool?.length ?? -1);
        g._bannerText = '';
        g._checkPeel();
        const after = !!(g._winnerUid || g._victoryRegistered || g.isOver);
        return {
            before,
            after,
            authBunch: auth,
            allPlaced,
            gridOk,
            won: after && !before
        };
    });

    if (blocked.won) {
        throw new Error(
            `${label}: guest claimed win while bunch authority=${guestState.authBunch} `
            + `(local=${guestState.localPool}, board=${guestState.boardPool}) `
            + `${JSON.stringify(blocked)}`
        );
    }
}

/** After last-bunch host peel each player should have 5 owned (4 grid + 1 peel). */
function assertLastBunchOwnedAfterHostPeel(hostOwned, guestOwned, postHostPeel) {
    if (hostOwned !== 5 || guestOwned !== 5) {
        throw new Error(
            `last-bunch host peel accounting: expected 5 owned each (4 grid + 1 peel), `
            + `got host=${hostOwned} guest=${guestOwned}\n${JSON.stringify(postHostPeel, null, 2)}`
        );
    }
}

module.exports = {
    assertAllPlayersPoolSynced,
    waitAllPlayersBoardSynced,    assertPoolBothStrict,
    assertPoolBothNatural,
    assertPeelDrainedStrict,
    assertWinBlockedOnGuestWhenDesynced,
    assertLastBunchOwnedAfterHostPeel,
    assertAllPlayerInventoriesValid,    assertAllPlayersSynced,    assertRemotesMatchHostBoard,
    captureHealth
};
