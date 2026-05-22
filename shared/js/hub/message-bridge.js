/**
 * Hub window message listener — routes iframe postMessage via HubProtocol.
 */
(function (global) {
    const Protocol = global.HubProtocol;

    /**
     * @param {Record<string, function(MessageEvent): void>} handlers keyed by MSG type or legacy string
     * @param {{ strict?: boolean, warnUnknown?: boolean }} [opts]
     */
    function install(handlers, opts = {}) {
        const strict = !!opts.strict;
        const warnUnknown = opts.warnUnknown !== false;

        window.addEventListener('message', (e) => {
            const check = Protocol.validateHubMessage(e.data, { strict });
            const type = check.type;
            if (!type) return;

            if (!check.ok && warnUnknown) {
                console.warn('[HUB] message validation:', check.error, e.data);
            }

            const fn = handlers[type];
            if (typeof fn === 'function') {
                fn(e);
                return;
            }
            if (warnUnknown && check.ok) {
                console.warn('[HUB] unhandled message type:', type);
            }
        });
    }

    const HubMessageBridge = { install };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HubMessageBridge;
    } else {
        global.HubMessageBridge = HubMessageBridge;
    }
})(typeof window !== 'undefined' ? window : global);
