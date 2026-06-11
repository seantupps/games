/** Bananagrams — mp-board (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-board.js');
    Object.assign(G.prototype, {
            _normalizeMpBoard(board) {
                if (!board) return board;
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

            _boardInventorySeq(board, uid) {
                return board?.inventorySeq?.[uid] ?? 0;
            },

            _positionsMapFromList(list) {
                const map = {};
                (list || []).forEach((p) => {
                    if (p?.id != null) map[p.id] = { x: p.x, y: p.y };
                });
                return map;
            },

            _applyMpSharedGameState(board) {
                const inReview = this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                const winActive = inReview || !!(board.winnerUid || this._winnerUid || this._victoryRegistered);
                const devSolvePool = this._bananaDevHook('applyDevSolveFromBoard', board) === true;
                if (Array.isArray(board.pool)) {
                    const localPoolLen = this._tilePool?.length ?? 0;
                    const remotePoolLen = board.pool.length;
                    const hostAuthoritative = this.isHost?.() && this.gameStarted && !winActive;
                    let nextPool = null;
                    if (winActive) {
                        nextPool = [];
                    } else if (this.isHost?.()) {
                        if (hostAuthoritative) {
                            const boardPool = this._mpBoardPoolForCurrentDeal?.(board);
                            const noHostPoolMutations = !(this._peelSeq || this._dumpSeq);
                            if (localPoolLen === 0 && remotePoolLen > 0 && boardPool?.length
                                && noHostPoolMutations) {
                                nextPool = [...boardPool];
                            } else if (remotePoolLen === 0 && localPoolLen > 0) {
                                nextPool = null;
                            } else if (remotePoolLen < localPoolLen) {
                                nextPool = null;
                            } else if (remotePoolLen > localPoolLen) {
                                nextPool = null;
                            }
                        } else if (localPoolLen === 0 && remotePoolLen > 0) {
                            const boardPool = this._mpBoardPoolForCurrentDeal?.(board);
                            if (boardPool?.length) nextPool = [...boardPool];
                        } else if (localPoolLen > 0 && localPoolLen > remotePoolLen) {
                            nextPool = null;
                        } else if (localPoolLen > 0 && remotePoolLen === 0) {
                            nextPool = null;
                        } else {
                            const boardPool = this._mpBoardPoolForCurrentDeal?.(board);
                            if (boardPool?.length) {
                                nextPool = [...boardPool];
                            }
                        }
                    } else if (!devSolvePool) {
                        nextPool = [...board.pool];
                    }
                    if (nextPool !== null && !devSolvePool) {
                        this._tilePool = nextPool;
                        if (this.roomData?.global?.board) {
                            this.roomData.global.board.pool = [...nextPool];
                        }
                    } else if (this.isHost?.() && hostAuthoritative && Array.isArray(this._tilePool)) {
                        const roomBoard = this.roomData?.global?.board;
                        if (roomBoard && Array.isArray(roomBoard.pool)
                            && roomBoard.pool.length !== this._tilePool.length) {
                            this._syncHostPoolOnRoomCaches?.();
                        }
                    }
                }
                if (board.poolUsesTileIds
                    || (Array.isArray(board.pool) && board.pool.some((e) => this._mpParseTileId?.(e)))) {
                    this._mpIdPoolActive = true;
                }
                this._mpEnsureIdPoolModeFromPool?.();
                if (board.canonical && typeof board.canonical === 'object') {
                    this._mpEnsureCanonicalMap?.();
                    const entries = Object.entries(board.canonical);
                    if (!this.isHost?.()) {
                        entries.forEach(([id, letter]) => {
                            this._mpCanonicalById[id] = this._mpNormLetter?.(letter) || letter;
                        });
                    } else {
                        const localCount = Object.keys(this._mpCanonicalById || {}).length;
                        entries.forEach(([id, letter]) => {
                            if (!this._mpCanonicalEntryForCurrentDeal?.(id)) return;
                            if (localCount === 0 || !this._mpCanonicalById[id]) {
                                this._mpCanonicalById[id] = this._mpNormLetter?.(letter) || letter;
                            }
                        });
                    }
                }
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
                    this.gameStarted = !!board.gameStarted;
                    if (typeof board.started === 'boolean') {
                        this.started = board.started;
                    } else if ((this.tiles?.length || 0) > 0) {
                        this.started = true;
                    }
                    if (board.startedAt) this._mpStartedAt = board.startedAt;
                    if (this.gameStarted && board.startedAt) {
                        this._syncMpTimerFromBoard(board.startedAt);
                    } else if (!this.gameStarted) {
                        this._mpStartedAt = null;
                        this._stopTimer();
                    }
                }
        
                this._applyMpActionBanners(board);
            },

            /** Peel/dump banners from board seq — safe even when full board apply is skipped. */
            _applyMpActionBanners(board) {
                if (!board) return;
                const peelSeq = board.peelSeq || 0;
                const dumpSeq = board.dumpSeq || 0;
                const actionSeqAdvanced = peelSeq > (this._lastPeelSeq || 0)
                    || dumpSeq > (this._lastDumpSeq || 0);
                const devSolvePool = this._bananaDevHook('applyDevSolveFromBoard', board) === true;
                // Guests mirror host pool from board on peel/dump; host keeps authoritative local _tilePool.
                let guestPoolSynced = false;
                if (Array.isArray(board.pool) && !this.isHost?.()) {
                    const inReview = this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                    const winActive = inReview || !!(board.winnerUid || this._winnerUid || this._victoryRegistered);
                    const remote = board.pool.length;
                    const local = this._tilePool?.length ?? 0;
                    const poolDrained = !winActive && remote < local;
                    const poolEmpty = !winActive && remote === 0 && local > 0;
                    if (actionSeqAdvanced || devSolvePool || poolDrained || poolEmpty) {
                        guestPoolSynced = true;
                        if (!winActive) {
                            this._tilePool = [...board.pool];
                            if (this.roomData?.global?.board) {
                                this.roomData.global.board.pool = [...board.pool];
                            }
                            if (typeof board.nextTileId === 'number') this._nextTileId = board.nextTileId;
                        } else {
                            this._tilePool = [];
                            if (this.roomData?.global?.board) {
                                this.roomData.global.board.pool = [];
                            }
                        }
                    }
                }
                if (peelSeq > (this._lastPeelSeq || 0)) {
                    const actor = board.peelActorUid;
                    this._showBanner('Peel!', 2200, {
                        actorUid: actor !== undefined && actor !== null ? actor : null
                    });
                }
                if (dumpSeq > (this._lastDumpSeq || 0)) {
                    const actor = board.dumpActorUid;
                    this._showBanner('Dump!', 2200, {
                        actorUid: actor !== undefined && actor !== null ? actor : null
                    });
                }
                if (actionSeqAdvanced || devSolvePool || guestPoolSynced) {
                    const poolEl = document.getElementById('banana-pool-count');
                    if (poolEl) poolEl.textContent = String(this._tilePool.length);
                    this.requestRender?.();
                }
            },

            /** Commit peel/dump seq after guest pool ingest (_mpIngestBoardBeforeInventory). */
            _commitMpActionSeqFromBoard(board) {
                if (!board) return;
                const peelSeq = board.peelSeq || 0;
                const dumpSeq = board.dumpSeq || 0;
                if (peelSeq > (this._lastPeelSeq || 0)) {
                    this._lastPeelSeq = peelSeq;
                }
                if (dumpSeq > (this._lastDumpSeq || 0)) {
                    this._lastDumpSeq = dumpSeq;
                }
            },

            /** After refresh/join: match room epoch so reload is not treated as rematch. */
            _seedMpAppliedResetFromRoom() {
                if (!this._isMultiplayerMode() || this._mpEpochSyncedFromRoom) return;
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                const epoch = S ? S.readResetCount(this.roomData) : (this.roomData?.global?.resetCount ?? 0);
                if (epoch >= 1) {
                    this._mpAppliedResetCount = epoch;
                    this._mpEpochSyncedFromRoom = true;
                }
            },

            _isFreshPostResetBoard(board) {
                if (!board || board.version < 2) return false;
                if ((board.peelSeq || 0) > 0 || (board.dumpSeq || 0) > 0) return false;
                const hands = board.tilesOwnedByPlayer || {};
                return Object.values(hands).some((h) => Array.isArray(h) && h.length > 0);
            },

            _applyMultiplayerBoard(board, options = {}) {
                if (!board) return;
                const recentReset = typeof this._isRecentProgrammaticReset === 'function'
                    && this._isRecentProgrammaticReset();
                if (this.isHost?.() && recentReset && !options.reset) {
                    const localWrite = (options._traceCaller || '').includes('hostWriteBoard');
                    if (!localWrite) {
                        if ((board.peelSeq || 0) > 0 || (board.dumpSeq || 0) > 0) return;
                        const myUid = this._myUid();
                        const inv = board.inventorySeq?.[myUid] ?? 0;
                        const handSize = this._handSizeForParty?.() || 0;
                        const ownedLen = board.tilesOwnedByPlayer?.[myUid]?.length
                            || board.hands?.[myUid]?.length
                            || 0;
                        if (inv > 1 || (handSize > 0 && ownedLen > 0 && ownedLen < handSize)) {
                            return;
                        }
                    }
                }
                const hadTilesBeforeApply = (this.tiles?.length || 0) > 0;
                this._seedMpAppliedResetFromRoom();
                const traceCaller = options._traceCaller
                    || (this._doneTraceOn()
                        ? (new Error().stack || '').split('\n').slice(1, 4).join(' | ')
                        : '');
                board = this._normalizeMpBoard(board);
                if (this._mpAwaitReset && !this.isHost?.() && !(options.force && options.reset)) {
                    if (!this._isFreshPostResetBoard(board)) {
                        return;
                    }
                    options = { ...options, reset: true, force: true };
                }
                this._applyMpActionBanners(board);
                this._mpIngestBoardBeforeInventory?.(board);
                this._traceDoneApply(board, options, traceCaller);
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                const epoch = S ? S.readResetCount(this.roomData) : (this.roomData?.global?.resetCount ?? 0);
                const appliedRc = this._mpAppliedResetCount || 0;
                if (epoch > appliedRc) {
                    this._mpAppliedResetCount = epoch;
                    this._boardSeq = 0;
                    this._exitReviewLocalState();
                    if (!this._isFreshPostResetBoard(board)) {
                        if (this._doneTraceOn()) {
                            console.log('[APPLY] skip stale board at epoch bump', {
                                caller: traceCaller,
                                boardSeq: board.seq,
                                gameStarted: board.gameStarted,
                                peelSeq: board.peelSeq,
                                dumpSeq: board.dumpSeq
                            });
                        }
                        return;
                    }
                    options = { ...options, force: true, reset: true };
                }
                const canApply = options.force
                    || this.sync?.shouldApplyBoard?.(appliedRc, epoch, this._boardSeq, board)
                    || (!this.sync && (!S || S.shouldApplyBoard(appliedRc, epoch, this._boardSeq, board)));
                if (!canApply) {
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

                if (this.isHost?.() && !options.reset && !options.force) {
                    const party = this._getPlayerUids();
                    if (party.length >= 2) {
                        const hands = board.tilesOwnedByPlayer || {};
                        const dealt = party.filter((u) => (hands[u]?.length || 0) > 0).length;
                        if (dealt > 0 && dealt < party.length) {
                            if (this._doneTraceOn()) {
                                console.log('[APPLY] host skip partial party inventory', {
                                    caller: traceCaller,
                                    dealt,
                                    party: party.length
                                });
                            }
                            return;
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
                if (this._hostReviewCompleting && inReview) {
                    return;
                }
                const leavingReview = this._mpClientBoardPhase === BananagramsGame.MP_PHASE.REVIEW
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
        
                if (board.seq != null) this._boardSeq = board.seq;

                this._mirrorBananaAckFromBoard(board);
                this._mirrorHostInventoryFromBoard(board);

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
        
                let layoutChanged = false;
                if (this._shouldProjectPlayingInventory?.(board, options)) {
                    layoutChanged = this._applyMpInventoryFromBoard(board, uid, options);
                    if (leavingReview && this.tiles?.length && !board.gameStarted) {
                        this.tiles.forEach((t) => { t.faceUp = false; });
                        layoutChanged = true;
                    }
                }
                this._mpClientBoardPhase = inReview
                    ? BananagramsGame.MP_PHASE.REVIEW
                    : this._boardPhase(board);

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
        
                this._applyMpSharedGameState(board);
                this._commitMpActionSeqFromBoard(board);
                if (leavingReview) {
                    if (board.gameStarted) {
                        if (!this.isHost?.()) {
                            this.tiles.forEach((t) => { t.faceUp = true; });
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
                        id: t.id,
                        faceUp: !!t.faceUp
                    }));
                });
                return { tilesOwnedByPlayer };
            },

            /** Host: tile positions for all players (authoritative on global/board during play). */
            _collectMpBoardPositions() {
                const tilePositionsByPlayer = {};
                if (!this.isHost()) return { tilePositionsByPlayer };
                this._hostEnsureMpStores();
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                const roomBoard = this._mpBoardFromRoom(this.roomData) || {};
                const roomPos = roomBoard.tilePositionsByPlayer || {};
                const me = this._myUid();
                if (me && this.tiles?.length) {
                    this._mpPlayerLayouts[me] = this._layoutFromTiles(this.tiles);
                }
                const active = new Set(this._getPlayerUids());
                const hostUid = this.roomData?.host || this._myUid();
                if (hostUid) active.add(hostUid);
                const uids = new Set([
                    ...active,
                    ...Object.keys(this._mpPlayerLayouts || {}),
                    ...Object.keys(roomPos || {})
                ]);
                uids.forEach((uid) => {
                    if (!active.has(uid)) return;
                    const positions = this._mpPlayerLayouts[uid]
                        || this._positionsMapFromList(roomPos[uid] || []);
                    if (!positions || !Object.keys(positions).length) return;
                    const list = Object.entries(positions)
                        .filter(([, p]) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
                        .map(([id, p]) => ({
                            id,
                            x: Math.round(p.x),
                            y: Math.round(p.y)
                        }));
                    if (list.length) tilePositionsByPlayer[uid] = list;
                });
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

            _syncHostPoolOnRoomCaches() {
                if (!this.isHost?.() || !Array.isArray(this._tilePool)) return;
                const pool = [...this._tilePool];
                if (this.roomData?.global?.board) {
                    this.roomData.global.board.pool = pool;
                }
                if (this.roomData?.state?.board) {
                    this.roomData.state.board.pool = pool;
                }
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                if (S?.setCanonicalBoardOnRoom && S?.readBoardFromRoom) {
                    const board = S.readBoardFromRoom(this.roomData);
                    if (board) {
                        board.pool = pool;
                        S.setCanonicalBoardOnRoom(this.roomData, board);
                    }
                }
                const poolEl = document.getElementById('banana-pool-count');
                if (poolEl) poolEl.textContent = String(pool.length);
            },

            _hostPublishBoard(board, traceLabel, applyOptions = {}) {
                if (!this.roomData) this.roomData = {};
                if (!this.roomData.global) this.roomData.global = {};
                this.roomData.global.board = board;
                if (this.isHost?.() && Array.isArray(this._tilePool)) {
                    board.pool = [...this._tilePool];
                    this._syncHostPoolOnRoomCaches?.();
                }
                this._traceDoneWrite({ 'global/board': board }, traceLabel);
                this.updateMetadata({ 'global/board': board });
                this.renderScoreboard();
                this._applyMultiplayerBoard(board, {
                    force: true,
                    _traceCaller: applyOptions._traceCaller || `${traceLabel}-local`
                });
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
                    const skipRtdbWrite = remoteBoard?.phase === REVIEW
                        && remoteFp
                        && fp === remoteFp;
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

                if (!this.canMutatePlayingBoard?.()) {
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
                this._hostPublishBoard(board, 'hostWriteBoard-playing', {
                    _traceCaller: 'hostWriteBoard-playing'
                });
                return true;
            },

            _hostSyncBoard(options = {}) {
                if (!this._isMultiplayerMode() || !this.isHost()) return;
                if (options.immediate !== false) {
                    this._flushHostSyncBoard();
                    return;
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
            },

            _hostReconcileOwnedFromRoomBoard() {
                if (!this.isHost()) return;
                if (typeof this._isRecentProgrammaticReset === 'function'
                    && this._isRecentProgrammaticReset()) {
                    return;
                }
                const board = this._mpBoardFromRoom(this.roomData);
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

            _flushHostSyncBoard() {
                if (!this._isMultiplayerMode() || !this.isHost()) return;
                if (!this.canMutatePlayingBoard?.()) {
                    this._hostCancelPendingBoardSync();
                    return;
                }
                if (this._hostSyncTimer) {
                    clearTimeout(this._hostSyncTimer);
                    this._hostSyncTimer = 0;
                }
                this._hostSyncQueued = false;
                this._hostReconcileOwnedFromRoomBoard();
                this._hostWriteBoard('playing');
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
                    const payload = {
                        version: this._mpPoolUsesTileIds?.() ? 5 : 4,
                        seq: this._boardSeq,
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
                        inventorySeq: { ...(this._mpInventorySeq || {}) }
                    };
                    if (this._mpPoolUsesTileIds?.() && this._mpCanonicalById) {
                        payload.canonical = { ...this._mpCanonicalById };
                    }
                    if (this.isHost() && this._bananaAck && Object.keys(this._bananaAck).length) {
                        payload.bananaAck = { ...this._bananaAck };
                    }
                    if (this._lastPeelDraws) payload.peelDraws = this._lastPeelDraws;
                    const snap = this._boardReviewSnapshot();
                    const inReview = !this._hostReviewCompleting
                        && (this._hostReviewTransitionActive
                            || this._boardPhase(snap) === BananagramsGame.MP_PHASE.REVIEW);
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
                if (Array.isArray(board.tiles)) {
                    let tiles = board.tiles.map((t) => ({ ...t }));
                    if (typeof BananaGrid !== 'undefined' && BananaGrid.resolveHandPositions) {
                        tiles = BananaGrid.resolveHandPositions(tiles);
                    }
                    this.tiles = tiles;
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
                        const canApply = resetEpoch
                            || this.sync?.shouldApplyBoard?.(appliedRc, epoch, this._boardSeq, board)
                            || (!this.sync && (!S || S.shouldApplyBoard(appliedRc, epoch, this._boardSeq, board)));
                        if (!canApply) {
                            this._bananaDevHook('applyDevSolveFromBoard', board);
                            this._applyMpActionBanners(board);
                            this._mpIngestBoardBeforeInventory?.(board);
                            this._commitMpActionSeqFromBoard(board);
                            return;
                        }
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
                this._bananaDevHook('resetSolveSeq', this);
                this._setGamePhase?.('playing');
                this._exitReviewLocalState();
                this._closeReviewEpoch();
                window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
                this._hostReviewCompleting = false;
                this._mpClientBoardPhase = null;
                this._mpAppliedResetCount = this.roomData?.global?.resetCount ?? this._mpAppliedResetCount ?? 0;
                this.isOver = false;
                this._victoryRegistered = false;
                this._stopTimer();
                this._bannerText = '';
                this._bannerPlacement = 'center';
                this._selectedIds.clear();
                this._selectionHighlight = false;
                this._winnerUid = null;
                this._bananaHandled = {};
                this._bananaAck = {};
                this._mpDeferredBoard = null;
                this._localInventorySeq = 0;
                this._mpCanonicalReset?.();
                this._clearLocalLayout();
                this._lastPeelSeq = 0;
                this._lastDumpSeq = 0;
                this._lastGuestDumpLayoutSeq = 0;
                this._guestDumpSpawnLock = null;
                this._guestPreDumpSnapshot = null;
                this._guestOptimisticDumpRemovedId = null;
                this._guestPendingDumpTile = null;
                this._guestDumpSeqAtSend = null;
                this._guestDumpBaselineOwnedCount = null;
                this._guestDumpBaselineIds = null;
                this._guestDumpHandFloor = null;
                this._peelSeq = 0;
                this._lastPeelDraws = null;
                this._winnerBannerUid = null;
                this._mpAwaitReset = true;
                this.tiles = [];
                this.gameStarted = false;
                this._resetAcknowledgedAt = Date.now();
                this.elapsedMs = 0;
                this._timerStart = null;
                this._mpStartedAt = null;
                if (typeof this._resetPlayingViewportAfterReview === 'function') {
                    this._resetPlayingViewportAfterReview();
                }
            },

            onGameReset() {
                this._stopTimer();
                if (typeof this._hostCancelPendingBoardSync === 'function') {
                    this._hostCancelPendingBoardSync();
                }
                this._bananaDevHook('resetSolveSeq', this);
                this._setGamePhase?.('playing');
                this._exitReviewLocalState();
                this._victoryRegistered = false;
                this._winnerUid = null;
                this._winnerBannerUid = null;
                this.isOver = false;
                this.winner = null;
                if (this._isMultiplayerMode() && !this.isHost()) {
                    return;
                }
                if (!this._isMultiplayerMode()) {
                    localStorage.removeItem(this.getPersistKey());
                } else {
                    this._clearLocalLayout();
                }
                this.started = false;
                this.gameStarted = false;
                this.tiles = [];
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
                this._winnerBannerUid = null;
                this._winnerUid = null;
                this._nextTileId = 0;
                this._selectedIds.clear();
                this._selectionHighlight = false;
                this._bananaHandled = {};
                this._bananaAck = {};
                this._boardSeq = 0;
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
