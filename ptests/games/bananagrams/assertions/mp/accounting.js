/**
 * MP action accounting — peel/dump tile deltas across all players.
 * Pattern: capture → compare → assert
 */
const { assertOk } = require('../core/assert-ok');
const { HOST_UID, GUEST_UID } = require('../core/capture');

function hostSnap(snapshot, ctx) {
    return snapshot.byUid?.[ctx.host.uid]
        || snapshot.players?.[0]
        || snapshot.host;
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
    const beforeHost = hostSnap(beforeSnapshot, ctx);
    const afterHost = hostSnap(afterSnapshot, ctx);
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

    assertOk(problems.length === 0, `${label}: peel accounting mismatch`, {
        problems,
        before: beforeSnapshot,
        after: afterSnapshot,
        playerCount: n
    });
}

/**
 * Dump: pool -= 3, dumper owned += 3, others unchanged.
 * @param {import('../../lib/mp-ctx').MpCtx} ctx
 * @param {object} beforeSnapshot
 * @param {object} afterSnapshot
 * @param {string} label
 * @param {{ dumperUid?: string }} [opts]
 */
function assertDumpAccounting(ctx, beforeSnapshot, afterSnapshot, label, opts = {}) {
    const beforeHost = hostSnap(beforeSnapshot, ctx);
    const afterHost = hostSnap(afterSnapshot, ctx);
    const poolDelta = (afterHost.pileCount ?? -1) - (beforeHost.pileCount ?? -1);
    const problems = [];

    if (poolDelta !== -3) {
        problems.push(`pool expected -3, got ${poolDelta}`);
    }

    let dumperUid = opts.dumperUid || null;
    if (!dumperUid) {
        for (const uid of ctx.uids) {
            const delta = (afterHost.ownedCountsByUid?.[uid] ?? 0)
                - (beforeHost.ownedCountsByUid?.[uid] ?? 0);
            if (delta === 3) {
                dumperUid = uid;
                break;
            }
        }
    }

    for (const uid of ctx.uids) {
        const delta = (afterHost.ownedCountsByUid?.[uid] ?? 0)
            - (beforeHost.ownedCountsByUid?.[uid] ?? 0);
        const expected = uid === dumperUid ? 3 : 0;
        if (delta !== expected) {
            problems.push(`${uid} owned expected +${expected}, got ${delta >= 0 ? '+' : ''}${delta}`);
        }
    }

    assertOk(problems.length === 0, `${label}: dump accounting mismatch`, {
        problems,
        dumperUid,
        before: beforeSnapshot,
        after: afterSnapshot
    });
}

module.exports = {
    assertPeelAccounting,
    assertPeelAccountingForCtx,
    assertDumpAccounting
};
