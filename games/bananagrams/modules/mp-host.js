/** Bananagrams — mp-host (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-host.js');
    Object.assign(G.prototype, {
            /** Drop players no longer in room playerData (non-host left). */
            _hostPurgeDepartedPlayers() {
                if (!this._isMultiplayerMode() || !this.isHost()) return false;
                // During active play (post-SPLIT), transient room snapshots can briefly omit playerData.
                // Avoid destructive purges that can erase live inventory/ownership state.
                if (this.gameStarted) return false;
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
                if (!this.canMutatePlayingBoard?.()) return;
                if (typeof BananaRules === 'undefined') return;
                const uids = this._getPlayerUids();
                if (uids.length < 2) return;
                const board = this._mpBoardFromRoom();
                if (board && this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW) return;
                if (board?.gameStarted) return;
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

            _setupMultiplayerHand(uids) {
                if (typeof BananaRules === 'undefined') return;
                if (!uids || uids.length < 2) return;
                this._stopTimer();
                this.started = true;
                this.gameStarted = false;
                this._mpStartedAt = null;
                this._winnerUid = null;
                this._setGamePhase?.('playing');
                const handSize = this._handSizeForParty();
                const origin = { x: this.ORIGIN, y: this.ORIGIN };
                this._mpOwned = {};
                this._mpInventorySeq = {};
                const shuffledIds = this._mpMaterializeDeck?.();
                if (!shuffledIds?.length) return;
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
                this._lastPeelDraws = null;
                this._localInventorySeq = 0;
                this._updateHudEl();
                this.tiles = this._mergeInventoryWithLayout(
                    this._mpOwned[myUid],
                    this._mpPlayerLayouts[myUid] || {},
                    null
                );
                this._localInventorySeq = this._mpInventorySeq[myUid] || 1;
                this._hostSyncBoard({ immediate: true });
                this._applyDefaultPlayingViewport?.();
                this.requestRender();
                this._syncViewportAfterLayout();
                this._mpLetterIntegrityCheck?.('initial-deal');
                this._mpDistributionInvariantCheck?.('initial-deal');
                this._mpAssertDealEpochMembership?.('initial-deal');
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
                this.tiles = BananaRules.dealSoloHand(
                    this._tilePool,
                    { x: this.ORIGIN, y: this.ORIGIN },
                    BananaRules.SOLO_HAND,
                    this._nextTileId
                );
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
                if (this.gameStarted) return;
                if (!this.canMutatePlayingBoard?.()) {
                    return;
                }
                const startedAt = Date.now();
                this.gameStarted = true;
                this._mpStartedAt = startedAt;
                Object.values(this._mpOwned || {}).forEach((owned) => {
                    owned.forEach((t) => { t.faceUp = true; });
                });
                this._syncMpTimerFromBoard(startedAt);
                this._hostSyncBoard({ immediate: true });
                this.requestRender();
            },

            /** Guest: mirror host SPLIT locally so drag positions are not wiped by stale pre-split boards. */
            _guestBeginSplit() {
                if (this.gameStarted) return;
                if (!this.canMutatePlayingBoard?.()) {
                    return;
                }
                const startedAt = Date.now();
                this.gameStarted = true;
                this._mpStartedAt = startedAt;
                this.tiles.forEach((t) => { t.faceUp = true; });
                this._timerStart = startedAt;
                this._startTimer();
                this._mpDeferredBoard = null;
                this.requestRender();
            },

            _hostBumpDump(uid) {
                this._dumpSeq = (this._dumpSeq || 0) + 1;
                this._dumpActorUid = uid;
            },

            _hostApplyDump(uid, tileId) {
                const result = this._hostApplyDumpInventoryOnly(uid, tileId);
                if (!result.ok) return false;
                this._hostBumpInventorySeq(uid);
                this._hostBumpDump(uid);
                this._hostApplyLocalOwnedToTiles?.(uid, result.removedId || tileId);
                this._hostSyncBoard({ immediate: true });
                this._mpDistributionInvariantCheck?.('host-dump');
                this._mpLetterIntegrityCheck?.('host-dump');
                return true;
            },

            _hostApplyDumpInventoryOnly(uid, tileId) {
                this._mpEnsureIdPoolModeFromPool?.();
                this._hostHydrateOwnedFromBoard?.(uid);
                const owned = [...(this._mpOwned[uid] || [])];
                const idx = owned.findIndex((o) => o.id === tileId);
                if (idx < 0) return { ok: false, reason: 'tile-not-found' };
                const min = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
                if ((this._tilePool?.length ?? 0) < min) return { ok: false, reason: 'short-pool' };

                const removed = owned[idx];
                const beforePoolSig = this._mpLetterSigFromPool?.(this._tilePool)
                    ?? this._mpLetterSigFromLetters?.(this._tilePool);
                if (!this._mpAssertIdPoolForMutation?.('host-dump')) {
                    return { ok: false, reason: 'no-id-pool' };
                }
                const nextPool = [...this._tilePool];
                const drawnIds = this._mpDumpTileIdToPool(nextPool, removed.id, min);
                if (drawnIds.length < min) return { ok: false, reason: 'short-pool' };
                this._tilePool = nextPool;
                owned.splice(idx, 1);
                const drawnTiles = [];
                drawnIds.forEach((id) => {
                    owned.push({ id, faceUp: true });
                    drawnTiles.push({ id, letter: this._mpLetter(id) });
                });

                this._mpOwned[uid] = owned;
                this._hostRepairOwnedFromCanonical?.('host-dump');
                this._mpPoolAudit?.('dump', {
                    beforePoolSig,
                    returnedTile: {
                        id: removed.id,
                        runtimeLetter: removed.letter,
                        canonicalLetter: this._mpLetter(removed.id)
                    },
                    drawnTiles,
                    afterPoolSig: this._mpLetterSigFromPool?.(this._tilePool)
                        ?? this._mpLetterSigFromLetters?.(this._tilePool),
                    ownedSig: this._mpCombinedOwnedSig?.(),
                    combinedSig: `${this._mpLetterSigFromPool?.(this._tilePool) ?? ''}+${this._mpCombinedOwnedSig?.()}`
                });
                return { ok: true, removedId: removed.id };
            },

            /** Host local bunch during play; guests read synced global/board pool. */
            _mpAuthoritativeBunchLen() {
                if (this.isHost?.()) return this._tilePool?.length ?? 0;
                const board = this._mpBoardFromRoom?.(this.roomData);
                if (Array.isArray(board?.pool)) {
                    const remote = board.pool.length;
                    const local = this._tilePool?.length ?? 0;
                    if (this.gameStarted && !this._winnerUid && remote !== local) {
                        // Pool only decreases on host peel/dump — never inflate local from stale board echo.
                        if (remote < local) this._tilePool = [...board.pool];
                    }
                    // Host is pool authority: trust local drain when RTDB board.pool lags after host peel.
                    if (local === 0 && remote > 0) return 0;
                    return remote;
                }
                return this._tilePool?.length ?? 0;
            },

            /** Active MP players for peel draws — roster with live hands, not stale room slots. */
            _peelPartyUids(actorUid) {
                const roster = this._getPlayerUids().filter(Boolean);
                this._hostEnsureMpStores?.();
                const board = this._mpBoardFromRoom?.(this.roomData) || {};
                const roomOwned = board.tilesOwnedByPlayer || {};
                const localOwned = this._mpOwned || {};
                const handLen = (uid) => {
                    const local = localOwned[uid];
                    if (Array.isArray(local) && local.length > 0) return local.length;
                    const remote = roomOwned[uid];
                    return Array.isArray(remote) ? remote.length : 0;
                };
                let party = roster.filter((uid) => handLen(uid) > 0);
                if (party.length < 2) party = [...roster];
                if (party.length < 2) {
                    const hostUid = this.roomData?.host || this._myUid();
                    party = [...new Set([hostUid, actorUid].filter(Boolean))];
                }
                return [...new Set(party)].sort();
            },

            /** Guest: align local bunch with host board pool before optimistic peel draws. */
            _guestAdoptAuthoritativePoolForPeel() {
                if (this.isHost?.() || !this._isMultiplayerMode?.()) return;
                const board = this._mpBoardFromRoom?.(this.roomData);
                if (!Array.isArray(board?.pool)) return;
                const local = this._tilePool?.length ?? 0;
                const remote = board.pool.length;
                if (remote < local || local === 0) {
                    this._tilePool = [...board.pool];
                    if (Number.isFinite(board.nextTileId)) this._nextTileId = board.nextTileId;
                }
            },

            /** Guest peel: board sync is authoritative (no local pool draw or id minting). */
            _guestApplyOptimisticPeel() {
                return false;
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

            _hostPeelForPlayer(uid, guestLayout = null) {
                if (!this._checker || !BananaGrid) return false;
                if (!this.canMutatePlayingBoard?.()) return false;
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
                const handRaw = uid === myUid
                    ? this.tiles
                    : (guestLayout ? this._handFromOwnedAndPositions(uid, guestLayout) : null);
                const hand = this._snapHandForValidation?.(handRaw) || handRaw;
                if (!hand?.length || hand.length < 3) return false;
                const result = BananaGrid.validateGrid(hand, this._checker);
                if (!result.ok || !this._allTilesPlacedOn(hand)) return false;
                const hasThreeTileWord = (result.words || []).some((w) => String(w || '').length >= 3);
                if (!hasThreeTileWord) return false;
        
                const board = this._mpBoardFromRoom?.(this.roomData) || {};
                const uids = this._peelPartyUids(uid);
                const roomOwned = board?.tilesOwnedByPlayer || {};
                const ownedByUid = {};
                // Peel uses an explicit in-memory baseline to avoid room snapshot races.
                // Prefer in-memory owned; fall back to board only when local is empty.
                uids.forEach((u) => {
                    const remote = Array.isArray(roomOwned?.[u])
                        ? this._mpNormalizeBoardOwned?.(roomOwned[u], true)
                            || roomOwned[u].map((t) => ({ id: t.id, faceUp: !!t.faceUp }))
                        : [];
                    const local = Array.isArray(this._mpOwned?.[u])
                        ? this._mpOwned[u].map((t) => ({ id: t.id, faceUp: !!t.faceUp }))
                        : [];
                    if (local.length) {
                        ownedByUid[u] = local;
                        return;
                    }
                    if (remote.length) {
                        ownedByUid[u] = remote;
                        return;
                    }
                    this._hostHydrateOwnedFromBoard?.(u);
                    ownedByUid[u] = (this._mpOwned?.[u] || []).map((t) => ({
                        id: t.id,
                        faceUp: !!t.faceUp
                    }));
                });
                const playerCount = uids.length;
                if (!this._tilePool.length || this._tilePool.length < playerCount) return false;
                if (!this._mpAssertIdPoolForMutation?.('host-peel')) return false;
                const beforePoolSig = this._mpLetterSigFromPool?.(this._tilePool)
                    ?? this._mpLetterSigFromLetters?.(this._tilePool);
                const drawn = {};
                const drawnIds = {};
                const drawnTiles = [];
                uids.forEach((u) => {
                    const ids = this._mpDrawIdsFromPool(this._tilePool, 1);
                    if (!ids.length) return;
                    const id = ids[0];
                    if (!ownedByUid[u]) ownedByUid[u] = [];
                    const letter = this._mpLetter(id);
                    ownedByUid[u].push({ id, faceUp: true });
                    drawn[u] = letter;
                    drawnIds[u] = id;
                    drawnTiles.push({ id, letter, player: u });
                });
                if (Object.keys(drawn).length !== playerCount) return false;
                uids.forEach((u) => {
                    this._mpOwned[u] = ownedByUid[u] || [];
                });
                if (uids.includes(myUid)) {
                    this._hostApplyLocalOwnedToTiles?.(myUid);
                }
                this._mpPoolAudit?.('peel', {
                    beforePoolSig,
                    returnedTile: null,
                    drawnTiles,
                    afterPoolSig: this._mpLetterSigFromPool?.(this._tilePool)
                        ?? this._mpLetterSigFromLetters?.(this._tilePool),
                    ownedSig: this._mpCombinedOwnedSig?.(),
                    combinedSig: `${this._mpLetterSigFromPool?.(this._tilePool) ?? ''}+${this._mpCombinedOwnedSig?.()}`
                });
                this._lastPeelDraws = drawn;
                this._peelSeq = (this._peelSeq || 0) + 1;
                this._peelActorUid = uid;
                uids.forEach((u) => this._hostBumpInventorySeq(u));
                if (typeof this._hostCancelPendingBoardSync === 'function') {
                    this._hostCancelPendingBoardSync();
                }
                this._hostRepairOwnedFromCanonical?.('host-peel');
                if (typeof this._hostWriteBoard === 'function') {
                    this._hostWriteBoard('playing');
                } else {
                    this._hostSyncBoard({ immediate: true });
                }
                const poolEl = document.getElementById('banana-pool-count');
                if (poolEl) poolEl.textContent = String(this._tilePool.length);
                this.requestRender?.();
                if (this.roomData?.global?.board && Array.isArray(this._tilePool)) {
                    this._syncHostPoolOnRoomCaches?.();
                }
                this._mpDistributionInvariantCheck?.('host-peel');
                this._mpLetterIntegrityCheck?.('host-peel');
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
                    this._mpLetterIntegrityCheck?.('host-dump-reconcile');
                    this._mpDistributionInvariantCheck?.('host-dump-reconcile');
                    if (this._hostApplyDump(uid, msg.tileId)) return 'handled';
                    console.warn('[Bananagrams] guest dump failed on host for', uid, msg.tileId);
                    return 'retry';
                }
                if (msg.type === 'peel') {
                    const layout = Array.isArray(msg.positions) ? msg.positions : null;
                    if (this._hostPeelForPlayer(uid, layout)) return 'handled';
                    return 'drop';
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
                        letter: this._mpCanonicalLetter(t.id, t.letter, 'victory-layout-tile')
                    }));
                    if (typeof this._logReviewBoards === 'function') {
                        this._logReviewBoards('host-received-ending', { [uid]: filtered });
                    }
                    if (this._hostMaySyncReview?.()) {
                        this._ensureReviewLayoutsSnapshot();
                        const display = this._displayReviewLayoutsFromOrig(this._reviewLayouts);
                        const fp = this._reviewLayoutsFingerprint(display);
                        if (!fp || fp !== this._reviewLayoutsSyncedFp) {
                            this._reviewLayoutsSyncedFp = fp;
                            this._hostSyncReviewState({ processBananaInteractions: false });
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
