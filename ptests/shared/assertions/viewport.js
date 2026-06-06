/**
 * Pan / zoom audits — registry caps: supportsZoom, mobileLayoutPolicy, viewportPanEnabled.
 * Shallow checks run in capability-audit; deep checks when game is started (optional).
 */
const GameRegistry = require('../../../shared/games/registry');
const { runScenario } = require('../infra/scenario-runner');
const { STEP_MS } = require('../infra/timeouts');

function capsFor(gameId, ctx = {}) {
    const mode = ctx.gameMode || GameRegistry.defaultModeFor(gameId);
    return { mode, caps: GameRegistry.getCapabilities(gameId, mode) };
}

/** Engine modules present for zoom / pan-zoom boards. */
async function assertViewportEngineReady(page, caps) {
    await page.evaluate((c) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        if (!win) throw new Error('game iframe missing');
        if (c.supportsZoom !== false && !win.GameZoom) {
            throw new Error('supportsZoom but GameZoom module missing');
        }
        const panZoom = c.mobileLayoutPolicy === 'pan-zoom-board' || c.viewportPanEnabled;
        if (panZoom && !win.GameViewport) {
            throw new Error('pan-zoom-board but GameViewport module missing');
        }
    }, caps);
}

/**
 * Pointer background pan on .board-pan-layer (desktop or touch).
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 */
async function assertBackgroundPanMovesBoard(page, opts = {}) {
    const minDist = opts.minDist ?? 20;
    const result = await page.evaluate(async (minDistIn) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const surface = win?.document.querySelector('.board-pan-layer')
            || win?.document.getElementById('board-canvas');
        if (!g || !surface) return { ok: false, reason: 'no-game-or-surface' };
        const before = { x: g.canvasPanX || 0, y: g.canvasPanY || 0 };
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 9,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const x0 = r.left + 48;
        const y0 = r.top + 48;
        const x1 = r.left + 200;
        const y1 = r.top + 160;
        surface.dispatchEvent(mk('pointerdown', x0, y0));
        surface.dispatchEvent(mk('pointermove', x1, y1));
        surface.dispatchEvent(mk('pointerup', x1, y1));
        await new Promise((r) => requestAnimationFrame(r));
        const after = { x: g.canvasPanX || 0, y: g.canvasPanY || 0 };
        const dist = Math.hypot(after.x - before.x, after.y - before.y);
        return { ok: dist >= minDistIn, dist, panInit: !!g._viewportPanInit };
    }, minDist);
    if (!result.ok) {
        throw new Error(`Background pan failed: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Wheel zoom should keep viewport center stable (requires started game + GameViewport).
 * @param {import('playwright').Page} page
 */
async function assertWheelZoomViewportCentered(page) {
    const result = await page.frameLocator('#game-frame').locator('body').evaluate(async () => {
        const g = window.game;
        const vp = window.GameViewport;
        if (!g?.handleZoom || !vp?.clientToWorld) {
            return { ok: false, skip: true, reason: 'zoom-not-ready' };
        }
        const host = document.getElementById('game-container');
        const r = host.getBoundingClientRect();
        const vcx = r.left + r.width / 2;
        const vcy = r.top + r.height / 2;
        const focal = vp.clientToWorld(g, vcx, vcy);
        g._pointerDragging = false;
        g._viewportPanning = false;
        const startZoom = g.targetZoom;
        for (let i = 0; i < 12; i++) {
            if (g.targetZoom < startZoom * 1.4) g.handleZoom(-40);
            while (Math.abs(g.zoom - g.targetZoom) > 0.002) {
                vp.tick(g);
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }
        const after = vp.worldToClient(g, focal.x, focal.y);
        const drift = Math.hypot(after.x - vcx, after.y - vcy);
        return { ok: drift <= 10, drift, zoom: g.zoom };
    });
    if (result.skip) return result;
    if (!result.ok) {
        throw new Error(`Viewport-center zoom drifted: ${JSON.stringify(result)}`);
    }
    return result;
}

/**
 * Shallow + optional deep viewport checks from registry caps.
 * @param {import('playwright').Page} page
 * @param {string} gameId
 * @param {object} [ctx]
 */
async function runViewportCapabilityChecks(page, gameId, ctx = {}) {
    const { caps } = capsFor(gameId, ctx);
    if (caps.supportsZoom === false && caps.mobileLayoutPolicy !== 'pan-zoom-board') return;

    await runScenario('Viewport engine ready', async () => {
        await assertViewportEngineReady(page, caps);
    });

    if (!ctx.deep) return;

    if (ctx.isMobile && caps.supportsZoom !== false) {
        await runScenario('Mobile pinch zoom range', async () => {
            const { assertPinchZoomRange } = require('../../platform/mobile/lib/mobile_assertions');
            await assertPinchZoomRange(page, ctx.mobileMs ?? STEP_MS);
        });
    }

    const panZoom = caps.mobileLayoutPolicy === 'pan-zoom-board'
        || caps.viewportPanEnabled === true;

    if (panZoom) {
        await runScenario('Background pan', async () => {
            await assertBackgroundPanMovesBoard(page);
        });
    }

    if (caps.supportsZoom !== false) {
        await runScenario('Wheel zoom viewport center', async () => {
            const r = await assertWheelZoomViewportCentered(page);
            if (r?.skip) return;
        });
    }
}

module.exports = {
    assertViewportEngineReady,
    assertBackgroundPanMovesBoard,
    assertWheelZoomViewportCentered,
    runViewportCapabilityChecks
};
