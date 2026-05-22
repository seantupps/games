/**
 * Capability-driven game adapter — attach to BaseGame instances after initIdentity.
 * Engine/hub use capabilities + serializeBoard/applyBoard, not game id strings.
 */
(function (global) {
    const Registry = global.GameRegistry;

    function defaultCapabilities() {
        return Registry
            ? { ...Registry.DEFAULT_CAPABILITIES }
            : {
                supportsTurnIndicator: true,
                supportsScoreboard: true,
                supportsWinBanner: true,
                supportsModes: false,
                supportsDragging: false,
                supportsZoom: true,
                supportsLongPressEndTurn: false,
                supportsRealtimePreviews: false,
                hasBoardState: true,
                syncStyle: 'event-log'
            };
    }

    /**
     * @param {import('../games/registry').BaseGame} game
     */
    function attachGameAdapter(game) {
        if (!game || typeof game !== 'object') return game;

        const id = game.gameName || 'unknown';
        const mode = game.mode || Registry?.defaultModeFor(id) || 'classic';
        game.capabilities = Registry
            ? Registry.getCapabilities(id, mode)
            : defaultCapabilities();
        game.hasCap = (name) => cap(game, name);

        if (typeof game.serializeBoard !== 'function') {
            game.serializeBoard = () => (game.capabilities.hasBoardState ? null : undefined);
        }
        if (typeof game.applyBoard !== 'function') {
            game.applyBoard = (board) => {
                if (board == null || typeof game.applyState !== 'function') return;
                game.applyState(board);
            };
        }
        if (typeof game.getExtraGlobalReset !== 'function') {
            game.getExtraGlobalReset = () => ({});
        }

        return game;
    }

    function cap(game, name) {
        return !!(game?.capabilities && game.capabilities[name]);
    }

    /**
     * Re-merge capabilities after mode change (call from initIdentity).
     * @param {object} game
     */
    function refreshCapabilities(game) {
        if (!game) return game;
        const id = game.gameName || 'unknown';
        const mode = game.mode || 'classic';
        game.capabilities = Registry
            ? Registry.getCapabilities(id, mode)
            : defaultCapabilities();
        return game;
    }

    const GameAdapter = { attachGameAdapter, refreshCapabilities, cap, defaultCapabilities };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameAdapter;
    } else {
        global.GameAdapter = GameAdapter;
    }
})(typeof window !== 'undefined' ? window : global);
