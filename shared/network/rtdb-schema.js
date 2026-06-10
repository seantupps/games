/**
 * Firebase RTDB layout — single source of truth for room paths.
 *
 * Canonical storage:
 *   games/{roomId}/state/board  — authoritative game board (MP inventory, review, etc.)
 *   games/{roomId}/meta/*       — game, mode, turn, resetCount, …
 *
 * Client convention (after normalizeRoomSnapshot):
 *   room.global.board           — only path game code should read
 *
 * Legacy (read + migrated on normalize; no dual-write for board):
 *   games/{roomId}/global/board
 */
(function (global) {
    const META_KEYS = ['game', 'mode', 'turn', 'firstPlayer', 'resetCount', 'stateVersion'];
    const STATE_BOARD_KEY = 'board';
    /** RTDB path for board payloads (engine still addresses writes as global/board). */
    const BOARD_STORAGE = 'state';

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
     * Expand relative engine path to RTDB paths (no board dual-write).
     * global/board → games/{roomId}/state/board only.
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
            // Drop stale legacy global/board so reads do not prefer an old higher-seq copy.
            if (parsed.key === STATE_BOARD_KEY || String(parsed.key).startsWith(`${STATE_BOARD_KEY}/`)) {
                updates[paths.legacyGlobalKey(roomId, STATE_BOARD_KEY)] = null;
            }
            return updates;
        }

        updates[`${room}/${parsed.key}`] = value;
        return updates;
    }

    /** resetCount is the room epoch; board.seq is meaningful only within that epoch. */
    function readResetCount(room) {
        if (!room || typeof room !== 'object') return 0;
        return room.global?.resetCount ?? room.meta?.resetCount ?? 0;
    }

    /**
     * Whether an incoming board should be applied (same rules as merge).
     */
    function shouldApplyBoard(cachedResetCount, incomingResetCount, cachedBoardSeq, incomingBoard, cachedStartedAt) {
        if (!incomingBoard || typeof incomingBoard !== 'object') return false;
        const inRc = incomingResetCount ?? 0;
        const cRc = cachedResetCount ?? 0;
        if (inRc > cRc) return true;
        if (inRc < cRc) return false;
        const incSeq = incomingBoard.seq ?? 0;
        const cSeq = cachedBoardSeq ?? 0;
        if (incSeq >= cSeq) return true;
        const incStarted = incomingBoard.startedAt ?? 0;
        const prevStarted = cachedStartedAt ?? 0;
        return incStarted > 0 && incStarted > prevStarted;
    }

    /** Per-player nested board fields — never replace a non-empty hand with an empty RTDB partial. */
    function mergePerPlayerBoardField(prevObj, incObj) {
        const out = { ...(prevObj || {}) };
        if (!incObj || typeof incObj !== 'object') return out;
        Object.entries(incObj).forEach(([uid, val]) => {
            if (val === undefined) return;
            if (Array.isArray(val) && val.length === 0
                && Array.isArray(out[uid]) && out[uid].length > 0) {
                return;
            }
            out[uid] = val;
        });
        return out;
    }

    /** Per-player inventorySeq — take the higher seq per uid (monotonic within epoch). */
    function mergePerPlayerInventorySeq(prevObj, incObj) {
        const out = { ...(prevObj || {}) };
        if (!incObj || typeof incObj !== 'object') return out;
        Object.entries(incObj).forEach(([uid, seq]) => {
            if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
            out[uid] = Math.max(out[uid] ?? 0, seq);
        });
        return out;
    }

    function mergeBoardInventoryFields(prevBoard, incBoard, merged) {
        if (!merged || typeof merged !== 'object') return merged;
        const prev = prevBoard || {};
        const inc = incBoard || {};
        if (prev.tilesOwnedByPlayer || inc.tilesOwnedByPlayer) {
            merged.tilesOwnedByPlayer = mergePerPlayerBoardField(
                prev.tilesOwnedByPlayer,
                inc.tilesOwnedByPlayer
            );
        }
        if (prev.hands || inc.hands) {
            merged.hands = mergePerPlayerBoardField(prev.hands, inc.hands);
        }
        if (prev.inventorySeq || inc.inventorySeq) {
            merged.inventorySeq = mergePerPlayerInventorySeq(
                prev.inventorySeq,
                inc.inventorySeq
            );
        }
        if (prev.tilePositionsByPlayer || inc.tilePositionsByPlayer) {
            merged.tilePositionsByPlayer = mergePerPlayerBoardField(
                prev.tilePositionsByPlayer,
                inc.tilePositionsByPlayer
            );
        }
        if (prev.layoutSeq || inc.layoutSeq) {
            merged.layoutSeq = mergePerPlayerInventorySeq(prev.layoutSeq, inc.layoutSeq);
        }
        if (merged.tilesOwnedByPlayer) {
            delete merged.hands;
        }
        return merged;
    }

    /**
     * Pick merged board: newer resetCount wins; same epoch → higher board.seq wins.
     * Legacy: partial reviewDone-only payloads (unused by Bananagrams MP; kept for old RTDB snapshots).
     */
    function pickBoardForEpoch(prevBoard, incBoard, cachedResetCount, incomingResetCount) {
        if (!incBoard || typeof incBoard !== 'object') return prevBoard;
        if (!prevBoard || typeof prevBoard !== 'object') return incBoard;
        const inRc = incomingResetCount ?? 0;
        const pRc = cachedResetCount ?? 0;
        if (inRc > pRc) return incBoard;
        if (inRc < pRc) return prevBoard;
        if (inRc === pRc && incBoard.seq == null && incBoard.reviewDone && !incBoard.tilesOwnedByPlayer) {
            return {
                ...prevBoard,
                reviewDone: { ...(prevBoard.reviewDone || {}), ...incBoard.reviewDone }
            };
        }
        const prevSeq = prevBoard.seq ?? 0;
        const incSeq = incBoard.seq ?? 0;
        const prevStarted = prevBoard.startedAt ?? 0;
        const incStarted = incBoard.startedAt ?? 0;
        const prevReview = prevBoard.phase === 'review' || prevBoard.reviewPhase === true;
        const incReview = incBoard.phase === 'review' || incBoard.reviewPhase === true;
        if (incSeq === prevSeq && prevReview && !incReview) {
            return prevBoard;
        }
        // Same-epoch soft reset: seq restarts on redeals but startedAt advances at SPLIT.
        if (incSeq < prevSeq && incStarted > 0 && incStarted > prevStarted) {
            const merged = { ...prevBoard, ...incBoard };
            merged.boardRevision = Math.max(
                prevBoard.boardRevision ?? 0,
                incBoard.boardRevision ?? 0
            );
            return mergeBoardInventoryFields(prevBoard, incBoard, merged);
        }
        if (incSeq >= prevSeq) {
            if (incStarted > 0 && prevStarted > 0 && incStarted < prevStarted) {
                return prevBoard;
            }
            const merged = { ...prevBoard, ...incBoard };
            const prevPlayingReset = prevBoard.phase === 'playing'
                && prevBoard.reviewPhase !== true
                && !prevBoard.winnerUid
                && (prevBoard.reviewEpoch ?? 0) === 0;
            const incReview = incBoard.phase === 'review' || incBoard.reviewPhase === true;
            if (prevPlayingReset && incReview) {
                const closed = prevBoard.reviewEpochClosed ?? 0;
                if ((incBoard.reviewEpoch ?? 0) <= closed) {
                    return prevBoard;
                }
            }
            if (incBoard.phase === 'playing' && incBoard.reviewPhase !== true) {
                merged.winnerUid = incBoard.winnerUid ?? null;
                if (!incBoard.reviewLayouts) {
                    delete merged.reviewLayouts;
                    delete merged.reviewLayoutsOrig;
                }
            }
            merged.boardRevision = Math.max(
                prevBoard.boardRevision ?? 0,
                incBoard.boardRevision ?? 0
            );
            return mergeBoardInventoryFields(prevBoard, incBoard, merged);
        }
        return prevBoard;
    }

    function boardFromRawRoom(raw) {
        if (!raw || typeof raw !== 'object') return null;
        return raw.state?.board ?? raw.global?.board ?? null;
    }

    /**
     * Resolve one canonical board from raw RTDB (state/board preferred, legacy global/board merged by epoch).
     */
    function resolveCanonicalBoard(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const meta = { ...(raw.meta || {}) };
        const legacyGlobal = { ...(raw.global || {}) };
        const state = { ...(raw.state || {}) };
        META_KEYS.forEach((k) => {
            if (meta[k] === undefined && legacyGlobal[k] !== undefined) meta[k] = legacyGlobal[k];
        });
        const rc = meta.resetCount ?? legacyGlobal.resetCount ?? 0;
        const stateBoard = state.board;
        const legacyBoard = legacyGlobal.board;
        // state/board is canonical; legacy global/board is read-compat only and may lag in-memory.
        if (stateBoard) return stateBoard;
        return legacyBoard ?? null;
    }

    /**
     * Merge board from prev + incoming partial room payloads into one snapshot.
     */
    function mergeRoomBoard(prev, incoming) {
        const prevRc = readResetCount(prev);
        const incRc = readResetCount(incoming);
        const prevBoard = boardFromRawRoom(prev) ?? prev?.global?.board;
        const incBoard = boardFromRawRoom(incoming) ?? incoming?.global?.board;
        return pickBoardForEpoch(prevBoard, incBoard, prevRc, incRc);
    }

    /**
     * Normalize raw RTDB room snapshot: games read room.global.board only.
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
            if (k === STATE_BOARD_KEY) return;
            if (state[k] === undefined) state[k] = legacyGlobal[k];
        });

        const board = resolveCanonicalBoard(raw);

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
            board
        };

        if (board != null) {
            state.board = board;
        }

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

    /** Games: read board only from normalized room.global.board. */
    function readBoardFromRoom(room) {
        if (!room) return null;
        return normalizeRoomSnapshot(room).global?.board ?? null;
    }

    function setCanonicalBoardOnRoom(room, board) {
        if (!room) return room;
        const norm = normalizeRoomSnapshot(room);
        norm.global.board = board;
        if (norm.state) norm.state.board = board;
        return norm;
    }

    /**
     * Host game/mode switch — clears state, resets meta, wipes events.
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
        BOARD_STORAGE,
        parseRelativePath,
        expandRelativeWrites,
        normalizeRoomSnapshot,
        readMetaField,
        readResetCount,
        shouldApplyBoard,
        pickBoardForEpoch,
        mergeRoomBoard,
        resolveCanonicalBoard,
        readBoardFromRoom,
        setCanonicalBoardOnRoom,
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
