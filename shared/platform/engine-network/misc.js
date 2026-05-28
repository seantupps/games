/**
 * Theme, dev/test messages, board inspect, keydown — not tied to one game id.
 */
(function (global) {
    function boardInspectType() {
        if (typeof HubProtocol !== 'undefined') {
            return HubProtocol.MSG?.BOARD_STATE_INSPECT || HubProtocol.MSG?.BANANA_BOARD_STATE;
        }
        return 'board-state-inspect';
    }

    function handleMisc(game, e) {
        const type = e.data.type;

        if (type === 'update-role') {
            game.playerRole = e.data.role;
            game.updateTurnIndicator();
            game.renderScoreboard();
            return true;
        }
        if (type === 'update-theme') {
            game.uid = e.data.uid || game.uid;
            document.documentElement.style.setProperty('--theme-color', e.data.color);
            if (e.data.opponentColor) {
                document.documentElement.style.setProperty('--opponent-color', e.data.opponentColor);
            }
            if (e.data.username) game.username = e.data.username;
            game.updateTurnIndicator();
            game.safeRender();
            return true;
        }
        if (type === 'update-opponent-theme') {
            document.documentElement.style.setProperty('--opponent-color', e.data.color);
            if (e.data.name) game.opponentName = e.data.name;
            game.updateTurnIndicator();
            game.safeRender();
            return true;
        }
        if (type === 'test-force-move') {
            game.submitMove(e.data.move);
            return true;
        }
        if (type === 'dict-adjust') {
            if (typeof game.applyDictionaryAdjustments === 'function') {
                game.applyDictionaryAdjustments(e.data.adjustments || {});
            }
            return true;
        }
        const inspect = boardInspectType();
        if (type === inspect || type === 'banana-board-state') {
            if (game.hasCap?.('supportsBoardStateInspect')
                && typeof game.reportBoardState === 'function') {
                game.reportBoardState();
            }
            return true;
        }
        if (type === 'keydown') {
            game._handleKeyDown(e.data);
            return true;
        }
        return false;
    }

    global.EngineNetwork = global.EngineNetwork || {};
    global.EngineNetwork.misc = { handleMisc };
})(typeof window !== 'undefined' ? window : global);
