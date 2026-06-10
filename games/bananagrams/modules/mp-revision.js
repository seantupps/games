/**
 * Bananagrams MP — monotonic boardRevision (structural SSOT for RTDB partial merges).
 *
 * Host bumps boardRevision on every full publish; guest applies playing lifecycle
 * only when revision is new and bundle-coherent. Legacy boards (no boardRevision)
 * use the same gate via a structural apply key (seq + inventory + action seq).
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-revision.js');

    Object.assign(G.prototype, {
            _mpBoardRevisionField(board) {
                const rev = board?.boardRevision;
                return typeof rev === 'number' && Number.isFinite(rev) ? rev : null;
            },

            _mpGuestInventoryLag(board, uid) {
                return this._mpInventorySeqLag?.(board, uid) === true;
            },

            /** Guest may catch up inventory when structural revision already applied but wire inventory advanced. */
            _mpGuestRevisionInventoryCatchUpAllowed(board, options = {}) {
                if (!this._isMultiplayerMode?.() || this.isHost?.()) return false;
                if (options.reset || options.force) return false;
                const uid = this._myUid?.();
                if (!uid || !this._mpGuestInventoryLag(board, uid)) return false;
                if (this._mpLifecyclePhase?.(board) === 'review') return false;
                return this._mpGuestRevisionCoherent(board, uid);
            },

            /** Full revision bundle — txn metadata + inventory snapshot must agree. */
            _mpGuestRevisionCoherent(board, uid) {
                if (!board) return false;
                const me = uid ?? this._myUid?.();
                if (!me) return false;
                const dumpOk = typeof this._isBoardDumpBundleCoherent !== 'function'
                    || this._isBoardDumpBundleCoherent(board);
                const peelOk = typeof this._isBoardPeelBundleCoherent !== 'function'
                    || this._isBoardPeelBundleCoherent(board);
                const splitOk = typeof this._isBoardSplitBundleCoherent !== 'function'
                    || this._isBoardSplitBundleCoherent(board);
                let invSnapOk = true;
                if (typeof this._isBoardInventorySnapshotConsistent === 'function') {
                    invSnapOk = this._isBoardInventorySnapshotConsistent(
                        board,
                        me,
                        board.tilesOwnedByPlayer?.[me] || []
                    );
                }
                return dumpOk && peelOk && splitOk && invSnapOk;
            },

            /**
             * Unified guest structural apply key — revision boards use r:N;
             * legacy boards (no boardRevision) use l:seq:inv:peel:dump.
             */
            _mpGuestStructuralApplyKey(board, uid) {
                if (!board) return null;
                const revision = this._mpBoardRevisionField(board);
                if (revision != null) return `r:${revision}`;
                const seq = board.seq ?? 0;
                const inv = uid ? (this._boardInventorySeq?.(board, uid) ?? 0) : 0;
                return `l:${seq}:${inv}:${board.peelSeq ?? 0}:${board.dumpSeq ?? 0}`;
            },

            /**
             * Legacy boards — require complete structural bundle before guest applies playing lifecycle.
             */
            _mpGuestLegacyBundleComplete(board, uid) {
                if (!board || !uid) return false;
                if (!Array.isArray(board.pool)) return false;
                if (!board.tilesOwnedByPlayer || typeof board.inventorySeq !== 'object') return false;
                const owned = board.tilesOwnedByPlayer[uid];
                if (!Array.isArray(owned)) return false;
                const remote = board.inventorySeq[uid] ?? 0;
                if (remote > 0 && !owned.length) return false;
                if (typeof this._isBoardInventorySnapshotConsistent === 'function'
                    && !this._isBoardInventorySnapshotConsistent(board, uid, owned)) {
                    return false;
                }
                const peelBoard = board.peelSeq || 0;
                const dumpBoard = board.dumpSeq || 0;
                if (peelBoard > 0 && !board.lastPeelTxn) return false;
                if (dumpBoard > 0 && !board.lastDumpTxn) return false;
                if (peelBoard > 0 && typeof this._isBoardPeelBundleCoherent === 'function'
                    && !this._isBoardPeelBundleCoherent(board)) {
                    return false;
                }
                if (dumpBoard > 0 && typeof this._isBoardDumpBundleCoherent === 'function'
                    && !this._isBoardDumpBundleCoherent(board)) {
                    return false;
                }
                return true;
            },

            /**
             * Guest structural apply gate — observe only complete host revisions.
             * @returns {{ action: 'apply'|'defer'|'skip', reason?: string, revision?: number|null, applied?: number }}
             */
            _mpGuestRevisionGate(board, options = {}) {
                if (!this._isMultiplayerMode?.() || this.isHost?.()) {
                    return { action: 'apply' };
                }
                if (options.reset || options.force) {
                    return { action: 'apply', reason: 'force' };
                }
                const phase = this._mpLifecyclePhase?.(board) || 'idle';
                if (phase === 'review') {
                    return { action: 'apply', reason: 'review' };
                }

                const revision = this._mpBoardRevisionField(board);
                const applied = this._mpAppliedBoardRevision || 0;
                const uid = this._myUid?.();
                const structuralKey = this._mpGuestStructuralApplyKey(board, uid);
                const appliedKey = this._mpGuestAppliedStructuralKey ?? null;

                if (revision == null) {
                    if (!this._mpGuestRevisionCoherent(board, uid)) {
                        return { action: 'defer', reason: 'legacy-incoherent', revision: null, applied };
                    }
                    if (!this._mpGuestLegacyBundleComplete(board, uid)) {
                        return { action: 'defer', reason: 'legacy-incomplete-bundle', revision: null, applied };
                    }
                    if (structuralKey === appliedKey && !this._mpGuestInventoryLag(board, uid)) {
                        return {
                            action: 'skip',
                            reason: 'legacy-stale-structural',
                            revision: null,
                            applied,
                            structuralKey,
                            appliedKey
                        };
                    }
                    return { action: 'apply', reason: 'legacy-coherent', revision: null, applied, structuralKey };
                }

                if (revision <= applied) {
                    if (structuralKey !== appliedKey || this._mpGuestInventoryLag(board, uid)) {
                        return { action: 'apply', reason: 'revision-reapply', revision, applied, structuralKey };
                    }
                    return { action: 'skip', reason: 'already-applied', revision, applied, structuralKey };
                }

                if (!this._mpGuestRevisionCoherent(board, uid)) {
                    this._mpPendingRevisionBoard = board;
                    return { action: 'defer', reason: 'revision-incoherent', revision, applied };
                }

                return { action: 'apply', reason: 'revision-ready', revision, applied, structuralKey };
            },

            _mpCommitAppliedBoardRevision(board) {
                if (this.isHost?.()) return;
                const uid = this._myUid?.();
                const structuralKey = this._mpGuestStructuralApplyKey(board, uid);
                if (structuralKey) {
                    this._mpGuestAppliedStructuralKey = structuralKey;
                }
                const revision = this._mpBoardRevisionField(board);
                if (revision != null) {
                    this._mpAppliedBoardRevision = Math.max(this._mpAppliedBoardRevision || 0, revision);
                }
                this._mpPendingRevisionBoard = null;
                if (uid) {
                    this._mpLastInventorySeqAtRevision = this._boardInventorySeq?.(board, uid) ?? 0;
                }
            },

            /**
             * Guest board apply entry — defer/skip until boardRevision bundle is coherent.
             * @returns {boolean} false to abort this board tick
             */
            _mpGuestRevisionAllowsBoardApply(board, options = {}, traceCaller = '') {
                const gate = this._mpGuestRevisionGate(board, options);
                if (gate.action === 'apply') return true;
                if (gate.action === 'skip') {
                    if (this._mpGuestRevisionInventoryCatchUpAllowed(board, options)) {
                        options._revisionInventoryCatchUp = true;
                        options.applySource = options.applySource || 'revision-inv-catch-up';
                        if (this._doneTraceOn?.()) {
                            console.log('[APPLY] guest revision skip — inventory catch-up', {
                                ...gate,
                                caller: traceCaller,
                                boardInv: this._boardInventorySeq?.(board, this._myUid?.()),
                                localInv: this._mpClientInventorySeq?.(this._myUid?.()) ?? 0
                            });
                        }
                        return true;
                    }
                    if (this._doneTraceOn?.()) {
                        console.log('[APPLY] guest revision skip', { ...gate, caller: traceCaller });
                    }
                    return false;
                }
                this._logInventoryProjectionFailure?.('revision-deferred', board, this._myUid?.(), {
                    caller: traceCaller,
                    reason: gate.reason,
                    revision: gate.revision,
                    applied: gate.applied
                });
                this._scheduleMpInventoryReconcile?.({
                    _inventoryApplySource: 'revision-deferred'
                });
                return false;
            },

            _mpClearRevisionClientState() {
                this._mpAppliedBoardRevision = 0;
                this._mpGuestAppliedStructuralKey = null;
                this._mpLastInventorySeqAtRevision = 0;
                this._mpPendingRevisionBoard = null;
            },

            _mpRevisionSnapshot(board) {
                const revision = this._mpBoardRevisionField(board);
                const uid = this._myUid?.();
                const boardInv = uid ? (this._boardInventorySeq?.(board, uid) ?? 0) : 0;
                const structuralKey = this._mpGuestStructuralApplyKey(board, uid);
                return {
                    boardRevision: revision,
                    appliedRevision: this._mpAppliedBoardRevision ?? 0,
                    structuralApplyKey: structuralKey,
                    appliedStructuralKey: this._mpGuestAppliedStructuralKey ?? null,
                    lastInventorySeqAtRevision: this._mpLastInventorySeqAtRevision ?? 0,
                    inventoryLagAfterRevision: uid ? boardInv > (this._mpLastInventorySeqAtRevision ?? 0) : null,
                    guestInventoryLag: uid ? this._mpGuestInventoryLag?.(board, uid) : null,
                    hostRevision: this.isHost?.() ? (this._mpBoardRevision ?? 0) : null,
                    pending: !!this._mpPendingRevisionBoard,
                    coherent: board ? this._mpGuestRevisionCoherent(board, uid) : null,
                    legacyBundleComplete: board && uid
                        ? this._mpGuestLegacyBundleComplete(board, uid)
                        : null
                };
            }
    });

    if (typeof window !== 'undefined') {
        G.registerMpDebug({
            revision() {
                const g = window.game;
                const board = g?._mpBoardFromRoom?.(g.roomData);
                return g?._mpRevisionSnapshot?.(board) ?? null;
            }
        });
    }
})(typeof window !== 'undefined' ? window : global);
