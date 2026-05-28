/**
 * Mobile layout policy helpers — capability-driven, no game id checks.
 */
(function (global) {
    /** @typedef {'none'|'fit-square'|'piles-dynamic'|'fixed-spiral-anchor'|'pan-zoom-board'} MobileLayoutPolicy */

    function policy(game) {
        return game?.capabilities?.mobileLayoutPolicy || 'none';
    }

    function usesFitSquare(game) {
        return policy(game) === 'fit-square';
    }

    function usesPanZoomBoard(game) {
        return policy(game) === 'pan-zoom-board';
    }

    function usesFixedSpiralAnchor(game) {
        return policy(game) === 'fixed-spiral-anchor';
    }

    function usesPilesDynamic(game) {
        return policy(game) === 'piles-dynamic';
    }

    function boardKind(game) {
        return game?.capabilities?.boardKind || 'generic';
    }

    function isPilesBoard(game) {
        return boardKind(game) === 'piles';
    }

    const MobileLayoutPolicy = {
        policy,
        usesFitSquare,
        usesPanZoomBoard,
        usesFixedSpiralAnchor,
        usesPilesDynamic,
        boardKind,
        isPilesBoard
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = MobileLayoutPolicy;
    } else {
        global.MobileLayoutPolicy = MobileLayoutPolicy;
    }
})(typeof window !== 'undefined' ? window : global);
