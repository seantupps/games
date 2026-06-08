/**
 * MP AI win steering — force host/guest victory via rack reservation.
 */
const { solveAttemptFromBrowserState } = require('../ai');

function resolvePlayToWin(opts) {
    if (opts.playToWin != null) return !!opts.playToWin;
    return process.env.FIVE_MP_AI_PLAY_TO_WIN !== '0';
}

/** @returns {{ side: 'host'|'guest'|null, forced: boolean }} */
function resolveWinSteering(opts, playToWin) {
    if (!playToWin) return { side: null, forced: false };
    const raw = opts.winSide ?? (() => {
        try {
            const { getWinSide } = require('../../../shared/infra/run-config');
            return getWinSide();
        } catch (_) {
            return null;
        }
    })();
    if (raw === 'host' || raw === 'p1') return { side: 'host', forced: true };
    if (raw === 'guest' || raw === 'p2') return { side: 'guest', forced: true };
    return { side: 'host', forced: false };
}

/** @deprecated use resolveWinSteering */
function resolveDesiredWinSide(opts, playToWin) {
    return resolveWinSteering(opts, playToWin).side;
}

function sideMatchesDesiredWin(ctx) {
    if (!ctx.desiredWinSide) return true;
    return ctx.desiredWinSide === 'host' ? !ctx.isGuest : ctx.isGuest;
}

const STEER_MIN_RACK_KEEP = 1;

function filterPlacementsForReservedRack(snap, placements, reservedIds) {
    const reserved = new Set(reservedIds || []);
    if (!reserved.size) return placements || [];
    const reservedLetters = new Set(
        (snap.rack || []).filter((r) => reserved.has(r.id))
            .map((r) => String(r.letter).toUpperCase())
    );
    if (!reservedLetters.size) return placements || [];
    const occupied = new Set((snap.boardCells || []).map((c) => `${c.gx},${c.gy}`));
    return (placements || []).filter((p) => {
        const want = String(p.letter || '').toUpperCase();
        if (occupied.has(`${p.gx},${p.gy}`)) return true;
        return !reservedLetters.has(want);
    });
}

function rackTileIdForPlacement(snap, placement) {
    const want = String(placement.letter || '').toUpperCase();
    const match = (snap.rack || []).find((r) => String(r.letter).toUpperCase() === want);
    return match?.id ?? null;
}

function splitWinPlacements(snap, solved) {
    const occupied = new Set((snap.boardCells || []).map((c) => `${c.gx},${c.gy}`));
    const rackLetters = new Set(
        (snap.rack || []).map((r) => String(r.letter).toUpperCase())
    );
    const fromRack = [];
    const onBoard = [];
    for (const p of solved.placements || []) {
        const key = `${p.gx},${p.gy}`;
        const needFromRack = !occupied.has(key)
            && rackLetters.has(String(p.letter).toUpperCase());
        if (needFromRack) fromRack.push(p);
        else onBoard.push(p);
    }
    return { fromRack, onBoard };
}

function reservedRackIdsForSteering(snap, ctx) {
    if (!ctx.desiredWinSide || sideMatchesDesiredWin(ctx)) return [];
    const rack = snap.rack || [];
    if (rack.length <= STEER_MIN_RACK_KEEP) {
        return rack.map((r) => r.id).filter(Boolean);
    }
    return rack.slice(-STEER_MIN_RACK_KEEP).map((r) => r.id).filter(Boolean);
}

function solveForPlayerStep(snap, ctx) {
    let rackLetters = (snap.rack || []).map((r) => r.letter);
    if (ctx.desiredWinSide && !sideMatchesDesiredWin(ctx)) {
        if (rackLetters.length <= STEER_MIN_RACK_KEEP) {
            return { changed: false, cleared: false, stuck: true, placements: [], rackLeft: rackLetters };
        }
        rackLetters = rackLetters.slice(0, -STEER_MIN_RACK_KEEP);
    }
    return solveAttemptFromBrowserState({
        boardCells: snap.boardCells,
        rackLetters
    });
}

module.exports = {
    resolvePlayToWin,
    resolveWinSteering,
    resolveDesiredWinSide,
    sideMatchesDesiredWin,
    STEER_MIN_RACK_KEEP,
    filterPlacementsForReservedRack,
    rackTileIdForPlacement,
    splitWinPlacements,
    reservedRackIdsForSteering,
    solveForPlayerStep
};
