/**
 * Structured state logging for MP actions playthrough debugging.
 * Enable: FIVE_MP_ACTIONS_DEBUG=1 (default on for this scenario).
 */
const {
    log,
    captureMpState,
    captureBothMpStates
} = require('../../lib/mp-lib');

const DEBUG = process.env.FIVE_MP_ACTIONS_DEBUG !== '0';

function enabled() {
    return DEBUG;
}

function stateLine(label, snap, solved) {
    const rackN = snap?.rack?.length ?? 0;
    const boardN = snap?.boardCells?.length ?? 0;
    const ai = solved
        ? `ai(changed=${solved.changed} cleared=${solved.cleared} stuck=${solved.stuck} left=${(solved.rackLeft || []).join('') || '-'})`
        : 'ai(-)';
    return [
        `  ${label}:`,
        `pool=${snap?.poolLen ?? '?'}`,
        `rack=${rackN}[${(snap?.rack || []).map((t) => t.letter).join('')}]`,
        `board=${boardN}`,
        `placed=${snap?.allPlaced ? 'y' : 'n'}`,
        `grid=${snap?.gridOk ? 'y' : 'n'}`,
        `winner=${snap?.winner ? 'y' : 'n'}`,
        ai
    ].join(' ');
}

function explainSkippedAction(snap, solved, kind) {
    if (kind === 'peel') {
        if (!snap?.allPlaced) return 'peel-skip(not-all-placed)';
        if (!snap?.gridOk) return 'peel-skip(grid-invalid)';
        if (snap?.poolLen === 1) return 'peel-skip(party-peel-needs-2+)';
        if (snap?.poolLen === 0) return 'peel-skip(win-peel-failed)';
        return 'peel-skip(check-returned-false)';
    }
    if (kind === 'dump') {
        if (!solved?.stuck) return 'dump-skip(not-stuck)';
        if (!(snap?.rack?.length > 0)) return 'dump-skip(empty-rack)';
        if (!(snap?.poolLen >= 3)) return `dump-skip(short-pool=${snap?.poolLen ?? '?'})`;
        return 'dump-skip(handle-returned-false)';
    }
    if (kind === 'place') {
        if (!solved?.changed) return 'place-skip(no-ai-change)';
        return 'place-skip(unknown)';
    }
    return `${kind}-skip(?)`;
}

function logPhase(phase, extra = '') {
    if (!enabled()) return;
    log(`[MP-STATE] ${phase}${extra ? ` ${extra}` : ''}`);
}

function logTurn(turn, startedAt, states, labels, solvedResults, actionNotes = []) {
    if (!enabled()) return;
    const elapsed = Date.now() - startedAt;
    log(`[MP-STATE] turn=${turn} elapsed=${elapsed}ms`);
    states.forEach((snap, i) => {
        log(stateLine(labels[i] || `P${i + 1}`, snap, solvedResults?.[i]));
    });
    if (actionNotes.length) {
        log(`[MP-STATE]   actions: ${actionNotes.join(' | ')}`);
    }
}

async function probeFrame(frame, label) {
    if (!enabled()) return null;
    try {
        const probe = await frame.evaluate(() => {
            const g = window.game;
            if (!g || !BananaGrid || !BananaRules) return { error: 'missing-game-or-rules' };
            const origin = g.ORIGIN;
            const opts = g._rackLayoutOptions();
            const rackBounds = BananaGrid.getRackBounds(
                { x: origin, y: origin },
                opts.cols,
                opts.gap,
                opts.tileSize,
                opts.handBelowCenter
            );
            const rackTiles = (g.tiles || []).filter((t) => BananaGrid.isTileInRack(t, rackBounds, opts.tileSize));
            const grid = BananaGrid.validateGrid(g.tiles, g._checker);
            const allPlacedFn = typeof g._allTilesPlaced === 'function'
                ? g._allTilesPlaced()
                : BananaGrid.allTilesPlacedInGrid(g.tiles, { x: origin, y: origin }, opts);
            const room = g.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            const words = (grid.words || []).map((w) => String(w || ''));
            const hasThree = words.some((w) => w.length >= 3);
            return {
                role: g.playerRole,
                uid: g._myUid?.() || null,
                isHost: !!g.isHost?.(),
                tileCount: g.tiles?.length ?? 0,
                rackCount: rackTiles.length,
                rackLetters: rackTiles.map((t) => t.letter).join(''),
                boardCellCount: (g.tiles || []).filter(
                    (t) => !BananaGrid.isTileInRack(t, rackBounds, opts.tileSize)
                ).length,
                poolLocal: g._tilePool?.length ?? -1,
                poolBoard: Array.isArray(board?.pool) ? board.pool.length : -1,
                gameStarted: !!g.gameStarted,
                allPlaced: !!allPlacedFn,
                gridOk: !!grid.ok,
                gridReason: grid.reason || null,
                words,
                hasThreeLetterWord: hasThree,
                peelSeq: board?.peelSeq ?? null,
                dumpSeq: board?.dumpSeq ?? null,
                boardSeq: board?.seq ?? null,
                winnerUid: g._winnerUid || board?.winnerUid || null,
                isOver: !!g.isOver,
                banner: g._bannerText || '',
                pendingInteractions: Array.isArray(room?.interactions?.banana)
                    ? room.interactions.banana.length
                    : 0
            };
        });
        log(`[MP-STATE] probe ${label}: ${JSON.stringify(probe)}`);
        return probe;
    } catch (e) {
        log(`[MP-STATE] probe ${label} failed: ${e.message}`);
        return { error: e.message };
    }
}

async function logBothPages(phase, page1, page2) {
    if (!enabled()) return;
    const snaps = await captureBothMpStates(page1, page2, phase);
    log(`[MP-STATE] ${phase}`);
    log(`[MP-STATE]   host: ${JSON.stringify(snaps.host)}`);
    log(`[MP-STATE]   guest: ${JSON.stringify(snaps.guest)}`);
    return snaps;
}

async function logFailure(page1, page2, turn, states, labels, solvedResults, reason) {
    log(`[MP-STATE] FAIL turn=${turn} reason=${reason}`);
    if (states?.length) {
        states.forEach((snap, i) => {
            log(stateLine(labels[i] || `P${i + 1}`, snap, solvedResults?.[i]));
        });
    }
    await logBothPages(`failure-${reason}`, page1, page2);
}

module.exports = {
    enabled,
    logPhase,
    logTurn,
    probeFrame,
    logBothPages,
    logFailure,
    explainSkippedAction,
    captureMpState,
    captureBothMpStates
};
