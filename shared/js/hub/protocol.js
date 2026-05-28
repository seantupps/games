/**
 * Hub ↔ iframe postMessage contract. Import constants instead of raw strings.
 * Payload shapes are documented per type; use validateHubMessage in dev/test.
 */
(function (global) {
    /** Legacy string shortcuts (iframe → hub, no payload) */
    const LEGACY_STRING = {
        TOGGLE_SETTINGS: 'toggle-settings',
        CLOSE_SETTINGS: 'close-settings',
        SWITCH_GAME: 'switch-game',
        CYCLE_MODE: 'cycle-mode',
        TOGGLE_CHAT: 'toggle-chat',
        TOGGLE_COMMAND: 'toggle-command'
    };

    const MSG = {
        // lifecycle
        IFRAME_READY: 'iframe-ready',
        GAME_RENDERED: 'game-rendered',
        GAME_RENDER_FAILED: 'game-render-failed',
        INIT_IDENTITY: 'init-identity',

        // hub chrome
        UPDATE_TURN: 'update-turn',
        UPDATE_WIN_BANNER: 'update-win-banner',
        TOGGLE_TURN_ALTERNATION: 'toggle-turn-alternation',
        OPEN_SETTINGS_EDGE_SWIPE: 'open-settings-edge-swipe',

        // theme / players
        UPDATE_THEME: 'update-theme',
        UPDATE_OPPONENT_THEME: 'update-opponent-theme',
        UPDATE_ROLE: 'update-role',

        // network bridge (iframe → hub → Firebase)
        NETWORK_SEND: 'network-send',
        NETWORK_SEND_EVENT: 'network-send-event',
        NETWORK_UPDATE_ROOM: 'network-update-room',
        NETWORK_UPDATE: 'network-update',
        NETWORK_EVENTS: 'network-events',

        // input forwarding
        KEYDOWN: 'keydown',
        WHEEL: 'wheel',
        MOUSEMOVE: 'mousemove',

        // viewport (hub ↔ iframe)
        FIVE_VIEWPORT_MODE: 'five-viewport-mode',
        FIVE_VIEWPORT_QUERY: 'five-viewport-query',

        // game → hub optional
        PINCH_ZOOM_CURRENT: 'pinch-zoom-current',

        // tests / dev
        TEST_FORCE_MOVE: 'test-force-move',
        DEV_WIN: 'dev-win'
    };

    const ALL_TYPES = new Set([
        ...Object.values(MSG),
        ...Object.values(LEGACY_STRING)
    ]);

    const PAYLOAD_HINTS = {
        [MSG.NETWORK_SEND]: ['path', 'payload'],
        [MSG.NETWORK_SEND_EVENT]: ['event'],
        [MSG.NETWORK_UPDATE_ROOM]: ['updates'],
        [MSG.NETWORK_UPDATE]: ['payload'],
        [MSG.NETWORK_EVENTS]: ['events'],
        [MSG.UPDATE_TURN]: ['text'],
        [MSG.UPDATE_WIN_BANNER]: ['visible'],
        [MSG.INIT_IDENTITY]: ['role'],
        [MSG.WHEEL]: ['deltaY'],
        [MSG.KEYDOWN]: ['key', 'code']
    };

    function normalizeType(data) {
        if (typeof data === 'string') return data;
        if (data && typeof data.type === 'string') return data.type;
        return null;
    }

    /**
     * @param {unknown} data
     * @param {{ strict?: boolean }} [opts]
     * @returns {{ ok: boolean, type: string|null, error?: string }}
     */
    function validateHubMessage(data, opts = {}) {
        const type = normalizeType(data);
        if (!type) {
            return { ok: false, type: null, error: 'missing type' };
        }
        if (!ALL_TYPES.has(type)) {
            return opts.strict
                ? { ok: false, type, error: `unknown hub message type: ${type}` }
                : { ok: true, type, error: 'unknown type (non-strict)' };
        }
        if (typeof data === 'object' && data !== null && PAYLOAD_HINTS[type]) {
            const missing = PAYLOAD_HINTS[type].filter((k) => !(k in data));
            if (missing.length && opts.strict) {
                return { ok: false, type, error: `missing fields: ${missing.join(', ')}` };
            }
        }
        return { ok: true, type };
    }

    function isLegacyString(data) {
        return typeof data === 'string' && Object.values(LEGACY_STRING).includes(data);
    }

    const HubProtocol = {
        MSG,
        LEGACY_STRING,
        ALL_TYPES,
        normalizeType,
        validateHubMessage,
        isLegacyString
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HubProtocol;
    } else {
        global.HubProtocol = HubProtocol;
    }
})(typeof window !== 'undefined' ? window : global);
