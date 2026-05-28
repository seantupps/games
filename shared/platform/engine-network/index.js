/**
 * Composes iframe network message handlers. Loaded before engine.js.
 */
(function (global) {
    function registerAll(game) {
        const EN = global.EngineNetwork;
        if (!EN?.room || !EN?.events) {
            console.warn('[EngineNetwork] modules missing; network listeners not registered');
            return;
        }

        window.addEventListener('message', (e) => {
            if (!e.data) return;

            if (EN.misc?.handleMisc?.(game, e)) return;

            if (EN.room.handleInitIdentity(game, e)) return;

            if (EN.events.handleNetworkEvents(game, e)) return;

            if (e.data.type === 'network-update' && e.data.payload) {
                EN.room.handleNetworkUpdateShell(game, e);
                const data = e.data.payload;
                EN.drag?.handleDragOnUpdate?.(game, data);
                EN.preview?.handlePreviews?.(game, data);
            }
        });
    }

    global.EngineNetwork = global.EngineNetwork || {};
    global.EngineNetwork.registerAll = registerAll;
})(typeof window !== 'undefined' ? window : global);
