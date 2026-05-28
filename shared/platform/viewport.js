/**
 * Pan + zoom board viewport (mobileLayoutPolicy: pan-zoom-board).
 * Wheel zoom always anchors to viewport center. Drag uses cursor world coords (refreshed on each pan/zoom tick).
 */
(function (global) {
    const Layout = global.MobileLayoutPolicy;

    function usesPanZoomBoard(game) {
        return Layout ? Layout.usesPanZoomBoard(game) : false;
    }

    /** Untransformed viewport rect — never use #board-canvas getBoundingClientRect (includes pan/zoom). */
    function viewportClientRect() {
        const host = document.getElementById('game-container');
        if (host) return host.getBoundingClientRect();
        const canvas = document.getElementById('board-canvas');
        return canvas
            ? { left: canvas.getBoundingClientRect().left, top: canvas.getBoundingClientRect().top }
            : { left: 0, top: 0, width: 0, height: 0 };
    }

    function viewportOrigin(game) {
        const { width: vw, height: vh } = game.getVisibleViewportSize();
        const canvas = document.getElementById('board-canvas');
        const cw = canvas?.clientWidth;
        const ch = canvas?.clientHeight;
        const w = cw > 0 ? cw : vw;
        const h = ch > 0 ? ch : vh;
        return { ox: w / 2, oy: h / 2, vw: w, vh: h };
    }

    function panForWorldAtCenter(game, worldX, worldY, zoom) {
        const { ox, oy } = viewportOrigin(game);
        const z = zoom ?? game.zoom ?? 1;
        return {
            panX: (ox - worldX) * z,
            panY: (oy - worldY) * z
        };
    }

    /** Pan so world (worldX, worldY) appears at client (clientX, clientY). */
    function panForWorldAtClient(game, worldX, worldY, clientX, clientY, zoom) {
        const canvas = document.getElementById('board-canvas');
        if (!canvas) return panForWorldAtCenter(game, worldX, worldY, zoom);
        const rect = viewportClientRect();
        const { ox, oy } = viewportOrigin(game);
        const z = zoom ?? game.zoom ?? 1;
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        return {
            panX: localX - ox - (worldX - ox) * z,
            panY: localY - oy - (worldY - oy) * z
        };
    }

    function panForCurrentFocal(game, zoom) {
        const f = game._viewportFocal;
        if (!f) return null;
        return panForWorldAtCenter(game, f.x, f.y, zoom);
    }

    function syncFocalFromPan(game) {
        const { ox, oy } = viewportOrigin(game);
        const z = game.zoom || 1;
        game._viewportFocal = {
            x: ox - (game.canvasPanX || 0) / z,
            y: oy - (game.canvasPanY || 0) / z
        };
    }

    function getContentCenter(game) {
        if (typeof game.getViewportContentCenter === 'function') {
            return game.getViewportContentCenter();
        }
        return { x: 0, y: 0 };
    }

    /** Screen (client) coords → world coords on the pan layer. */
    function clientToWorld(game, clientX, clientY) {
        const canvas = document.getElementById('board-canvas');
        if (!canvas) return { x: 0, y: 0 };
        const rect = viewportClientRect();
        const { ox, oy } = viewportOrigin(game);
        const z = game.zoom ?? 1;
        const panX = game.canvasPanX || 0;
        const panY = game.canvasPanY || 0;
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        return {
            x: ox + (localX - ox - panX) / z,
            y: oy + (localY - oy - panY) / z
        };
    }

    /** World coords on the pan layer → screen (client) coords. */
    function worldToClient(game, worldX, worldY) {
        const canvas = document.getElementById('board-canvas');
        if (!canvas) return { x: 0, y: 0 };
        const rect = viewportClientRect();
        const { ox, oy } = viewportOrigin(game);
        const z = game.zoom ?? 1;
        const panX = game.canvasPanX || 0;
        const panY = game.canvasPanY || 0;
        return {
            x: rect.left + ox + panX + (worldX - ox) * z,
            y: rect.top + oy + panY + (worldY - oy) * z
        };
    }

    function applyPanZoom(game) {
        const target = document.getElementById('game-container') || document.body;
        const canvas = document.getElementById('board-canvas');
        if (!canvas) return false;

        const { ox, oy } = viewportOrigin(game);
        const panX = game.canvasPanX || 0;
        const panY = game.canvasPanY || 0;
        const z = game.zoom ?? 1;

        document.body.style.transform = '';
        document.body.style.transformOrigin = '';
        target.classList.add('pan-zoom-board');
        target.style.position = 'relative';
        target.style.left = '';
        target.style.top = '';
        target.style.width = '100%';
        target.style.height = '100%';
        target.style.margin = '0';
        target.style.transform = '';
        target.style.transformOrigin = '';
        target.style.overflow = 'hidden';

        canvas.style.willChange = 'transform';
        canvas.style.position = 'absolute';
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.transformOrigin = `${ox}px ${oy}px`;
        canvas.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${z})`;

        if (typeof GameDevOverlay !== 'undefined') GameDevOverlay.sync(game);
        if (game._dragCursorRefresh) game._dragCursorRefresh();
        if (game.onZoomChange) game.onZoomChange();
        return true;
    }

    function centerWorldPoint(game, worldX, worldY) {
        game._viewportFocal = { x: worldX, y: worldY };
        const pan = panForWorldAtCenter(game, worldX, worldY, game.zoom);
        game.canvasPanX = pan.panX;
        game.canvasPanY = pan.panY;
        applyPanZoom(game);
    }

    function centerContent(game) {
        const c = getContentCenter(game);
        centerWorldPoint(game, c.x, c.y);
    }

    function handleWheelZoom(game, deltaY) {
        const Zoom = global.GameZoom;
        if (Zoom && !Zoom.canZoom(game)) return;

        syncFocalFromPan(game);

        if (Zoom) {
            Zoom.applyWheelDelta(game, deltaY);
            return;
        }
        const factor = deltaY > 0 ? 0.9 : 1.1;
        game.targetZoom = Math.min(Math.max(game.targetZoom * factor, 0.2), 5.0);
    }

    /** Keep focal world point under viewport center after iframe resize. */
    function reflowOnResize(game) {
        if (!game._viewportFocal) syncFocalFromPan(game);
        const f = game._viewportFocal || getContentCenter(game);
        const pan = panForWorldAtCenter(game, f.x, f.y, game.zoom);
        game.canvasPanX = pan.panX;
        game.canvasPanY = pan.panY;
        applyPanZoom(game);
    }

    /** Smooth zoom + pan focal lock — call from engine RAF loop. */
    function tick(game) {
        const Zoom = global.GameZoom;
        const vel = Zoom ? Zoom.velocity(game) : (game.zoomVelocity ?? 0.12);
        let dirty = false;

        if (Math.abs(game.zoom - game.targetZoom) > 0.0005) {
            if (game._viewportPanning || !game._viewportFocal) syncFocalFromPan(game);
            const delta = game.targetZoom - game.zoom;
            game.zoom += delta * vel;
            const pan = panForCurrentFocal(game, game.zoom)
                || panForWorldAtCenter(game, game._viewportFocal.x, game._viewportFocal.y, game.zoom);
            game.canvasPanX = pan.panX;
            game.canvasPanY = pan.panY;
            dirty = true;
        }

        if (dirty) applyPanZoom(game);
        return dirty || Math.abs(game.zoom - game.targetZoom) > 0.001;
    }

    function initPan(game) {
        if (game._viewportPanInit) return;
        if (game.capabilities?.viewportPanEnabled === false) return;
        const el = document.getElementById('board-canvas') || document.querySelector('.board-pan-layer');
        if (!el) return;

        const THRESHOLD = 4;
        let start = null;
        let last = null;
        let panRaf = 0;

        const flushPan = () => {
            panRaf = 0;
            applyPanZoom(game);
            syncFocalFromPan(game);
        };

        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target.closest('.tile')) return;
            if (game._pinchActive) return;
            start = { x: e.clientX, y: e.clientY };
            last = { x: e.clientX, y: e.clientY };
            game._viewportPanning = false;
            try {
                if (e.pointerId != null) el.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        };

        const onMove = (e) => {
            if (!start || !last) return;
            if (game._pinchActive) {
                onUp();
                return;
            }
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (!game._viewportPanning && Math.hypot(dx, dy) < THRESHOLD) return;
            game._viewportPanning = true;
            const mdx = e.clientX - last.x;
            const mdy = e.clientY - last.y;
            last.x = e.clientX;
            last.y = e.clientY;
            game.canvasPanX = (game.canvasPanX || 0) + mdx;
            game.canvasPanY = (game.canvasPanY || 0) + mdy;
            if (!panRaf) {
                panRaf = requestAnimationFrame(flushPan);
            }
        };

        const onUp = () => {
            if (panRaf) cancelAnimationFrame(panRaf);
            panRaf = 0;
            start = null;
            last = null;
            game._viewportPanning = false;
            syncFocalFromPan(game);
        };

        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        game._viewportPanInit = true;
    }

    const GameViewport = {
        usesPanZoomBoard,
        applyPanZoom,
        centerWorldPoint,
        centerContent,
        handleWheelZoom,
        tick,
        initPan,
        syncFocalFromPan,
        getContentCenter,
        clientToWorld,
        worldToClient,
        reflowOnResize
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameViewport;
    } else {
        global.GameViewport = GameViewport;
    }
})(typeof window !== 'undefined' ? window : global);
