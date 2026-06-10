/** Bananagrams — mp-host (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-host.js');
    Object.assign(G.prototype, {
            /** Drop players no longer in room playerData (non-host left). */
            _hostPurgeDepartedPlayers() {
                if (!this._isMultiplayerMode() || !this.isHost()) return false;
                // Pre-split: roster still settling — transient playerData must not erase dealt hands.
                // Post-SPLIT: same — brief omissions must not wipe live inventory.
                if (!this.gameStarted) return false;
                const active = new Set(this._getPlayerUids());
                const hostUid = this.roomData?.host || this._myUid();
                if (hostUid) active.add(hostUid);

                this._hostEnsureMpStores();
                const board = this._mpBoardFromRoom();
                const seen = new Set(active);
                const maybeDeparted = [
                    ...Object.keys(this._mpOwned || {}),
                    ...Object.keys(board?.tilesOwnedByPlayer || {}),
                    ...Object.keys(board?.scores || {}),
                    ...(Array.isArray(board?.playerUids) ? board.playerUids : []),
                    ...Object.keys(board?.reviewLayouts || {}),
                    ...Object.keys(board?.reviewLayoutsOrig || {}),
                    ...Object.keys(board?.tilePositionsByPlayer || {}),
                    ...Object.keys(board?.inventorySeq || {})
                ];
                const departed = maybeDeparted.filter((uid) => uid && !seen.has(uid));
                if (!departed.length) return false;

                departed.forEach((uid) => {
                    delete this._mpOwned[uid];
                    delete this._mpInventorySeq[uid];
                    if (this._mpPlayerLayouts) delete this._mpPlayerLayouts[uid];
                    if (this._mpScores) delete this._mpScores[uid];
                    if (this._reviewLayouts) delete this._reviewLayouts[uid];
                    if (this._endingLayoutsCache) delete this._endingLayoutsCache[uid];
                });

                const inReview = board && this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                if (inReview && typeof this._hostWriteBoard === 'function') {
                    this._hostWriteBoard('review', { processBananaInteractions: false });
                } else {
                    this._hostSyncBoard({ immediate: true });
                }
                this.renderScoreboard();
                return true;
            },

            _maybeSetupMultiplayer() {
                if (!this._isMultiplayerMode() || !this.isHost()) return;
                if (typeof BananaRules === 'undefined') return;
                const uids = this._getPlayerUids();
                if (uids.length < 2) return;
                const board = this._mpBoardFromRoom();
                if (board && this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW) return;
                if (board?.gameStarted) return;
                const hands = board?.tilesOwnedByPlayer || {};
                const needsInitialDeal = !Object.values(hands).some((h) => h?.length > 0);
                if (needsInitialDeal) {
                    this._hostReviewCompleting = false;
                    this._hostReviewTransitionActive = false;
                    this._exitReviewLocalState?.();
                    this._setGamePhase?.('playing');
                } else if (!this.canMutatePlayingBoard?.()) {
                    return;
                }
                const hasDealtBoard = board?.version >= 2
                    && board.tilesOwnedByPlayer
                    && Object.values(board.tilesOwnedByPlayer).some((hand) => hand?.length > 0);
                if (hasDealtBoard) {
                    const preSplit = !board.gameStarted;
                    const hands = board.tilesOwnedByPlayer || {};
                    const everyoneDealt = uids.every(
                        (uid) => Array.isArray(hands[uid]) && hands[uid].length > 0
                    );
                    // Late-join before SPLIT: redeal when room roster ≠ dealt hands
                    // (playerUids can list all members while only the host has tiles).
                    if (preSplit && !everyoneDealt) {
                        this._setupMultiplayerHand(uids);
                        return;
                    }
                    if (board.tilesOwnedByPlayer?.[this._myUid()]?.length) {
                        this._applyMultiplayerBoard(board, { force: true, reset: true });
                    }
                    return;
                }
                this._setupMultiplayerHand(uids);
            },

            /**
             * Host authority → network snapshot shape.
             * Same structure guests receive; used for local projection before/after publish.
             */
            _hostAuthorityBoardSnapshot(uids) {
                const party = uids || [];
                this._hostEnsureMpStores?.();
                const tilesOwnedByPlayer = {};
                const tilePositionsByPlayer = {};
                party.forEach((uid) => {
                    const ownedRaw = this._mpOwned?.[uid] || [];
                    if (ownedRaw.length) {
                        tilesOwnedByPlayer[uid] = ownedRaw.map((t) => ({
                            id: String(t.id),
                            faceUp: !!t.faceUp
                        }));
                    }
                    const positions = this._mpPlayerLayouts?.[uid];
                    if (positions && Object.keys(positions).length) {
                        const list = Object.entries(positions)
                            .filter(([, p]) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
                            .map(([id, p]) => ({
                                id,
                                x: Math.round(p.x),
                                y: Math.round(p.y)
                            }));
                        if (list.length) tilePositionsByPlayer[uid] = list;
                    }
                });
                return {
                    version: this._mpPoolUsesTileIds?.() ? 5 : 4,
                    gameStarted: false,
                    started: true,
                    tilesOwnedByPlayer,
                    tilePositionsByPlayer,
                    inventorySeq: { ...(this._mpInventorySeq || {}) }
                };
            },

            _setupMultiplayerHand(uids) {
                if (typeof BananaRules === 'undefined') return;
                if (!uids || uids.length < 2) return;
                if (this._hostInitialDealInFlight) return;
                this._hostInitialDealInFlight = true;
                try {
                this._hostReviewCompleting = false;
                this._hostReviewTransitionActive = false;
                this._exitReviewLocalState?.();
                this._stopTimer();
                this.started = true;
                this.gameStarted = false;
                this._mpStartedAt = null;
                this._winnerUid = null;
                this._setGamePhase?.('playing');
                const handSize = this._handSizeForParty();
                const origin = { x: this.ORIGIN, y: this.ORIGIN };
                const shuffledIds = this._mpMaterializeDeck?.();
                if (!shuffledIds?.length) return;
                this._mpOwned = {};
                this._mpInventorySeq = {};
                this._tilePool = shuffledIds;
                const myUid = this._myUid();
                uids.forEach((uid) => {
                    const dealt = this._mpDealTilesFromPoolIds(this._tilePool, origin, handSize);
                    const { owned, positions } = this._splitTiles(dealt);
                    this._mpOwned[uid] = owned;
                    this._mpInventorySeq[uid] = 1;
                    if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                    this._mpPlayerLayouts[uid] = positions;
                    if (!this._mpScores[uid]) this._mpScores[uid] = 0;
                });
                Object.values(this._mpOwned).forEach((list) => {
                    this._mpCanonicalRegisterDrawn?.(list, 'initial-deal');
                });
                const guestUid = uids.find((u) => u !== myUid);
                if (guestUid) {
                    (this._mpOwned[guestUid] || []).forEach((t) => {
                        const letter = this._mpLetter?.(t.id) || '';
                        this.traceTileLetter?.({
                            ctx: 'initial-deal',
                            playerId: guestUid,
                            tileId: t.id,
                            observedLetter: letter,
                            canonicalLetter: letter,
                            source: 'deal',
                            round: 0
                        });
                    });
                }
                this.elapsedMs = 0;
                this._timerStart = null;
                this._selectedIds.clear();
                this._selectionHighlight = false;
                this._bannerText = '';
                this._peelSeq = 0;
                this._dumpSeq = 0;
                this._lastPeelSeq = 0;
                this._lastDumpSeq = 0;
                this._lastPeelDraws = null;
                this._localInventorySeq = 0;
                this._updateHudEl();
                const dealBoard = this._hostAuthorityBoardSnapshot(uids);
                const deckSize = uids.length * handSize + (this._tilePool?.length || 0);
                const dealTxn = {
                    uids,
                    handSize,
                    deckSize,
                    pool: [...this._tilePool],
                    tilesOwnedByPlayer: dealBoard.tilesOwnedByPlayer,
                    inventorySeq: dealBoard.inventorySeq
                };
                if (typeof this._hostValidateDealTxn === 'function'
                    && !this._hostValidateDealTxn(dealTxn)) {
                    const reason = typeof this._hostDealTxnFailureReason === 'function'
                        ? (this._hostDealTxnFailureReason(dealTxn) || 'unknown')
                        : 'unknown';
                    console.error('[Bananagrams][deal-txn] validation failed', reason, dealTxn);
                    return;
                }
                const myInvSeq = this._mpInventorySeq[myUid] || 1;
                const projected = this._applyMpInventoryAxis(dealBoard, myUid, {
                    force: true,
                    reset: true,
                    inventorySeq: myInvSeq,
                    _inventoryApplySource: 'host-initial-deal'
                });
                if (!projected) {
                    this._logInventoryProjectionFailure?.('host-initial-deal', dealBoard, myUid);
                }
                this._mpLetterIntegrityCheck?.('initial-deal');
                this._mpDistributionInvariantCheck?.('initial-deal');
                this._mpAssertDealEpochMembership?.('initial-deal');
                this._hostSyncBoard({ immediate: true });
                if (!projected) return;
                this._applyDefaultPlayingViewport?.();
                this.requestRender();
                this._syncViewportAfterLayout();
                } finally {
                    this._hostInitialDealInFlight = false;
                }
            },

            setupNewHand() {
                if (typeof BananaRules === 'undefined') return;
                if (this._isMultiplayerMode()) {
                    if (this.isHost()) this._setupMultiplayerHand(this._getPlayerUids());
                    return;
                }
                this._stopTimer();
                this.started = true;
                this.gameStarted = false;
                this._tilePool = this._buildTilePool();
                this._nextTileId = 0;
                const dealt = BananaRules.dealSoloHand(
                    this._tilePool,
                    { x: this.ORIGIN, y: this.ORIGIN },
                    BananaRules.SOLO_HAND,
                    this._nextTileId
                );
                this._commitMpTilesProjection?.(dealt, {
                    mode: 'playing',
                    source: 'setupNewHand-solo',
                    tileCount: dealt.length
                }) || (this.tiles = dealt);
                this._nextTileId += this.tiles.length;
                this.elapsedMs = 0;
                this._timerStart = null;
                this._selectedIds.clear();
                this._selectionHighlight = false;
                this._bannerText = '';
                this._bannerPlacement = 'center';
                this._updateHudEl();
                this.persistState();
                this._soloDistributionInvariantCheck?.('setupNewHand');
                this._applyDefaultPlayingViewport?.();
                this.requestRender();
                this._syncViewportAfterLayout();
            },

            _hostBeginSplit() {
                return this._hostCommitSplitTransaction?.() ?? false;
            },

            /** Guest: face-up/timer/deferred-board projection only after coherent split bundle. */
            _projectGuestSplitFromBoard(board) {
                if (this.isHost?.()) return;
                const snapBoard = board || this._mpBoardFromRoom?.(this.roomData);
                if (!this._mpGuestWireGameStarted?.(snapBoard)) return;
                if (!this.canMutatePlayingBoard?.()) return;
                this._setGamePhase?.('playing');
                this._mutateMpTilesInPlace?.('guest-split-face-up', (tiles) => {
                    tiles.forEach((t) => { t.faceUp = true; });
                    return true;
                }, { mode: 'playing' });
                this._mpDeferredBoard = null;
                this._flushDeferredBoardApply?.();
                this.requestRender();
            },

            _hostBumpDump(uid) {
                this._dumpSeq = (this._dumpSeq || 0) + 1;
                this._dumpActorUid = uid;
            },

            _hostBumpPeel(uid) {
                this._peelSeq = (this._peelSeq || 0) + 1;
                this._peelActorUid = uid;
            },

            /** @see mp-dump.js — _hostCommitDumpTransaction */
            _hostApplyDump(uid, tileId) {
                return this._hostCommitDumpTransaction(uid, tileId);
            },

            /** Debug/triage — wire board.pool length (guest should match _tilePool after sync). */
            _mpGuestPoolWireLen() {
                const board = this._mpBoardFromRoom?.(this.roomData);
                return Array.isArray(board?.pool) ? board.pool.length : null;
            },

            _mpGuestPoolCacheLen() {
                return this._tilePool?.length ?? 0;
            },

            /** Host: live _tilePool. Guest: _tilePool mirrored from wire on every board apply. */
            _mpAuthoritativeBunchLen() {
                if (this.isHost?.()) return this._tilePool?.length ?? 0;
                this._mpGuestEnsurePoolSynced?.();
                return this._tilePool?.length ?? 0;
            },

            _mpDisplayPoolLen() {
                return this._mpAuthoritativeBunchLen?.() ?? (this._tilePool?.length ?? 0);
            },

            /** Flush latest MP layouts/inventory before host registers win (real peel-win or dev /win). */
            _hostSyncLayoutBeforeWin(uid, guestLayout = null) {
                this._hostEnsureMpStores();
                const myUid = this._myUid();
                if (guestLayout && uid !== myUid) {
                    if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                    const positions = {};
                    guestLayout.forEach((p) => {
                        if (p?.id != null) positions[p.id] = { x: p.x, y: p.y };
                    });
                    this._mpPlayerLayouts[uid] = positions;
                }
                if (typeof this._hostCancelPendingBoardSync === 'function') {
                    this._hostCancelPendingBoardSync();
                }
                // Do not publish a playing-phase board here — it races review transition and can
                // flash/wipe post-game review on host and guest when seq advances past review.
            },

            _hostBananasForPlayer(uid, guestLayout = null) {
                if (!this._checker || !BananaGrid) return false;
                if (!this.canMutatePlayingBoard?.()) return false;
                if (this._tilePool.length) return false;
                const myUid = this._myUid();
                let hand = uid === myUid
                    ? this.tiles
                    : (guestLayout ? this._handFromOwnedAndPositions(uid, guestLayout) : null);
                if (typeof this._snapHandForValidation === 'function') {
                    hand = this._snapHandForValidation(hand);
                }
                if (!this._handQualifiesForBananasWin(hand)) return false;
                this._hostSyncLayoutBeforeWin(uid, guestLayout);
                this._onPlayerWins(uid);
                return true;
            },

            /** Dev /win — same host transition as bananas win (sync + review), skip peel validation. */
            _hostDevWinForPlayer(uid, guestLayout = null) {
                if (!this.isHost()) return false;
                if (!this.canMutatePlayingBoard?.()) return false;
                this._tilePool = [];
                this._hostSyncLayoutBeforeWin(uid, guestLayout);
                this._onPlayerWins(uid);
                return true;
            },

            /**
             * @returns {'handled'|'drop'|'retry'} handled = success; drop = stale/permanent fail; retry = leave queued
             */
            _hostHandleBananaInteraction(uid, msg) {
                if (!msg || !this.isHost() || uid === this._myUid()) return 'drop';
                const postWin = !this.canMutatePlayingBoard?.();
                if (postWin && msg.type !== 'victory-layout') return 'drop';
                if (msg.type === 'dev-win' && msg.uid) {
                    const layout = Array.isArray(msg.positions) ? msg.positions : null;
                    if (Array.isArray(msg.owned) && msg.owned.length) {
                        this._hostSetOwned(uid, msg.owned, false);
                        if (!this._mpInventorySeq?.[uid]) this._mpInventorySeq[uid] = 1;
                    }
                    if (this._hostDevWinForPlayer(uid, layout)) return 'handled';
                    return 'drop';
                }
                if (msg.type === 'split') {
                    if (this.gameStarted) return 'drop';
                    this._hostBeginSplit();
                    return 'handled';
                }
                if (msg.type === 'dump' && msg.tileId) {
                    return this._hostHandleDumpInteraction(uid, msg);
                }
                if (msg.type === 'peel') {
                    return this._hostHandlePeelInteraction(uid, msg);
                }
                if (msg.type === 'bananas') {
                    const layout = Array.isArray(msg.positions) ? msg.positions : null;
                    if (this._hostBananasForPlayer(uid, layout)) return 'handled';
                    return 'drop';
                }
                if (msg.type === 'victory-layout') {
                    if (!Array.isArray(msg.tiles)) return 'drop';
                    const winnerUid = this._winnerUid || this.roomData?.global?.board?.winnerUid;
                    // Winner layout is frozen on host at win time; still accept loser snapshots.
                    if (this._reviewEndingLayoutsFrozen && uid === winnerUid
                        && (this._reviewLayouts?.[uid]?.length
                            || this._endingLayoutsCache?.[uid]?.length)) {
                        return 'handled';
                    }
                    const filtered = msg.tiles.filter((t) => t?.id);
                    if (!filtered.length) return 'drop';
                    filtered.forEach((t) => {
                        const norm = this._mpNormLetter?.(t.letter);
                        if (norm && /^[A-Z]$/.test(norm)) {
                            this._mpCanonicalRegister?.(t.id, norm, 'victory-layout');
                        }
                    });
                    this._hostSetOwned(uid, filtered.map((t) => ({
                        id: t.id,
                        faceUp: !!t.faceUp
                    })), false, {
                        source: 'review',
                        action: 'review',
                        ctx: `host-set-owned:${uid}`,
                        msgType: 'victory-layout'
                    });
                    if (!this._reviewLayouts) this._reviewLayouts = {};
                    this._reviewLayouts[uid] = filtered.map((t) => ({
                        ...t,
                        letter: this._mpNormLetter?.(t.letter) || t.letter
                    }));
                    if (typeof this._logReviewBoards === 'function') {
                        this._logReviewBoards('host-received-ending', { [uid]: filtered });
                    }
                    if (this._hostMaySyncReview?.()) {
                        const orig = this._ensureReviewLayoutsSnapshot();
                        const party = this._getPlayerUids?.() || [];
                        const display = this._displayReviewLayoutsFromOrig(orig);
                        const fp = this._reviewLayoutsFingerprint(display);
                        if (!fp || fp !== this._reviewLayoutsSyncedFp) {
                            this._reviewLayoutsSyncedFp = fp;
                            this._hostSyncReviewState({ processBananaInteractions: false });
                        }
                        if (this._reviewLayoutsReady?.(orig, party)) {
                            this._reviewLayoutsFp = null;
                            this._applyReviewLayouts(display);
                            this._ensureReviewTilesProjected?.(this._boardReviewSnapshot?.());
                            if (!this._postGameReview) {
                                this._activateReviewUi?.();
                            }
                        }
                    }
                    return 'handled';
                }
                return 'drop';
            },

            _planDrawnTileSpots(existingTiles, letters) {
                if (!letters.length || typeof BananaRules === 'undefined') return null;
                const viewport = this._getVisibleWorldBounds();
                const visOpts = { visibilityBounds: viewport };
                const bounds = BananaRules.spawnEffectiveBounds(existingTiles, viewport);
                let spots = BananaRules.spawnAllocateSlots(existingTiles, letters, bounds, visOpts);
                if (spots?.length === letters.length) return spots;
                spots = BananaRules.spawnAllocateSlots(existingTiles, letters, viewport, visOpts);
                if (spots?.length === letters.length) return spots;
                const cluster = BananaRules.spawnClusterBounds(existingTiles);
                if (!cluster) return null;
                return BananaRules.spawnAllocateSlots(
                    existingTiles,
                    letters,
                    BananaRules.intersectBounds(cluster, viewport),
                    visOpts
                );
            },

            _materializeDrawnTiles(spots, faceUp = true) {
                if (this._isMultiplayerMode?.()) {
                    console.error('[Bananagrams] _materializeDrawnTiles must not run in MP');
                    return [];
                }
                return (spots || []).map((spot) => ({
                    id: `t-${this._nextTileId++}`,
                    letter: spot.letter,
                    x: spot.x,
                    y: spot.y,
                    faceUp: !!faceUp
                }));
            },

            _applyDrawnLettersToHand(letters, handTiles = this.tiles) {
                if (this._isMultiplayerMode?.()) return null;
                if (!letters?.length) return null;
                const spots = this._planDrawnTileSpots(handTiles, letters);
                if (!spots || spots.length !== letters.length) return null;
                const added = this._materializeDrawnTiles(spots, true);
                added.forEach((t) => handTiles.push(t));
                if (this._isMultiplayerMode()) this._persistMpLayout();
                else this.persistState();
                return added;
            }
    });
})(typeof window !== 'undefined' ? window : global);
