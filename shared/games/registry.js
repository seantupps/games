/**
 * Single source of truth for games on the hub + iframe platform.
 * Add a game here first, then games/<id>/, logic module, and tests.
 *
 * RTDB today: games/{roomId}/global/* + gameData/{roomId}/events
 * Target (migration): games/{roomId}/meta + events + state (per-game opaque state blob)
 */
(function (global) {
    /** @typedef {'event-log'|'snapshot'|'hybrid'} SyncStyle */
    /** @typedef {'generic'|'piles'|'line'} BoardKind */
    /**
     * @typedef {'none'|'fit-square'|'piles-dynamic'|'fixed-spiral-anchor'} MobileLayoutPolicy
     */

    /**
     * Capability flags — engine/hub branch on these, not game id strings.
     * @typedef {Object} GameCapabilities
     * @property {BoardKind} [boardKind]
     * @property {MobileLayoutPolicy} [mobileLayoutPolicy]
     * @property {boolean} supportsTurnIndicator
     * @property {boolean} supportsScoreboard
     * @property {boolean} supportsWinBanner
     * @property {boolean} supportsModes
     * @property {boolean} supportsDragging
     * @property {boolean} supportsZoom
     * @property {boolean} supportsLongPressEndTurn
     * @property {boolean} supportsRealtimePreviews
     * @property {boolean} supportsPileColors
     * @property {boolean} hasBoardState
     * @property {SyncStyle} syncStyle
     */

    /** @type {GameCapabilities} */
    const DEFAULT_CAPABILITIES = {
        boardKind: 'generic',
        mobileLayoutPolicy: 'none',
        supportsTurnIndicator: true,
        supportsScoreboard: true,
        supportsWinBanner: true,
        supportsModes: false,
        supportsDragging: false,
        supportsZoom: true,
        supportsLongPressEndTurn: false,
        supportsRealtimePreviews: false,
        supportsPileColors: false,
        hasBoardState: true,
        syncStyle: 'event-log'
    };

    /**
     * @typedef {Object} GameDefinition
     * @property {string} id
     * @property {string} label
     * @property {string} logicKey — key in GameLogic / Cloud Functions Logic
     * @property {string[]} modes
     * @property {string} defaultMode
     * @property {GameCapabilities} capabilities
     * @property {Partial<Record<string, GameCapabilities>>} [capabilitiesByMode]
     * @property {string[]} globalResetKeys — under games/{roomId}/global/ cleared on game/mode switch
     * @property {boolean} clearGameDataOnReset — wipe gameData/{roomId} on host reset
     * @property {Record<string, string>} [auditByMode] — SP audit config dir per mode (no .js)
     * @property {string} [auditConfig] — default SP audit dir when single mode
     * @property {Record<string, string>} [mpAuditByMode] — MP audit config dir per mode
     * @property {string} [mpAuditConfig] — default MP audit dir when single mode
     */

    /** @type {GameDefinition[]} */
    const GAMES = [
        {
            id: 'piles',
            label: 'Piles',
            logicKey: 'piles',
            modes: ['classic', 'freestyle'],
            defaultMode: 'classic',
            capabilities: {
                ...DEFAULT_CAPABILITIES,
                boardKind: 'piles',
                mobileLayoutPolicy: 'piles-dynamic',
                supportsModes: true,
                supportsDragging: true,
                supportsLongPressEndTurn: true,
                supportsPileColors: true,
                syncStyle: 'hybrid'
            },
            capabilitiesByMode: {
                freestyle: { mobileLayoutPolicy: 'fixed-spiral-anchor' }
            },
            globalResetKeys: [
                'board',
                'piecePositions',
                'colors',
                'pileColors'
            ],
            clearGameDataOnReset: true,
            auditByMode: {
                classic: 'ptests/desktop/singleplayer/classic_piles',
                freestyle: 'ptests/desktop/singleplayer/freestyle_piles'
            },
            mpAuditByMode: {
                classic: 'ptests/desktop/multiplayer/mp_classic_piles',
                freestyle: 'ptests/desktop/multiplayer/mp_freestyle_piles'
            }
        },
        {
            id: 'line',
            label: 'Line',
            logicKey: 'line',
            modes: ['classic'],
            defaultMode: 'classic',
            capabilities: {
                ...DEFAULT_CAPABILITIES,
                boardKind: 'line',
                mobileLayoutPolicy: 'fit-square',
                supportsDragging: false,
                supportsRealtimePreviews: true,
                syncStyle: 'hybrid'
            },
            globalResetKeys: ['board'],
            clearGameDataOnReset: true,
            auditConfig: 'ptests/desktop/singleplayer/line',
            mpAuditConfig: 'ptests/desktop/multiplayer/mp_line'
        }
    ];

    const BY_ID = Object.fromEntries(GAMES.map((g) => [g.id, g]));

    function list() {
        return GAMES.slice();
    }

    function listIds() {
        return GAMES.map((g) => g.id);
    }

    function get(id) {
        return BY_ID[id] || null;
    }

    function has(id) {
        return !!BY_ID[id];
    }

    function defaultId() {
        return GAMES[0]?.id || 'piles';
    }

    function defaultModeFor(id) {
        return get(id)?.defaultMode || 'classic';
    }

    function normalizeMode(id, mode) {
        const def = get(id);
        if (!def) return 'classic';
        if (def.modes.includes(mode)) return mode;
        return def.defaultMode;
    }

    function nextGameId(currentId) {
        const ids = listIds();
        const i = ids.indexOf(currentId);
        if (i < 0) return ids[0];
        return ids[(i + 1) % ids.length];
    }

    function nextMode(id, currentMode) {
        const def = get(id);
        if (!def || def.modes.length < 2) return def?.defaultMode || 'classic';
        const i = def.modes.indexOf(currentMode);
        const idx = i < 0 ? 0 : (i + 1) % def.modes.length;
        return def.modes[idx];
    }

    /**
     * @param {string} id
     * @param {string} [mode]
     * @returns {GameCapabilities}
     */
    function getCapabilities(id, mode) {
        const def = get(id);
        const base = def
            ? { ...DEFAULT_CAPABILITIES, ...def.capabilities }
            : { ...DEFAULT_CAPABILITIES };
        if (mode && def?.capabilitiesByMode?.[mode]) {
            return { ...base, ...def.capabilitiesByMode[mode] };
        }
        return base;
    }

    function auditPathFor(id, mode) {
        const def = get(id);
        if (!def) return null;
        if (def.auditByMode && def.auditByMode[mode]) return def.auditByMode[mode];
        return def.auditConfig || null;
    }

    function mpAuditPathFor(id, mode) {
        const def = get(id);
        if (!def) return null;
        if (def.mpAuditByMode && def.mpAuditByMode[mode]) return def.mpAuditByMode[mode];
        return def.mpAuditConfig || null;
    }

    function buildHostGameSwitchUpdates(roomId, gameId, mode, resetCount) {
        const def = get(gameId);
        const Schema = typeof RtdbSchema !== 'undefined'
            ? RtdbSchema
            : (typeof require !== 'undefined' ? require('../network/rtdb-schema') : null);
        if (Schema) {
            return Schema.buildHostGameSwitchUpdates(
                roomId, gameId, mode, resetCount, def?.globalResetKeys || []
            );
        }
        const updates = {};
        const base = `games/${roomId}`;
        updates[`${base}/global/game`] = gameId;
        updates[`${base}/global/mode`] = mode;
        updates[`${base}/status`] = 'playing';
        updates[`${base}/winner`] = null;
        updates[`${base}/global/turn`] = 'P1';
        updates[`${base}/global/firstPlayer`] = 'P1';
        updates[`${base}/global/resetCount`] = resetCount;
        updates[`${base}/global/board`] = null;
        updates[`${base}/lastMove`] = null;
        updates[`${base}/interactions`] = null;
        updates[`${base}/previews`] = null;
        (def?.globalResetKeys || []).forEach((key) => {
            if (key === 'board') return;
            updates[`${base}/global/${key}`] = null;
        });
        if (def?.clearGameDataOnReset !== false) {
            updates[`gameData/${roomId}`] = null;
        }
        return updates;
    }

    const GameRegistry = {
        DEFAULT_CAPABILITIES,
        list,
        listIds,
        get,
        has,
        defaultId,
        defaultModeFor,
        normalizeMode,
        nextGameId,
        nextMode,
        getCapabilities,
        auditPathFor,
        mpAuditPathFor,
        buildHostGameSwitchUpdates
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameRegistry;
    } else {
        global.GameRegistry = GameRegistry;
    }
})(typeof window !== 'undefined' ? window : global);
