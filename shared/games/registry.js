/**
 * Single source of truth for games on the hub + iframe platform.
 * Add a game here first, then games/<id>/, logic module, and tests.
 *
 * RTDB today: games/{roomId}/global/* + gameData/{roomId}/events
 * Target (migration): games/{roomId}/meta + events + state (per-game opaque state blob)
 */
(function (global) {
    /** @typedef {'event-log'|'snapshot'|'hybrid'|'board-authoritative'} SyncStyle */
    /** @typedef {'generic'|'piles'|'line'|'crossword'} BoardKind */
    /**
     * @typedef {'none'|'fit-square'|'piles-dynamic'|'fixed-spiral-anchor'|'pan-zoom-board'} MobileLayoutPolicy
     */

    /**
     * Capability flags — engine/hub branch on these, not game id strings.
     * @typedef {Object} GameCapabilities
     * @property {BoardKind} [boardKind]
     * @property {MobileLayoutPolicy} [mobileLayoutPolicy]
     * @property {boolean} supportsTurnIndicator
     * @property {boolean} [supportsGameTimer] — elapsed clock in iframe HUD (off for simultaneous games)
     * @property {boolean} supportsScoreboard
     * @property {boolean} supportsWinBanner
     * @property {boolean} supportsModes
     * @property {boolean} supportsDragging
     * @property {boolean} [unboundedDrag]
     * @property {boolean} supportsZoom
     * @property {boolean} supportsLongPressEndTurn
     * @property {boolean} [supportsSettingsEdgeSwipe]
     * @property {boolean} [supportsVictoryAutoReset]
     * @property {boolean} supportsRealtimePreviews
     * @property {boolean} supportsPileColors
     * @property {boolean} hasBoardState
     * @property {SyncStyle} syncStyle
     * @property {boolean} [mpBoardAuthoritative] — MP: global/board drives state; skip event-log applyState
     * @property {boolean} [supportsPostGameReview] — review phase, Done in iframe, hub banner clearance
     * @property {boolean} [flexiblePlayerRoles] — party roles P1…Pn (not fixed P1/P2)
     * @property {boolean} [supportsBoardStateInspect] — hub chat can request board-state snapshot
     * @property {number} [winBannerAutoFadeMs] — hub win banner auto-hide (post-game review games)
     * @property {boolean} [auditReadyCallable] — iframe implements isAuditReady(); MP/SP waits use it
     * Guest MP reset: engine calls optional onRemoteReset() then applyBoard(global/board).
     * Host reset: onGameReset() then host pushes global/board via resetGame().
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
        supportsSettingsEdgeSwipe: true,
        supportsVictoryAutoReset: true,
        supportsRealtimePreviews: false,
        supportsPileColors: false,
        hasBoardState: true,
        syncStyle: 'event-log',
        mpBoardAuthoritative: false,
        supportsPostGameReview: false,
        flexiblePlayerRoles: false,
        supportsBoardStateInspect: false
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
     * @property {string} [mobileMpExtras] — optional ptests module with runMobileMpExtras(page1, page2, ctx)
     * @property {'default'|'extended'} [mpSuite] — MP runner tier (`npm run mp` uses default only)
     * @property {number[]} [mpPlayerCounts] — MP audit player counts (default [2])
     * @property {string} [mpAudit3p] — optional custom 3p audit module path (no .js)
     * @property {number} [maxPartyPlayers] — max party size for this game (default 8)
     * @property {boolean} [hideWhenPartyAtLeast] — hide in hub picker when party has this many+ members
     * @property {string} [hubModeInLobby] — iframe mode in lobby (e.g. bananagrams solo)
     * @property {string} [hubModeInParty] — iframe mode in party room (e.g. bananagrams multiplayer)
     * @property {number} [preferredForPartySizeAtLeast] — default picker when party has N+ members
     */

    const DEFAULT_MAX_PARTY = 8;

    /** @type {GameDefinition[]} */
    const GAMES = [
        {
            id: 'piles',
            label: 'Piles',
            logicKey: 'piles',
            maxPartyPlayers: 2,
            mpPlayerCounts: [2],
            hideWhenPartyAtLeast: 3,
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
                classic: 'ptests/games/classic-piles/desktop-sp',
                freestyle: 'ptests/games/freestyle-piles/desktop-sp'
            },
            mpAuditByMode: {
                classic: 'ptests/games/classic-piles/desktop-mp',
                freestyle: 'ptests/games/freestyle-piles/desktop-mp'
            }
        },
        {
            id: 'line',
            label: 'Line',
            logicKey: 'line',
            maxPartyPlayers: 2,
            mpPlayerCounts: [2],
            hideWhenPartyAtLeast: 3,
            modes: ['classic'],
            defaultMode: 'classic',
            capabilities: {
                ...DEFAULT_CAPABILITIES,
                boardKind: 'line',
                mobileLayoutPolicy: 'fit-square',
                supportsDragging: false,
                supportsSettingsEdgeSwipe: false,
                supportsVictoryAutoReset: true,
                supportsRealtimePreviews: true,
                syncStyle: 'hybrid'
            },
            globalResetKeys: ['board'],
            clearGameDataOnReset: true,
            auditConfig: 'ptests/games/line/desktop-sp',
            mpAuditConfig: 'ptests/games/line/desktop-mp'
        },
        {
            id: 'bananagrams',
            label: 'Bananagrams',
            logicKey: 'bananagrams',
            mpSuite: 'extended',
            mpPlayerCounts: [2, 3],
            mpAudit3p: 'ptests/games/bananagrams/desktop-mp/mp_bananagrams_3p',
            modes: ['solo'],
            defaultMode: 'solo',
            maxPartyPlayers: 8,
            hubModeInLobby: 'solo',
            hubModeInParty: 'multiplayer',
            preferredForPartySizeAtLeast: 3,
            capabilities: {
                ...DEFAULT_CAPABILITIES,
                boardKind: 'crossword',
                mobileLayoutPolicy: 'pan-zoom-board',
                viewportPanEnabled: true,
                supportsSettingsEdgeSwipe: false,
                supportsVictoryAutoReset: false,
                supportsDragging: true,
                unboundedDrag: true,
                supportsTurnIndicator: false,
                supportsGameTimer: true,
                supportsScoreboard: true,
                supportsWinBanner: false,
                supportsModes: false,
                supportsZoom: true,
                hasBoardState: true,
                syncStyle: 'event-log',
                flexiblePlayerRoles: true,
                supportsBoardStateInspect: true
            },
            capabilitiesByMode: {
                solo: {
                    supportsWinBanner: true,
                    supportsVictoryAutoReset: false,
                    supportsScoreboard: false
                },
                multiplayer: {
                    supportsWinBanner: true,
                    supportsVictoryAutoReset: false,
                    supportsScoreboard: true,
                    syncStyle: 'board-authoritative',
                    mpBoardAuthoritative: true,
                    supportsPostGameReview: true,
                    winBannerAutoFadeMs: 4000
                }
            },
            globalResetKeys: ['board'],
            clearGameDataOnReset: true,
            auditConfig: 'ptests/games/bananagrams/desktop-sp',
            mobileAuditConfig: 'ptests/games/bananagrams/mobile/bananagrams_sp',
            mpAuditConfig: 'ptests/games/bananagrams/desktop-mp/index',
            mobileMpAuditConfig: 'ptests/games/bananagrams/mobile/bananagrams_mp'
        }
        // NEW_GAME_REGISTRY_INSERT
    ];

    function maxPartyPlayers(id) {
        return get(id)?.maxPartyPlayers ?? DEFAULT_MAX_PARTY;
    }

    /** @param {string} id @returns {number[]} */
    function mpPlayerCountsFor(id) {
        const counts = get(id)?.mpPlayerCounts;
        return Array.isArray(counts) && counts.length ? [...counts] : [2];
    }

    function supportsMpPlayerCount(id, count) {
        return mpPlayerCountsFor(id).includes(count);
    }

    /** @param {string} id @param {number} count */
    function mpAuditPathForPlayerCount(id, mode, count, { mobile = false } = {}) {
        if (count === 3) {
            const custom = get(id)?.mpAudit3p;
            if (custom) return custom;
        }
        return mpAuditPathFor(id, mode, { mobile });
    }

    /** Whether this game should appear in the hub picker for the current party size. */
    function isAvailableForPartySize(id, partySize) {
        const def = get(id);
        if (!def) return false;
        if (partySize > maxPartyPlayers(id)) return false;
        if (def.hideWhenPartyAtLeast != null && partySize >= def.hideWhenPartyAtLeast) return false;
        return true;
    }

    function defaultPartyGameId(partySize) {
        const preferred = GAMES.find(
            (g) => g.preferredForPartySizeAtLeast != null && partySize >= g.preferredForPartySizeAtLeast
        );
        if (preferred) return preferred.id;
        return defaultId();
    }

    /** Hub iframe mode for lobby vs party (uses hubModeInLobby / hubModeInParty when set). */
    function hubModeFor(id, inParty) {
        const def = get(id);
        if (!def) return 'classic';
        if (inParty && def.hubModeInParty) return def.hubModeInParty;
        if (!inParty && def.hubModeInLobby) return def.hubModeInLobby;
        return def.defaultMode;
    }

    function hasCapability(id, capName, mode) {
        return !!getCapabilities(id, mode)[capName];
    }

    /** @param {string} id @param {string} [mode] */
    function boardKindFor(id, mode) {
        return getCapabilities(id, mode).boardKind || 'generic';
    }

    /**
     * Playwright MP ready-wait — branch on boardKind, not game id.
     * @param {object} status — snapshot from multiplayer_base wait loop
     * @param {import('./registry').BoardKind} boardKind
     */
    function auditBoardReady(status, boardKind) {
        if (!status || typeof status !== 'object') return false;
        if (status.auditReady === true) return true;
        switch (boardKind) {
            case 'piles':
                return !!status.hasPiles;
            case 'line':
                return !!status.hasNodes;
            case 'crossword':
                return !!(status.hasTiles && status.started && status.dictReady);
            default:
                return !!(status.hasPiles || status.hasNodes
                    || (status.hasTiles && status.started && status.dictReady));
        }
    }

    /** Games that use hubModeInLobby / hubModeInParty instead of a fixed picker mode. */
    function usesHubModeSwitch(id) {
        const def = get(id);
        return !!(def?.hubModeInLobby || def?.hubModeInParty);
    }

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
        if (def.hubModeInParty && mode === def.hubModeInParty) return def.hubModeInParty;
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
        DEFAULT_MAX_PARTY,
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
        maxPartyPlayers,
        mpPlayerCountsFor,
        supportsMpPlayerCount,
        mpAuditPathForPlayerCount,
        isAvailableForPartySize,
        defaultPartyGameId,
        hubModeFor,
        hasCapability,
        boardKindFor,
        auditBoardReady,
        usesHubModeSwitch,
        buildHostGameSwitchUpdates
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameRegistry;
    } else {
        global.GameRegistry = GameRegistry;
    }
})(typeof window !== 'undefined' ? window : global);
