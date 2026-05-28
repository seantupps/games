/** Bananagrams — mp-network (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-network.js');
    const BANANA_ACK_MAX = 128;

    Object.assign(G.prototype, {
            onNetworkUpdate(data) {
                this._reconcileMpMode();
                if (!this._isMultiplayerMode()) return;
                if (this._doneTraceOn()) {
                    this._traceDoneFlags('onNetworkUpdate-enter');
                }
                this._seedMpAppliedResetFromRoom();
                if (this.isHost()) {
                    this._hostPurgeDepartedPlayers?.();
                    this._maybeSetupMultiplayer();
                }
                const board = this._mpBoardFromRoom(this.roomData);
                if (board?.version >= 2) {
                    this._applyMultiplayerBoard(board, { _traceCaller: 'onNetworkUpdate' });
                }
                if (this.isHost()) {
                    this._processBananaInteractions(data?.interactions?.banana);
                }
                if (this._doneTraceOn()) {
                    this._traceDoneFlags('onNetworkUpdate-exit');
                }
            },

            /** Guest → host command (peel, dump, split, victory-layout). Host acks via board.bananaAck. */
            _sendBananaInteraction(payload) {
                const uid = this._myUid();
                if (!uid || !payload?.type) return;
                const at = Date.now();
                const id = `${at}-${Math.random().toString(36).slice(2, 8)}`;
                const msg = { ...payload, at, id };
                this.broadcast(`interactions/banana/${uid}/${id}`, msg);
            },

            _flattenBananaInteractions(banana) {
                const out = [];
                if (!banana || typeof banana !== 'object') return out;
                Object.entries(banana).forEach(([uid, node]) => {
                    if (!node || typeof node !== 'object') return;
                    if (node.type) {
                        out.push({
                            uid,
                            msg: node,
                            path: `interactions/banana/${uid}`
                        });
                        return;
                    }
                    Object.entries(node).forEach(([key, msg]) => {
                        if (msg && typeof msg === 'object' && msg.type) {
                            out.push({
                                uid,
                                msg,
                                path: `interactions/banana/${uid}/${key}`
                            });
                        }
                    });
                });
                return out.sort((a, b) => (a.msg.at || 0) - (b.msg.at || 0));
            },

            _bananaAckKey(uid, msg) {
                if (msg?.id) return `${uid}:${msg.id}`;
                return `${uid}:${msg.type}:${msg.tileId || ''}:${msg.at || 0}`;
            },

            _isBananaAcked(uid, msg) {
                const key = this._bananaAckKey(uid, msg);
                if (this._bananaHandled?.[key]) return true;
                const boardAck = this.roomData?.global?.board?.bananaAck
                    || this._bananaAck
                    || {};
                return !!boardAck[key];
            },

            _pruneBananaAck(ack) {
                const keys = Object.keys(ack || {});
                if (keys.length <= BANANA_ACK_MAX) return ack || {};
                const trimmed = {};
                keys.slice(-BANANA_ACK_MAX).forEach((k) => {
                    trimmed[k] = true;
                });
                return trimmed;
            },

            _ackBananaInteraction(uid, msg, path) {
                const key = this._bananaAckKey(uid, msg);
                if (!this._bananaHandled) this._bananaHandled = {};
                this._bananaHandled[key] = true;
                this._bananaAck = this._pruneBananaAck({
                    ...(this._bananaAck || {}),
                    [key]: true
                });
                if (path) this.broadcast(path, null);
            },

            _mirrorBananaAckFromBoard(board) {
                if (!board?.bananaAck || typeof board.bananaAck !== 'object') return;
                this._bananaAck = { ...board.bananaAck };
                if (!this._bananaHandled) this._bananaHandled = {};
                Object.keys(board.bananaAck).forEach((k) => {
                    this._bananaHandled[k] = true;
                });
            },

            _processBananaInteractions(banana) {
                if (!this.isHost()) return;
                let ackedNew = false;
                this._flattenBananaInteractions(banana).forEach(({ uid, msg, path }) => {
                    if (this._isBananaAcked(uid, msg)) {
                        if (path) this.broadcast(path, null);
                        return;
                    }
                    const result = this._hostHandleBananaInteraction(uid, msg);
                    if (result === 'retry') {
                        return;
                    }
                    this._ackBananaInteraction(uid, msg, path);
                    ackedNew = true;
                });
                if (ackedNew) {
                    if (this._hostSyncRaf) {
                        cancelAnimationFrame(this._hostSyncRaf);
                        this._hostSyncRaf = 0;
                    }
                    this._hostSyncQueued = true;
                    this._flushHostSyncBoard();
                }
            },

            _bananaInteractKey(uid, msg) {
                return this._bananaAckKey(uid, msg);
            },

            _isBananaHandled(uid, msg) {
                return this._isBananaAcked(uid, msg);
            },

            _markBananaHandled(uid, msg) {
                this._ackBananaInteraction(uid, msg, null);
            }
    });
})(typeof window !== 'undefined' ? window : global);
