/**
 * Shared compare helpers — pure checks; callers decide assert vs return.
 */
const { failWithSnapshot } = require('./format-failure');

/**
 * @param {*} want
 * @param {*} got
 * @param {string} field
 */
function compareField(want, got, field) {
    const ok = want === got;
    return {
        ok,
        field,
        want,
        got,
        message: ok ? undefined : `${field}: want ${want}, got ${got}`
    };
}

/**
 * @param {object[]} states
 * @param {number} [refIndex]
 */
function comparePoolLengths(states, refIndex = 0) {
    const ref = states[refIndex];
    const problems = [];
    for (let i = 0; i < states.length; i++) {
        if (i === refIndex) continue;
        const s = states[i];
        [
            compareField(ref.localPool, s.localPool, `P${refIndex + 1} vs P${i + 1} localPool`),
            compareField(ref.boardPool, s.boardPool, `P${refIndex + 1} vs P${i + 1} boardPool`),
            compareField(ref.boardSeq, s.boardSeq, `P${refIndex + 1} vs P${i + 1} boardSeq`)
        ].forEach((c) => {
            if (!c.ok && c.message) problems.push(c.message);
        });
    }
    return { ok: problems.length === 0, problems, ref, states };
}

/**
 * @param {object[]} states — health or action snapshots
 * @param {string[]} uids
 */
function compareOwnedCounts(states, uids) {
    const problems = [];
    for (const uid of uids) {
        const counts = states.map((s) => s.ownedByUid?.[uid] ?? s.ownedCountsByUid?.[uid] ?? -1);
        if (!counts.every((c) => c === counts[0])) {
            problems.push(`owned mismatch for ${uid}: ${counts.join(' vs ')}`);
        }
    }
    return { ok: problems.length === 0, problems, uids };
}

/**
 * @param {object} snapshot — capturePlayerStates result
 * @param {object} hostSnap
 * @param {object[]} remotes — ctx.remotes entries
 * @param {string[]} uids
 * @param {string[]} [fields]
 */
function compareRemoteToHost(snapshot, hostSnap, remotes, uids, fields = [
    'boardSeq', 'pileCount', 'boardPileCount', 'reviewPhase', 'winner'
]) {
    const problems = [];
    for (const remote of remotes) {
        const actual = snapshot.byUid?.[remote.uid]
            || snapshot.players?.[remote.index];
        if (!actual) {
            problems.push(`missing snapshot for ${remote.uid}`);
            continue;
        }
        for (const field of fields) {
            const c = compareField(hostSnap[field], actual[field], `${remote.uid}.${field}`);
            if (!c.ok && c.message) problems.push(c.message);
        }
        for (const uid of uids) {
            const hc = hostSnap.ownedCountsByUid?.[uid] ?? -1;
            const rc = actual.ownedCountsByUid?.[uid] ?? -2;
            const c = compareField(hc, rc, `${remote.uid} owned ${uid}`);
            if (!c.ok && c.message) problems.push(c.message);
        }
    }
    return { ok: problems.length === 0, problems };
}

/**
 * @param {object[]} states — per-client review captures
 * @param {string[]} uids
 * @param {{ minPerPlayer?: number }} [opts]
 */
function compareReviewBoards(states, uids, opts = {}) {
    const min = opts.minPerPlayer ?? 1;
    const margin = opts.margin ?? 12;
    const problems = [];

    for (const state of states || []) {
        if (!state.postGame) problems.push(`${state.client}: not in review`);
        for (const uid of uids) {
            if ((state.counts?.[uid] || 0) < min) {
                problems.push(`${state.client}: missing tiles for ${uid} (min ${min})`);
            }
        }
        if ((state.layoutKeys?.length || 0) < uids.length) {
            problems.push(`${state.client}: reviewLayouts incomplete (${state.layoutKeys?.length || 0}/${uids.length})`);
        }
        if (state.viewportBad?.length) {
            problems.push(`${state.client}: ${state.viewportBad.length} tile(s) off viewport (margin ${margin})`);
        }
    }

    const totals = (states || []).map((s) => s.tileCount ?? -1);
    if (totals.length > 1 && !totals.every((t) => t === totals[0])) {
        problems.push(`review tile count mismatch: ${totals.join(' vs ')}`);
    }

    return { ok: problems.length === 0, problems, states };
}

/**
 * @param {string} label
 * @param {{ ok: boolean, problems: string[] }} compareResult
 * @param {object} [snapshot]
 */
function assertNoDrift(label, compareResult, snapshot = {}) {
    if (compareResult?.ok) return compareResult;
    failWithSnapshot(label, compareResult?.problems || ['compare failed'], snapshot);
    return compareResult;
}

function compareBagCounts(actual, bag, label = 'bag') {
    const problems = [];
    const letters = new Set([...Object.keys(actual || {}), ...Object.keys(bag || {})]);
    for (const letter of letters) {
        const got = actual[letter] || 0;
        const want = bag[letter] || 0;
        if (got !== want) problems.push(`${label} ${letter}: want ${want}, got ${got}`);
    }
    return { ok: problems.length === 0, problems };
}

module.exports = {
    compareField,
    comparePoolLengths,
    compareOwnedCounts,
    compareRemoteToHost,
    compareReviewBoards,
    compareBagCounts,
    assertNoDrift
};
