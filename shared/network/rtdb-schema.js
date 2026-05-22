/**
 * Firebase RTDB layout — single source of truth for room paths.
 *
 * Target layout (direction of travel):
 *   games/{roomId}/
 *     host, status, winner, playerData, users, chat, interactions, previews, lastMove  (room shell)
 *     meta/   — game, mode, turn, firstPlayer, resetCount, stateVersion
 *     state/  — opaque per-game snapshot (board, piecePositions, pileColors, colors, scores, …)
 *     events/ — authoritative move log (event-sourced truth)
 *
 * Legacy (still read + dual-written during migration):
 *   games/{roomId}/global/*
 *   gameData/{roomId}/events
 */
(function (global) {
    const META_KEYS = ['game', 'mode', 'turn', 'firstPlayer', 'resetCount', 'stateVersion'];
    const STATE_BOARD_KEY = 'board';

    const paths = {
        room: (roomId) => `games/${roomId}`,
        meta: (roomId) => `games/${roomId}/meta`,
        metaKey: (roomId, key) => `games/${roomId}/meta/${key}`,
        state: (roomId) => `games/${roomId}/state`,
        stateKey: (roomId, key) => `games/${roomId}/state/${key}`,
        events: (roomId) => `games/${roomId}/events`,
        eventPush: (roomId) => `games/${roomId}/events`,
        legacyGlobal: (roomId) => `games/${roomId}/global`,
        legacyGlobalKey: (roomId, key) => `games/${roomId}/global/${key}`,
        legacyGameData: (roomId) => `gameData/${roomId}`,
        legacyEvents: (roomId) => `gameData/${roomId}/events`,
        chat: (roomId) => `games/${roomId}/chat`,
        playerData: (roomId, uid) => `games/${roomId}/playerData/${uid}`,
        users: (roomId, uid) => `games/${roomId}/users/${uid}`,
        lobbyChat: () => 'lobby/chat'
    };

    /** @deprecated use paths.* */
    const LEGACY = paths;
    const TARGET = { meta: paths.meta, state: paths.state, events: paths.events };

    function isMetaRelativePath(relative) {
        return META_KEYS.includes(relative.replace(/^global\//, ''));
    }

    function parseRelativePath(relative) {
        const r = relative.replace(/^\//, '');
        if (r.startsWith('global/')) {
            const key = r.slice('global/'.length);
            if (META_KEYS.includes(key)) return { zone: 'meta', key };
            return { zone: 'state', key };
        }
        if (r.startsWith('meta/')) return { zone: 'meta', key: r.slice(5) };
        if (r.startsWith('state/')) return { zone: 'state', key: r.slice(6) };
        return { zone: 'room', key: r };
    }

    /**
     * Expand relative engine path to full RTDB paths (dual-write meta/state + legacy global).
     * @returns {Record<string, string>}
     */
    function expandRelativeWrites(roomId, relative, value) {
        const updates = {};
        const parsed = parseRelativePath(relative);
        const room = paths.room(roomId);

        if (parsed.zone === 'meta') {
            updates[paths.metaKey(roomId, parsed.key)] = value;
            updates[paths.legacyGlobalKey(roomId, parsed.key)] = value;
            return updates;
        }

        if (parsed.zone === 'state') {
            updates[paths.stateKey(roomId, parsed.key)] = value;
            updates[paths.legacyGlobalKey(roomId, parsed.key)] = value;
            return updates;
        }

        updates[`${room}/${parsed.key}`] = value;
        return updates;
    }

    /**
     * Normalize raw RTDB room snapshot into shape clients already expect (room.global.*).
     */
    function normalizeRoomSnapshot(raw) {
        if (!raw || typeof raw !== 'object') return raw;

        const meta = { ...(raw.meta || {}) };
        const state = { ...(raw.state || {}) };
        const legacyGlobal = { ...(raw.global || {}) };

        META_KEYS.forEach((k) => {
            if (meta[k] === undefined && legacyGlobal[k] !== undefined) meta[k] = legacyGlobal[k];
        });

        Object.keys(legacyGlobal).forEach((k) => {
            if (META_KEYS.includes(k)) return;
            if (state[k] === undefined) state[k] = legacyGlobal[k];
        });

        const global = {
            ...legacyGlobal,
            ...meta,
            ...state,
            game: meta.game ?? legacyGlobal.game,
            mode: meta.mode ?? legacyGlobal.mode,
            turn: meta.turn ?? legacyGlobal.turn,
            firstPlayer: meta.firstPlayer ?? legacyGlobal.firstPlayer,
            resetCount: meta.resetCount ?? legacyGlobal.resetCount,
            stateVersion: meta.stateVersion ?? legacyGlobal.stateVersion,
            board: state.board ?? legacyGlobal.board ?? null
        };

        return {
            ...raw,
            meta,
            state,
            global
        };
    }

    function readMetaField(room, key) {
        if (!room) return undefined;
        if (room.meta && room.meta[key] !== undefined) return room.meta[key];
        return room.global?.[key];
    }

    /**
     * Host game/mode switch — clears state, resets meta, wipes events (both locations).
     */
    function buildHostGameSwitchUpdates(roomId, gameId, mode, resetCount, extraGlobalResetKeys = []) {
        const updates = {};
        const base = paths.room(roomId);

        updates[`${base}/status`] = 'playing';
        updates[`${base}/winner`] = null;
        updates[`${base}/lastMove`] = null;
        updates[`${base}/interactions`] = null;
        updates[`${base}/previews`] = null;

        META_KEYS.forEach((k) => {
            if (k === 'resetCount') {
                updates[paths.metaKey(roomId, k)] = resetCount;
                updates[paths.legacyGlobalKey(roomId, k)] = resetCount;
                return;
            }
            if (k === 'game') {
                updates[paths.metaKey(roomId, k)] = gameId;
                updates[paths.legacyGlobalKey(roomId, k)] = gameId;
                return;
            }
            if (k === 'mode') {
                updates[paths.metaKey(roomId, k)] = mode;
                updates[paths.legacyGlobalKey(roomId, k)] = mode;
                return;
            }
            if (k === 'turn' || k === 'firstPlayer') {
                updates[paths.metaKey(roomId, k)] = 'P1';
                updates[paths.legacyGlobalKey(roomId, k)] = 'P1';
            }
        });

        // Wipe entire state subtree in one path (avoid state + state/child in same update).
        updates[paths.state(roomId)] = null;
        updates[paths.legacyGlobalKey(roomId, STATE_BOARD_KEY)] = null;

        const keys = new Set([...(extraGlobalResetKeys || [])]);
        keys.forEach((key) => {
            if (key === STATE_BOARD_KEY) return;
            updates[paths.legacyGlobalKey(roomId, key)] = null;
        });

        updates[paths.events(roomId)] = null;
        updates[paths.legacyGameData(roomId)] = null;

        return updates;
    }

    function applyRoomRootPatch(roomId, patch) {
        const updates = {};
        Object.entries(patch).forEach(([rel, val]) => {
            Object.assign(updates, expandRelativeWrites(roomId, rel, val));
        });
        return updates;
    }

    const RtdbSchema = {
        paths,
        LEGACY: paths,
        TARGET,
        META_KEYS,
        STATE_BOARD_KEY,
        parseRelativePath,
        expandRelativeWrites,
        normalizeRoomSnapshot,
        readMetaField,
        buildHostGameSwitchUpdates,
        applyRoomRootPatch,
        relativeGlobal: (key) => `global/${key}`
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = RtdbSchema;
    } else {
        global.RtdbSchema = RtdbSchema;
    }
})(typeof window !== 'undefined' ? window : global);
