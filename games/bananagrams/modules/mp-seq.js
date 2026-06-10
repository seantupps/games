/**
 * Bananagrams MP — sequence counter registry (single reader API + debug snapshot).
 *
 * Counter matrix — what each seq gates:
 *
 * | Counter | Source | Role |
 * |---------|--------|------|
 * | board.seq | RTDB global/board | Lifecycle apply gate (deal, split, review) |
 * | board.inventorySeq[uid] | RTDB global/board | Network authority for hand membership version |
 * | _localInventorySeq | Client runtime | Projected inventorySeq after hand membership apply |
 * | _mpClientInventorySeq(uid) | Client read API | Alias — use for all client logic reads |
 * | _mpProjectionInventorySeq(uid) | Client read API | Host active play → _mpInventorySeq; else _localInventorySeq |
 * | _mpInventorySeq[uid] | Host runtime | Host write authority before publish |
 * | board.peelSeq / dumpSeq | RTDB global/board | Last committed peel/dump on wire |
 * | _lastPeelSeq / _lastDumpSeq | Client runtime | Acknowledged action seq (banners, pool) |
 * | _peelSeq / _dumpSeq | Host runtime | Live counters while host mutates |
 * | resetCount / _mpAppliedResetCount | RTDB / client | Room epoch — allows board.seq reset |
 * | dealEpoch | board + canonical | Scopes tile id pool to current deal |
 *
 * Inventory projection uses board.inventorySeq only — never lastDumpTxn.afterInventorySeq.
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-seq.js');

    Object.assign(G.prototype, {
            /** Network authority — board.inventorySeq[uid] only. Never use for host client logic during play. */
            _boardInventorySeq(board, uid) {
                return board?.inventorySeq?.[uid] ?? 0;
            },

            /** Host live write authority before board publish. Write path only — reads use _mpClientInventorySeq. */
            _hostLiveInventorySeq(uid) {
                return this._mpInventorySeq?.[uid] ?? 0;
            },

            /**
             * Client inventory seq — single read API for HUD, eligibility, layout persist, pipeline gates.
             * Host active play: live _mpInventorySeq (publish may lag wire). Guest/idle: _localInventorySeq.
             */
            _mpClientInventorySeq(uid) {
                return this._mpProjectionInventorySeq(uid);
            },

            /**
             * Client projection cursor — during host active play, live _mpInventorySeq is
             * authority (not wire board.inventorySeq or stale _localInventorySeq).
             */
            _mpProjectionInventorySeq(uid) {
                if (!uid) return this._localInventorySeq || 0;
                if (this.isHost?.() && uid === this._myUid?.()
                    && this.gameStarted && this.canMutatePlayingBoard?.()
                    && !this._reviewUiActive?.()) {
                    return this._hostLiveInventorySeq(uid);
                }
                return this._localInventorySeq || 0;
            },

            /** Keep host own projection cursor aligned with live authority after bump/echo. */
            _hostSyncOwnInventoryProjection(uid) {
                if (!uid || uid !== this._myUid?.()) return;
                const live = this._hostLiveInventorySeq(uid);
                if (live > 0) this._localInventorySeq = live;
            },

            /** Triage — all three counters plus client read (host publish-pending when live > wire). */
            _snapshotHostInventoryCounters(board, uid) {
                const me = uid ?? this._myUid?.();
                if (!me) return null;
                const wire = board ? this._boardInventorySeq(board, me) : null;
                const local = this._localInventorySeq || 0;
                const live = this.isHost?.() ? this._hostLiveInventorySeq(me) : null;
                const client = this._mpClientInventorySeq(me);
                return {
                    uid: String(me).slice(-14),
                    wire,
                    local,
                    hostLive: live,
                    client,
                    hostPublishPending: board ? this._hostInventoryPublishPending(me, board) : false,
                    clientMatchesLive: live == null || client === live,
                    localMatchesLive: live == null || local === live
                };
            },

            /** True when inventory projection still needs to catch up to authority. */
            _mpInventorySeqLag(board, uid) {
                if (!board || !uid) return false;
                if (this.isHost?.() && uid === this._myUid?.()
                    && this.gameStarted && this.canMutatePlayingBoard?.()
                    && !this._reviewUiActive?.()) {
                    const owned = this._mpNormalizeBoardOwned?.(this._mpOwned?.[uid])
                        || this._mpOwned?.[uid]
                        || [];
                    if (!owned.length) return false;
                    return !this._verifyInventoryMembership?.(owned, this.tiles);
                }
                const remote = this._boardInventorySeq(board, uid);
                const stored = this._loadLocalHandRecord?.() || {};
                const cacheSeq = stored.inventorySeq ?? 0;
                const local = Math.max(this._mpClientInventorySeq(uid), cacheSeq);
                return remote > local;
            },

            /** Host mid-txn: live authority advanced but wire board not yet published. */
            _hostInventoryPublishPending(uid, board) {
                if (!this.isHost?.() || !uid || !board) return false;
                if (!this.gameStarted || !this.canMutatePlayingBoard?.()) return false;
                return this._hostLiveInventorySeq(uid) > this._boardInventorySeq(board, uid);
            },

            /** Unified seq matrix for dev, test, and failure snapshots. */
            _snapshotMpSeqMatrix(board, uid, why = 'seq-matrix') {
                const me = uid ?? this._myUid?.();
                const boardInv = me ? this._boardInventorySeq(board, me) : 0;
                const localInv = this._mpClientInventorySeq?.(me) ?? 0;
                const hostInv = me && this.isHost?.() ? this._hostLiveInventorySeq(me) : null;
                const peelBoard = board?.peelSeq ?? 0;
                const dumpBoard = board?.dumpSeq ?? 0;
                const peelLast = this._lastPeelSeq ?? 0;
                const dumpLast = this._lastDumpSeq ?? 0;
                const dumpTxn = board?.lastDumpTxn;
                const peelTxn = board?.lastPeelTxn;
                const splitTxn = board?.lastSplitTxn;

                return {
                    why,
                    role: this.isHost?.() ? 'host' : 'guest',
                    uid: me ? String(me).slice(-14) : null,
                    lifecycle: {
                        boardSeq: board?.seq ?? null,
                        localBoardSeq: this._boardSeq ?? null,
                        boardRevision: board?.boardRevision ?? null,
                        appliedRevision: this._mpAppliedBoardRevision ?? 0,
                        legacyAppliedBoardSeq: null,
                        appliedStructuralKey: this._mpGuestAppliedStructuralKey ?? null,
                        hostRevision: this.isHost?.() ? (this._mpBoardRevision ?? 0) : null,
                        resetCount: board?.resetCount ?? this.roomData?.global?.resetCount ?? null,
                        mpAppliedResetCount: this._mpAppliedResetCount ?? null,
                        mpAwaitReset: !!this._mpAwaitReset,
                        mpEpochSyncedFromRoom: !!this._mpEpochSyncedFromRoom,
                        dealEpoch: board?.dealEpoch ?? this._mpDealEpoch?.() ?? null
                    },
                    inventory: {
                        board: boardInv,
                        local: localInv,
                        hostLive: hostInv,
                        lag: typeof this._mpInventorySeqLag === 'function'
                            ? this._mpInventorySeqLag(board, me)
                            : boardInv > localInv,
                        hostDrift: this.isHost?.() && hostInv != null && hostInv !== boardInv,
                        hostPublishPending: me ? this._hostInventoryPublishPending?.(me, board) : false
                    },
                    actions: {
                        peelBoard,
                        peelLive: this._peelSeq ?? 0,
                        peelLast,
                        peelPending: peelBoard > peelLast,
                        dumpBoard,
                        dumpLive: this._dumpSeq ?? 0,
                        dumpLast,
                        dumpPending: dumpBoard > dumpLast
                    },
                    pool: (() => {
                        const base = {
                            board: Array.isArray(board?.pool) ? board.pool.length : null,
                            local: this._tilePool?.length ?? 0,
                            drift: Array.isArray(board?.pool)
                                ? board.pool.length !== (this._tilePool?.length ?? 0)
                                : false,
                            poolLag: (peelBoard > peelLast || dumpBoard > dumpLast)
                                && Array.isArray(board?.pool)
                                && board.pool.length === (this._tilePool?.length ?? 0),
                            lastApply: this._lastMpPoolApply ? { ...this._lastMpPoolApply } : null
                        };
                        if (this.isHost?.()) {
                            const stores = this._snapshotHostPoolStores?.();
                            if (stores) {
                                base.hostStores = stores;
                                base.display = stores.display;
                            }
                        }
                        return base;
                    })(),
                    boardApply: this._lastBoardApply ? { ...this._lastBoardApply } : null,
                    dumpBundle: dumpTxn ? {
                        dumpSeq: dumpTxn.dumpSeq ?? dumpBoard,
                        actorUid: dumpTxn.actorUid ? String(dumpTxn.actorUid).slice(-14) : null,
                        afterInventorySeq: dumpTxn.afterInventorySeq ?? null,
                        beforeInventorySeq: dumpTxn.beforeInventorySeq ?? null,
                        boardInventoryAtActor: dumpTxn.actorUid
                            ? this._boardInventorySeq(board, dumpTxn.actorUid)
                            : null,
                        coherent: typeof this._isBoardDumpBundleCoherent === 'function'
                            ? this._isBoardDumpBundleCoherent(board)
                            : null
                    } : null,
                    peelBundle: peelTxn ? {
                        peelSeq: peelTxn.peelSeq ?? peelBoard,
                        actorUid: peelTxn.actorUid ? String(peelTxn.actorUid).slice(-14) : null,
                        partyUids: (peelTxn.partyUids || []).map((u) => String(u).slice(-14)),
                        afterInventorySeq: peelTxn.afterInventorySeq ?? null,
                        beforeInventorySeq: peelTxn.beforeInventorySeq ?? null,
                        coherent: typeof this._isBoardPeelBundleCoherent === 'function'
                            ? this._isBoardPeelBundleCoherent(board)
                            : null
                    } : null,
                    splitBundle: splitTxn ? {
                        resetCount: splitTxn.resetCount ?? null,
                        startedAt: splitTxn.startedAt ?? null,
                        afterBoardSeq: splitTxn.afterBoardSeq ?? null,
                        boardStartedAt: board?.startedAt ?? null,
                        boardGameStarted: board?.gameStarted ?? null,
                        coherent: typeof this._isBoardSplitBundleCoherent === 'function'
                            ? this._isBoardSplitBundleCoherent(board)
                            : null
                    } : null,
                    inventoryApplyGen: this._mpInventoryApplyGen ?? 0,
                    lastInventoryApply: this._lastMpInventoryApply
                        ? { ...this._lastMpInventoryApply }
                        : null,
                    reconcileAttempts: this._mpInvReconcileAttempts ?? 0
                };
            }
    });

    if (typeof window !== 'undefined') {
        G.registerMpDebug({
            seqMatrix() {
                const g = window.game;
                const board = g?._mpBoardFromRoom?.(g.roomData);
                const uid = g?._myUid?.();
                return g?._snapshotMpSeqMatrix?.(board, uid, 'debug') ?? null;
            },
            inventorySnapshot() {
                const g = window.game;
                const board = g?._mpBoardFromRoom?.(g.roomData);
                const uid = g?._myUid?.();
                return g?._snapshotInventoryProjection?.(board, uid, 'debug') ?? null;
            },
            inventoryCounters() {
                const g = window.game;
                const board = g?._mpBoardFromRoom?.(g.roomData);
                const uid = g?._myUid?.();
                return g?._snapshotHostInventoryCounters?.(board, uid) ?? null;
            }
        });
    }
})(typeof window !== 'undefined' ? window : global);
