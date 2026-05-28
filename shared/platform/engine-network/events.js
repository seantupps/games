/**
 * Authoritative move event log (network-events).
 */
(function (global) {
    function handleNetworkEvents(game, e) {
        if (e.data.type !== 'network-events') return false;
        if (game.roomId === 'lobby' || !game.isMultiplayer) return true;

        game._eventsLoaded = true;
        const events = Array.isArray(e.data.events) ? e.data.events : [];
        const roomRc = game._currentResetRound();
        const replay = game._eventsForReplay(events);

        if (events.length > 0 && replay.length === 0 && game._resetAcknowledgedAt) {
            console.warn('[ENGINE] Dropping pre-reset / wrong-round event batch');
            game.gameEvents = [];
            game._eventsSyncedAtResetCount = roomRc;
            game.rebuildState();
            return true;
        }

        game.gameEvents = events;
        game._eventsSyncedAtResetCount = roomRc;
        game.rebuildState();
        return true;
    }

    global.EngineNetwork = global.EngineNetwork || {};
    global.EngineNetwork.events = { handleNetworkEvents };
})(typeof window !== 'undefined' ? window : global);
