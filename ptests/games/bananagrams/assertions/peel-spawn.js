/**
 * Peel spawn — world bounds + on-screen visibility inside #game-container.
 */

/** @param {import('playwright').Frame} frame */
async function evalPeelTileVisibility(frame, beforeIds, label, mobile = false) {
    return frame.evaluate(({ ids, lbl, mob }) => {
        const g = window.game;
        const added = g.tiles.filter((t) => !ids.includes(t.id));
        if (added.length !== 1) {
            return {
                ok: false,
                label: lbl,
                phase: 'local-hand',
                reason: 'added-count',
                expected: 1,
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
            bottom: clip.bottom - borderIns.bottom
        };

        const intersectArea = (a, b) => {
            const left = Math.max(a.left, b.left);
            const top = Math.max(a.top, b.top);
            const right = Math.min(a.right, b.right);
            const bottom = Math.min(a.bottom, b.bottom);
            if (right <= left || bottom <= top) return 0;
            return (right - left) * (bottom - top);
        };

        const t = added[0];
        const size = BananaRules.TILE_SIZE;
        const gap = BananaRules.TILE_GAP;
        const vb = g._getVisibleWorldBounds({ forSpawn: true });
        const insideWorld = t.x >= vb.left
            && t.y >= vb.top
            && t.x + size <= vb.right
            && t.y + size <= vb.bottom;
        if (!insideWorld) {
            return {
                ok: false,
                label: lbl,
                phase: 'world',
                reason: 'outside-visible-world-bounds',
                world: { x: t.x, y: t.y },
                visBounds: vb
            };
        }

        if (typeof BananaRules.tilesSpawnBlocked === 'function') {
            const others = g.tiles.filter((ot) => ot.id !== t.id);
            for (const o of others) {
                if (BananaRules.tilesSpawnBlocked(t.x, t.y, o.x, o.y, size, gap)) {
                    return {
                        ok: false,
                        label: lbl,
                        phase: 'world',
                        reason: 'connected-to-existing',
                        added: { id: t.id, x: t.x, y: t.y },
                        existing: { id: o.id, x: o.x, y: o.y }
                    };
                }
            }
        }

        const el = document.querySelector(`[data-tile-id="${t.id}"]`);
        if (!el) {
            return { ok: false, label: lbl, phase: 'dom', reason: 'missing-dom', id: t.id };
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
            return {
                ok: false,
                label: lbl,
                phase: 'dom',
                reason: 'css-hidden',
                id: t.id
            };
        }

        const r = el.getBoundingClientRect();
        const tileArea = Math.max(r.width * r.height, 1);
        if (r.width < minDim || r.height < minDim) {
            return {
                ok: false,
                label: lbl,
                phase: 'dom',
                reason: 'tiny-rect',
                rect: { left: r.left, top: r.top, width: r.width, height: r.height }
            };
        }

        const visibleArea = intersectArea(r, clipInset);
        const ratio = visibleArea / tileArea;
        if (ratio < minVisibleRatio) {
            return {
                ok: false,
                label: lbl,
                phase: 'dom',
                reason: 'clipped-off-canvas',
                visibleRatio: Math.round(ratio * 100) / 100,
                need: minVisibleRatio,
                rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                clip: clipInset
            };
        }

        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < clipInset.left || cy < clipInset.top || cx > clipInset.right || cy > clipInset.bottom) {
            return {
                ok: false,
                label: lbl,
                phase: 'dom',
                reason: 'center-outside-canvas',
                center: { x: cx, y: cy },
                clip: clipInset
            };
        }

        const hit = document.elementFromPoint(cx, cy);
        const onTile = hit === el || el.contains(hit);
        if (!onTile) {
            return {
                ok: false,
                label: lbl,
                phase: 'dom',
                reason: 'hit-test-miss',
                hitTag: hit?.tagName,
                center: { x: cx, y: cy }
            };
        }

        return {
            ok: true,
            label: lbl,
            added: { id: t.id, letter: t.letter, x: t.x, y: t.y }
        };
    }, { ids: beforeIds, lbl: label, mob: mobile });
}

/**
 * Peel tile must be in spawn viewport (world) and visible on screen.
 * @param {import('playwright').Frame} frame
 */
async function assertPeelSpawnInViewport(frame, beforeIds, label, options = {}) {
    const vis = await evalPeelTileVisibility(frame, beforeIds, label, !!options.mobile);
    if (!vis.ok) {
        throw new Error(`${label} — peel not in player view (${JSON.stringify(vis)})`);
    }
    return vis;
}

/**
 * Host and guest peel draws must both land in each player's visible viewport.
 */
async function assertPeelViewportBothPlayers(hostFrame, guestFrame, hostBeforeIds, guestBeforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    await assertPeelSpawnInViewport(hostFrame, hostBeforeIds, `${label} (host)`, { mobile });
    await assertPeelSpawnInViewport(guestFrame, guestBeforeIds, `${label} (guest)`, { mobile });
}

module.exports = {
    evalPeelTileVisibility,
    assertPeelSpawnInViewport,
    assertPeelViewportBothPlayers
};
