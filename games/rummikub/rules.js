/**
 * Rummikub layout constants — tile size is easy to tweak here and in style.css vars.
 *
 * Layout knobs live in DESKTOP / MOBILE; puzzle timing and pool size stay shared.
 * If you change TILE_W or TILE_H for mobile, also update style.css (--rummi-tile-w/h).
 */
var RummikubRules = (() => {
    const SHARED = {
        PLACED_COUNT: 54,
        REMOVE_PERCENT: 30,
        GEN_TIMEOUT_MS: 3000,
        SOLVE_DEADLINE_MS: 2000,
        /** Win verification budget (partition seeds + backtrack). */
        WIN_VERIFY_DEADLINE_MS: 5000,
        COLOR_HEX: {
            B: '#1a1a1a',
            R: '#dc2626',
            U: '#2563eb',
            O: '#ea580c'
        }
    };

    /** Desktop layout — pan/zoom board + rack spacing. */
    const DESKTOP = {
        TILE_W: 40,
        TILE_H: 52,
        TILE_GAP: 40,
        RACK_ROWS: 3,
        /** Rack top edge — lower moves rack up toward the board. */
        HAND_BELOW_CENTER: 340,
        /** Board anchor — lower moves the board down toward the rack. */
        BOARD_ABOVE_CENTER: 50,
        /** Horizontal gap between meld islands in pixels (refresh to apply). */
        MELD_ISLAND_GAP_PX: 80,
        /** Empty grid rows between meld wrap rows. */
        MELD_GAP_Y: 1,
        /** Max grid cells wide before meld islands wrap to the next row. */
        MAX_MELD_ROW_WIDTH: 18
    };

    /** Mobile layout — tune independently from desktop. */
    const MOBILE = {
        TILE_W: 40,
        TILE_H: 52,
        TILE_GAP: 40,
        RACK_ROWS: 3,
        HAND_BELOW_CENTER: 500,
        BOARD_ABOVE_CENTER: 200,
        MELD_ISLAND_GAP_PX: 40,
        MELD_GAP_Y: 1,
        MAX_MELD_ROW_WIDTH: 12
    };

    function isMobileViewport() {
        return typeof window !== 'undefined'
            && typeof window.game?.isMobileViewport === 'function'
            && window.game.isMobileViewport();
    }

    function pickLayout(isMobile) {
        if (isMobile === true) return MOBILE;
        if (isMobile === false) return DESKTOP;
        return isMobileViewport() ? MOBILE : DESKTOP;
    }

    function layout(isMobile) {
        const L = pickLayout(isMobile);
        return {
            ...SHARED,
            ...L,
            BOARD_CELL_STEP: L.TILE_GAP,
            BOARD_ROW_STEP: L.TILE_H
        };
    }

    function rackCols(tileCount = pickLayout().RACK_ROWS * 8, isMobile) {
        const L = pickLayout(isMobile);
        return Math.max(1, Math.ceil(tileCount / L.RACK_ROWS));
    }

    function rackOrigin(origin, tileCount = pickLayout().RACK_ROWS * 8, isMobile) {
        const L = pickLayout(isMobile);
        const cols = rackCols(tileCount, isMobile);
        const startX = origin.x - ((cols - 1) * L.TILE_GAP + L.TILE_W) / 2;
        const startY = origin.y + L.HAND_BELOW_CENTER;
        return { startX, startY, cols };
    }

    function boardAnchor(origin, isMobile) {
        const L = pickLayout(isMobile);
        return {
            x: origin.x - 4 * L.TILE_GAP,
            y: origin.y - L.BOARD_ABOVE_CENTER
        };
    }

    const LAYOUT_KEYS = [
        'TILE_W', 'TILE_H', 'TILE_GAP', 'RACK_ROWS',
        'HAND_BELOW_CENTER', 'BOARD_ABOVE_CENTER',
        'MELD_ISLAND_GAP_PX', 'MELD_GAP_Y', 'MAX_MELD_ROW_WIDTH',
        'BOARD_CELL_STEP', 'BOARD_ROW_STEP'
    ];

    const rules = {
        ...SHARED,
        DESKTOP,
        MOBILE,
        layout,
        pickLayout,
        rackCols,
        rackOrigin,
        boardAnchor
    };

    LAYOUT_KEYS.forEach((key) => {
        if (key === 'BOARD_CELL_STEP') {
            Object.defineProperty(rules, key, { get: () => pickLayout().TILE_GAP, enumerable: true });
        } else if (key === 'BOARD_ROW_STEP') {
            Object.defineProperty(rules, key, { get: () => pickLayout().TILE_H, enumerable: true });
        } else {
            Object.defineProperty(rules, key, { get: () => pickLayout()[key], enumerable: true });
        }
    });

    return rules;
})();

if (typeof globalThis !== 'undefined') {
    globalThis.RummikubRules = RummikubRules;
}
