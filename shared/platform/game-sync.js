/**
 * Game sync facade.
 *
 * This is the narrow runtime boundary between games/BaseGame and the hub/network.
 * Existing game code can keep using BaseGame.broadcast/updateMetadata/submitMove,
 * but those calls now pass through one place with explicit sync policy.
 */
(function (global) {
    function registry() {
        return typeof global.GameRegistry !== 'undefined' ? global.GameRegistry : null;
    }

    function schema() {
        return typeof global.RtdbSchema !== 'undefined' ? global.RtdbSchema : null;
    }

    function capabilitiesFor(game) {
        if (game?.capabilities) return game.capabilities;
        const reg = registry();
        return reg?.getCapabilities
            ? reg.getCapabilities(game?.gameName || 'unknown', game?.mode || 'classic')
            : {};
    }

    function syncStyleFor(game) {
        return capabilitiesFor(game)?.syncStyle || 'event-log';
    }

    function readBoard(game, room) {
        const S = schema();
        const snap = room || game?.roomData;
        if (!snap) return null;
        return S?.readBoardFromRoom ? S.readBoardFromRoom(snap) : snap.global?.board ?? snap.state?.board ?? null;
    }

    function isSnapshotAuthoritative(game, board = readBoard(game)) {
        const style = syncStyleFor(game);
        if (style === 'snapshot') return true;
        if (style === 'hybrid') return !!board && capabilitiesFor(game)?.hasBoardState !== false;
        return !!board && game?.gameName === 'bananagrams' && board.version >= 2;
    }

    function mergeRoomSnapshot(prev, incoming) {
        if (!incoming || typeof incoming !== 'object') return prev;
        if (!prev || typeof prev !== 'object') return incoming;
        const hasPayload = incoming.global || incoming.state || incoming.meta
            || incoming.playerData || incoming.interactions || incoming.previews;
        if (!hasPayload) return incoming;

        const merged = { ...prev, ...incoming };
        if (prev.meta || incoming.meta) merged.meta = { ...(prev.meta || {}), ...(incoming.meta || {}) };
        if (prev.global || incoming.global) merged.global = { ...(prev.global || {}), ...(incoming.global || {}) };
        if (prev.state || incoming.state) merged.state = { ...(prev.state || {}), ...(incoming.state || {}) };
        if (incoming.playerData != null) {
            merged.playerData = { ...incoming.playerData };
        } else if (prev.playerData) {
            merged.playerData = { ...prev.playerData };
        }
        if (prev.interactions || incoming.interactions) {
            merged.interactions = { ...(prev.interactions || {}), ...(incoming.interactions || {}) };
        }
        if (incoming.interactions === null) merged.interactions = null;
        if (incoming.previews === null) merged.previews = null;
        else if (prev.previews || incoming.previews) {
            merged.previews = { ...(prev.previews || {}), ...(incoming.previews || {}) };
        }

        const S = schema();
        if (S?.mergeRoomBoard) {
            const picked = S.mergeRoomBoard(prev, incoming);
            if (picked !== undefined) {
                merged.global = merged.global || {};
                merged.global.board = picked;
                merged.state = merged.state || {};
                merged.state.board = picked;
            }
        }

        return S?.normalizeRoomSnapshot ? S.normalizeRoomSnapshot(merged) : merged;
    }

    function sendNetwork(path, payload) {
        global.parent.postMessage({ type: 'network-send', path, payload }, '*');
    }

    function updateRoom(updates) {
        const sanitize = (value) => {
            if (value === undefined) return undefined;
            if (Array.isArray(value)) {
                return value.map((item) => {
                    const clean = sanitize(item);
                    return clean === undefined ? null : clean;
                });
            }
            if (value && typeof value === 'object') {
                const out = {};
                Object.entries(value).forEach(([key, child]) => {
                    const clean = sanitize(child);
                    if (clean !== undefined) out[key] = clean;
                });
                return out;
            }
            return value;
        };
        const parent = global.parent;
        const canWriteDirect =
            parent
            && parent !== global
            && parent.NetworkEngine?.isInitialized
            && parent.NetworkEngine?.roomId
            && parent.NetworkEngine.roomId !== 'lobby'
            && parent.RtdbSchema?.expandRelativeWrites;
        if (canWriteDirect) {
            const multiUpdates = {};
            Object.entries(updates || {}).forEach(([key, val]) => {
                const clean = sanitize(val);
                Object.assign(
                    multiUpdates,
                    parent.RtdbSchema.expandRelativeWrites(parent.NetworkEngine.roomId, key, clean)
                );
            });
            if (updates?.['global/resetCount'] !== undefined) {
                multiUpdates[parent.RtdbSchema.paths.legacyGameData(parent.NetworkEngine.roomId)] = null;
                multiUpdates[parent.RtdbSchema.paths.events(parent.NetworkEngine.roomId)] = null;
            }
            parent.NetworkEngine.db.ref().update(multiUpdates).catch((err) => {
                console.warn('[GameSync] direct room update failed; falling back to hub message', err?.message || err);
                parent.postMessage({ type: 'network-update-room', updates }, '*');
            });
            return;
        }
        global.parent.postMessage({ type: 'network-update-room', updates }, '*');
    }

    function sendEvent(game, event) {
        global.parent.postMessage({
            type: 'network-send-event',
            event: {
                ...event,
                resetCount: event?.resetCount ?? game?._currentResetRound?.() ?? 1
            }
        }, '*');
    }

    function buildHostResetUpdates(game, { wasOver = false } = {}) {
        if (!game) return {};
        if (wasOver) {
            const prevFirstPlayer = game.firstPlayer || 'P1';
            game.firstPlayer = prevFirstPlayer === 'P1' ? 'P2' : 'P1';
            console.log(`HOST: Alternating first player for the next game. Prev: ${prevFirstPlayer}, Next: ${game.firstPlayer}`);
        } else if (!game.firstPlayer) {
            game.firstPlayer = 'P1';
        }

        const startTurn = game.firstPlayer;
        const resetCount = (game.roomData?.global?.resetCount || 0) + 1;
        const updates = {
            status: 'playing',
            winner: null,
            'global/firstPlayer': game.firstPlayer,
            'global/turn': startTurn,
            'global/resetCount': resetCount
        };

        const board = typeof game.serializeBoard === 'function' ? game.serializeBoard() : null;
        updates['global/board'] = capabilitiesFor(game)?.hasBoardState !== false ? board : null;

        const reg = registry()?.get ? registry().get(game.gameName) : null;
        (reg?.globalResetKeys || ['piecePositions', 'colors', 'pileColors']).forEach((key) => {
            if (key !== 'board') updates[`global/${key}`] = null;
        });

        if (typeof game.getExtraGlobalReset === 'function') {
            Object.assign(updates, game.getExtraGlobalReset() || {});
        }

        updates.lastMove = null;
        updates.interactions = null;

        game.turn = startTurn;
        game.lastResetCount = resetCount;
        game._resetAcknowledgedCount = resetCount;
        game._resetAcknowledgedAt = Date.now();
        return updates;
    }

    function attachGameSync(game) {
        if (!game || game.sync) return game?.sync || null;
        const sync = {
            syncStyle: () => syncStyleFor(game),
            capabilities: () => capabilitiesFor(game),
            readBoard: (room) => readBoard(game, room),
            isSnapshotAuthoritative: (board) => isSnapshotAuthoritative(game, board),
            mergeRoomSnapshot,
            shouldApplyBoard: (cachedResetCount, incomingResetCount, cachedBoardSeq, incomingBoard) => {
                const S = schema();
                return S?.shouldApplyBoard
                    ? S.shouldApplyBoard(cachedResetCount, incomingResetCount, cachedBoardSeq, incomingBoard)
                    : true;
            },
            send: sendNetwork,
            updateRoom,
            sendEvent: (event) => sendEvent(game, event),
            buildHostResetUpdates: (opts) => buildHostResetUpdates(game, opts)
        };
        game.sync = sync;
        return sync;
    }

    const GameSync = {
        attachGameSync,
        capabilitiesFor,
        syncStyleFor,
        readBoard,
        isSnapshotAuthoritative,
        mergeRoomSnapshot,
        sendNetwork,
        updateRoom,
        sendEvent,
        buildHostResetUpdates
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameSync;
    } else {
        global.GameSync = GameSync;
    }
})(typeof window !== 'undefined' ? window : global);
