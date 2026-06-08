/**
 * MP AI solver apply — browser snapshot + grid placement (shared by runners and assertions).
 */
const { solveAttemptFromBrowserState } = require('../ai');
const { attachSnapshotTileIds } = require('./ai-snapshot-apply');

/** In-browser snapshot (solo-style largest-component rack/board). */
const SNAPSHOT_BROWSER_STATE = `() => {
    const g = window.game;
    const won = !!(
        g._winnerUid || g._victoryRegistered || g.isOver
        || g._inReviewExperience?.()
        || (typeof g._isBoardInReview === 'function' && g._isBoardInReview())
    );
    const origin = g.ORIGIN;
    const gap = BananaRules.TILE_GAP;
    const opts = g._rackLayoutOptions();
    const rackBounds = BananaGrid.getRackBounds(
        { x: origin, y: origin }, opts.cols, opts.gap, opts.tileSize, opts.handBelowCenter
    );
    const originPt = { x: origin, y: origin };
    const tileLetter = (t) => {
        if (typeof g._mpLetter === 'function' && g._mpPoolUsesTileIds?.()) {
            const canon = g._mpLetter(t.id);
            if (canon) return canon;
        }
        return t.letter;
    };
    if (typeof g._mpHydrateTiles === 'function' && g._mpPoolUsesTileIds?.()) {
        g.tiles = g._mpHydrateTiles(g.tiles);
    }
    if (BananaGrid.isStartingRack(g.tiles, originPt, opts)) {
        return {
            rack: g.tiles.map((t) => ({ id: t.id, letter: tileLetter(t) })),
            boardCells: [],
            poolLen: g._tilePool.length,
            tileCount: g.tiles.length,
            gameStarted: !!g.gameStarted,
            origin, gap, winner: won, allPlaced: false, gridOk: false
        };
    }
    const toCell = (t) => ({
        gx: Math.round((t.x - origin) / gap),
        gy: Math.round((t.y - origin) / gap)
    });
    const visited = new Set();
    let largest = [];
    for (const seed of g.tiles) {
        if (visited.has(seed.id)) continue;
        const component = [];
        const queue = [seed];
        visited.add(seed.id);
        while (queue.length) {
            const cur = queue.pop();
            component.push(cur);
            const { gx, gy } = toCell(cur);
            for (const other of g.tiles) {
                if (visited.has(other.id)) continue;
                const { gx: ox, gy: oy } = toCell(other);
                if (Math.abs(ox - gx) + Math.abs(oy - gy) === 1) {
                    visited.add(other.id);
                    queue.push(other);
                }
            }
        }
        if (component.length > largest.length) largest = component;
    }
    const boardIds = new Set(largest.map((t) => t.id));
    const rack = [];
    const boardCells = [];
    for (const t of g.tiles) {
        if (boardIds.has(t.id)) {
            const { gx, gy } = toCell(t);
            boardCells.push({ gx, gy, letter: tileLetter(t), id: t.id });
        } else {
            rack.push({ id: t.id, letter: tileLetter(t) });
        }
    }
    const handForGrid = typeof g._snapHandForValidation === 'function'
        ? g._snapHandForValidation(g.tiles)
        : g.tiles;
    const allPlaced = typeof g._allTilesPlacedOn === 'function'
        ? g._allTilesPlacedOn(handForGrid)
        : false;
    const gridCheck = BananaGrid.validateGrid(handForGrid, g._checker);
    return {
        rack,
        boardCells,
        poolLen: g._tilePool.length,
        tileCount: g.tiles.length,
        gameStarted: !!g.gameStarted,
        origin,
        gap,
        winner: won,
        allPlaced,
        gridOk: gridCheck.ok
    };
}`;

async function injectSnapshot(frames) {
    await Promise.all(frames.map((f) => f.evaluate((fnStr) => {
        window.snapshotMpAiState = new Function('return ' + fnStr)();
    }, SNAPSHOT_BROWSER_STATE)));
}

async function applyPlacements(frame, snap, solved, opts = {}) {
    const reservedTileIds = opts.reservedTileIds || [];
    const raw = opts.onlyPlacements ?? solved.placements;
    const placements = attachSnapshotTileIds(snap, raw);
    if (!placements.length) return { ok: true, placed: 0 };
    return frame.evaluate(({ placements, origin, gap, reservedIds }) => {
        const g = window.game;
        const reserved = new Set(reservedIds || []);
        const used = new Set();
        const halfGap = gap / 2;
        const byId = new Map((g.tiles || []).map((t) => [t.id, t]));
        for (const p of placements) {
            const tx = origin + p.gx * gap;
            const ty = origin + p.gy * gap;
            const want = String(p.letter || '').toUpperCase();
            let best = null;
            if (p.id && byId.has(p.id) && !used.has(p.id) && !reserved.has(p.id)) {
                const pinned = byId.get(p.id);
                const pinLetter = typeof g._mpLetter === 'function'
                    ? (g._mpLetter(pinned.id) || pinned.letter)
                    : pinned.letter;
                if (pinLetter.toUpperCase() === want) best = pinned;
            }
            if (!best) {
                let bestD = Infinity;
                for (const t of g.tiles) {
                    if (used.has(t.id) || reserved.has(t.id)) continue;
                    const tileLetter = typeof g._mpLetter === 'function'
                        ? (g._mpLetter(t.id) || t.letter)
                        : t.letter;
                    if (tileLetter.toUpperCase() !== want) continue;
                    if (Math.abs(t.x - tx) <= halfGap && Math.abs(t.y - ty) <= halfGap) {
                        best = t;
                        bestD = 0;
                        break;
                    }
                    const d = (t.x - tx) ** 2 + (t.y - ty) ** 2;
                    if (d < bestD) { bestD = d; best = t; }
                }
            }
            if (!best) return { ok: false, reason: 'missing-tile', letter: p.letter };
            used.add(best.id);
            best.x = tx;
            best.y = ty;
            best.faceUp = true;
            if (typeof g._mpLetter === 'function') {
                const canon = g._mpLetter(best.id);
                if (canon) best.letter = canon;
            }
        }
        const rackOpts = g._rackLayoutOptions();
        const rb = BananaGrid.getRackBounds(
            { x: origin, y: origin },
            rackOpts.cols, rackOpts.gap, rackOpts.tileSize, rackOpts.handBelowCenter
        );
        const unassigned = g.tiles.filter((t) => !used.has(t.id));
        for (let i = 0; i < unassigned.length; i++) {
            const row = Math.floor(i / rackOpts.cols);
            const col = i % rackOpts.cols;
            unassigned[i].x = rb.x + col * rackOpts.gap;
            unassigned[i].y = rb.y + row * rackOpts.gap;
            unassigned[i].faceUp = true;
        }
        if (g._persistMpLayout) g._persistMpLayout();
        if (typeof g._mpHydrateTiles === 'function') {
            g.tiles = g._mpHydrateTiles(g.tiles);
        }
        if (typeof g.requestRender === 'function') g.requestRender();
        return { ok: true, placed: used.size };
    }, {
        placements,
        origin: snap.origin,
        gap: snap.gap,
        reservedIds: reservedTileIds
    });
}

async function snapshotMpAiState(frame) {
    return frame.evaluate(() => window.snapshotMpAiState());
}

/** Solver-driven placement until peel-ready grid. */
async function solveAndApplyAiMove(frame) {
    await injectSnapshot([frame]);
    let snap = await frame.evaluate(() => window.snapshotMpAiState());
    for (let attempt = 0; attempt < 8; attempt++) {
        const peelReady = await frame.evaluate(() => {
            const g = window.game;
            if (!g?._checker || typeof BananaGrid === 'undefined') return false;
            const hand = typeof g._snapHandForValidation === 'function'
                ? g._snapHandForValidation(g.tiles)
                : g.tiles;
            const grid = BananaGrid.validateGrid(hand, g._checker);
            if (!grid.ok || !BananaGrid.isConnected(hand)) return false;
            const hasThree = (grid.words || []).some((w) => String(w || '').length >= 3);
            if (!hasThree) return false;
            return typeof g._allTilesPlacedOn === 'function' ? g._allTilesPlacedOn(hand) : true;
        });
        if (peelReady) return { ok: true };
        const solved = solveAttemptFromBrowserState({
            boardCells: snap.boardCells,
            rackLetters: (snap.rack || []).map((r) => r.letter)
        });
        if (!solved.changed || !solved.placements?.length) {
            return {
                ok: false,
                reason: 'solver-stuck',
                rack: snap.rack?.length ?? 0,
                board: snap.boardCells?.length ?? 0
            };
        }
        const applied = await applyPlacements(frame, snap, solved);
        if (!applied.ok) return { ok: false, reason: 'apply-failed', applied };
        snap = await frame.evaluate(() => window.snapshotMpAiState());
        if ((snap.rack || []).length > 0 && (snap.rack || []).length <= 2) {
            const brute = await frame.evaluate(() => {
                const g = window.game;
                if (!g?._checker || typeof BananaGrid === 'undefined') return false;
                const gap = window.BananaRules.TILE_GAP;
                const origin = g.ORIGIN;
                const toCell = (t) => ({
                    gx: Math.round((t.x - origin) / gap),
                    gy: Math.round((t.y - origin) / gap)
                });
                const occupied = new Set((g.tiles || []).map((t) => {
                    const { gx, gy } = toCell(t);
                    return `${gx},${gy}`;
                }));
                const rackTiles = (g.tiles || []).filter((t) => {
                    const { gx, gy } = toCell(t);
                    return Math.abs(gx) > 8 || Math.abs(gy) > 8;
                });
                if (!rackTiles.length) return true;
                const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
                for (const tile of rackTiles) {
                    let placed = false;
                    for (const [dx, dy] of dirs) {
                        for (const key of occupied) {
                            const [gx, gy] = key.split(',').map(Number);
                            const nx = gx + dx;
                            const ny = gy + dy;
                            const nkey = `${nx},${ny}`;
                            if (occupied.has(nkey)) continue;
                            tile.x = origin + nx * gap;
                            tile.y = origin + ny * gap;
                            const hand = typeof g._snapHandForValidation === 'function'
                                ? g._snapHandForValidation(g.tiles)
                                : g.tiles;
                            const grid = BananaGrid.validateGrid(hand, g._checker);
                            if (grid.ok && BananaGrid.isConnected(hand)) {
                                occupied.add(nkey);
                                placed = true;
                                g._persistMpLayout?.();
                                break;
                            }
                            occupied.delete(nkey);
                        }
                        if (placed) break;
                    }
                    if (!placed) return false;
                }
                g.requestRender?.();
                return true;
            });
            if (!brute) {
                return { ok: false, reason: 'brute-stuck', rack: snap.rack?.length ?? 0 };
            }
            snap = await frame.evaluate(() => window.snapshotMpAiState());
        }
    }
    return { ok: false, reason: 'max-attempts' };
}

module.exports = {
    SNAPSHOT_BROWSER_STATE,
    injectSnapshot,
    applyPlacements,
    snapshotMpAiState,
    solveAndApplyAiMove
};
