/** Bananagrams — mp-board (prototype mixin). Requires game.js + mp-seq.js first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-board.js');
    Object.assign(G.prototype, {
            _normalizeMpBoard(board) {
                if (!board) return board;
                if (board.tilesOwnedByPlayer && board.hands) {
                    board = { ...board };
                    delete board.hands;
                }
                if (board.version >= 5) return board;
                if (board.version >= 4) return board;
                if (board.version === 3) return board;
                if (board.version === 2 && board.hands) {
                    const tilesOwnedByPlayer = {};
                    const tilePositionsByPlayer = {};
                    const seq = board.handSeq || {};
                    Object.entries(board.hands).forEach(([uid, tiles]) => {
                        if (!Array.isArray(tiles)) return;
                        tilesOwnedByPlayer[uid] = tiles.map((t) => ({
                            id: t.id,
                            letter: t.letter,
                            faceUp: !!t.faceUp
                        }));
                        tilePositionsByPlayer[uid] = tiles.map((t) => ({
                            id: t.id,
                            x: t.x,
                            y: t.y
                        }));
                    });
                    return {
                        ...board,
                        version: 3,
                        tilesOwnedByPlayer,
                        tilePositionsByPlayer,
                        inventorySeq: { ...seq },
                        layoutSeq: { ...seq }
                    };
                }
                return board;
            },

            /**
             * Inventory axis — single entry for playing-hand projection.
             * One apply per board tick; async RAF retry only when apply no-ops but authority lags.
             */
            _applyMpInventoryAxis(board, uid, options = {}) {
                if (!board || !uid) return false;
                if (this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW && !options.reset) {
                    return false;
                }

                const source = options._inventoryApplySource || options._traceCaller || 'inventory-axis';
                const intent = this._mpInventoryApplyIntent?.(board, uid, options);
                if (!intent && !options.reset && !options.force) {
                    return false;
                }

                const applyOpts = {
                    ...options,
                    ...(intent || {}),
                    _inventoryApplySource: source,
                    _inventoryApplyGen: this._nextMpInventoryApplyGen?.()
                };

                let changed = false;
                if (this._shouldProjectPlayingInventory?.(board, applyOpts) || intent || options.force || options.reset) {
                    changed = !!this._applyMpInventoryFromBoard(board, uid, applyOpts);
                } else if (!this.isHost?.()) {
                    if (this._mpInventorySeqLag?.(board, uid)) {
                        this._logInventoryProjectionFailure?.('projection-gate-blocked', board, uid, {
                            remote: this._boardInventorySeq(board, uid),
                            local: this._mpClientInventorySeq?.(uid),
                            applySource: source,
                            applyGen: applyOpts._inventoryApplyGen
                        });
                    }
                }

                this._noteMpInventoryApply?.(
                    source,
                    applyOpts._inventoryApplyGen,
                    changed ? 'ok' : 'no-op',
                    board,
                    uid
                );

                if (changed) {
                    this._mpInvReconcileAttempts = 0;
                    if (!this.isHost?.()) this._mpInventoryProjectionFailed = false;
                    return true;
                }

                if (this._mpInventoryNeedsRetry?.(board, uid)) {
                    const remote = this._boardInventorySeq(board, uid);
                    const local = this._mpClientInventorySeq?.(uid) ?? 0;
                    const ownedLen = board.tilesOwnedByPlayer?.[uid]?.length || 0;
                    const tilesLen = this.tiles?.length || 0;
                    this._logInventoryProjectionFailure?.('inventory-apply-no-op', board, uid, {
                        applySource: source,
                        applyGen: applyOpts._inventoryApplyGen,
                        remote,
                        local,
                        ownedLen,
                        tilesLen
                    });
                    this._scheduleMpInventoryReconcile?.({ _inventoryApplySource: `${source}-retry` });
                }
                return false;
            },

            _positionsMapFromList(list) {
                const map = {};
                (list || []).forEach((p) => {
                    if (p?.id != null) map[p.id] = { x: p.x, y: p.y };
                });
                return map;
            },

            /**
             * Single pool projection per board tick — idempotent via options._poolAppliedThisTick.
             * Guest: _tilePool mirrors wire board.pool on every apply (no lag window).
             */
            _applyBoardPoolOnce(board, options = {}, reason = 'board-pool') {
                if (options._poolAppliedThisTick) return false;
                options._poolAppliedThisTick = true;
                if (!board || !Array.isArray(board.pool)) {
                    if (!this.isHost?.()) this._refreshPoolHud?.();
                    return false;
                }
                if (this.isHost?.() && !this._hostMayIngestBoardToAuthority?.(board, options)) {
                    this._syncHostPoolOnRoomCaches?.();
                    return false;
                }
                return this._applyPoolFromBoardAuthority(board, reason, {
                    force: !!options.force,
                    reset: !!options.reset,
                    inventorySynced: !!options.inventorySynced
                });
            },

            /**
             * Single pool projection entry — board.pool is network truth for guests;
             * host owns live pool during play. Never infer/slice pool from action seq.
             * @returns {boolean} true when local pool cache was updated
             */
            _applyPoolFromBoardAuthority(board, reason = 'pool-authority', options = {}) {
                if (!board || !Array.isArray(board.pool)) return false;
                const inReview = this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                const winActive = inReview || !!(board.winnerUid || this._winnerUid || this._victoryRegistered);
                const devSolvePool = this._bananaDevHook('applyDevSolveFromBoard', board) === true;
                if (devSolvePool) return false;

                const remoteLen = board.pool.length;
                const localLen = this._tilePool?.length ?? 0;
                const peelBoard = board.peelSeq || 0;
                const dumpBoard = board.dumpSeq || 0;
                const peelLast = this._lastPeelSeq ?? 0;
                const dumpLast = this._lastDumpSeq ?? 0;
                const actionPending = peelBoard > peelLast || dumpBoard > dumpLast;
                const poolDrift = remoteLen !== localLen;

                if (winActive) {
                    if (this.isHost?.() && localLen > 0 && this.started && !this.gameStarted) {
                        return false;
                    }
                    if (localLen === 0) return false;
                    this._tilePool = [];
                    this._noteMpPoolApply(reason, localLen, 0, 'win-clear');
                    this._refreshPoolHud?.();
                    return true;
                }

                if (this.isHost?.()) {
                    return this._applyHostPoolFromBoardAuthority(board, reason, options, {
                        remoteLen,
                        localLen,
                        poolDrift
                    });
                }

                return this._applyGuestPoolFromBoardAuthority(board, reason, options, {
                    remoteLen,
                    localLen,
                    poolDrift,
                    actionPending,
                    peelBoard,
                    dumpBoard
                });
            },

            _noteMpPoolApply(reason, prevLen, nextLen, gate) {
                const wireLen = !this.isHost?.() ? this._mpGuestPoolWireLen?.() : null;
                this._lastMpPoolApply = {
                    reason: reason || null,
                    gate: gate || null,
                    prevLen,
                    nextLen,
                    wireLen,
                    cacheLag: wireLen != null && wireLen !== nextLen,
                    at: Date.now()
                };
                if (prevLen !== nextLen) {
                    console.log('[Bananagrams][pool] mirror', this._lastMpPoolApply);
                }
            },

            _applyHostPoolFromBoardAuthority(board, reason, options, ctx) {
                const { remoteLen, localLen, poolDrift } = ctx;
                const hostPlaying = this.gameStarted && !(this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW);
                if (hostPlaying) {
                    if (poolDrift) {
                        console.error('[Bananagrams][pool] host pool drift during play — refusing board mirror', {
                            reason,
                            boardPool: remoteLen,
                            livePool: localLen
                        });
                    }
                    this._syncHostPoolOnRoomCaches?.();
                    return false;
                }
                if (remoteLen === 0 && localLen > 0) return false;
                if (!poolDrift && !options.force && !options.reset) return false;
                this._tilePool = [...board.pool];
                this._noteMpPoolApply(reason, localLen, remoteLen, 'host-mirror');
                this._refreshPoolHud?.();
                return true;
            },

            _applyGuestPoolFromBoardAuthority(board, reason, options, ctx) {
                const { localLen } = ctx;
                const gate = options.inventorySynced
                    ? 'inventory-synced'
                    : (options.force || options.reset ? 'force' : 'wire-sync');
                this._mirrorGuestPoolFromBoard(board, reason, localLen, gate);
                this._refreshPoolHud?.();
                return true;
            },

            /** Guest read-path heal — _tilePool must always match wire board.pool. */
            _mpGuestEnsurePoolSynced(board) {
                if (this.isHost?.()) return true;
                const snap = board || this._mpBoardFromRoom?.(this.roomData);
                if (!snap || !Array.isArray(snap.pool)) return false;
                const localLen = this._tilePool?.length ?? 0;
                if (localLen === snap.pool.length) return true;
                this._mirrorGuestPoolFromBoard(snap, 'ensure-pool-sync', localLen, 'read-path');
                return true;
            },

            _mirrorGuestPoolFromBoard(board, reason, prevLen, gate) {
                (board.pool || []).forEach((id) => {
                    this._mpAssertIdDealEpoch?.(id, 'pool-authority');
                });
                this._tilePool = [...board.pool];
                if (typeof board.nextTileId === 'number') {
                    this._nextTileId = board.nextTileId;
                }
                this._noteMpPoolApply(reason, prevLen, board.pool.length, gate);
            },

            _applyMpSharedGameState(board, options = {}) {
                const inReview = this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                this._mpEnsureIdPoolModeFromBoard(board);
                this._mpMergeCanonicalFromBoard(board, options);
                if (typeof board.nextTileId === 'number') this._nextTileId = board.nextTileId;
                if (board.scores && typeof board.scores === 'object') {
                    this._mpScores = { ...board.scores };
                }
                if (this._hostReviewCompleting && !inReview) {
                    this._winnerUid = null;
                    this._victoryRegistered = false;
                    this.isOver = false;
                    this._winnerBannerUid = null;
                } else if (inReview) {
                    if (board.winnerUid) this._winnerUid = board.winnerUid;
                } else {
                    this._winnerUid = board.winnerUid || null;
                }
                if (inReview) {
                    this._freezeTimerOnVictory();
                } else {
                    const prevStarted = !!this.gameStarted;
                    const nextStartedRaw = !!board.gameStarted;
                    const nextStarted = this.isHost?.()
                        ? nextStartedRaw
                        : (nextStartedRaw && (this._mpGuestWireGameStarted?.(board) ?? nextStartedRaw));
                    const hostFaceUpPlay = this.isHost?.() && this.gameStarted && !nextStarted
                        && (this.tiles?.length || 0) > 0
                        && (this.tiles.some((t) => t.faceUp) || this._mpStartedAt)
                        && this._boardPhase(board) === BananagramsGame.MP_PHASE.PLAYING;
                    if (hostFaceUpPlay) {
                        // Stale pre-split board echo must not revert host mid-game after SPLIT.
                    } else if (this.isHost?.() && this.gameStarted && !nextStarted
                        && this.canMutatePlayingBoard?.() && (this.tiles?.length || 0) > 0) {
                        // Ignore stale gameStarted=false echoes while host is mid-game.
                    } else {
                        this.gameStarted = nextStarted;
                    }
                    if (typeof board.started === 'boolean') {
                        this.started = board.started;
                    } else if ((this.tiles?.length || 0) > 0) {
                        this.started = true;
                    }
                    if (board.startedAt && (this.isHost?.() || nextStarted)) {
                        this._mpStartedAt = board.startedAt;
                    }
                    if (this.gameStarted && board.startedAt) {
                        this._syncMpTimerFromBoard(board.startedAt);
                    } else if (!this.gameStarted) {
                        this._mpStartedAt = null;
                        this._stopTimer();
                    }
                    if (!this.isHost?.() && board.gameStarted && !prevStarted) {
                        this._projectGuestSplitFromBoard?.(board);
                    }
                }
        
                if (!options.hostSkipBanners) {
                    this._applyMpActionBanners(board);
                }
            },

            /** Peel/dump render refresh only — banners fire from _commitMpActionSeqFromBoard. */
            _applyMpActionBanners(board) {
                if (!board) return;
                const peelSeq = board.peelSeq || 0;
                const dumpSeq = board.dumpSeq || 0;
                const actionSeqAdvanced = peelSeq > (this._lastPeelSeq || 0)
                    || dumpSeq > (this._lastDumpSeq || 0);
                const devSolvePool = this._bananaDevHook('applyDevSolveFromBoard', board) === true;
                if (actionSeqAdvanced || devSolvePool) {
                    this.requestRender?.();
                }
            },

            _refreshPoolHud() {
                const poolEl = document.getElementById('banana-pool-count');
                if (!poolEl) return;
                const len = typeof this._mpAuthoritativeBunchLen === 'function'
                    ? this._mpAuthoritativeBunchLen()
                    : (this._tilePool?.length ?? 0);
                poolEl.textContent = String(len);
            },

            /** Reset per-tick idempotency flags at start of _applyMultiplayerBoard. */
            _resetBoardApplyOnceFlags() {
                this._boardApplyOnceFlags = { actionSeq: false, revision: false };
            },

            /** Peel/dump seq + banners — once per board apply tick (not in inventory pipeline). */
            _applyBoardActionSeqOnce(board) {
                if (this._boardApplyOnceFlags?.actionSeq) return;
                if (!this._boardApplyOnceFlags) this._resetBoardApplyOnceFlags();
                this._boardApplyOnceFlags.actionSeq = true;
                this._commitMpActionSeqFromBoard(board);
            },

            /** Guest structural revision ack — once per successful lifecycle boundary. */
            _applyBoardRevisionCommitOnce(board) {
                if (this.isHost?.() || this._boardApplyOnceFlags?.revision) return;
                if (!this._boardApplyOnceFlags) this._resetBoardApplyOnceFlags();
                this._boardApplyOnceFlags.revision = true;
                this._mpCommitAppliedBoardRevision?.(board);
            },

            /** Single lifecycle boundary for action-seq ack (+ guest revision when inventory ok). */
            _applyBoardLifecycleCommitOnce(board, { inventorySynced = false, boundaryOk = false } = {}) {
                if (!this.isHost?.() && inventorySynced && boundaryOk) {
                    this._applyBoardRevisionCommitOnce(board);
                }
                this._applyBoardActionSeqOnce(board);
            },

            /** Commit peel/dump seq only after inventory authority is in sync. */
            _commitMpActionSeqFromBoard(board) {
                if (!board) return;
                const req = this._mpRequireCoherent?.(board, 'action-seq-commit', { log: false });
                if (req && !req.ok) return;
                const peelSeq = board.peelSeq || 0;
                const dumpSeq = board.dumpSeq || 0;
                if (peelSeq > (this._lastPeelSeq || 0)) {
                    this._lastPeelSeq = peelSeq;
                    const actor = board.peelActorUid;
                    this._showBanner('Peel!', 2200, {
                        actorUid: actor !== undefined && actor !== null ? actor : null
                    });
                }
                if (dumpSeq > (this._lastDumpSeq || 0)) {
                    this._lastDumpSeq = dumpSeq;
                    const actor = board.dumpActorUid;
                    this._showBanner('Dump!', 2200, {
                        actorUid: actor !== undefined && actor !== null ? actor : null
                    });
                }
            },

            /** @see mp-epoch.js */

            /**
             * Tab reload: local inventory seq starts at 0 while board peel/dump seq is already
             * advanced. Without seeding, guests treat reload as a new peel/dump refresh and prefer
             * stale RTDB layout over localStorage.
             */
            _seedMpActionSeqForClientReload(board) {
                if (!board || !this._isMultiplayerMode?.()) return;
                if ((this._mpClientInventorySeq?.(this._myUid?.()) || 0) > 0 || (this.tiles?.length || 0) > 0) return;
                const peel = board.peelSeq || 0;
                const dump = board.dumpSeq || 0;
                if (peel <= (this._lastPeelSeq || 0) && dump <= (this._lastDumpSeq || 0)) return;
                this._lastPeelSeq = Math.max(this._lastPeelSeq || 0, peel);
                this._lastDumpSeq = Math.max(this._lastDumpSeq || 0, dump);
                if (this.isHost?.() && typeof board.boardRevision === 'number') {
                    this._mpBoardRevision = Math.max(this._mpBoardRevision || 0, board.boardRevision);
                }
            },

            _isFreshPostResetBoard(board) {
                if (!board || board.version < 2) return false;
                if ((board.peelSeq || 0) > 0 || (board.dumpSeq || 0) > 0) return false;
                const hands = board.tilesOwnedByPlayer || {};
                return Object.values(hands).some((h) => Array.isArray(h) && h.length > 0);
            },

            /** Same-epoch redeals restart board seq at SPLIT; startedAt advances. */
            _isSameEpochSoftResetBoard(board) {
                if (!board || this.isHost?.()) return false;
                const incSeq = board.seq ?? 0;
                const incStarted = board.startedAt ?? 0;
                if (incStarted <= 0) return false;
                const localSeq = this._boardSeq ?? 0;
                const localStarted = this._mpStartedAt ?? 0;
                return incSeq < localSeq && incStarted > localStarted
                    && (board.peelSeq || 0) === 0 && (board.dumpSeq || 0) === 0;
            },

            _applySameEpochSoftResetClientState(board, options = {}) {
                if (!board || this.isHost?.()) return options;
                if (!options.reset && !this._isSameEpochSoftResetBoard(board)) return options;
                this._boardSeq = board.seq ?? 0;
                if (board.boardRevision != null) {
                    this._mpBoardRevision = board.boardRevision;
                }
                this._mpClearRevisionClientState?.();
                this._mpStartedAt = board.startedAt ?? this._mpStartedAt;
                return { ...options, reset: true, force: true };
            },

            _inferBoardApplySource(options, traceCaller) {
                if (options.applySource) return options.applySource;
                const caller = traceCaller || options._traceCaller || '';
                if (caller.includes('deferred-drag')) return 'deferred-drag';
                if (options._revisionInventoryCatchUp || caller.includes('revision-inv')) {
                    return 'revision-inv-catch-up';
                }
                if (caller.includes('onNetworkUpdate')) return 'network';
                if (caller.includes('hostWriteBoard') || caller.includes('-local')) return 'host-publish-echo';
                return 'board-apply';
            },

            _noteBoardApply(source, traceLabel, board) {
                this._lastBoardApply = {
                    source: source || null,
                    traceLabel: traceLabel || null,
                    boardSeq: board?.seq ?? null,
                    localBoardSeq: this._boardSeq ?? null,
                    at: Date.now()
                };
            },

            /** Host playing: live, client, and wire inventorySeq aligned after publish echo. */
            _hostInventoryAuthoritySynced(board, uid) {
                if (!board || !uid) return false;
                const boardInv = this._boardInventorySeq(board, uid);
                const hostInv = this._hostLiveInventorySeq(uid);
                const clientInv = this._mpClientInventorySeq(uid);
                if (!boardInv) return hostInv === 0 && clientInv === 0;
                return hostInv === boardInv && clientInv === boardInv;
            },

            /** True when host ingress must run echo path (banners, phase, action seq) despite same board.seq. */
            _hostBoardIngressNeedsLightweightEcho(board) {
                if (!board) return false;
                if ((board.peelSeq || 0) > (this._lastPeelSeq ?? 0)) return true;
                if ((board.dumpSeq || 0) > (this._lastDumpSeq ?? 0)) return true;
                const rev = this._mpBoardRevisionField?.(board);
                if (rev != null && rev > (this._mpBoardRevision ?? 0)) return true;
                const phaseSnap = this._clientMpPhaseSnapshot?.(board);
                if (phaseSnap?.phaseDrift) return true;
                if ((board.winnerUid || null) !== (this._winnerUid || null)) return true;
                return false;
            },

            /**
             * Skip redundant host ingress — publish echo already committed this seq;
             * network RTDB echo must not re-run guest projection pipeline.
             */
            _hostIsStaleBoardIngress(board, options = {}) {
                if (!this.isHost?.() || options.reset || options.allowHostFullApply
                    || options._deferredDragFlush || options._layoutOnlyDeferredFlush) return false;
                const uid = this._myUid?.();
                if (!uid) return false;
                if (this._hostBoardIngressNeedsLightweightEcho(board)) return false;
                const incSeq = board?.seq ?? 0;
                const localSeq = this._boardSeq ?? 0;
                if (incSeq < localSeq) return true;
                if (incSeq > localSeq) return false;
                if (!this.gameStarted && !(board?.peelSeq || board?.dumpSeq)) return false;
                return this._hostInventoryAuthoritySynced(board, uid);
            },

            /** True when host is in active play and board must not mutate authority stores. */
            _hostIsActivePlayAuthority(board) {
                if (!this.isHost?.()) return false;
                if (this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW) return false;
                return !!(this.gameStarted && this.canMutatePlayingBoard?.());
            },

            /**
             * Drag-deferred layout catch-up — position projection + pool + lifecycle boundary.
             * Invoked from _applyMultiplayerBoard when _layoutOnlyDeferredFlush is set.
             */
            _applyDeferredDragLayoutFlushTick(board, options, traceCaller) {
                const uid = this._myUid();
                if (!uid || !board) return;
                this._applyMpActionBanners(board);
                if (!this.isHost?.() || this._hostMayIngestBoardToAuthority?.(board, options)) {
                    this._mpIngestBoardBeforeInventory?.(board);
                }
                this._traceDoneApply(board, options, traceCaller);
                const owned = this._boardAuthoritativeOwned(board, uid);
                const layoutChanged = this._projectLayoutPositionsOnly(board, uid, owned, {
                    ...options,
                    _inventoryApplySource: options._inventoryApplySource || 'deferred-drag-layout',
                    _deferredDragFlush: true
                });
                const inventorySynced = this._isInventorySyncedWithBoard?.(board, uid) ?? true;
                if (inventorySynced && board.seq != null) {
                    this._boardSeq = board.seq;
                }
                this._applyBoardPoolOnce(board, {
                    ...options,
                    inventorySynced
                }, `${traceCaller || 'deferred-drag'}-pool`);
                let guestBoundaryOk = true;
                if (inventorySynced && !this.isHost?.()) {
                    guestBoundaryOk = this._assertGuestInventoryBoundary?.(board, uid, 'deferred-drag-layout') ?? true;
                    if (!guestBoundaryOk) {
                        this._mpInventoryProjectionFailed = true;
                        this._scheduleMpInventoryReconcile?.({
                            _inventoryApplySource: 'deferred-drag-boundary'
                        });
                    }
                    guestBoundaryOk = guestBoundaryOk
                        && (this._assertGuestPoolCacheMirrored?.(board, 'deferred-drag-layout') ?? true);
                }
                this._applyBoardLifecycleCommitOnce(board, {
                    inventorySynced,
                    boundaryOk: guestBoundaryOk
                });
                if (layoutChanged) {
                    this.requestRender?.();
                    this._syncViewportAfterLayout?.();
                }
            },

            /**
             * Entry for post-drag deferred board apply — routes through _applyMultiplayerBoard
             * (revision gate, pool once, lifecycle commit, _noteBoardApply).
             */
            _applyDeferredDragBoardFlush(board, { actionClass = false } = {}) {
                if (!board) return;
                const baseOpts = {
                    _traceCaller: 'deferred-drag-flush',
                    applySource: 'deferred-drag',
                    _deferredDragFlush: true,
                    _inventoryApplySource: actionClass ? 'deferred-drag-action' : 'deferred-drag-layout'
                };
                if (actionClass) {
                    this._applyMultiplayerBoard(board, {
                        ...baseOpts,
                        force: true,
                        ...(this.isHost?.() ? { _hostAuthorityProjection: true } : {})
                    });
                    return;
                }
                this._applyMultiplayerBoard(board, {
                    ...baseOpts,
                    _layoutOnlyDeferredFlush: true
                });
            },

            /**
             * Guest/host inventory catch-up when board.seq or boardRevision lags wire inventorySeq.
             * Full lifecycle: inventory axis → shared state → boundary → pool once → action-seq.
             */
            _applyBoardInventoryCatchUpTick(board, uid, options, traceCaller) {
                if (!board || !uid) return;
                const catchUpSource = options.applySource || 'revision-inv-catch-up';
                this._noteBoardApply(catchUpSource, traceCaller, board);

                let invLayoutChanged = false;
                if (!this.isHost?.()) {
                    const req = this._mpRequireCoherent?.(board, 'inventory-apply', { ...options, log: false });
                    if (req && !req.ok) {
                        this._mpCoherenceBlock?.(board, 'inventory-apply', uid, {
                            _inventoryApplySource: options._inventoryApplySource || catchUpSource
                        });
                        this._applyBoardPoolOnce(board, options, `${traceCaller || 'board'}-pool-blocked`);
                        return;
                    }
                    invLayoutChanged = this._applyMpInventoryAxis(board, uid, {
                        ...options,
                        force: true,
                        _inventoryApplySource: options._inventoryApplySource || catchUpSource
                    });
                } else {
                    this._hostApplyLocalOwnedToTiles?.(uid);
                }

                const inventorySynced = this._isInventorySyncedWithBoard?.(board, uid) ?? true;
                if (inventorySynced) {
                    if (board.seq != null) {
                        this._boardSeq = board.seq;
                    }
                    this._applyMpSharedGameState(board, {
                        inventorySynced: true,
                        poolReason: `${traceCaller || 'board'}-inv-catch-up`
                    });
                } else {
                    this._logInventoryProjectionFailure?.('inv-catch-up-pending-inventory', board, uid);
                }

                this._applyBoardPoolOnce(board, {
                    ...options,
                    inventorySynced
                }, `${traceCaller || 'board'}-pool-inv-catch-up`);

                let guestBoundaryOk = true;
                if (inventorySynced && !this.isHost?.()) {
                    guestBoundaryOk = this._assertGuestInventoryBoundary?.(board, uid, catchUpSource) ?? true;
                    if (!guestBoundaryOk) {
                        this._mpInventoryProjectionFailed = true;
                        this._scheduleMpInventoryReconcile?.({
                            _inventoryApplySource: `${catchUpSource}-boundary`
                        });
                    }
                    guestBoundaryOk = guestBoundaryOk
                        && (this._assertGuestPoolCacheMirrored?.(board, catchUpSource) ?? true);
                }

                this._applyBoardLifecycleCommitOnce(board, {
                    inventorySynced,
                    boundaryOk: guestBoundaryOk
                });
                if (invLayoutChanged) {
                    this.requestRender?.();
                    this._syncViewportAfterLayout?.();
                }
            },

            _applyMultiplayerBoard(board, options = {}) {
                if (!board) return;
                this._resetBoardApplyOnceFlags();
                const recentReset = typeof this._isRecentProgrammaticReset === 'function'
                    && this._isRecentProgrammaticReset();
                if (this.isHost?.() && recentReset && !options.reset) {
                    const localWrite = (options._traceCaller || '').includes('hostWriteBoard');
                    if (!localWrite) {
                        if ((board.peelSeq || 0) > 0 || (board.dumpSeq || 0) > 0) return;
                        const myUid = this._myUid();
                        const inv = this._boardInventorySeq?.(board, myUid) ?? 0;
                        const handSize = this._handSizeForParty?.() || 0;
                        const ownedLen = board.tilesOwnedByPlayer?.[myUid]?.length || 0;
                        if (inv > 1 || (handSize > 0 && ownedLen > 0 && ownedLen < handSize)) {
                            return;
                        }
                    }
                }
                const hadTilesBeforeApply = (this.tiles?.length || 0) > 0;
                this._seedMpAppliedResetFromRoom();
                this._seedMpActionSeqForClientReload(board);
                const traceCaller = options._traceCaller
                    || (this._doneTraceOn()
                        ? (new Error().stack || '').split('\n').slice(1, 4).join(' | ')
                        : '');
                board = this._normalizeMpBoard(board);
                const applySource = this._inferBoardApplySource(options, traceCaller);
                this._noteBoardApply(applySource, traceCaller, board);
                if (this.isHost?.() && this._hostIsActivePlayAuthority(board)
                    && !options.reset && !options.force && !options.allowHostFullApply
                    && !options._layoutOnlyDeferredFlush) {
                    if (this._hostIsStaleBoardIngress(board, options)) {
                        if (this._hostBoardIngressNeedsLightweightEcho?.(board)) {
                            this._applyHostPublishEcho(board, traceCaller, {
                                ...options,
                                applySource
                            });
                        } else if (this._doneTraceOn()) {
                            console.log('[APPLY] host skip redundant ingress', {
                                applySource,
                                traceCaller,
                                boardSeq: board.seq,
                                localSeq: this._boardSeq
                            });
                        }
                        return;
                    }
                    this._hostApplyPlayingBoardIngress(board, traceCaller, {
                        ...options,
                        applySource
                    });
                    return;
                }
                if (this.isHost?.() && this._hostIsStaleBoardIngress(board, options)) {
                    if (this._hostBoardIngressNeedsLightweightEcho?.(board)) {
                        this._applyHostPublishEcho(board, traceCaller, {
                            ...options,
                            applySource
                        });
                    } else if (this._doneTraceOn()) {
                        console.log('[APPLY] host skip redundant ingress', {
                            applySource,
                            traceCaller,
                            boardSeq: board.seq,
                            localSeq: this._boardSeq
                        });
                    }
                    return;
                }
                if (this._mpAwaitReset && !this.isHost?.() && !(options.force && options.reset)) {
                    if (!this._isFreshPostResetBoard(board)) {
                        return;
                    }
                    options = { ...options, reset: true, force: true };
                }
                if (!options.reset && this._isFreshPostResetBoard(board)
                    && (this._clientMpPhaseSnapshot?.(board)?.uiReview
                        || this._mpClientMirrorInReview?.())
                    && !board.winnerUid && !board.gameStarted) {
                    this._exitReviewLocalState?.();
                    options = { ...options, reset: true, force: true };
                }
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                const epoch = S ? S.readResetCount(this.roomData) : (this.roomData?.global?.resetCount ?? 0);
                const appliedRc = this._mpAppliedResetCount || 0;
                if (epoch > appliedRc) {
                    this._mpAppliedResetCount = epoch;
                    this._boardSeq = 0;
                    this._mpClearRevisionClientState?.();
                    this._mpClearActionSeqForReset?.();
                    this._exitReviewLocalState();
                    if (!this._isFreshPostResetBoard(board)) {
                        if (!this.isHost?.()) {
                            this._mpAwaitReset = true;
                            this._clearMpTilesProjection?.('epoch-stale-board', { clearRegistry: true });
                            this.gameStarted = false;
                            this._mpStartedAt = null;
                            this._stopTimer();
                        }
                        this._logMpDiagnostic?.('epoch-stale-board-skipped', board, this._myUid?.(), {
                            caller: traceCaller,
                            boardSeq: board.seq,
                            gameStarted: board.gameStarted,
                            peelSeq: board.peelSeq,
                            dumpSeq: board.dumpSeq,
                            epochFlags: this._mpEpochFlagsSnapshot?.(board)
                        });
                        return;
                    }
                    options = { ...options, force: true, reset: true };
                }
                options = this._applySameEpochSoftResetClientState(board, options);
                if (!this._mpGuestRevisionAllowsBoardApply?.(board, options, traceCaller)) {
                    return;
                }
                const uidEarly = this._myUid();
                const invLag = uidEarly && this._mpInventorySeqLag?.(board, uidEarly);
                if (options._revisionInventoryCatchUp) {
                    if (!invLag) {
                        if (this._doneTraceOn?.()) {
                            console.log('[APPLY] revision inv catch-up skip — inventory synced', {
                                caller: traceCaller,
                                boardInv: uidEarly ? this._boardInventorySeq(board, uidEarly) : null,
                                localInv: this._mpClientInventorySeq?.(uidEarly) ?? 0
                            });
                        }
                        return;
                    }
                    this._applyBoardInventoryCatchUpTick(board, uidEarly, options, traceCaller);
                    return;
                }
                if (options._layoutOnlyDeferredFlush) {
                    this._applyDeferredDragLayoutFlushTick(board, options, traceCaller);
                    return;
                }
                this._applyMpActionBanners(board);
                if (!this.isHost?.() || this._hostMayIngestBoardToAuthority?.(board, options)) {
                    this._mpIngestBoardBeforeInventory?.(board);
                }
                this._traceDoneApply(board, options, traceCaller);
                const canApply = options.force || options.reset
                    || this.sync?.shouldApplyBoard?.(appliedRc, epoch, this._boardSeq, board)
                    || (!this.sync && (!S || S.shouldApplyBoard(
                        appliedRc, epoch, this._boardSeq, board, this._mpStartedAt
                    )));
                if (!canApply && !invLag) {
                    if (this._doneTraceOn()) {
                        console.log('[APPLY] skipped', {
                            caller: traceCaller,
                            boardSeq: board.seq,
                            localSeq: this._boardSeq,
                            epoch,
                            appliedRc
                        });
                    }
                    return;
                }
                if (!canApply && invLag) {
                    this._applyBoardInventoryCatchUpTick(board, uidEarly, {
                        ...options,
                        applySource: options.applySource || 'board-inv-lag',
                        _inventoryApplySource: options._inventoryApplySource || 'board-inv-lag'
                    }, traceCaller);
                    return;
                }

                if (this.isHost?.() && !options.reset && !options.force) {
                    const party = this._getPlayerUids();
                    if (party.length >= 2) {
                        const hands = board.tilesOwnedByPlayer || {};
                        const dealt = party.filter((u) => (hands[u]?.length || 0) > 0).length;
                        if (dealt > 0 && dealt < party.length) {
                            this._logInventoryProjectionFailure?.('host-partial-party', board, this._myUid?.(), {
                                caller: traceCaller,
                                dealt,
                                party: party.length
                            });
                            const myUid = this._myUid?.();
                            if (!myUid || !(hands[myUid]?.length)) {
                                return;
                            }
                            options = { ...options, force: true };
                            this._maybeSetupMultiplayer?.();
                        }
                    }
                }

                if (this._isStaleReviewBoard(board)) {
                    if (this._doneTraceOn()) {
                        console.log('[APPLY] skipped stale review', {
                            caller: traceCaller,
                            boardSeq: board.seq,
                            reviewEpoch: board.reviewEpoch,
                            closed: this._mpReviewEpochClosed
                        });
                    }
                    return;
                }
                if (this._isStalePlayingBoardWhileInReview(board, options)) {
                    this._reviewDbg?.('ignore-stale-playing', {
                        caller: traceCaller,
                        boardSeq: board.seq,
                        localSeq: this._boardSeq,
                        phase: board.phase
                    });
                    return;
                }
        
                const uid = this._myUid();
                const inReview = this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                // Guest SSOT: freeze ending layout before review board can mutate this.tiles.
                if (inReview && !this.isHost?.() && !this._myEndingLayoutPublished) {
                    const me = uid;
                    if (me && !this._endingLayoutsCache?.[me]?.length) {
                        this._freezeMyEndingLayout?.();
                    }
                }
                if (this._hostReviewCompleting && inReview) {
                    return;
                }
                const leavingReview = this._mpClientMirrorInReview?.()
                    && !inReview;
                if (leavingReview) {
                    const spuriousPlayingDuringReview = !board.winnerUid
                        && (this._reviewUiActive?.() || this._winnerUid || this.isOver);
                    if (spuriousPlayingDuringReview) {
                        this._reviewDbg?.('ignore-leaving-review-echo', {
                            boardSeq: board.seq,
                            localSeq: this._boardSeq,
                            gameStarted: board.gameStarted
                        });
                        return;
                    }
                    const applyLeavingReview = !board.winnerUid
                        || board.gameStarted
                        || (!this._winnerUid && !this.isOver && !this._hostReviewTransitionActive);
                    if (applyLeavingReview) {
                        this._exitReviewLocalState();
                        options = { ...options, reset: true, force: true };
                    } else {
                        return;
                    }
                }
        
                const pendingBoardSeq = board.seq;

                this._mirrorBananaAckFromBoard(board);
                if (this._hostMayIngestBoardToAuthority?.(board, options)) {
                    this._mirrorHostInventoryFromBoard(board);
                }

                const preservePlayViewport = !!(this.isMobileViewport?.()
                    && this._usesPanZoomBoard?.()
                    && this.gameStarted
                    && this._fitZoomInitialized
                    && !options.reset
                    && !leavingReview);
                let savedPlayViewport = null;
                if (preservePlayViewport) {
                    savedPlayViewport = {
                        panX: this.canvasPanX,
                        panY: this.canvasPanY,
                        zoom: this.zoom,
                        targetZoom: this.targetZoom,
                        focalX: this._viewportFocal?.x ?? null,
                        focalY: this._viewportFocal?.y ?? null
                    };
                }
        
                let layoutChanged = this._applyMpInventoryAxis(board, uid, options);
                const inventorySynced = this._isInventorySyncedWithBoard?.(board, uid) ?? true;
                if (!inventorySynced && !options.reset) {
                    this._logInventoryProjectionFailure?.('lifecycle-blocked-pending-inventory', board, uid);
                } else if (pendingBoardSeq != null) {
                    this._boardSeq = pendingBoardSeq;
                }
                if (options.reset && !this.isHost?.()) {
                    this._mpCommitAppliedBoardRevision?.(board);
                }
                if (leavingReview && this.tiles?.length && !board.gameStarted) {
                    this._mutateMpTilesInPlace?.('leave-review-face-down', (tiles) => {
                        tiles.forEach((t) => { t.faceUp = false; });
                        return true;
                    }, { mode: 'playing' });
                    layoutChanged = true;
                }
                this._syncClientPhaseFromBoard(board);

                if (inReview) {
                    this._noteReviewEpochFromBoard(board);
                } else if ((board.reviewEpoch ?? 0) === 0) {
                    this._closeReviewEpoch();
                    if (board.reviewEpochClosed != null) {
                        this._mpReviewEpochClosed = Math.max(
                            this._mpReviewEpochClosed ?? 0,
                            board.reviewEpochClosed
                        );
                    }
                }

                let guestBoundaryOk = true;
                if (inventorySynced) {
                    this._applyMpSharedGameState(board, {
                        inventorySynced: true,
                        poolReason: `${traceCaller || 'board'}-inv-synced`
                    });
                }

                this._applyBoardPoolOnce(board, {
                    ...options,
                    inventorySynced
                }, `${traceCaller || 'board'}-pool`);

                if (inventorySynced && !this.isHost?.()) {
                    guestBoundaryOk = this._assertGuestInventoryBoundary?.(board, uid, 'post-lifecycle') ?? true;
                    if (!guestBoundaryOk) {
                        this._mpInventoryProjectionFailed = true;
                        this._scheduleMpInventoryReconcile?.({
                            _inventoryApplySource: 'post-lifecycle-boundary'
                        });
                    }
                    guestBoundaryOk = guestBoundaryOk
                        && (this._assertGuestPoolCacheMirrored?.(board, 'post-lifecycle') ?? true);
                }

                this._applyBoardLifecycleCommitOnce(board, {
                    inventorySynced,
                    boundaryOk: guestBoundaryOk
                });
                if (leavingReview) {
                    if (board.gameStarted) {
                        if (!this.isHost?.()) {
                            this._mutateMpTilesInPlace?.('leave-review-split-face-up', (tiles) => {
                                tiles.forEach((t) => { t.faceUp = true; });
                                return true;
                            }, { mode: 'playing' });
                        }
                    } else {
                        this.gameStarted = false;
                        this._mpStartedAt = null;
                        this._stopTimer();
                    }
                }
        
                if (inReview && board.winnerUid && board.winnerUid !== this._winnerBannerUid) {
                    this._winnerBannerUid = board.winnerUid;
                    this._winnerUid = board.winnerUid;
                    if (!this._victoryRegistered) {
                        const hostUid = this.roomData?.host || '';
                        const hubWinner = board.winnerUid === hostUid ? 'P1' : 'P2';
                        this.clearAutoReset();
                        this._registerVictoryWithoutAutoReset(hubWinner, { winnerUid: board.winnerUid });
                    }
                } else if (!inReview && !board.winnerUid) {
                    const roomWinner = this.roomData?.global?.board?.winnerUid;
                    const keepVictory = !this.canMutatePlayingBoard?.();
                    if (!roomWinner && !keepVictory
                        && (this._victoryRegistered || this.isOver || this._winnerUid)) {
                        this._victoryRegistered = false;
                        this.isOver = false;
                        this._winnerUid = null;
                        this._winnerBannerUid = null;
                        this.winner = null;
                        window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
                    }
                }
        
                if (inReview) {
                    this._applyMpReviewFromBoard(board);
                    this._ensureReviewTilesProjected?.(board);
                } else if (this._tryWinPendingReviewProjection?.(board)) {
                    layoutChanged = true;
                } else if (layoutChanged && (this._reviewUiActive?.() || this._inReviewExperience?.())) {
                    const snap = this._boardReviewSnapshot?.();
                    if (snap && this._boardPhase(snap) === BananagramsGame.MP_PHASE.REVIEW) {
                        this._applyMpReviewFromBoard(snap);
                        this._ensureReviewTilesProjected?.(snap);
                    }
                }
                this._traceDoneFlags(`apply-exit:${traceCaller.slice(0, 40)}`);
        
                this._updateHudEl();
                this.renderScoreboard();
                if (this.isMobileViewport?.() && this._usesPanZoomBoard?.() && !inReview && (this.tiles?.length || 0) > 0) {
                    const needsMobileRefit = !this._fitZoomInitialized || options.reset || leavingReview;
                    if (needsMobileRefit && (options.reset || leavingReview)) {
                        this._fitZoomInitialized = false;
                        this._mobileLayoutAnchorLocked = false;
                    }
                    if (needsMobileRefit) {
                        if (this._mobileLayoutAnchorLocked
                            && typeof this.refreshMobileLayoutViewportOnly === 'function') {
                            this.refreshMobileLayoutViewportOnly();
                        } else {
                            this.refreshMobileLayout();
                        }
                    }
                }
                if (layoutChanged) {
                    this.requestRender();
                    const shouldSyncViewport = !!(options.reset
                        || leavingReview
                        || (!hadTilesBeforeApply && (this.tiles?.length || 0) > 0)
                        || (this.isMobileViewport?.() && this._usesPanZoomBoard?.() && !this._fitZoomInitialized));
                    if (leavingReview && typeof this._resetPlayingViewportAfterReview === 'function') {
                        this._resetPlayingViewportAfterReview();
                    }
                    if (shouldSyncViewport) this._syncViewportAfterLayout();
                } else {
                    this.requestRender();
                    if (inReview && this.tiles?.length) {
                        this._syncViewportAfterLayout();
                        if (typeof this._scheduleReviewViewportBurst === 'function') {
                            this._scheduleReviewViewportBurst('mp-board-apply-review');
                        }
                    }
                }

                if (savedPlayViewport) {
                    this.canvasPanX = savedPlayViewport.panX;
                    this.canvasPanY = savedPlayViewport.panY;
                    this.zoom = savedPlayViewport.zoom;
                    this.targetZoom = savedPlayViewport.targetZoom;
                    if (savedPlayViewport.focalX != null && savedPlayViewport.focalY != null) {
                        this._viewportFocal = {
                            x: savedPlayViewport.focalX,
                            y: savedPlayViewport.focalY
                        };
                    }
                    if (typeof GameViewport !== 'undefined') {
                        GameViewport.applyPanZoom(this);
                    }
                }

            },

            _collectMpBoardPlayers() {
                const tilesOwnedByPlayer = {};
                if (!this.isHost()) return { tilesOwnedByPlayer };
                this._hostRepairOwnedFromCanonical?.('board-write');
                this._hostEnsureMpStores();
                const active = new Set(this._getPlayerUids());
                const hostUid = this.roomData?.host || this._myUid();
                if (hostUid) active.add(hostUid);
                active.forEach((uid) => {
                    const owned = this._mpOwned?.[uid] || [];
                    if (!owned.length) return;
                    tilesOwnedByPlayer[uid] = owned.map((t) => ({
                        id: String(t.id),
                        faceUp: !!t.faceUp
                    }));
                });
                return { tilesOwnedByPlayer };
            },

            /** Host: tile positions for all players — staged authority only during active play. */
            _collectMpBoardPositions() {
                const tilePositionsByPlayer = {};
                if (!this.isHost()) return { tilePositionsByPlayer };
                this._hostEnsureMpStores();
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};

                const hostPlaying = this._hostIsPlayingLayoutAuthority?.();
                const roomBoard = this._mpBoardFromRoom(this.roomData) || {};
                const allowWireFallback = !hostPlaying;

                const active = new Set(this._getPlayerUids());
                const hostUid = this.roomData?.host || this._myUid();
                if (hostUid) active.add(hostUid);

                const layoutGaps = [];
                active.forEach((uid) => {
                    const ownedRaw = this._mpOwned?.[uid] || [];
                    if (!ownedRaw.length) return;
                    const owned = this._mpNormalizeBoardOwned?.(ownedRaw) || ownedRaw;
                    const positions = this._hostStagedLayoutForPublish?.(uid, owned, {
                        allowWireFallback,
                        board: roomBoard
                    });
                    if (!positions || !Object.keys(positions).length) {
                        layoutGaps.push(String(uid).slice(-14));
                        return;
                    }
                    const list = Object.entries(positions)
                        .filter(([, p]) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
                        .map(([id, p]) => ({
                            id,
                            x: Math.round(p.x),
                            y: Math.round(p.y)
                        }));
                    if (list.length) tilePositionsByPlayer[uid] = list;
                });

                if (layoutGaps.length && hostPlaying) {
                    const detail = { uids: layoutGaps, hostPlaying: true };
                    if (typeof BananaDev !== 'undefined' && BananaDev.failAuthorityCommit) {
                        BananaDev.failAuthorityCommit('host publish layout incomplete', detail);
                    } else {
                        console.error('[Bananagrams][layout] host publish layout incomplete', detail);
                    }
                }

                this._lastMpLayoutPublish = {
                    hostPlaying: !!hostPlaying,
                    allowWireFallback,
                    playerCount: Object.keys(tilePositionsByPlayer).length,
                    gaps: layoutGaps,
                    at: Date.now()
                };

                return { tilePositionsByPlayer };
            },

            _hostCancelPendingBoardSync() {
                this._hostSyncQueued = false;
                if (this._hostSyncRaf) {
                    cancelAnimationFrame(this._hostSyncRaf);
                    this._hostSyncRaf = 0;
                }
                if (this._hostSyncTimer) {
                    clearTimeout(this._hostSyncTimer);
                    this._hostSyncTimer = 0;
                }
            },

            /**
             * Host HUD refresh only — live _tilePool is play authority.
             * roomData.global.board.pool updates only via _hostPublishBoard (full publish).
             */
            _refreshHostPoolHud() {
                if (!this.isHost?.()) return;
                this._refreshPoolHud?.();
            },

            /** Dev/test: host pool copies — live vs in-memory roomData vs wire snapshot. */
            _snapshotHostPoolStores() {
                if (!this.isHost?.()) return null;
                const live = this._tilePool?.length ?? 0;
                const roomGlobal = this.roomData?.global?.board?.pool;
                const roomGlobalLen = Array.isArray(roomGlobal) ? roomGlobal.length : null;
                const roomState = this.roomData?.state?.board?.pool;
                const roomStateLen = Array.isArray(roomState) ? roomState.length : null;
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                const canonBoard = S?.readBoardFromRoom?.(this.roomData);
                const canonLen = Array.isArray(canonBoard?.pool) ? canonBoard.pool.length : null;
                return {
                    live,
                    roomGlobal: roomGlobalLen,
                    roomState: roomStateLen,
                    canonical: canonLen,
                    display: this._mpDisplayPoolLen?.() ?? live,
                    drift: {
                        roomGlobalVsLive: roomGlobalLen != null && roomGlobalLen !== live,
                        roomStateVsLive: roomStateLen != null && roomStateLen !== live,
                        canonicalVsLive: canonLen != null && canonLen !== live
                    },
                    note: 'Host SSOT during play is _tilePool; roomData pool mirrors publish only'
                };
            },

            /** @deprecated — use _refreshHostPoolHud; no longer mutates roomData pool caches. */
            _syncHostPoolOnRoomCaches() {
                if (this.isHost?.() && Array.isArray(this._tilePool)) {
                    const pool = [...this._tilePool];
                    const board = this.roomData?.global?.board;
                    if (board) {
                        board.pool = pool;
                        if (this.roomData?.state?.board) {
                            this.roomData.state.board.pool = pool;
                        }
                    }
                }
                this._refreshHostPoolHud();
            },

            _hostPublishBoard(board, traceLabel, applyOptions = {}) {
                if (!this.roomData) this.roomData = {};
                if (!this.roomData.global) this.roomData.global = {};
                if (this.isHost?.()) {
                    this._mpBoardRevision = (this._mpBoardRevision || 0) + 1;
                    board.boardRevision = this._mpBoardRevision;
                }
                const REVIEW = BananagramsGame.MP_PHASE.REVIEW;
                const isPlayingPublish = board?.phase !== REVIEW
                    && (this.gameStarted || (board?.dumpSeq || 0) > 0 || (board?.peelSeq || 0) > 0);
                if (this.isHost?.() && isPlayingPublish) {
                    if (!this._hostAssertPublishBoardAuthority?.(board)) {
                        console.error('[Bananagrams][host] refusing publish — authority mismatch', {
                            traceLabel
                        });
                        return false;
                    }
                    if (!this._hostAssertPeelSerializedBoardAuthority?.(board)) {
                        console.error('[Bananagrams][host] refusing publish — peel authority mismatch', {
                            traceLabel
                        });
                        return false;
                    }
                    if (!this._hostAssertSerializedSplitBoardAuthority?.(board)) {
                        console.error('[Bananagrams][host] refusing publish — split authority mismatch', {
                            traceLabel
                        });
                        return false;
                    }
                }
                this.roomData.global.board = board;
                if (this.isHost?.() && Array.isArray(this._tilePool)) {
                    board.pool = [...this._tilePool];
                }
                this._traceDoneWrite({ 'global/board': board }, traceLabel);
                this.updateMetadata({ 'global/board': board });
                this.renderScoreboard();
                const isReviewBoard = board?.phase === REVIEW;
                if (isReviewBoard) {
                    this._applyMultiplayerBoard(board, {
                        force: true,
                        applySource: 'host-publish-review',
                        allowHostFullApply: true,
                        _traceCaller: applyOptions._traceCaller || `${traceLabel}-local`
                    });
                } else if (isPlayingPublish && !applyOptions.allowHostFullApply) {
                    this._applyHostPublishEcho(board, traceLabel, applyOptions);
                } else {
                    this._applyMultiplayerBoard(board, {
                        force: true,
                        applySource: 'host-publish',
                        allowHostFullApply: true,
                        _traceCaller: applyOptions._traceCaller || `${traceLabel}-local`
                    });
                }
                return true;
            },

            /**
             * Single host write path for global/board (playing inventory sync or review transition).
             * @param {'playing'|'review'} mode
             * @returns {boolean} whether the write committed (false = blocked or not host)
             */
            _hostWriteBoard(mode, options = {}) {
                if (!this._isMultiplayerMode() || !this.isHost()) return false;

                const REVIEW = BananagramsGame.MP_PHASE.REVIEW;
                const isReview = mode === 'review';

                if (isReview) {
                    if (typeof this._hostMaySyncReview === 'function' && !this._hostMaySyncReview()) {
                        return false;
                    }
                    this._hostCancelPendingBoardSync();
                    this.isOver = true;

                    const remoteBoard = this.sync?.readBoard?.(this.roomData)
                        || (typeof RtdbSchema !== 'undefined' && RtdbSchema.readBoardFromRoom
                            ? RtdbSchema.readBoardFromRoom(this.roomData)
                            : this._boardReviewSnapshot());
                    const remoteSeq = remoteBoard?.seq ?? 0;
                    const origLayouts = typeof this._ensureReviewLayoutsSnapshot === 'function'
                        ? this._ensureReviewLayoutsSnapshot()
                        : (this._reviewLayouts || {});
                    const displayLayouts = typeof this._displayReviewLayoutsFromOrig === 'function'
                        ? this._displayReviewLayoutsFromOrig(origLayouts)
                        : origLayouts;
                    const fp = typeof this._reviewLayoutsFingerprint === 'function'
                        ? this._reviewLayoutsFingerprint(displayLayouts)
                        : null;
                    const remoteFp = remoteBoard?.reviewLayouts
                        && typeof this._reviewLayoutsFingerprint === 'function'
                        ? this._reviewLayoutsFingerprint(remoteBoard.reviewLayouts)
                        : null;
                    const partyUids = this._getPlayerUids?.() || [];
                    const remoteOrig = remoteBoard?.reviewLayoutsOrig || remoteBoard?.reviewLayouts || {};
                    const remoteLayoutsReady = typeof this._reviewLayoutsReady === 'function'
                        ? this._reviewLayoutsReady(remoteOrig, partyUids)
                        : true;
                    const localLayoutsReady = typeof this._reviewLayoutsReady === 'function'
                        ? this._reviewLayoutsReady(origLayouts, partyUids)
                        : true;
                    const skipRtdbWrite = remoteBoard?.phase === REVIEW
                        && remoteFp
                        && fp === remoteFp
                        && remoteLayoutsReady;
                    if (skipRtdbWrite) {
                        this._reviewLayoutsSyncedFp = fp;
                        this._mpReviewEpoch = remoteBoard.reviewEpoch ?? this._mpReviewEpoch;
                        const local = this._boardReviewSnapshot();
                        if (typeof this._isBoardInReview === 'function' && !this._isBoardInReview(local)) {
                            this._hostPublishBoard(
                                { ...remoteBoard, pool: [] },
                                'hostWriteBoard-review-refresh',
                                { _traceCaller: 'hostWriteBoard-review-refresh' }
                            );
                        } else if (localLayoutsReady) {
                            const display = typeof this._displayReviewLayoutsFromOrig === 'function'
                                ? this._displayReviewLayoutsFromOrig(origLayouts)
                                : origLayouts;
                            this._reviewLayoutsFp = null;
                            this._applyReviewLayouts?.(display);
                            this._ensureReviewTilesProjected?.(remoteBoard);
                        }
                        if (options.processBananaInteractions !== false) {
                            this._processBananaInteractions(this.roomData?.interactions?.banana);
                        }
                        return true;
                    }
                    this._boardSeq = Math.max(this._boardSeq || 0, remoteSeq) + 1;
                    if (typeof this._logReviewBoards === 'function') {
                        this._logReviewBoards('sync-to-board', displayLayouts);
                    }
                    const board = this._cleanBoardPayload(this.serializeBoard());
                    board.seq = this._boardSeq;
                    board.phase = REVIEW;
                    board.pool = [];
                    board.winnerUid = this._winnerUid || board.winnerUid || null;
                    board.reviewLayoutsOrig = JSON.parse(JSON.stringify(origLayouts));
                    board.reviewLayouts = displayLayouts;
                    const closed = this._mpReviewEpochClosed ?? 0;
                    board.reviewEpoch = closed + 1;
                    this._mpReviewEpoch = board.reviewEpoch;
                    this._hostPublishBoard(board, 'hostWriteBoard-review', {
                        _traceCaller: 'hostWriteBoard-review'
                    });
                    this._setGamePhase?.('review');
                    if (options.processBananaInteractions !== false) {
                        this._processBananaInteractions(this.roomData?.interactions?.banana);
                    }
                    return true;
                }

                const preSplitDealPublish = this.started && !this.gameStarted
                    && Object.values(this._mpOwned || {}).some((h) => h?.length > 0);
                if (!this.canMutatePlayingBoard?.() && !preSplitDealPublish) {
                    return false;
                }

                this._hostSyncQueued = false;
                this._boardSeq += 1;
                const board = this._cleanBoardPayload(this.serializeBoard());
                board.pool = [...this._tilePool];
                this._bananaDevHook('augmentPlayingBoard', board);
                if (board.phase !== REVIEW) {
                    board.winnerUid = null;
                    board.reviewLayouts = null;
                    board.reviewLayoutsOrig = null;
                    board.reviewEpoch = 0;
                    board.reviewEpochClosed = this._mpReviewEpochClosed ?? 0;
                    const { tilePositionsByPlayer } = this._collectMpBoardPositions();
                    if (Object.keys(tilePositionsByPlayer).length) {
                        board.tilePositionsByPlayer = tilePositionsByPlayer;
                    }
                } else if (!board.reviewEpoch) {
                    const closed = this._mpReviewEpochClosed ?? 0;
                    board.reviewEpoch = closed + 1;
                    this._mpReviewEpoch = board.reviewEpoch;
                }
                if (!this._hostPublishBoard(board, 'hostWriteBoard-playing', {
                    _traceCaller: 'hostWriteBoard-playing'
                })) {
                    return false;
                }
                return true;
            },

            /** @returns {boolean} whether playing board publish committed */
            _hostSyncBoard(options = {}) {
                if (!this._isMultiplayerMode() || !this.isHost()) return false;
                if (options.immediate !== false) {
                    return this._flushHostSyncBoard();
                }
                this._hostSyncQueued = true;
                const ensureTimer = () => {
                    if (this._hostSyncTimer) return;
                    this._hostSyncTimer = setTimeout(() => {
                        this._hostSyncTimer = 0;
                        if (!this._hostSyncQueued) return;
                        if (this._hostSyncRaf) {
                            cancelAnimationFrame(this._hostSyncRaf);
                            this._hostSyncRaf = 0;
                        }
                        this._flushHostSyncBoard();
                    }, 80);
                };
                if (this._hostSyncRaf) {
                    ensureTimer();
                    return;
                }
                this._hostSyncRaf = requestAnimationFrame(() => {
                    this._hostSyncRaf = 0;
                    this._flushHostSyncBoard();
                });
                ensureTimer();
                return true;
            },

            _hostReconcileOwnedFromRoomBoard() {
                if (!this.isHost()) return;
                const board = this._mpBoardFromRoom(this.roomData);
                if (!this._hostMayIngestBoardToAuthority?.(board)) return;
                if (typeof this._isRecentProgrammaticReset === 'function'
                    && this._isRecentProgrammaticReset()) {
                    return;
                }
                const hands = board?.tilesOwnedByPlayer || {};
                this._hostEnsureMpStores();
                this._getPlayerUids().forEach((uid) => {
                    if (this._mpOwned[uid]?.length) return;
                    const owned = hands[uid];
                    if (Array.isArray(owned) && owned.length) {
                        this._hostSetOwned(uid, owned, false, {
                            source: 'rtdb',
                            action: 'sync',
                            ctx: `host-set-owned:${uid}`,
                            msgType: 'reconcile-board'
                        });
                    }
                });
            },

            /** @returns {boolean} whether playing board publish committed */
            _flushHostSyncBoard() {
                if (!this._isMultiplayerMode() || !this.isHost()) return false;
                const party = this._getPlayerUids();
                if (party.length >= 2) {
                    const dealt = party.filter((u) => (this._mpOwned?.[u]?.length || 0) > 0).length;
                    if (dealt > 0 && dealt < party.length) {
                        const midGame = this.gameStarted
                            || (this._dumpSeq || 0) > 0
                            || (this._peelSeq || 0) > 0;
                        if (midGame) {
                            console.error('[Bananagrams][host] partial party mid-game — refusing reconcile/publish', {
                                dealt,
                                party: party.length
                            });
                            this._hostCancelPendingBoardSync?.();
                            return false;
                        }
                        this._setupMultiplayerHand?.(party);
                        return true;
                    }
                }
                const preSplitDealPublish = this.started && !this.gameStarted
                    && Object.values(this._mpOwned || {}).some((h) => h?.length > 0);
                if (!this.canMutatePlayingBoard?.() && !preSplitDealPublish) {
                    this._hostCancelPendingBoardSync();
                    return false;
                }
                if (this._hostSyncTimer) {
                    clearTimeout(this._hostSyncTimer);
                    this._hostSyncTimer = 0;
                }
                this._hostSyncQueued = false;
                if (!this.gameStarted) {
                    this._hostReconcileOwnedFromRoomBoard?.();
                }
                const ok = this._hostWriteBoard('playing');
                if (ok) {
                    this._processBananaInteractions?.(this.roomData?.interactions?.banana);
                }
                return !!ok;
            },

            _cleanBoardPayload(board) {
                const clean = JSON.parse(JSON.stringify(board));
                const scrub = (val) => {
                    if (typeof val === 'number' && !Number.isFinite(val)) return null;
                    if (Array.isArray(val)) return val.map(scrub);
                    if (val && typeof val === 'object') {
                        Object.keys(val).forEach((k) => { val[k] = scrub(val[k]); });
                    }
                    return val;
                };
                return scrub(clean);
            },

            serializeBoard() {
                if (this._isMultiplayerMode()) {
                    const uids = this._getPlayerUids();
                    const { tilesOwnedByPlayer } = this._collectMpBoardPlayers();
                    const inventorySeq = {};
                    uids.forEach((uid) => {
                        inventorySeq[uid] = this._mpInventorySeq?.[uid] ?? 1;
                    });
                    const payload = {
                        version: this._mpPoolUsesTileIds?.() ? 5 : 4,
                        seq: this._boardSeq,
                        boardRevision: this._mpBoardRevision || 0,
                        resetCount: this._readRoomResetCount?.() ?? (this.roomData?.global?.resetCount ?? 0),
                        playerUids: uids,
                        handSize: this._handSizeForParty(),
                        pool: [...this._tilePool],
                        poolUsesTileIds: !!this._mpPoolUsesTileIds?.(),
                        gameStarted: this.gameStarted,
                        startedAt: this._mpStartedAt || null,
                        winnerUid: null,
                        nextTileId: this._nextTileId,
                        dealEpoch: this._mpDealEpoch?.() ?? 0,
                        started: this.started,
                        peelSeq: this._peelSeq || 0,
                        peelActorUid: (this._peelSeq || 0) > 0 ? (this._peelActorUid || null) : null,
                        dumpSeq: this._dumpSeq || 0,
                        dumpActorUid: (this._dumpSeq || 0) > 0 ? (this._dumpActorUid || null) : null,
                        scores: { ...this._mpScores },
                        tilesOwnedByPlayer,
                        inventorySeq
                    };
                    if (this._mpPoolUsesTileIds?.() && this._mpCanonicalById) {
                        payload.canonical = { ...this._mpCanonicalById };
                    }
                    if (this.isHost() && this._bananaAck && Object.keys(this._bananaAck).length) {
                        payload.bananaAck = { ...this._bananaAck };
                    }
                    if (this._lastPeelDraws) payload.peelDraws = this._lastPeelDraws;
                    if (this._lastMpDumpTxn) payload.lastDumpTxn = { ...this._lastMpDumpTxn };
                    if (this._lastMpPeelTxn) payload.lastPeelTxn = { ...this._lastMpPeelTxn };
                    if (this.gameStarted && this._lastMpSplitTxn) {
                        const epoch = Math.max(
                            this.lastResetCount ?? 0,
                            this._readRoomResetCount?.() ?? 0
                        );
                        payload.lastSplitTxn = {
                            ...this._lastMpSplitTxn,
                            resetCount: epoch
                        };
                    } else {
                        payload.lastSplitTxn = null;
                    }
                    const preSplitDeal = this.started && !this.gameStarted && !this._winnerUid;
                    const snap = this._boardReviewSnapshot();
                    let inReview = !preSplitDeal
                        && !this._hostReviewCompleting
                        && (this._hostReviewTransitionActive
                            || this._boardPhase(snap) === BananagramsGame.MP_PHASE.REVIEW);
                    if (this.isHost?.() && this.gameStarted && !this._reviewUiActive?.()
                        && !this._hostReviewTransitionActive) {
                        inReview = false;
                    }
                    payload.phase = inReview
                        ? BananagramsGame.MP_PHASE.REVIEW
                        : BananagramsGame.MP_PHASE.PLAYING;
                    if (inReview) {
                        payload.winnerUid = this._winnerUid || null;
                        const orig = typeof this._ensureReviewLayoutsSnapshot === 'function'
                            ? this._ensureReviewLayoutsSnapshot()
                            : (this._reviewLayouts || {});
                        if (typeof this._displayReviewLayoutsFromOrig === 'function') {
                            payload.reviewLayouts = this._displayReviewLayoutsFromOrig(orig);
                            payload.reviewLayoutsOrig = JSON.parse(JSON.stringify(orig));
                        } else {
                            payload.reviewLayouts = { ...(orig || {}) };
                        }
                    } else {
                        payload.winnerUid = null;
                        const { tilePositionsByPlayer } = this._collectMpBoardPositions();
                        if (Object.keys(tilePositionsByPlayer).length) {
                            payload.tilePositionsByPlayer = tilePositionsByPlayer;
                        }
                    }
                    return payload;
                }
                return {
                    version: 1,
                    bagMode: this._soloBagLabel(),
                    soloHandSize: typeof BananaRules !== 'undefined' ? BananaRules.SOLO_HAND : undefined,
                    tiles: this.tiles.map((t) => ({
                        id: t.id,
                        letter: t.letter,
                        x: t.x,
                        y: t.y,
                        faceUp: !!t.faceUp
                    })),
                    pool: [...this._tilePool],
                    gameStarted: this.gameStarted,
                    elapsedMs: this.elapsedMs,
                    nextTileId: this._nextTileId,
                    started: this.started,
                    pan: { x: this.canvasPanX, y: this.canvasPanY },
                    zoom: this.targetZoom
                };
            },

            applyBoard(board, options = {}) {
                if (!board) return;
                if (board.version >= 2) {
                    this._applyMultiplayerBoard(board, options);
                    return;
                }
                if (this._isMultiplayerMode?.()) {
                    console.error('[Bananagrams] applyBoard v1 blocked in MP — require board.version >= 2');
                    return;
                }
                if (Array.isArray(board.tiles)) {
                    this._commitMpTilesProjection(
                        board.tiles.map((t) => ({ ...t })),
                        { mode: 'playing', source: 'applyBoard-v1-solo' }
                    );
                    this.started = true;
                }
                if (Array.isArray(board.pool)
                    && !(this.isHost?.() && this._mpPoolIsIdBased?.())) {
                    this._tilePool = [...board.pool];
                }
                if (typeof board.nextTileId === 'number') this._nextTileId = board.nextTileId;
                if (typeof board.gameStarted === 'boolean') this.gameStarted = board.gameStarted;
                if (typeof board.elapsedMs === 'number') this.elapsedMs = board.elapsedMs;
                if (board.pan) {
                    this.canvasPanX = board.pan.x || 0;
                    this.canvasPanY = board.pan.y || 0;
                }
                if (typeof board.zoom === 'number') {
                    this.targetZoom = board.zoom;
                    this.zoom = board.zoom;
                }
                if (this.gameStarted && this._usesGameTimer()) {
                    this._timerStart = Date.now() - this.elapsedMs;
                    this._startTimer();
                }
                this.requestRender();
                this._syncViewportAfterLayout();
            },

            applyState(state) {
                if (this._isMultiplayerMode()) {
                    const board = this._mpBoardFromRoom(this.roomData);
                    if (board?.version >= 2) {
                        const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                        const epoch = S ? S.readResetCount(this.roomData) : (this.roomData?.global?.resetCount ?? 0);
                        const appliedRc = this._mpAppliedResetCount || 0;
                        const resetEpoch = epoch > appliedRc;
                        this._applyMultiplayerBoard(board, {
                            ...(resetEpoch ? { force: true, reset: true } : {}),
                            _traceCaller: 'rebuildState-applyState'
                        });
                        return;
                    }
                }
                if (state && Array.isArray(state.tiles)) {
                    this.applyBoard(state);
                }
            },

            _mpBoardFromRoom(room) {
                const snap = room || this.roomData;
                if (!snap) return null;
                const board = this.sync?.readBoard?.(snap)
                    || (typeof RtdbSchema !== 'undefined' && RtdbSchema.readBoardFromRoom
                        ? RtdbSchema.readBoardFromRoom(snap)
                        : snap.global?.board ?? null);
                return this._normalizeMpBoard(board);
            },

            onRemoteReset() {
                window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
                this._mpResetForRemoteSignal?.();
            },

            onGameReset() {
                this._stopTimer();
                if (typeof this._hostCancelPendingBoardSync === 'function') {
                    this._hostCancelPendingBoardSync();
                }
                this._bananaDevHook('resetSolveSeq', this);
                this._hostReviewCompleting = false;
                this._hostReviewTransitionActive = false;
                this._setGamePhase?.('playing');
                this._exitReviewLocalState();
                this._victoryRegistered = false;
                this._winnerUid = null;
                this._winnerBannerUid = null;
                this.isOver = false;
                this.winner = null;
                if (this._isMultiplayerMode() && !this.isHost()) {
                    this._mpClearActionSeqForReset?.();
                    return;
                }
                if (!this._isMultiplayerMode()) {
                    localStorage.removeItem(this.getPersistKey());
                } else {
                    this._clearLocalLayout();
                    this._mpCanonicalReset?.();
                }
                this.started = false;
                this.gameStarted = false;
                this._clearMpTilesProjection?.('board-reset', { clearRegistry: true });
                this._tilePool = [];
                this._mpOwned = null;
                this._mpLastKnownOwned = null;
                this._mpPlayerLayouts = null;
                this._mpInventorySeq = null;
                this._localInventorySeq = 0;
                this._lastPeelSeq = 0;
                this._lastDumpSeq = 0;
                this._peelSeq = 0;
                this._lastPeelDraws = null;
                this._peelActorUid = null;
                this._dumpSeq = 0;
                this._dumpActorUid = null;
                this._lastMpDumpTxn = null;
                this._lastMpPeelTxn = null;
                this._lastMpSplitTxn = null;
                this._clearDumpClientState?.();
                this._winnerBannerUid = null;
                this._winnerUid = null;
                this._nextTileId = 0;
                this._selectedIds.clear();
                this._selectionHighlight = false;
                this._bananaHandled = {};
                this._bananaAck = {};
                this._boardSeq = 0;
                this._mpBoardRevision = 0;
                this._mpClearRevisionClientState?.();
                if (this._isMultiplayerMode() && this.isHost?.() && this.roomData?.global) {
                    this.roomData.global.board = null;
                    if (this.roomData.state) this.roomData.state.board = null;
                }
                this._resetAcknowledgedAt = Date.now();
                this._bannerText = '';
                this.canvasPanX = 0;
                this.canvasPanY = 0;
                this._viewportFocal = null;
                this._fitZoomInitialized = false;
                this._mobileLayoutAnchorLocked = false;
                this._mobileContentBounds = null;
                this.elapsedMs = 0;
                this.setupNewHand();
                this._applyDefaultPlayingViewport?.();
                this._syncViewportAfterLayout();
            },

            _serializeHandTiles(tiles = this.tiles) {
                return (tiles || [])
                    .filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y))
                    .map((t) => ({
                        id: t.id,
                        letter: t.letter,
                        x: Math.round(t.x),
                        y: Math.round(t.y),
                        faceUp: !!t.faceUp
                    }));
            }
    });
})(typeof window !== 'undefined' ? window : global);
