/**
 * Mobile layout bounds, fit, and refresh — extracted from engine.js.
 * Loaded before engine.js.
 */
(function (global) {
    const P = () => global.MobileLayoutPolicy;

    function policy(game) {
        const pol = P();
        return pol ? pol.policy(game) : (game.capabilities?.mobileLayoutPolicy || 'none');
    }

    function usesFitSquare(game) {
        const pol = P();
        if (pol) return pol.usesFitSquare(game);
        return policy(game) === 'fit-square';
    }

    function usesPanZoomBoard(game) {
        const pol = P();
        if (pol) return pol.usesPanZoomBoard(game);
        return policy(game) === 'pan-zoom-board';
    }

    function usesFixedSpiralAnchor(game) {
        const pol = P();
        if (pol) return pol.usesFixedSpiralAnchor(game);
        return policy(game) === 'fixed-spiral-anchor';
    }

    function isPilesBoard(game) {
        const pol = P();
        if (pol?.isPilesBoard) return pol.isPilesBoard(game);
        return (game.capabilities?.boardKind || 'generic') === 'piles';
    }

    function spiralCoords(game, n) {
                if (n === 0) return { x: 0, y: 0 };
                let x = 0;
                let y = 0;
                let step = 1;
                let count = 0;
                while (count < n) {
                    for (let i = 0; i < step && count < n; i++) { x++; count++; }
                    if (count === n) break;
                    for (let i = 0; i < step && count < n; i++) { y--; count++; }
                    if (count === n) break;
                    step++;
                    for (let i = 0; i < step && count < n; i++) { x--; count++; }
                    if (count === n) break;
                    for (let i = 0; i < step && count < n; i++) { y++; count++; }
                    if (count === n) break;
                    step++;
                }
                return { x, y };
    }

    function classicPileWorldBounds(game, portrait) {
                const piece = 44;
                const pad = piece / 2;
                const gap = 70;
                const vgap = 70;
                const spacing = portrait ? 200 : 250;
                const centers = { B: -spacing, R: 0, G: spacing };
                let minNx = Infinity;
                let maxNx = -Infinity;
                let minNy = Infinity;
                let maxNy = -Infinity;

                for (const pk of ['B', 'R', 'G']) {
                    for (let idx = 0; idx < 5; idx++) {
                        let offsetX;
                        let offsetY;
                        if (portrait) {
                            const centerYOffset = centers[pk];
                            if (idx < 3) {
                                offsetX = (idx - 1) * gap;
                                offsetY = centerYOffset;
                            } else {
                                offsetX = idx === 3 ? -gap / 2 : gap / 2;
                                offsetY = centerYOffset - vgap;
                            }
                        } else {
                            const centerXOffset = centers[pk];
                            if (idx < 3) {
                                offsetX = centerXOffset + (idx - 1) * gap;
                                offsetY = 0;
                            } else {
                                offsetX = centerXOffset + (idx === 3 ? -gap / 2 : gap / 2);
                                offsetY = -vgap;
                            }
                        }
                        const nx = 500 + offsetX;
                        const ny = 500 + offsetY;
                        minNx = Math.min(minNx, nx - pad);
                        maxNx = Math.max(maxNx, nx + pad);
                        minNy = Math.min(minNy, ny - pad);
                        maxNy = Math.max(maxNy, ny + pad);
                    }
                }

                return {
                    w: maxNx - minNx,
                    h: maxNy - minNy,
                    cx: (minNx + maxNx) / 2,
                    cy: (minNy + maxNy) / 2
                };
    }

    function shouldLockFreestyle(game) {
                return game.isMobileViewport() && usesFixedSpiralAnchor(game);
    }

    function getFreestyleInitialVisualBounds(game) {
                const piece = 44;
                const pad = piece / 2;
                let minNx = Infinity;
                let maxNx = -Infinity;
                let minNy = Infinity;
                let maxNy = -Infinity;
                for (let i = 0; i < 12; i++) {
                    const spiral = spiralCoords(game, i);
                    const nx = 500 + spiral.x * 75;
                    const ny = 500 + spiral.y * 75;
                    minNx = Math.min(minNx, nx - pad);
                    maxNx = Math.max(maxNx, nx + pad);
                    minNy = Math.min(minNy, ny - pad);
                    maxNy = Math.max(maxNy, ny + pad);
                }
                if (!Number.isFinite(minNx)) {
                    return { w: 400, h: 400, cx: 500, cy: 500 };
                }
                return {
                    w: maxNx - minNx,
                    h: maxNy - minNy,
                    cx: (minNx + maxNx) / 2,
                    cy: (minNy + maxNy) / 2
                };
    }

    function getPilesStableVisualBounds(game) {
                const piece = 44;
                const { width: vw, height: vh } = game.getVisibleViewportSize();
                const portrait = vh > vw;

                if (game.mode === 'classic') {
                    return classicPileWorldBounds(game, portrait);
                }

                if (game._mobileLayoutAnchorLocked && game._mobileContentBounds) {
                    return game._mobileContentBounds;
                }

                const pad = piece / 2;
                let minNx = Infinity;
                let maxNx = -Infinity;
                let minNy = Infinity;
                let maxNy = -Infinity;
                const items = game.piles
                    ? Object.values(game.piles).flat().filter(Boolean)
                    : [];
                const walk = (idx) => {
                    const spiral = spiralCoords(game, idx);
                    let nx = 500 + spiral.x * 75;
                    let ny = 500 + spiral.y * 75;
                    return { nx, ny };
                };
                if (items.length) {
                    items.forEach((piece) => {
                        let { nx, ny } = walk(piece.gridIdx ?? 0);
                        const saved = game.piecePositions?.[piece.id];
                        if (saved) {
                            if (saved.nx !== undefined) nx = saved.nx;
                            if (saved.ny !== undefined) ny = saved.ny;
                        }
                        minNx = Math.min(minNx, nx - pad);
                        maxNx = Math.max(maxNx, nx + pad);
                        minNy = Math.min(minNy, ny - pad);
                        maxNy = Math.max(maxNy, ny + pad);
                    });
                } else {
                    for (let i = 0; i < 12; i++) {
                        const { nx, ny } = walk(i);
                        minNx = Math.min(minNx, nx - pad);
                        maxNx = Math.max(maxNx, nx + pad);
                        minNy = Math.min(minNy, ny - pad);
                        maxNy = Math.max(maxNy, ny + pad);
                    }
                }
                if (!Number.isFinite(minNx)) {
                    return { w: 400, h: 400, cx: 500, cy: 500 };
                }
                return {
                    w: maxNx - minNx,
                    h: maxNy - minNy,
                    cx: (minNx + maxNx) / 2,
                    cy: (minNy + maxNy) / 2
                };
    }

    function lockMobileLayoutAnchor(game) {
                if (game._mobileLayoutAnchorLocked) return;
                game._mobileContentBounds = getFreestyleInitialVisualBounds(game);
                game._mobileLayoutAnchorLocked = true;
    }

    function applyMobilePilesContainerGeometry(game, bounds) {
                const { width: vw, height: vh } = game.getVisibleViewportSize();
                if (!vw || !vh || !bounds) return;
                const board = game.localSize || 1000;
                const docEl = document.documentElement;
                docEl.style.height = '100%';
                docEl.style.width = '100%';
                docEl.style.maxHeight = '';
                docEl.style.overflow = 'hidden';
                document.body.style.display = 'block';
                document.body.style.position = 'relative';
                document.body.style.width = `${vw}px`;
                document.body.style.height = `${vh}px`;
                document.body.style.maxHeight = `${vh}px`;
                document.body.style.minHeight = '0';
                document.body.style.overflow = 'hidden';
                document.body.style.margin = '0';
                document.body.style.transform = '';
                document.body.style.transformOrigin = '';
                const container = document.getElementById('game-container');
                if (container) {
                    container.style.position = 'absolute';
                    container.style.left = `${vw / 2 - bounds.cx}px`;
                    container.style.top = `${vh / 2 - bounds.cy}px`;
                    container.style.width = `${board}px`;
                    container.style.height = `${board}px`;
                    container.style.margin = '0';
                    container.style.transformOrigin = `${bounds.cx}px ${bounds.cy}px`;
                }
    }

    function getMobileVisualBounds(game) {
                const pad = game.isMobileViewport() ? 32 : 12;
                const ls = game.localSize || 800;
                const fallback = { w: ls, h: ls, cx: ls / 2, cy: ls / 2 };

                if (usesPanZoomBoard(game)) {
                    return getPanZoomWorldVisualBounds(game);
                }

                if (isPilesBoard(game) || usesFixedSpiralAnchor(game) || policy(game) === 'piles-dynamic') {
                    return getPilesStableVisualBounds(game);
                }

                if (game.nodes?.length && usesFitSquare(game)) {
                    let minX = Infinity;
                    let minY = Infinity;
                    let maxX = -Infinity;
                    let maxY = -Infinity;
                    for (const n of game.nodes) {
                        const x = parseFloat(n.el?.style?.left) || 0;
                        const y = parseFloat(n.el?.style?.top) || 0;
                        minX = Math.min(minX, x - pad);
                        maxX = Math.max(maxX, x + pad);
                        minY = Math.min(minY, y - pad);
                        maxY = Math.max(maxY, y + pad);
                    }
                    if (!Number.isFinite(minX)) return fallback;
                    return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
                }

                const container = document.getElementById('game-container');
                const pieces = container?.querySelectorAll('.piece') || [];
                if (pieces.length) {
                    let minX = Infinity;
                    let minY = Infinity;
                    let maxX = -Infinity;
                    let maxY = -Infinity;
                    pieces.forEach((p) => {
                        const x = parseFloat(p.style.left) || 0;
                        const y = parseFloat(p.style.top) || 0;
                        const w = p.offsetWidth || 36;
                        const h = p.offsetHeight || 36;
                        minX = Math.min(minX, x - pad);
                        maxX = Math.max(maxX, x + w + pad);
                        minY = Math.min(minY, y - pad);
                        maxY = Math.max(maxY, y + h + pad);
                    });
                    if (!Number.isFinite(minX)) return fallback;
                    return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
                }

                return fallback;
    }

    function computeDefaultPanZoomWorldVisualBounds(game) {
                const pad = 56;
                const size = 40;
                const gap = 40;
                const center = typeof game.getViewportContentCenter === 'function'
                    ? game.getViewportContentCenter()
                    : { x: 2400, y: 2400 };
                const tiles = game.tiles;
                if (!tiles?.length) {
                    const cols = 7;
                    const rows = 3;
                    const w = (cols - 1) * gap + size + pad * 2;
                    const h = (rows - 1) * gap + size + pad * 2;
                    return { w, h, cx: center.x, cy: center.y };
                }
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const t of tiles) {
                    if (t.x == null || t.y == null) continue;
                    minX = Math.min(minX, t.x);
                    maxX = Math.max(maxX, t.x + size);
                    minY = Math.min(minY, t.y);
                    maxY = Math.max(maxY, t.y + size);
                }
                if (!Number.isFinite(minX)) {
                    const w = 7 * gap + size + pad * 2;
                    const h = 3 * gap + size + pad * 2;
                    return { w, h, cx: center.x, cy: center.y };
                }
                minX -= pad;
                minY -= pad;
                maxX += pad;
                maxY += pad;
                return {
                    w: maxX - minX,
                    h: maxY - minY,
                    cx: (minX + maxX) / 2,
                    cy: (minY + maxY) / 2
                };
    }

    /** Prefer game override (e.g. Bananagrams hand bounds); fall back to generic tile AABB. */
    function getPanZoomWorldVisualBounds(game) {
        if (typeof game.getPanZoomWorldVisualBounds === 'function') {
            return game.getPanZoomWorldVisualBounds();
        }
        return computeDefaultPanZoomWorldVisualBounds(game);
    }

    function fitPanZoomMobileViewport(game) {
                const bounds = getPanZoomWorldVisualBounds(game);
                game._mobileContentBounds = bounds;
                const { width: vw, height: vh } = game.getVisibleViewportSize();
                const margin = 24;
                const scaleX = (vw - margin * 2) / Math.max(bounds.w, 1);
                const scaleY = (vh - margin * 2) / Math.max(bounds.h, 1);
                const fit = Math.min(Math.max(Math.min(scaleX, scaleY), 0.2), 5);
                const focal = typeof game.getViewportContentCenter === 'function'
                    ? game.getViewportContentCenter()
                    : { x: bounds.cx, y: bounds.cy };
                const z = game.zoom || 1;

                if (!game._fitZoomInitialized) {
                    game.targetZoom = fit;
                    game.zoom = fit;
                    game._mobileBaseFit = fit;
                    game._fitZoomInitialized = true;
                    game._mobileLayoutAnchorLocked = true;
                } else if (z < fit * 0.98 || z > fit * 1.02) {
                    // Persisted/desktop zoom can be above mobile fit — clamp and recenter rack.
                    game.targetZoom = fit;
                    game.zoom = fit;
                    game._mobileBaseFit = fit;
                }

                if (typeof GameViewport !== 'undefined') {
                    GameViewport.centerWorldPoint(game, focal.x, focal.y);
                }
                game.applyZoom();
    }

    function refreshMobileLayout(game) {
                if (!game.isMobileViewport()) return;
                if (usesFitSquare(game) && game.fitBoardToViewport) {
                    fitBoardToViewport(game);
                    return;
                }
                if (usesPanZoomBoard(game)) {
                    fitPanZoomMobileViewport(game);
                    return;
                }
                if (shouldLockFreestyle(game)) {
                    lockMobileLayoutAnchor(game);
                    applyMobilePilesContainerGeometry(game, game._mobileContentBounds);
                    game.applyZoom();
                    return;
                }
                game._mobileContentBounds = getPilesStableVisualBounds(game);
                applyMobilePilesContainerGeometry(game, game._mobileContentBounds);
                game.applyZoom();
    }

    function refreshMobileLayoutViewportOnly(game) {
                if (!game.isMobileViewport()) return;
                if (usesFitSquare(game) && game.fitBoardToViewport) {
                    fitBoardToViewport(game);
                    return;
                }
                if (usesPanZoomBoard(game)) {
                    if (typeof GameViewport !== 'undefined') {
                        GameViewport.reflowOnResize(game);
                    }
                    game.applyZoom();
                    return;
                }
                if (!game._mobileLayoutAnchorLocked || !game._mobileContentBounds) {
                    refreshMobileLayout(game);
                    return;
                }
                applyMobilePilesContainerGeometry(game, game._mobileContentBounds);
                game.applyZoom();
    }

    function getDefaultZoomForViewport(game) {
                if (game.isMobileViewport()) {
                    const { width: vw, height: vh } = game.getVisibleViewportSize();
                    const margin = 20;
                    const bounds = shouldLockFreestyle(game)
                        ? (game._mobileContentBounds || getFreestyleInitialVisualBounds(game))
                        : getMobileVisualBounds(game);
                    const scaleX = (vw - margin * 2) / Math.max(bounds.w, 1);
                    const scaleY = (vh - margin * 2) / Math.max(bounds.h, 1);
                    const base = Math.min(Math.max(Math.min(scaleX, scaleY), 0.25), 5);
                    game._mobileBaseFit = base;
                    game._mobileContentBounds = bounds;
                    return base;
                }
                return 1;
    }

    function fitBoardToViewport(game) {
                if (!game.isMobileViewport()) return;
                if (!game.localSize || !usesFitSquare(game)) return;
                const container = document.getElementById('game-container');
                if (!container) return;
                const { width: vw, height: vh } = game.getVisibleViewportSize();
                if (!vw || !vh) return;
                game._mobileContentBounds = getMobileVisualBounds(game);

                container.style.width = `${game.localSize}px`;
                container.style.height = `${game.localSize}px`;
                container.style.margin = '0';
                container.style.flexShrink = '0';

                const docEl = document.documentElement;
                docEl.style.height = `${vh}px`;
                docEl.style.width = `${vw}px`;
                docEl.style.maxHeight = `${vh}px`;
                docEl.style.overflow = 'hidden';
                document.body.style.display = 'block';
                document.body.style.position = 'relative';
                document.body.style.width = `${vw}px`;
                document.body.style.height = `${vh}px`;
                document.body.style.maxHeight = `${vh}px`;
                document.body.style.minHeight = '0';
                document.body.style.overflow = 'hidden';
                document.body.style.margin = '0';

                if (!game._fitZoomInitialized) {
                    game.restorePersistedZoom();
                }
                game.applyZoom();
    }

    const api = {
        policy, usesFitSquare, usesPanZoomBoard, usesFixedSpiralAnchor,
        spiralCoords, classicPileWorldBounds, shouldLockFreestyle,
        getFreestyleInitialVisualBounds, getPilesStableVisualBounds,
        lockMobileLayoutAnchor, applyMobilePilesContainerGeometry,
        getMobileVisualBounds, getPanZoomWorldVisualBounds,
        fitPanZoomMobileViewport, refreshMobileLayout,
        refreshMobileLayoutViewportOnly, getDefaultZoomForViewport, fitBoardToViewport
    };

    /** Must load after engine.js — replaces no-op class stubs with real implementations. */
    function install(BaseGame) {
        if (!BaseGame?.prototype) return;
        Object.assign(BaseGame.prototype, {
            _mobileLayoutPolicy() { return policy(this); },
            _usesFitSquareMobileLayout() { return usesFitSquare(this); },
            _usesPanZoomBoard() { return usesPanZoomBoard(this); },
            _usesFixedSpiralMobileAnchor() { return usesFixedSpiralAnchor(this); },
            _spiralCoords(n) { return spiralCoords(this, n); },
            _classicPileWorldBounds(portrait) { return classicPileWorldBounds(this, portrait); },
            _shouldLockFreestyleMobileLayout() { return shouldLockFreestyle(this); },
            getFreestyleInitialVisualBounds() { return getFreestyleInitialVisualBounds(this); },
            getPilesStableVisualBounds() { return getPilesStableVisualBounds(this); },
            lockMobileLayoutAnchor() { return lockMobileLayoutAnchor(this); },
            _applyMobilePilesContainerGeometry(bounds) { return applyMobilePilesContainerGeometry(this, bounds); },
            getMobileVisualBounds() { return getMobileVisualBounds(this); },
            getPanZoomWorldVisualBounds() { return computeDefaultPanZoomWorldVisualBounds(this); },
            _fitPanZoomMobileViewport() { return fitPanZoomMobileViewport(this); },
            refreshMobileLayout() { return refreshMobileLayout(this); },
            refreshMobileLayoutViewportOnly() { return refreshMobileLayoutViewportOnly(this); },
            getDefaultZoomForViewport() { return getDefaultZoomForViewport(this); },
            fitBoardToViewport() { return fitBoardToViewport(this); }
        });
    }

    global.EngineMobileLayout = api;
    global.EngineMobileLayout.install = install;
    if (global.BaseGame) install(global.BaseGame);
})(typeof window !== 'undefined' ? window : global);
