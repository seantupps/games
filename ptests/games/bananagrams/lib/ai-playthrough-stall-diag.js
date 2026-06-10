/**
 * Targeted AI playthrough stall bundle — instant verdict when MP solver loop stalls.
 */

/** Runs in game iframe. */
function stallPlayerDiagScript() {
    const g = window.game;
    if (!g?._checker || typeof BananaGrid === 'undefined') {
        return { ok: false, reason: 'missing-game' };
    }
    const uid = g._myUid?.() || null;
    const room = g.roomData;
    const board = (typeof RtdbSchema !== 'undefined' && room)
        ? RtdbSchema.readBoardFromRoom(room)
        : room?.global?.board;
    const hand = typeof g._snapHandForValidation === 'function'
        ? g._snapHandForValidation(g.tiles)
        : (g.tiles || []);
    const grid = BananaGrid.validateGrid(hand, g._checker);
    const { tiles: mainTiles, disconnected } = BananaGrid.largestComponentTiles(hand);
    const mainGrid = mainTiles.length
        ? BananaGrid.validateGrid(mainTiles, g._checker)
        : { ok: false, words: [], reason: 'empty-main' };
    const owned = board?.tilesOwnedByPlayer?.[uid] || board?.hands?.[uid] || g._mpOwned?.[uid] || [];
    let peelWouldRun = null;
    try {
        peelWouldRun = typeof g._checkPeel === 'function' ? !!g._checkPeel() : null;
    } catch (_) {
        peelWouldRun = null;
    }
    return {
        role: g.playerRole || (g.isHost?.() ? 'host' : 'guest'),
        uid,
        tiles: hand.length,
        owned: Array.isArray(owned) ? owned.length : 0,
        pool: g._tilePool?.length ?? -1,
        boardCells: hand.filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y)).length,
        rackTiles: hand.length - mainTiles.length - disconnected,
        mainTiles: mainTiles.length,
        stragglers: disconnected,
        allPlaced: typeof g._allTilesPlacedOn === 'function' ? !!g._allTilesPlacedOn(hand) : null,
        connected: BananaGrid.isConnected(hand),
        gridOk: !!grid.ok,
        gridInvalidReason: grid.ok ? null : (grid.reason || null),
        gridInvalidWord: grid.ok ? null : (grid.word || null),
        mainGridOk: !!mainGrid.ok,
        mainInvalidReason: mainGrid.ok ? null : (mainGrid.reason || null),
        mainInvalidWord: mainGrid.ok ? null : (mainGrid.word || null),
        words: (mainGrid.words || grid.words || []).slice(0, 14),
        peelWouldRun,
        boardPeelSeq: board?.peelSeq ?? null,
        boardDumpSeq: board?.dumpSeq ?? null,
        boardRevision: board?.boardRevision ?? null,
        appliedRevision: g._mpAppliedBoardRevision ?? null,
        firstCorrupt: g._mpFirstLetterCorruption || null,
        dist: g._lastMpDistCheck?.ok === false ? g._lastMpDistCheck : null
    };
}

/**
 * @param {object[]} sides — playthrough side ctxs with .frame and .label
 * @param {object} stats
 * @param {number} idleRounds
 * @param {number} hostPool
 * @param {number} round
 */
async function captureStallFailureDiag(sides, stats, idleRounds, hostPool, round) {
    const players = await Promise.all(sides.map(async (side) => {
        const diag = await side.frame.evaluate(stallPlayerDiagScript);
        return { ...diag, label: side.label, isGuest: !!side.isGuest };
    }));
    const host = players.find((p) => !p.isGuest) || players[0];
    const guest = players.find((p) => p.isGuest) || players[1];
    const verdict = inferStallVerdict({ host, guest, stats, idleRounds, hostPool, round });
    const suspects = inferStallSuspects({ host, guest, stats, hostPool });
    return {
        kind: 'ai-playthrough-stall',
        verdict,
        suspects,
        idleRounds,
        hostPool,
        round,
        stats,
        players
    };
}

function inferStallVerdict({ host, guest, idleRounds, hostPool, round }) {
    const guestBad = guest && !guest.gridOk;
    const hostBad = host && !host.gridOk;
    const guestWord = guest?.mainInvalidWord || guest?.gridInvalidWord;
    const hostWord = host?.mainInvalidWord || host?.gridInvalidWord;

    if (guestBad && host && host.gridOk) {
        const w = guestWord ? `"${guestWord}"` : (guest.mainInvalidReason || guest.gridInvalidReason || 'unknown');
        return `Guest crossword invalid (${w}) — MP party peel blocked; host stuck at pool=${hostPool} after ${idleRounds} idle rounds (round ${round})`;
    }
    if (hostBad && guest && guest.gridOk) {
        const w = hostWord ? `"${hostWord}"` : (host.mainInvalidReason || host.gridInvalidReason || 'unknown');
        return `Host crossword invalid (${w}) — cannot peel/drain bunch (pool=${hostPool})`;
    }
    if (guestBad && hostBad) {
        return `Both players have invalid crosswords — MP playthrough cannot advance (pool=${hostPool})`;
    }
    if (host && !host.peelWouldRun && host.allPlaced && host.gridOk && hostPool > 0) {
        return `Host grid valid but _checkPeel() false with pool=${hostPool} — likely party-peel gate (guest must also be peel-ready)`;
    }
    return `No progress for ${idleRounds} round-trips — host pool=${hostPool}, host tiles=${host?.tiles ?? '?'}, guest tiles=${guest?.tiles ?? '?'}`;
}

function inferStallSuspects({ host, guest, hostPool }) {
    const out = [];
    const guestWord = guest?.mainInvalidWord || guest?.gridInvalidWord;
    if (guest && !guest.gridOk) {
        out.push(
            guestWord
                ? `Guest invalid word ${guestWord} on ${guest.mainTiles} tile crossword`
                + ' — inspect guest layout projection / canonical letters (mp-board.js, mp-canonical.js)'
                : `Guest grid invalid (${guest.mainInvalidReason || guest.gridInvalidReason})`
                + ' — inspect guest tile hydration and layout stores'
        );
        if (host?.gridOk && hostPool > 0) {
            out.push('Party peel requires ALL players peel-ready — one invalid guest board blocks entire MP game');
        }
    }
    if (guest?.firstCorrupt) {
        out.push(`Guest letter corruption: ${JSON.stringify(guest.firstCorrupt)}`);
    }
    if (host?.dist) {
        out.push(`Host distribution invariant failed: ${JSON.stringify(host.dist)}`);
    }
    if (guest?.tiles !== guest?.owned && guest?.owned != null) {
        out.push(`Guest tiles=${guest.tiles} vs owned=${guest.owned} — inventory projection drift`);
    }
    return out;
}

/**
 * @param {object} bundle
 * @returns {string}
 */
function formatStallFailure(bundle, opts = {}) {
    const lines = [];
    lines.push('── AI PLAYTHROUGH STALL ───────────────────────────────');
    if (!opts.skipVerdict) lines.push(`VERDICT: ${bundle.verdict}`);

    for (const p of bundle.players || []) {
        const invalid = p.mainInvalidWord || p.gridInvalidWord;
        const gridTag = p.gridOk ? 'valid' : (invalid ? `INVALID "${invalid}"` : (p.gridInvalidReason || 'invalid'));
        lines.push(
            `${p.label}: tiles=${p.tiles} board=${p.mainTiles} stragglers=${p.stragglers}`
            + ` pool=${p.pool} grid=${gridTag} peel=${p.peelWouldRun ? 'yes' : 'no'}`
        );
        if (p.words?.length) lines.push(`  words: ${p.words.join(', ')}`);
    }

    lines.push(
        `Stats: peels=${bundle.stats?.peels ?? 0} dumps=${bundle.stats?.dumps ?? 0}`
        + ` placements=${bundle.stats?.placements ?? 0} desiredWin=${bundle.stats?.desiredWinSide ?? '?'}`
    );

    if (bundle.suspects?.length) {
        lines.push('Fix first:');
        bundle.suspects.slice(0, 4).forEach((s) => lines.push(`  → ${s}`));
    }
    lines.push('────────────────────────────────────────────────────────');
    return lines.join('\n');
}

/**
 * @param {string} message
 * @param {object} bundle
 */
function throwStallFailure(message, bundle) {
    const skipVerdict = String(message).includes(bundle.verdict);
    const targetedText = formatStallFailure(bundle, { skipVerdict });
    const err = new Error(message);
    err.details = {
        targeted: true,
        targetedDiag: bundle,
        targetedText,
        problems: [bundle.verdict]
    };
    throw err;
}

module.exports = {
    captureStallFailureDiag,
    formatStallFailure,
    throwStallFailure,
    stallPlayerDiagScript
};
