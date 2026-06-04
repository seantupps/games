/**
 * Tile + viewport stability across peel/dump (mobile MP full audit).
 * Captures screen positions, world offsets, and pan/zoom/focal before vs after an action.
 */

const DEFAULT_SCREEN_TOLERANCE = 2;
const DEFAULT_WORLD_TOLERANCE = 1;
const DEFAULT_MAX_PAN_DELTA = 2;
const DEFAULT_MAX_FOCAL_DELTA = 2;
const DEFAULT_MAX_ZOOM_DELTA = 0.001;

/** @param {import('playwright').Page} page */
async function captureTileStabilitySnapshot(page) {
    return page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        const doc = frame?.contentDocument;
        const screen = {};
        const world = {};
        if (doc) {
            [...doc.querySelectorAll('.tile')].forEach((node) => {
                const id = node?.dataset?.tileId;
                if (!id) return;
                const r = node.getBoundingClientRect();
                screen[id] = {
                    cx: Math.round(r.left + (r.width / 2)),
                    cy: Math.round(r.top + (r.height / 2))
                };
            });
        }
        (g?.tiles || []).forEach((t) => {
            world[t.id] = {
                dx: Math.round((t.x ?? 0) - (g?.ORIGIN ?? 0)),
                dy: Math.round((t.y ?? 0) - (g?.ORIGIN ?? 0))
            };
        });
        return {
            viewport: {
                panX: Math.round(g?.canvasPanX || 0),
                panY: Math.round(g?.canvasPanY || 0),
                zoom: Number((g?.zoom ?? 1).toFixed(4)),
                targetZoom: Number((g?.targetZoom ?? 1).toFixed(4)),
                focalX: Number.isFinite(g?._viewportFocal?.x) ? Math.round(g._viewportFocal.x) : null,
                focalY: Number.isFinite(g?._viewportFocal?.y) ? Math.round(g._viewportFocal.y) : null
            },
            screen,
            world,
            tileIds: (g?.tiles || []).map((t) => t.id)
        };
    });
}

/** Wait for mobile layout/render to settle after peel/dump sync (poll-first, capped by syncMs). */
async function waitMobilePeelDumpSettle(page, frame, { syncMs = 200 } = {}) {
    await frame.evaluate(async () => {
        const g = window.game;
        g?.requestRender?.();
        await new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
    });
    const deadline = Date.now() + Math.max(0, syncMs);
    let lastSig = null;
    while (Date.now() < deadline) {
        const snap = await captureTileStabilitySnapshot(page);
        const sig = JSON.stringify({
            vp: snap.viewport,
            screen: snap.screen,
            world: snap.world
        });
        if (lastSig && sig === lastSig) {
            break;
        }
        lastSig = sig;
        await page.waitForTimeout(Math.min(40, deadline - Date.now()));
    }
    await frame.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
}

function assertExistingTilesStableAfterAction(before, after, label, options = {}) {
    const screenTol = options.screenTolerance ?? DEFAULT_SCREEN_TOLERANCE;
    const worldTol = options.worldTolerance ?? DEFAULT_WORLD_TOLERANCE;
    const maxPan = options.maxPanDelta ?? DEFAULT_MAX_PAN_DELTA;
    const maxFocal = options.maxFocalDelta ?? DEFAULT_MAX_FOCAL_DELTA;
    const maxZoom = options.maxZoomDelta ?? DEFAULT_MAX_ZOOM_DELTA;

    const afterIdSet = new Set(after?.tileIds || []);
    const movedWorld = [];
    const movedScreen = [];

    Object.keys(before?.world || {}).forEach((id) => {
        if (!afterIdSet.has(id)) return;
        const b = before.world[id];
        const a = after.world[id];
        if (!a) return;
        if (Math.abs((a.dx ?? 0) - (b.dx ?? 0)) > worldTol
            || Math.abs((a.dy ?? 0) - (b.dy ?? 0)) > worldTol) {
            movedWorld.push({ id, before: b, after: a });
        }
    });

    Object.keys(before?.screen || {}).forEach((id) => {
        if (!afterIdSet.has(id)) return;
        const b = before.screen[id];
        const a = after.screen[id];
        if (!a) return;
        if (Math.abs((a.cx ?? 0) - (b.cx ?? 0)) > screenTol
            || Math.abs((a.cy ?? 0) - (b.cy ?? 0)) > screenTol) {
            movedScreen.push({ id, before: b, after: a });
        }
    });

    if (movedWorld.length) {
        throw new Error(`${label}: existing tiles moved in world space (${JSON.stringify(movedWorld.slice(0, 12))})`);
    }
    if (movedScreen.length) {
        throw new Error(`${label}: existing tiles shifted on screen (${JSON.stringify(movedScreen.slice(0, 12))})`);
    }

    const bvp = before?.viewport || {};
    const avp = after?.viewport || {};
    const panDrift = Math.max(
        Math.abs((avp.panX || 0) - (bvp.panX || 0)),
        Math.abs((avp.panY || 0) - (bvp.panY || 0))
    );
    const focalDrift = (bvp.focalX == null || bvp.focalY == null
        || avp.focalX == null || avp.focalY == null)
        ? 0
        : Math.max(Math.abs(avp.focalX - bvp.focalX), Math.abs(avp.focalY - bvp.focalY));
    const zoomDrift = Math.max(
        Math.abs((avp.zoom || 1) - (bvp.zoom || 1)),
        Math.abs((avp.targetZoom || 1) - (bvp.targetZoom || 1))
    );

    if (panDrift > maxPan || focalDrift > maxFocal || zoomDrift > maxZoom) {
        throw new Error(`${label}: viewport shifted (${JSON.stringify({ before: bvp, after: avp, panDrift, focalDrift, zoomDrift })})`);
    }
}

/** @param {import('playwright').Page} page */
async function assertMobileTileStabilityAfterAction(page, frame, beforeSnap, label, options = {}) {
    await waitMobilePeelDumpSettle(page, frame, options);
    const afterSnap = await captureTileStabilitySnapshot(page);
    assertExistingTilesStableAfterAction(beforeSnap, afterSnap, label, options);
    return afterSnap;
}

module.exports = {
    captureTileStabilitySnapshot,
    waitMobilePeelDumpSettle,
    assertExistingTilesStableAfterAction,
    assertMobileTileStabilityAfterAction,
    DEFAULT_SCREEN_TOLERANCE,
    DEFAULT_WORLD_TOLERANCE
};
