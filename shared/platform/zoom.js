/**
 * Smooth zoom for all games — targetZoom animates via RAF (no desktop snap).
 * Zoom may run together with tile drag or background pan; pan-zoom drag uses cursor anchoring.
 */
(function (global) {
    const DEFAULT_VELOCITY = 0.12;
    const SETTLED_EPS = 0.0005;

    function velocity(game) {
        return game?.zoomVelocity ?? DEFAULT_VELOCITY;
    }

    function isAnimating(game) {
        return Math.abs((game?.zoom ?? 1) - (game?.targetZoom ?? 1)) > SETTLED_EPS;
    }

    function canZoom() {
        return true;
    }

    function canDrag(game) {
        if (!game) return true;
        if (game._pinchActive) return false;
        return true;
    }

    function applyWheelDelta(game, deltaY) {
        if (!canZoom(game)) return false;
        const factor = deltaY > 0 ? 0.9 : 1.1;
        game.targetZoom = Math.min(Math.max(game.targetZoom * factor, 0.2), 5.0);
        return true;
    }

    function tick(game) {
        if (!isAnimating(game)) return false;

        const Viewport = global.GameViewport;
        const Layout = global.MobileLayoutPolicy;
        if (Viewport && Layout?.usesPanZoomBoard(game)) {
            return Viewport.tick(game);
        }

        const vel = velocity(game);
        game.zoom += (game.targetZoom - game.zoom) * vel;
        if (typeof game.applyZoom === 'function') game.applyZoom();
        return true;
    }

    const GameZoom = {
        DEFAULT_VELOCITY,
        velocity,
        isAnimating,
        canZoom,
        canDrag,
        applyWheelDelta,
        tick
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameZoom;
    } else {
        global.GameZoom = GameZoom;
    }
})(typeof window !== 'undefined' ? window : global);
