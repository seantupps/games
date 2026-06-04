/**
 * Board-authoritative MP helpers — command/ack, board.seq, warmup gate, ephemeral cleanup.
 * Reference consumer: games/_template/game-board-auth.js, games/bananagrams/modules/mp-*.js
 */
(function (global) {
    const BOARD_VERSION = 2;
    const DEFAULT_ACK_MAX = 128;

    function schema() {
        return global.RtdbSchema || null;
    }

    function readResetCount(room) {
        const S = schema();
        return S?.readResetCount ? S.readResetCount(room) : (room?.global?.resetCount ?? room?.meta?.resetCount ?? 0);
    }

    function readBoard(game, room) {
        if (game?.sync?.readBoard) return game.sync.readBoard(room || game.roomData);
        const snap = room || game?.roomData;
        return snap?.global?.board ?? snap?.state?.board ?? null;
    }

    function ackKey(uid, msg) {
        if (msg?.id) return `${uid}:${msg.id}`;
        return `${uid}:${msg?.type || 'cmd'}:${msg?.at || 0}`;
    }

    function pruneAckMap(ack, max = DEFAULT_ACK_MAX) {
        const keys = Object.keys(ack || {});
        if (keys.length <= max) return ack || {};
        const trimmed = {};
        keys.slice(-max).forEach((k) => { trimmed[k] = true; });
        return trimmed;
    }

    /**
     * Guest → host command channel under interactions/{channel}/{uid}/{id}.
     * Host acks via board[ackField] and clears interaction paths.
     *
     * @param {object} game
     * @param {{ channel?: string, ackField?: string, ackMax?: number }} [opts]
     */
    function createCommandChannel(game, opts = {}) {
        const channel = opts.channel || 'commands';
        const ackField = opts.ackField || 'commandAck';
        const ackMax = opts.ackMax ?? DEFAULT_ACK_MAX;
        const basePath = `interactions/${channel}`;

        if (!game._commandAckLocal) game._commandAckLocal = {};
        if (!game._commandAckHandled) game._commandAckHandled = {};

        function flatten(interactions) {
            const node = interactions?.[channel];
            const out = [];
            if (!node || typeof node !== 'object') return out;
            Object.entries(node).forEach(([uid, bucket]) => {
                if (!bucket || typeof bucket !== 'object') return;
                if (bucket.type) {
                    out.push({ uid, msg: bucket, path: `${basePath}/${uid}` });
                    return;
                }
                Object.entries(bucket).forEach(([key, msg]) => {
                    if (msg && typeof msg === 'object' && msg.type) {
                        out.push({ uid, msg, path: `${basePath}/${uid}/${key}` });
                    }
                });
            });
            return out.sort((a, b) => (a.msg.at || 0) - (b.msg.at || 0));
        }

        function boardAck() {
            return readBoard(game)?.[ackField]
                || game._commandAckLocal
                || {};
        }

        function isAcked(uid, msg) {
            const key = ackKey(uid, msg);
            if (game._commandAckHandled[key]) return true;
            return !!boardAck()[key];
        }

        function isStale(msg) {
            const resetAt = game._resetAcknowledgedAt || 0;
            return !!(resetAt && msg?.at && msg.at < resetAt);
        }

        function clearInteractionPath(path) {
            if (!path) return;
            if (typeof game.broadcast === 'function') {
                game.broadcast(path, null);
            } else if (game.sync?.send) {
                game.sync.send(path, null);
            }
        }

        function ack(uid, msg, path) {
            const key = ackKey(uid, msg);
            game._commandAckHandled[key] = true;
            game._commandAckLocal = pruneAckMap({
                ...game._commandAckLocal,
                [key]: true
            }, ackMax);
            clearInteractionPath(path);
        }

        function mirrorFromBoard(board) {
            const ack = board?.[ackField];
            if (!ack || typeof ack !== 'object') return;
            game._commandAckLocal = { ...ack };
            Object.keys(ack).forEach((k) => {
                game._commandAckHandled[k] = true;
            });
        }

        function send(payload) {
            const uid = game.uid
                || sessionStorage.getItem('game_uid')
                || localStorage.getItem('game_uid');
            if (!uid || !payload?.type) return null;
            const at = Date.now();
            const id = `${at}-${Math.random().toString(36).slice(2, 8)}`;
            const msg = { ...payload, at, id };
            const path = `${basePath}/${uid}/${id}`;
            if (typeof game.broadcast === 'function') {
                game.broadcast(path, msg);
            } else if (game.sync?.send) {
                game.sync.send(path, msg);
            }
            return { msg, path };
        }

        /**
         * Host-only: process pending commands. handler(uid, msg) → 'handled'|'ignore'|'retry'
         * @param {object} interactions — roomData.interactions
         * @param {(uid: string, msg: object) => 'handled'|'ignore'|'retry'} handler
         * @returns {boolean} whether any command was handled (caller may publish board)
         */
        function processHost(interactions, handler) {
            if (!game.isHost?.()) return false;
            let handledAny = false;
            flatten(interactions).forEach(({ uid, msg, path }) => {
                if (isAcked(uid, msg)) {
                    clearInteractionPath(path);
                    return;
                }
                if (isStale(msg)) {
                    ack(uid, msg, path);
                    return;
                }
                const result = handler(uid, msg);
                if (result === 'retry') return;
                ack(uid, msg, path);
                if (result === 'handled') handledAny = true;
            });
            return handledAny;
        }

        return {
            channel,
            ackField,
            send,
            flatten,
            isAcked,
            isStale,
            ack,
            mirrorFromBoard,
            processHost,
            clearInteractionPath
        };
    }

    function shouldApplyIncomingBoard(game, board) {
        if (!board || typeof board !== 'object') return false;
        if ((board.version ?? 0) < BOARD_VERSION) return false;
        const epoch = readResetCount(game.roomData);
        const appliedRc = game._mpAppliedResetCount ?? 0;
        const resetEpoch = epoch > appliedRc;
        if (resetEpoch) return true;
        if (game.sync?.shouldApplyBoard) {
            return game.sync.shouldApplyBoard(appliedRc, epoch, game._boardSeq ?? 0, board);
        }
        const S = schema();
        return S?.shouldApplyBoard
            ? S.shouldApplyBoard(appliedRc, epoch, game._boardSeq ?? 0, board)
            : (board.seq ?? 0) >= (game._boardSeq ?? 0);
    }

    /**
     * Apply board when resetCount/seq allow. Updates _boardSeq and _mpAppliedResetCount.
     * @param {object} game
     * @param {object} board
     * @param {(board: object, opts: object) => void} onApply
     * @param {object} [opts]
     */
    function applyIncomingBoard(game, board, onApply, opts = {}) {
        if (!shouldApplyIncomingBoard(game, board)) {
            return false;
        }
        const epoch = readResetCount(game.roomData);
        const appliedRc = game._mpAppliedResetCount ?? 0;
        const resetEpoch = epoch > appliedRc;
        if (typeof onApply === 'function') {
            onApply(board, { force: !!opts.force || resetEpoch, reset: resetEpoch, ...opts });
        }
        if (board.seq != null) game._boardSeq = board.seq;
        game._mpAppliedResetCount = epoch;
        if (resetEpoch) {
            game._resetAcknowledgedCount = epoch;
            game._resetAcknowledgedAt = game._resetAcknowledgedAt || Date.now();
        }
        return true;
    }

    function nextBoardSeq(game) {
        game._boardSeq = (game._boardSeq ?? 0) + 1;
        return game._boardSeq;
    }

    /**
     * Host-only publish with mandatory board.version and monotonic board.seq.
     * Merges commandAck from game._commandAckLocal when present.
     *
     * @param {object} game
     * @param {object} body — board fields (seq assigned if bumpSeq !== false)
     * @param {{ bumpSeq?: boolean, traceLabel?: string, ackField?: string }} [opts]
     */
    function hostPublishBoard(game, body, opts = {}) {
        if (!game.isHost?.()) {
            console.warn('[MpBoardAuth] hostPublishBoard refused — not host');
            return null;
        }
        const bumpSeq = opts.bumpSeq !== false;
        const ackField = opts.ackField || 'commandAck';
        const prevSeq = game._boardSeq ?? 0;
        const seq = bumpSeq ? nextBoardSeq(game) : (body?.seq ?? prevSeq);

        if (bumpSeq && seq <= prevSeq) {
            throw new Error(`[MpBoardAuth] board.seq must increase (prev=${prevSeq}, next=${seq})`);
        }

        const board = {
            ...body,
            version: BOARD_VERSION,
            seq
        };

        if (game._commandAckLocal && Object.keys(game._commandAckLocal).length) {
            board[ackField] = pruneAckMap({ ...game._commandAckLocal }, opts.ackMax ?? DEFAULT_ACK_MAX);
        }

        if (!game.roomData) game.roomData = {};
        if (!game.roomData.global) game.roomData.global = {};
        game.roomData.global.board = board;
        game._lastPublishedSeq = seq;

        if (typeof game.updateMetadata === 'function') {
            game.updateMetadata({ 'global/board': board });
        } else if (game.sync?.updateRoom) {
            game.sync.updateRoom({ 'global/board': board });
        }

        return board;
    }

    /** Board-authoritative isAuditReady — host seeded board v2; guest applied epoch. */
    function isAuditReady(game) {
        if (!game.identitySynced) return false;
        if (!game.isMultiplayer) return true;

        const board = readBoard(game);
        if (!board || (board.version ?? 0) < BOARD_VERSION) return false;

        if (game.isHost?.()) {
            return board.initialized === true || (board.seq ?? 0) >= 1;
        }

        const epoch = readResetCount(game.roomData);
        if ((game._mpAppliedResetCount ?? 0) < epoch && (board.seq ?? 0) < 1) {
            return false;
        }
        return game._auditReady !== false;
    }

    /**
     * Host warmup gate — true when host must seed global/board before guests play.
     * @param {object} game
     * @param {(board: object|null) => boolean} [isPopulated]
     */
    function hostWarmupBoardNeeded(game, isPopulated) {
        if (!game.isMultiplayer || !game.isHost?.()) return false;
        const board = readBoard(game);
        if (!board || (board.version ?? 0) < BOARD_VERSION) return true;
        if (typeof isPopulated === 'function') return !isPopulated(board);
        return board.initialized !== true && (board.seq ?? 0) < 1;
    }

    /** Clear all ephemeral RTDB keys after host reset or on demand. */
    function clearAllEphemeral(game) {
        const updates = { interactions: null, previews: null };
        if (typeof game.updateMetadata === 'function') {
            game.updateMetadata(updates);
        } else if (game.sync?.updateRoom) {
            game.sync.updateRoom(updates);
        }
    }

    function initBoardAuthState(game) {
        if (game._boardSeq == null) game._boardSeq = 0;
        if (game._mpAppliedResetCount == null) game._mpAppliedResetCount = 0;
        if (!game._commandAckLocal) game._commandAckLocal = {};
        if (!game._commandAckHandled) game._commandAckHandled = {};
    }

    const MpBoardAuth = {
        BOARD_VERSION,
        DEFAULT_ACK_MAX,
        ackKey,
        pruneAckMap,
        createCommandChannel,
        readBoard,
        readResetCount,
        shouldApplyIncomingBoard,
        applyIncomingBoard,
        nextBoardSeq,
        hostPublishBoard,
        isAuditReady,
        hostWarmupBoardNeeded,
        clearAllEphemeral,
        initBoardAuthState
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = MpBoardAuth;
    } else {
        global.MpBoardAuth = MpBoardAuth;
    }
})(typeof window !== 'undefined' ? window : global);
