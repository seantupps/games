/** Bananagrams — MP inventory transactions (host authority). Requires game.js + mp-seq.js first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) {
        console.error('[Bananagrams] mp-transactions.js skipped — BananagramsGame missing');
        return;
    }

    const dumpDrawCount = () => (
        typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3
    );

    Object.assign(G.prototype, {
            _mpUniqueOwnedIds(owned) {
                const ids = (owned || []).map((t) => t?.id).filter(Boolean);
                return new Set(ids).size === ids.length;
            },

            _mpUniqueIdList(ids) {
                const list = (ids || []).filter(Boolean);
                return new Set(list).size === list.length;
            },

            /** Host: every deal id owned by at most one player (authority partition). */
            _mpGlobalOwnedIdSet() {
                const out = new Set();
                const addId = (id) => {
                    if (!id) return;
                    if (this._mpIdPoolActive && !this._mpIdMatchesDealEpoch?.(id)) return;
                    out.add(id);
                };
                Object.values(this._mpOwned || {}).forEach((list) => {
                    (list || []).forEach((t) => addId(t?.id));
                });
                return out;
            },

            /** Host: validate dump inventory mutation before publishing board. */
            _hostValidateDumpTxn(txn, owned) {
                if (!txn || !owned?.length) return false;
                const drawCount = dumpDrawCount();
                if (owned.some((t) => t.id === txn.dumpedTileId)) return false;
                if (!Array.isArray(txn.addedTileIds) || txn.addedTileIds.length !== drawCount) {
                    return false;
                }
                if (!this._mpUniqueIdList(txn.addedTileIds)) return false;
                if (!this._mpUniqueOwnedIds(owned)) return false;
                if (typeof txn.beforeInventorySeq !== 'number'
                    || typeof txn.afterInventorySeq !== 'number'
                    || txn.afterInventorySeq !== txn.beforeInventorySeq + 1) {
                    return false;
                }
                if (typeof txn.beforeOwnedLen === 'number'
                    && owned.length !== txn.beforeOwnedLen + 2) {
                    return false;
                }
                return txn.addedTileIds.every((id) => owned.some((t) => t.id === id));
            },

            /**
             * Host: validate initial deal before publishing board.
             * Conservation: sum(owned) + pool === materialized deck size.
             */
            _hostValidateDealTxn(txn) {
                if (!txn || !Array.isArray(txn.uids) || txn.uids.length < 2) return false;
                const hands = txn.tilesOwnedByPlayer || {};
                const handSize = txn.handSize || 0;
                if (!handSize) return false;
                const allDealt = txn.uids.every(
                    (uid) => Array.isArray(hands[uid]) && hands[uid].length === handSize
                );
                if (!allDealt) return false;
                const ownedIds = [];
                txn.uids.forEach((uid) => {
                    (hands[uid] || []).forEach((t) => { if (t?.id) ownedIds.push(t.id); });
                });
                if (!this._mpUniqueOwnedIds(ownedIds.map((id) => ({ id })))) return false;
                const pool = Array.isArray(txn.pool) ? txn.pool : [];
                const ownedTotal = ownedIds.length;
                const poolLen = pool.length;
                const total = ownedTotal + poolLen;
                if (typeof txn.deckSize === 'number' && total !== txn.deckSize) return false;
                const seqOk = txn.uids.every((uid) => (txn.inventorySeq?.[uid] ?? 0) === 1);
                if (!seqOk) return false;
                return true;
            },

            _hostDealTxnFailureReason(txn) {
                if (!txn || !Array.isArray(txn.uids) || txn.uids.length < 2) return 'uids';
                const hands = txn.tilesOwnedByPlayer || {};
                const handSize = txn.handSize || 0;
                if (!handSize) return 'handSize';
                const lens = Object.fromEntries(
                    txn.uids.map((uid) => [uid, (hands[uid] || []).length])
                );
                if (!txn.uids.every((uid) => (hands[uid] || []).length === handSize)) {
                    return `allDealt:${JSON.stringify(lens)}`;
                }
                const ownedIds = [];
                txn.uids.forEach((uid) => {
                    (hands[uid] || []).forEach((t) => { if (t?.id) ownedIds.push(t.id); });
                });
                if (!this._mpUniqueOwnedIds(ownedIds.map((id) => ({ id })))) return 'unique-owned';
                const pool = Array.isArray(txn.pool) ? txn.pool : [];
                const total = ownedIds.length + pool.length;
                if (typeof txn.deckSize === 'number' && total !== txn.deckSize) {
                    return `conservation:${total}!=${txn.deckSize}`;
                }
                const seq = txn.inventorySeq || {};
                if (!txn.uids.every((uid) => (seq[uid] ?? 0) === 1)) {
                    return `inventorySeq:${JSON.stringify(seq)}`;
                }
                return null;
            },

            /** Host: validate split txn before publish. */
            _hostValidateSplitTxn(txn) {
                if (!txn || txn.type !== 'SPLIT') return false;
                if (typeof txn.resetCount !== 'number' || txn.resetCount < 0) return false;
                if (typeof txn.startedAt !== 'number' || txn.startedAt <= 0) return false;
                if (typeof txn.afterBoardSeq !== 'number' || txn.afterBoardSeq <= 0) return false;
                return true;
            },

            /** Playing lifecycle — pre-split deal vs post-split play vs idle. */
            _mpLifecyclePhase(board) {
                if (!board) return 'idle';
                if (board.phase === BananagramsGame.MP_PHASE.REVIEW) return 'review';
                if (board.started && !board.gameStarted) return 'pre-split';
                if (board.gameStarted) return 'playing';
                if (board.started) return 'pre-split';
                return 'idle';
            },

            _countBoardOwned(board) {
                const hands = board?.tilesOwnedByPlayer || {};
                return Object.values(hands).reduce(
                    (n, list) => n + (Array.isArray(list) ? list.length : 0),
                    0
                );
            },

            /** Guest: hand/party conservation. Host: pool + owned (live authority). */
            _assertGlobalTileConservation(board, ctx = 'conservation') {
                if (!board) return true;
                const uid = this._myUid?.();
                const ownedTotal = this._countBoardOwned(board);
                const localTiles = this.tiles?.length ?? 0;
                const handUnique = new Set((this.tiles || []).map((t) => t?.id).filter(Boolean)).size;
                const myOwned = uid
                    ? (board.tilesOwnedByPlayer?.[uid] || []).length
                    : 0;
                let ok = true;

                if (this.isHost?.()) {
                    const poolLen = Array.isArray(board.pool) ? board.pool.length : 0;
                    const localPool = this._tilePool?.length ?? 0;
                    if (poolLen !== localPool) {
                        this._logInventoryProjectionFailure?.('pool-drift', board, uid, {
                            ctx,
                            boardPool: poolLen,
                            localPool
                        });
                        ok = false;
                    }
                } else if (uid && myOwned > 0 && (localTiles !== myOwned || handUnique !== myOwned)) {
                    this._logInventoryProjectionFailure?.('owned-tiles-drift', board, uid, {
                        ctx,
                        myOwned,
                        localTiles,
                        handUnique
                    });
                    ok = false;
                }

                if (typeof board.handSize === 'number' && board.playerUids?.length) {
                    const minDealt = board.handSize * board.playerUids.length;
                    if (ownedTotal > 0 && ownedTotal < minDealt) {
                        this._logInventoryProjectionFailure?.('partial-party-owned', board, uid, {
                            ctx,
                            ownedTotal,
                            minDealt
                        });
                        ok = false;
                    }
                }
                return ok;
            },

            /**
             * Guest: after _applyBoardPoolOnce, _tilePool must match wire board.pool (eager mirror).
             */
            _assertGuestPoolCacheMirrored(board, ctx = 'pool-cache') {
                if (!board || this.isHost?.()) return true;
                const wireLen = Array.isArray(board.pool) ? board.pool.length : null;
                if (wireLen == null) return true;
                const cacheLen = this._tilePool?.length ?? 0;
                if (wireLen === cacheLen) return true;
                this._logInventoryProjectionFailure?.('pool-cache-drift', board, this._myUid?.(), {
                    ctx,
                    boardPool: wireLen,
                    cachePool: cacheLen
                });
                return false;
            },

            /** Host: validate peel — one tile per active player, pool decreases accordingly. */
            _hostValidatePeelTxn(txn, ownedByUid) {
                if (!txn || !ownedByUid || typeof ownedByUid !== 'object') return false;
                const party = txn.partyUids || Object.keys(ownedByUid);
                if (!party.length) return false;
                const drawn = txn.drawnIds || {};
                if (Object.keys(drawn).length !== party.length) return false;
                if (typeof txn.beforePoolLen !== 'number' || typeof txn.afterPoolLen !== 'number') {
                    return false;
                }
                if (txn.afterPoolLen !== txn.beforePoolLen - party.length) return false;
                if (typeof txn.peelSeq !== 'number') return false;
                const beforeInv = txn.beforeInventorySeq || {};
                const afterInv = txn.afterInventorySeq || {};
                if (!party.every((uid) => {
                    const addedId = drawn[uid];
                    if (!addedId) return false;
                    const owned = ownedByUid[uid] || [];
                    if (!owned.some((t) => t.id === addedId)) return false;
                    if (!this._mpUniqueOwnedIds(owned)) return false;
                    const before = beforeInv[uid];
                    const after = afterInv[uid];
                    if (typeof before !== 'number' || typeof after !== 'number') return false;
                    return after === before + 1;
                })) return false;
                return true;
            },

            /** Dev/test: assert projected tiles match authority after apply. */
            _assertClientInventoryProjection(board, uid, ctx = 'assert') {
                if (!board || !uid) return true;
                if (this.isHost?.() && uid === this._myUid?.()
                    && this.gameStarted && this.canMutatePlayingBoard?.()
                    && !this._reviewUiActive?.()) {
                    const live = this._hostLiveInventorySeq?.(uid) ?? 0;
                    const client = this._mpClientInventorySeq?.(uid) ?? 0;
                    const local = this._localInventorySeq || 0;
                    if (live !== client || live !== local) {
                        this._logInventoryProjectionFailure?.('host-inventory-counter-drift', board, uid, {
                            ctx,
                            live,
                            local,
                            client,
                            wire: this._boardInventorySeq(board, uid)
                        });
                        return false;
                    }
                }
                const owned = this.isHost?.() && uid === this._myUid?.()
                    && this.gameStarted && this.canMutatePlayingBoard?.()
                    && !this._reviewUiActive?.()
                    ? (this._mpNormalizeBoardOwned?.(this._mpOwned?.[uid]) || this._mpOwned?.[uid] || [])
                    : (board.tilesOwnedByPlayer?.[uid] || []);
                const ownedNorm = this._mpNormalizeBoardOwned?.(owned) || owned;
                const tilesLen = this.tiles?.length ?? 0;
                const ownedLen = ownedNorm.length;
                if (this._mpInventorySeqLag?.(board, uid)) {
                    this._logInventoryProjectionFailure?.('seq-lag-after-apply', board, uid, {
                        ctx,
                        remote: this._boardInventorySeq(board, uid),
                        local: this._mpClientInventorySeq?.(uid),
                        ownedLen,
                        tilesLen
                    });
                    return false;
                }
                if (ownedLen > 0 && !this._verifyInventoryMembership?.(ownedNorm, this.tiles)) {
                    this._logInventoryProjectionFailure?.('membership-drift-after-apply', board, uid, {
                        ctx,
                        ownedLen,
                        tilesLen
                    });
                    return false;
                }
                return true;
            },

            /**
             * Guest: reject partial RTDB merges where action/inventory seq advanced
             * but tilesOwnedByPlayer still reflects pre-action membership.
             */
            _isBoardInventorySnapshotConsistent(board, uid, owned) {
                if (typeof this._isBoardDumpBundleCoherent === 'function'
                    && !this._isBoardDumpBundleCoherent(board)) {
                    return false;
                }
                if (typeof this._isBoardPeelBundleCoherent === 'function'
                    && !this._isBoardPeelBundleCoherent(board)) {
                    return false;
                }
                if (typeof this._isBoardSplitBundleCoherent === 'function'
                    && !this._isBoardSplitBundleCoherent(board)) {
                    return false;
                }
                const list = owned || [];
                const remote = this._boardInventorySeq(board, uid);
                const localSeq = this._mpClientInventorySeq?.(uid) ?? 0;
                const phase = this._mpLifecyclePhase?.(board) || 'idle';
                const inPlay = phase === 'pre-split' || phase === 'playing';

                if (!list.length) {
                    if (!this.isHost?.() && inPlay && remote > localSeq) {
                        return false;
                    }
                    if (!this.isHost?.() && inPlay && (this.tiles?.length > 0)) return false;
                    return true;
                }
                if (!this._mpUniqueOwnedIds(list)) return false;

                if (this.isHost?.()) return true;

                if (remote <= localSeq) return true;

                const runtimeLen = this.tiles?.length || 0;
                if (runtimeLen > 0 && list.length < runtimeLen) {
                    return false;
                }

                const txn = board?.lastDumpTxn;
                if (txn && txn.actorUid === uid && txn.afterInventorySeq === remote) {
                    const drawCount = dumpDrawCount();
                    const ownedIds = new Set(list.map((o) => o.id));
                    if (list.some((o) => o.id === txn.dumpedTileId)) return false;
                    if (!Array.isArray(txn.addedTileIds) || txn.addedTileIds.length !== drawCount) {
                        return false;
                    }
                    if (!txn.addedTileIds.every((id) => ownedIds.has(id))) return false;
                    if (typeof txn.beforeOwnedLen === 'number'
                        && list.length !== txn.beforeOwnedLen + 2) {
                        return false;
                    }
                }

                return true;
            },

            /**
             * Guest system boundary — after authority apply, unique hand ids must equal
             * board.tilesOwnedByPlayer[uid].length, match membership exactly, satisfy dump
             * txn coupling when lastDumpTxn applies at inventorySeq, and conserve pool.
             * Failure blocks commit (caller rolls back localInventorySeq).
             */
            _assertGuestInventoryBoundary(board, uid, ctx = 'boundary') {
                if (!board || !uid || this.isHost?.()) return true;

                const ownedRaw = board.tilesOwnedByPlayer?.[uid] || [];
                const owned = this._mpNormalizeBoardOwned?.(ownedRaw) || ownedRaw;
                const remote = this._boardInventorySeq(board, uid) ?? 0;
                const localSeq = this._mpClientInventorySeq?.(uid) ?? 0;
                const tiles = this.tiles || [];
                const uniqueIds = new Set(tiles.map((t) => t?.id).filter(Boolean));

                if (uniqueIds.size !== tiles.length) {
                    this._logInventoryProjectionFailure?.('boundary-duplicate-runtime-ids', board, uid, {
                        ctx,
                        tilesLen: tiles.length,
                        handUnique: uniqueIds.size
                    });
                    return false;
                }

                const ownedLen = owned.length;
                if (ownedLen > 0 && uniqueIds.size !== ownedLen) {
                    this._logInventoryProjectionFailure?.('boundary-owned-count-mismatch', board, uid, {
                        ctx,
                        ownedLen,
                        handUnique: uniqueIds.size,
                        handLen: tiles.length
                    });
                    return false;
                }

                if (ownedLen > 0 && !this._verifyInventoryMembership?.(owned, tiles)) {
                    this._logInventoryProjectionFailure?.('boundary-membership-mismatch', board, uid, {
                        ctx,
                        ownedLen,
                        tilesLen: tiles.length
                    });
                    return false;
                }

                if (localSeq !== remote) {
                    this._logInventoryProjectionFailure?.('boundary-seq-not-synced', board, uid, {
                        ctx,
                        remote,
                        localSeq
                    });
                    return false;
                }

                const txn = board.lastDumpTxn;
                const dumpSeq = board.dumpSeq || 0;
                const dumpJustApplied = txn
                    && txn.actorUid === uid
                    && (txn.dumpSeq ?? dumpSeq) === dumpSeq
                    && txn.afterInventorySeq === remote;

                if (dumpJustApplied) {
                    const drawCount = dumpDrawCount();
                    const ownedIdSet = new Set(owned.map((o) => o.id));
                    if (owned.some((o) => o.id === txn.dumpedTileId)) {
                        this._logInventoryProjectionFailure?.('boundary-dump-tile-still-owned', board, uid, { ctx });
                        return false;
                    }
                    if (!Array.isArray(txn.addedTileIds) || txn.addedTileIds.length !== drawCount) {
                        this._logInventoryProjectionFailure?.('boundary-dump-added-count', board, uid, { ctx });
                        return false;
                    }
                    if (!txn.addedTileIds.every((id) => ownedIdSet.has(id))) {
                        this._logInventoryProjectionFailure?.('boundary-dump-added-missing', board, uid, { ctx });
                        return false;
                    }
                    if (typeof txn.beforeOwnedLen === 'number' && ownedLen !== txn.beforeOwnedLen + 2) {
                        this._logInventoryProjectionFailure?.('boundary-dump-owned-len', board, uid, {
                            ctx,
                            ownedLen,
                            expected: txn.beforeOwnedLen + 2,
                            beforeOwnedLen: txn.beforeOwnedLen
                        });
                        return false;
                    }
                    if (typeof txn.beforeInventorySeq === 'number'
                        && txn.afterInventorySeq !== txn.beforeInventorySeq + 1) {
                        this._logInventoryProjectionFailure?.('boundary-dump-seq-coupling', board, uid, { ctx });
                        return false;
                    }
                }

                const peelTxn = board.lastPeelTxn;
                const peelSeq = board.peelSeq || 0;
                const peelJustApplied = peelTxn
                    && peelTxn.partyUids?.includes(uid)
                    && (peelTxn.peelSeq ?? peelSeq) === peelSeq
                    && peelTxn.afterInventorySeq?.[uid] === remote;

                if (peelJustApplied) {
                    const drawnId = peelTxn.drawnIds?.[uid];
                    const ownedIdSet = new Set(owned.map((o) => o.id));
                    if (!drawnId || !ownedIdSet.has(drawnId)) {
                        this._logInventoryProjectionFailure?.('boundary-peel-drawn-missing', board, uid, { ctx });
                        return false;
                    }
                    const beforeLen = peelTxn.beforeOwnedLen?.[uid];
                    if (typeof beforeLen === 'number' && ownedLen !== beforeLen + 1) {
                        this._logInventoryProjectionFailure?.('boundary-peel-owned-len', board, uid, {
                            ctx,
                            ownedLen,
                            expected: beforeLen + 1,
                            beforeOwnedLen: beforeLen
                        });
                        return false;
                    }
                    const before = peelTxn.beforeInventorySeq?.[uid];
                    const after = peelTxn.afterInventorySeq?.[uid];
                    if (typeof before === 'number' && after !== before + 1) {
                        this._logInventoryProjectionFailure?.('boundary-peel-seq-coupling', board, uid, { ctx });
                        return false;
                    }
                }

                return this._assertGlobalTileConservation(board, ctx);
            },

            /** Shared publish tail for host action txns — caller runs rollback on false. */
            _hostPublishTxnOrRollback(rollbackFn, label = 'txn') {
                if (this._hostSyncBoard?.({ immediate: true })) return true;
                rollbackFn?.();
                console.error(`[Bananagrams][${label}] board publish failed — rolled back`);
                return false;
            }
    });
})(typeof window !== 'undefined' ? window : global);
