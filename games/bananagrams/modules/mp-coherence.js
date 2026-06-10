/**
 * Bananagrams MP — unified coherence snapshot (inventory + pool + epoch + action seq).
 *
 * Single read for triage: `__bananaMpDebug.coherence()` or `_mpCoherenceSnapshot(board, uid)`.
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-coherence.js');

    /** ctx → boolean snap flags that must be true for apply/render/input. */
    G.MP_COHERENCE_CTX = {
        'inventory-apply': [
            'inventorySynced', 'dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent',
            'revisionSynced', 'epochSynced'
        ],
        'pool-cache-mirror': [
            'inventorySynced', 'dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent',
            'revisionSynced', 'epochSynced'
        ],
        'pool-hud': ['dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent', 'revisionSynced', 'epochSynced'],
        'action-seq-commit': [
            'inventorySynced', 'dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent', 'revisionSynced'
        ],
        'spawn-render': [
            'inventorySynced', 'dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent', 'revisionSynced'
        ],
        'hand-mutation': [
            'inventorySynced', 'dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent',
            'revisionSynced', 'epochSynced'
        ],
        'host-live-mutation': [
            'inventorySynced', 'dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent',
            'poolSynced', 'epochSynced', 'revisionSynced'
        ],
        bundle: [
            'dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent', 'inventorySnapshotConsistent'
        ],
        default: [
            'inventorySynced', 'dumpBundleCoherent', 'peelBundleCoherent', 'splitBundleCoherent',
            'poolSynced', 'epochSynced', 'revisionSynced'
        ]
    };

    Object.assign(G.prototype, {
            /**
             * @returns {{
             *   ok: boolean,
             *   coherent: boolean,
             *   inventorySynced: boolean,
             *   dumpBundleCoherent: boolean,
             *   peelBundleCoherent: boolean,
             *   splitBundleCoherent: boolean,
             *   poolSynced: boolean,
             *   epochSynced: boolean,
             *   actionSeqAcked: boolean,
             *   failed: string[],
             *   peelPending?: boolean,
             *   dumpPending?: boolean,
             *   inventoryLag?: boolean,
             *   seq?: object,
             *   epoch?: object
             * }}
             */
            _mpCoherenceSnapshot(board, uid, why = 'coherence') {
                if (!this._isMultiplayerMode?.()) {
                    return {
                        why,
                        role: 'solo',
                        ok: true,
                        coherent: true,
                        inventorySynced: true,
                        dumpBundleCoherent: true,
                        peelBundleCoherent: true,
                        splitBundleCoherent: true,
                        poolSynced: true,
                        epochSynced: true,
                        actionSeqAcked: true,
                        inventorySnapshotConsistent: true,
                        revisionSynced: true,
                        failed: []
                    };
                }

                const me = uid ?? this._myUid?.();
                const snapBoard = board || this._mpBoardFromRoom?.(this.roomData) || null;
                const seq = typeof this._snapshotMpSeqMatrix === 'function'
                    ? this._snapshotMpSeqMatrix(snapBoard, me, why)
                    : null;
                const epoch = typeof this._mpEpochFlagsSnapshot === 'function'
                    ? this._mpEpochFlagsSnapshot(snapBoard)
                    : null;

                const boardInv = me ? this._boardInventorySeq(snapBoard, me) : 0;
                const localInv = this._mpClientInventorySeq?.(me) ?? 0;
                const hostInv = this.isHost?.() && me ? this._hostLiveInventorySeq(me) : null;
                const hostPublishPending = me && snapBoard
                    ? !!this._hostInventoryPublishPending?.(me, snapBoard)
                    : false;

                let inventorySynced = !this._mpInventorySeqLag?.(snapBoard, me);
                if (inventorySynced && this.isHost?.() && me && hostInv != null) {
                    inventorySynced = !hostPublishPending
                        && this._verifyInventoryMembership?.(
                            this._mpNormalizeBoardOwned?.(this._mpOwned?.[me])
                                || this._mpOwned?.[me]
                                || snapBoard.tilesOwnedByPlayer?.[me]
                                || [],
                            this.tiles
                        );
                }
                if (inventorySynced && me && snapBoard) {
                    const owned = this.isHost?.() && this.gameStarted && this.canMutatePlayingBoard?.()
                        && !this._reviewUiActive?.()
                        ? (this._mpNormalizeBoardOwned?.(this._mpOwned?.[me]) || this._mpOwned?.[me] || [])
                        : (snapBoard.tilesOwnedByPlayer?.[me] || []);
                    if (owned.length && typeof this._verifyInventoryMembership === 'function') {
                        inventorySynced = this._verifyInventoryMembership(owned, this.tiles);
                    }
                }

                const dumpBundleCoherent = typeof this._isBoardDumpBundleCoherent === 'function'
                    ? this._isBoardDumpBundleCoherent(snapBoard)
                    : true;
                const peelBundleCoherent = typeof this._isBoardPeelBundleCoherent === 'function'
                    ? this._isBoardPeelBundleCoherent(snapBoard)
                    : true;
                const splitBundleCoherent = typeof this._isBoardSplitBundleCoherent === 'function'
                    ? this._isBoardSplitBundleCoherent(snapBoard)
                    : true;

                let inventorySnapshotConsistent = true;
                if (me && snapBoard && !this.isHost?.()) {
                    const ownedForSnap = snapBoard.tilesOwnedByPlayer?.[me] || [];
                    if (typeof this._isBoardInventorySnapshotConsistent === 'function') {
                        inventorySnapshotConsistent = this._isBoardInventorySnapshotConsistent(
                            snapBoard,
                            me,
                            ownedForSnap
                        );
                    }
                }

                const peelBoard = snapBoard?.peelSeq ?? 0;
                const dumpBoard = snapBoard?.dumpSeq ?? 0;
                const peelLast = this._lastPeelSeq ?? 0;
                const dumpLast = this._lastDumpSeq ?? 0;
                const peelPending = peelBoard > peelLast;
                const dumpPending = dumpBoard > dumpLast;
                const actionSeqAcked = !peelPending && !dumpPending;

                const boardPoolLen = !this.isHost?.()
                    ? (Array.isArray(snapBoard?.pool)
                        ? snapBoard.pool.length
                        : (this._mpGuestPoolWireLen?.() ?? null))
                    : (Array.isArray(snapBoard?.pool) ? snapBoard.pool.length : null);
                const localPoolLen = this._isHost?.()
                    ? (this._tilePool?.length ?? 0)
                    : (this._mpGuestPoolCacheLen?.() ?? (this._tilePool?.length ?? 0));
                const displayPoolLen = typeof this._mpDisplayPoolLen === 'function'
                    ? this._mpDisplayPoolLen()
                    : localPoolLen;
                let poolSynced = true;
                if (boardPoolLen != null) {
                    if (this.isHost?.() && this.gameStarted && !this._winnerUid) {
                        poolSynced = boardPoolLen === localPoolLen;
                    } else if (!this.isHost?.()) {
                        poolSynced = boardPoolLen === localPoolLen;
                    } else if (peelPending || dumpPending) {
                        poolSynced = !seq?.pool?.poolLag && boardPoolLen === localPoolLen;
                    } else {
                        poolSynced = boardPoolLen === localPoolLen;
                    }
                }

                const roomEpoch = epoch?.roomEpoch ?? 0;
                const appliedEpoch = epoch?.mpAppliedResetCount ?? 0;
                const epochSynced = roomEpoch === appliedEpoch && !this._mpAwaitReset;

                const boardRevision = this._mpBoardRevisionField?.(snapBoard);
                const appliedRevision = this._mpAppliedBoardRevision ?? 0;
                let revisionSynced = true;
                if (this.isHost?.() && boardRevision != null) {
                    revisionSynced = boardRevision <= (this._mpBoardRevision ?? 0);
                } else if (!this.isHost?.() && boardRevision != null) {
                    revisionSynced = boardRevision <= appliedRevision
                        || this._mpGuestRevisionCoherent?.(snapBoard, me);
                }

                const flags = {
                    inventorySynced,
                    dumpBundleCoherent,
                    peelBundleCoherent,
                    splitBundleCoherent,
                    inventorySnapshotConsistent,
                    poolSynced,
                    epochSynced,
                    actionSeqAcked,
                    revisionSynced
                };
                const failed = Object.entries(flags)
                    .filter(([, ok]) => !ok)
                    .map(([key]) => key);

                return {
                    why,
                    role: this.isHost?.() ? 'host' : 'guest',
                    uid: me ? String(me).slice(-14) : null,
                    ok: failed.length === 0,
                    coherent: failed.length === 0,
                    ...flags,
                    failed,
                    peelPending,
                    dumpPending,
                    inventoryLag: boardInv > localInv,
                    boardInventorySeq: boardInv,
                    localInventorySeq: localInv,
                    hostInventorySeq: hostInv,
                    displayPoolLen,
                    boardPoolLen,
                    cachePoolLen: localPoolLen,
                    boardRevision,
                    appliedRevision,
                    revisionPending: !!this._mpPendingRevisionBoard,
                    seq,
                    epoch
                };
            },

            /** First failing coherence flag — for logs and ptest messages. */
            _mpCoherenceFailureReason(board, uid) {
                const req = this._mpRequireCoherent(board, 'default', { uid, log: false });
                if (req.ok) return null;
                return req.failed[0] || 'coherence';
            },

            /**
             * Single enforced coherence gate — use at pipeline, pool, action-seq, spawn, input.
             * @returns {{ ok: boolean, failed: string[], snap: object, ctx: string, bypass?: string }}
             */
            _mpRequireCoherent(board, ctx = 'default', options = {}) {
                const uid = options.uid ?? this._myUid?.();
                const snap = this._mpCoherenceSnapshot(board, uid, ctx);
                if (!this._isMultiplayerMode?.()) {
                    return { ok: true, failed: [], snap, ctx };
                }
                const hostLivePlay = this.isHost?.()
                    && this.gameStarted
                    && this.canMutatePlayingBoard?.()
                    && this._boardPhase(board) !== BananagramsGame.MP_PHASE.REVIEW
                    && !options.reset
                    && !options.force;
                const enforceHost = options.requireOnHost || hostLivePlay;
                if (this.isHost?.() && !enforceHost) {
                    return { ok: true, failed: [], snap, ctx };
                }
                if (options.force || options.reset) {
                    return { ok: true, failed: [], snap, ctx, bypass: options.reset ? 'reset' : 'force' };
                }
                const keys = options.require
                    || G.MP_COHERENCE_CTX[ctx]
                    || G.MP_COHERENCE_CTX.default;
                const failed = keys.filter((key) => snap[key] === false);
                const ok = failed.length === 0;
                if (!ok && failed.includes('revisionSynced') && snap.boardRevision != null) {
                    this._mpPendingRevisionBoard = board || this._mpBoardFromRoom?.(this.roomData);
                }
                if (!ok && options.log !== false) {
                    this._logMpDiagnostic?.('coherence-blocked', board, uid, {
                        ctx,
                        failed,
                        snapFailed: snap.failed
                    });
                }
                return { ok, failed, snap, ctx };
            },

            /** Log + schedule reconcile when coherence blocks guest apply. */
            _mpCoherenceBlock(board, ctx, uid, options = {}) {
                const req = this._mpRequireCoherent(board, ctx, { ...options, uid, log: false });
                if (req.ok) return req;
                this._logInventoryProjectionFailure?.('coherence-blocked', board, uid, {
                    ctx,
                    failed: req.failed,
                    snapFailed: req.snap?.failed
                });
                if (!this.isHost?.()) {
                    this._scheduleMpInventoryReconcile?.({
                        _inventoryApplySource: options._inventoryApplySource || `coherence-${ctx}`
                    });
                } else {
                    console.error('[Bananagrams][host] coherence drift', {
                        ctx,
                        failed: req.failed,
                        snapFailed: req.snap?.failed
                    });
                }
                return req;
            },

            /**
             * Guest MP: wire-confirmed play before peel/dump/drag hand mutations.
             * Split initiation (beginGame) is intentionally outside this gate.
             */
            _mpGuestAuthorityReadyForPlay() {
                if (!this._isMultiplayerMode?.() || this.isHost?.()) return true;
                const board = this._mpBoardFromRoom?.(this.roomData);
                if (!this._mpGuestWireGameStarted?.(board)) return false;
                return this._mpRequireCoherent(board, 'hand-mutation', { log: false }).ok;
            },

            /** Host MP: assert live authority matches publish bundle before txn commit. */
            _hostAssertLiveCoherence(ctx = 'host-live-mutation') {
                if (!this.isHost?.() || !this._isMultiplayerMode?.()) return true;
                const board = typeof this._hostAuthorityBoardSnapshot === 'function'
                    ? this._hostAuthorityBoardSnapshot(this._getPlayerUids?.())
                    : this._mpBoardFromRoom?.(this.roomData);
                if (!board) return true;
                const req = this._mpRequireCoherent(board, ctx, { requireOnHost: true, log: false });
                if (req.ok) return true;
                console.error('[Bananagrams][host] live coherence drift before mutation', {
                    ctx,
                    failed: req.failed,
                    snapFailed: req.snap?.failed
                });
                if (typeof BananaDev !== 'undefined' && BananaDev.failAuthorityCommit) {
                    BananaDev.failAuthorityCommit('host live coherence drift', {
                        ctx,
                        failed: req.failed
                    });
                }
                return false;
            }
    });

    if (typeof window !== 'undefined') {
        G.registerMpDebug({
            coherence() {
                const g = window.game;
                const board = g?._mpBoardFromRoom?.(g.roomData);
                const uid = g?._myUid?.();
                return g?._mpCoherenceSnapshot?.(board, uid, 'debug') ?? null;
            },
            requireCoherent(ctx = 'default') {
                const g = window.game;
                const board = g?._mpBoardFromRoom?.(g.roomData);
                const hostLive = g?.isHost?.() && g?.gameStarted && g?.canMutatePlayingBoard?.();
                return g?._mpRequireCoherent?.(board, ctx, {
                    log: false,
                    requireOnHost: !!hostLive
                }) ?? null;
            },
            guestHandMutationAllowed() {
                const g = window.game;
                if (!g?._isMultiplayerMode?.() || g.isHost?.()) return true;
                return g._canMutatePlayingHand?.() ?? false;
            },
            guestAuthorityReady() {
                const g = window.game;
                return g?._mpGuestAuthorityReadyForPlay?.() ?? true;
            },
            displayPoolLen() {
                const g = window.game;
                return g?._mpDisplayPoolLen?.() ?? g?._tilePool?.length ?? 0;
            },
            hostPoolStores() {
                const g = window.game;
                return g?._snapshotHostPoolStores?.() ?? null;
            }
        });
    }
})(typeof window !== 'undefined' ? window : global);
