/**
 * Bind solver grid placements to physical tile ids (prevents letter-only apply flakiness).
 */

/** @param {{ rack?: Array<string|{id:string,letter:string}>, boardCells?: Array<{gx:number,gy:number,letter:string,id?:string}> }} snap */
function rackLettersFromSnap(snap) {
    return (snap?.rack || []).map((r) => String(typeof r === 'string' ? r : r.letter).toUpperCase());
}

/**
 * @param {{ rack?: Array<{id:string,letter:string}>, boardCells?: Array<{gx:number,gy:number,letter:string,id?:string}> }} snap
 * @param {Array<{gx:number,gy:number,letter:string,id?:string}>} placements
 */
function attachSnapshotTileIds(snap, placements) {
    const byCell = new Map(
        (snap.boardCells || []).filter((c) => c.id).map((c) => [`${c.gx},${c.gy}`, c.id])
    );
    const rackByLetter = new Map();
    for (const r of snap.rack || []) {
        const entry = typeof r === 'string' ? { id: null, letter: r } : r;
        const L = String(entry.letter).toUpperCase();
        if (!entry.id) continue;
        if (!rackByLetter.has(L)) rackByLetter.set(L, []);
        rackByLetter.get(L).push(entry.id);
    }
    const usedRackIds = new Set();
    return (placements || []).map((p) => {
        const key = `${p.gx},${p.gy}`;
        let id = byCell.get(key) || p.id || null;
        if (!id) {
            const want = String(p.letter).toUpperCase();
            const pool = rackByLetter.get(want) || [];
            while (pool.length && usedRackIds.has(pool[0])) pool.shift();
            if (pool.length) {
                id = pool.shift();
                usedRackIds.add(id);
            }
        }
        return { ...p, id };
    });
}

/**
 * Browser-side apply body (solo + MP share id-first matching).
 * @param {object} opts
 * @param {Array<{gx:number,gy:number,letter:string,id?:string}>} opts.placements
 * @param {number} opts.origin
 * @param {number} opts.gap
 * @param {string[]} [opts.reservedIds]
 * @param {(tile: object) => string} [opts.tileLetter]
 */
function applyPinnedPlacementsInFrame(opts) {
    const {
        placements,
        origin,
        gap,
        reservedIds = [],
        tileLetter = (t) => t.letter
    } = opts;
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
            if (String(tileLetter(pinned)).toUpperCase() === want) best = pinned;
        }

        if (!best) {
            let bestD = Infinity;
            for (const t of g.tiles) {
                if (used.has(t.id) || reserved.has(t.id)) continue;
                if (String(tileLetter(t)).toUpperCase() !== want) continue;
                if (Math.abs(t.x - tx) <= halfGap && Math.abs(t.y - ty) <= halfGap) {
                    best = t;
                    bestD = 0;
                    break;
                }
                const d = (t.x - tx) ** 2 + (t.y - ty) ** 2;
                if (d < bestD) {
                    bestD = d;
                    best = t;
                }
            }
        }

        if (!best) return { ok: false, reason: 'missing-tile', letter: p.letter, id: p.id || null };

        used.add(best.id);
        best.x = tx;
        best.y = ty;
        best.faceUp = true;
        const canon = tileLetter(best);
        if (canon) best.letter = canon;
    }

    const rackOpts = g._rackLayoutOptions();
    const rb = BananaGrid.getRackBounds(
        { x: origin, y: origin },
        rackOpts.cols,
        rackOpts.gap,
        rackOpts.tileSize,
        rackOpts.handBelowCenter
    );
    const unassigned = g.tiles.filter((t) => !used.has(t.id));
    for (let i = 0; i < unassigned.length; i++) {
        const row = Math.floor(i / rackOpts.cols);
        const col = i % rackOpts.cols;
        unassigned[i].x = rb.x + col * rackOpts.gap;
        unassigned[i].y = rb.y + row * rackOpts.gap;
        unassigned[i].faceUp = true;
    }

    if (typeof g.requestRender === 'function') g.requestRender();
    return { ok: true, placed: used.size, usedIds: [...used] };
}

module.exports = {
    rackLettersFromSnap,
    attachSnapshotTileIds,
    applyPinnedPlacementsInFrame
};
