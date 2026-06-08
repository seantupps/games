/**
 * Shared in-frame spawn tile DOM + world visibility checks (peel + dump).
 */

/**
 * @param {import('playwright').Frame} frame
 * @param {{ beforeIds?: string[], addedIds?: string[], expectedCount: number, label: string, mobile?: boolean, mode?: 'peel'|'dump' }} opts
 */
async function evalSpawnTilesVisibility(frame, opts) {
    const {
        beforeIds = [],
        addedIds = null,
        expectedCount,
        label,
        mobile = false,
        mode = expectedCount === 1 ? 'peel' : 'dump'
    } = opts;

    return frame.evaluate(({
        beforeIds: bIds,
        addedIds: aIds,
        expectedCount: exp,
        label: lbl,
        mobile: mob,
        mode: md
    }) => {
        const g = window.game;
        const added = aIds?.length
            ? g.tiles.filter((t) => aIds.includes(t.id))
            : g.tiles.filter((t) => !bIds.includes(t.id));

        if (added.length !== exp) {
            return {
                ok: false,
                label: lbl,
                phase: 'local-hand',
                reason: 'added-count',
                expected: exp,
                got: added.length
            };
        }

        const hostRect = document.getElementById('game-container')?.getBoundingClientRect();
        const clip = hostRect && hostRect.width > 0
            ? hostRect
            : {
                left: 0,
                top: 0,
                right: window.innerWidth,
                bottom: window.innerHeight,
                width: window.innerWidth,
                height: window.innerHeight
            };
        if (!clip || clip.width < 8 || clip.height < 8) {
            return { ok: false, label: lbl, phase: 'dom', reason: 'no-viewport-clip', clip: clip || null };
        }

        const minVisibleRatio = mob ? 0.25 : 0.28;
        const minDim = mob ? 10 : 8;
        const borderIns = (typeof BananaRules !== 'undefined'
            && typeof BananaRules.viewportSpawnBorderInsets === 'function')
            ? BananaRules.viewportSpawnBorderInsets({ game: g, mobile: mob })
            : (mob
                ? { top: 30, right: 30, bottom: 30, left: 30 }
                : { top: 32, right: 64, bottom: 32, left: 64 });
        const clipInset = {
            left: clip.left + borderIns.left,
            top: clip.top + borderIns.top,
            right: clip.right - borderIns.right,
            bottom: clip.bottom - borderIns.bottom,
            width: Math.max(0, clip.width - borderIns.left - borderIns.right),
            height: Math.max(0, clip.height - borderIns.top - borderIns.bottom)
        };

        const intersectArea = (a, b) => {
            const left = Math.max(a.left, b.left);
            const top = Math.max(a.top, b.top);
            const right = Math.min(a.right, b.right);
            const bottom = Math.min(a.bottom, b.bottom);
            if (right <= left || bottom <= top) return 0;
            return (right - left) * (bottom - top);
        };

        const size = BananaRules.TILE_SIZE;
        const gap = BananaRules.TILE_GAP;
        const uiFails = [];
        const addedIdSet = added.map((t) => t.id);

        for (const t of added) {
            if (typeof g._getVisibleWorldBounds === 'function') {
                const vb = g._getVisibleWorldBounds({ forSpawn: true });
                const insideWorld = t.x >= vb.left
                    && t.y >= vb.top
                    && t.x + size <= vb.right
                    && t.y + size <= vb.bottom;
                if (!insideWorld) {
                    uiFails.push({
                        id: t.id,
                        reason: 'outside-visible-world-bounds',
                        world: { x: t.x, y: t.y },
                        visBounds: vb
                    });
                    continue;
                }
            }

            if (md === 'peel' && typeof BananaRules.tilesSpawnBlocked === 'function') {
                const others = g.tiles.filter((ot) => ot.id !== t.id);
                for (const o of others) {
                    if (BananaRules.tilesSpawnBlocked(t.x, t.y, o.x, o.y, size, gap)) {
                        uiFails.push({
                            id: t.id,
                            reason: 'connected-to-existing',
                            added: { id: t.id, x: t.x, y: t.y },
                            existing: { id: o.id, x: o.x, y: o.y }
                        });
                    }
                }
            }

            const el = document.querySelector(`[data-tile-id="${t.id}"]`);
            if (!el) {
                uiFails.push({ id: t.id, reason: 'missing-dom' });
                continue;
            }
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
                uiFails.push({
                    id: t.id,
                    reason: 'css-hidden',
                    display: style.display,
                    visibility: style.visibility,
                    opacity: style.opacity
                });
                continue;
            }

            const r = el.getBoundingClientRect();
            const tileArea = Math.max(r.width * r.height, 1);
            if (r.width < minDim || r.height < minDim) {
                uiFails.push({
                    id: t.id,
                    reason: 'tiny-rect',
                    rect: { left: r.left, top: r.top, width: r.width, height: r.height }
                });
                continue;
            }

            const visibleArea = intersectArea(r, clipInset);
            const ratio = visibleArea / tileArea;
            if (ratio < minVisibleRatio) {
                uiFails.push({
                    id: t.id,
                    reason: 'clipped-off-canvas',
                    visibleRatio: Math.round(ratio * 100) / 100,
                    need: minVisibleRatio,
                    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                    clip: {
                        left: clipInset.left,
                        top: clipInset.top,
                        right: clipInset.right,
                        bottom: clipInset.bottom
                    }
                });
                continue;
            }

            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if (cx < clipInset.left || cy < clipInset.top || cx > clipInset.right || cy > clipInset.bottom) {
                uiFails.push({
                    id: t.id,
                    reason: 'center-outside-canvas',
                    center: { x: cx, y: cy },
                    clip: clipInset
                });
                continue;
            }

            const hit = document.elementFromPoint(cx, cy);
            const onTile = hit === el || el.contains(hit);
            if (!onTile) {
                uiFails.push({
                    id: t.id,
                    reason: 'hit-test-miss',
                    hitTag: hit?.tagName,
                    hitClass: hit?.className,
                    center: { x: cx, y: cy }
                });
            }
        }

        if (md === 'dump' && typeof BananaRules.tilesSpawnBlocked === 'function') {
            const others = g.tiles.filter((ot) => !addedIdSet.includes(ot.id));
            for (const a of added) {
                for (const o of others) {
                    if (BananaRules.tilesSpawnBlocked(a.x, a.y, o.x, o.y, size, gap)) {
                        uiFails.push({
                            id: a.id,
                            reason: 'connected-to-existing',
                            added: { id: a.id, x: a.x, y: a.y },
                            existing: { id: o.id, x: o.x, y: o.y }
                        });
                    }
                }
            }
            if (added.length === 3
                && typeof BananaRules.isDumpBatchPlacementValid === 'function'
                && !BananaRules.isDumpBatchPlacementValid(added, gap)) {
                uiFails.push({
                    id: added[0]?.id,
                    reason: 'dump-batch-invalid-placement',
                    positions: added.map((t) => ({ id: t.id, x: t.x, y: t.y }))
                });
            }
        }

        if (uiFails.length) {
            return {
                ok: false,
                label: lbl,
                phase: md === 'dump' ? 'dom-visibility' : 'dom',
                uiFails,
                added: added.map((t) => ({ id: t.id, letter: t.letter, x: t.x, y: t.y }))
            };
        }

        return {
            ok: true,
            label: lbl,
            added: added.map((t) => ({
                id: t.id,
                letter: t.letter,
                x: t.x,
                y: t.y
            }))
        };
    }, {
        beforeIds,
        addedIds,
        expectedCount,
        label,
        mobile,
        mode
    });
}

/** Legacy MP spawn check — new tiles visible in world bounds, no overlap. */
async function assertSpawnedAtViewportBottom(frame, beforeIds, label = 'spawn', minAdded = 1) {
    const result = await frame.evaluate(({ idList, minExpected }) => {
        const g = window.game;
        const size = BananaRules.TILE_SIZE;
        const pad = BananaRules.spawnViewportPad();
        const idSet = new Set(idList);
        const added = g.tiles.filter((t) => !idSet.has(t.id));
        const old = g.tiles.filter((t) => idSet.has(t.id));
        const bounds = g._getVisibleWorldBounds();
        const keys = new Set();
        if (added.length < minExpected) {
            return { ok: false, reason: 'missing-added', added: added.length, minExpected };
        }

        for (const t of added) {
            if (t.x < bounds.left + pad || t.y < bounds.top + pad
                || t.x + size > bounds.right - pad || t.y + size > bounds.bottom - pad) {
                return { ok: false, reason: 'not-visible', tile: t, bounds };
            }
            const key = BananaRules.tileCellKey(t.x, t.y, size);
            if (keys.has(key)) {
                return { ok: false, reason: 'duplicate-cell', key, tile: t };
            }
            keys.add(key);
            for (const o of old) {
                if (BananaRules.tilesOverlap(t.x, t.y, o.x, o.y, size)) {
                    return { ok: false, reason: 'overlap', tile: t, other: o };
                }
            }
        }
        for (let i = 0; i < added.length; i++) {
            for (let j = i + 1; j < added.length; j++) {
                if (BananaRules.tilesOverlap(added[i].x, added[i].y, added[j].x, added[j].y, size)) {
                    return { ok: false, reason: 'added-overlap', a: added[i], b: added[j] };
                }
            }
        }
        return { ok: true, added: added.map((t) => ({ id: t.id, x: t.x, y: t.y })), bounds };
    }, { idList: beforeIds, minExpected: minAdded });
    if (!result.ok) {
        throw new Error(`${label} spawn invalid (${JSON.stringify(result)})`);
    }
    return result;
}

/** Every model tile has a visible DOM node on the page. */
async function assertAllTilesVisible(page, label, { minTiles = 1 } = {}) {
    const result = await page.evaluate(({ minExpected }) => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        const doc = frame?.contentDocument;
        if (!g || !doc) return { ok: false, reason: 'missing-game-frame' };
        const modelTiles = [...(g.tiles || [])];
        const missingDomIds = [];
        const hidden = [];
        if (modelTiles.length < minExpected) {
            return {
                ok: false,
                reason: 'too-few-model-tiles',
                modelCount: modelTiles.length,
                minExpected
            };
        }
        for (const t of modelTiles) {
            const node = doc.querySelector(`.tile[data-tile-id="${t.id}"]`);
            if (!node) {
                missingDomIds.push(t.id);
                continue;
            }
            const r = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            const visible = style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0.01
                && r.width > 0
                && r.height > 0;
            if (!visible) {
                hidden.push({
                    id: t.id,
                    rect: {
                        left: Math.round(r.left),
                        top: Math.round(r.top),
                        right: Math.round(r.right),
                        bottom: Math.round(r.bottom),
                        width: Math.round(r.width),
                        height: Math.round(r.height)
                    },
                    style: {
                        display: style.display,
                        visibility: style.visibility,
                        opacity: style.opacity
                    }
                });
            }
        }
        return {
            ok: missingDomIds.length === 0 && hidden.length === 0,
            modelCount: modelTiles.length,
            domCount: doc.querySelectorAll('.tile').length,
            missingDomIds,
            hidden
        };
    }, { minExpected: minTiles });
    if (!result.ok) {
        throw new Error(`${label} guest tiles not all visible (${JSON.stringify(result)})`);
    }
    return result;
}

module.exports = {
    evalSpawnTilesVisibility,
    assertSpawnedAtViewportBottom,
    assertAllTilesVisible
};
