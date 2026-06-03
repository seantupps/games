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
                if (this._inReviewExperience?.()) return;
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
                this._tilePool = this._buildTilePool();
                const handSize = this._handSizeForParty();
                const origin = { x: this.ORIGIN, y: this.ORIGIN };
                let nextId = 0;
                this._mpOwned = {};
                this._mpInventorySeq = {};
                const myUid = this._myUid();
                uids.forEach((uid) => {
                    const dealt = BananaRules.dealPlayerHand(
                        this._tilePool, origin, handSize, nextId
                    );
                    const { owned, positions } = this._splitTiles(dealt);
                    this._mpOwned[uid] = owned;
                    this._mpInventorySeq[uid] = 1;
                    if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                    this._mpPlayerLayouts[uid] = positions;
                    if (!this._mpScores[uid]) this._mpScores[uid] = 0;
                    nextId += handSize;
                });
                this._nextTileId = nextId;
                this.elapsedMs = 0;
                this._timerStart = null;
                this._selectedIds.clear();
                this._selectionHighlight = false;
                this._bannerText = '';
                this._peelSeq = 0;
                this._lastPeelDraws = null;
                this._localInventorySeq = 0;
                this._updateHudEl();
                this._hostSyncBoard({ immediate: true });
                this.tiles = this._mergeInventoryWithLayout(
                    this._mpOwned[myUid],
                    this._mpPlayerLayouts[myUid] || {},
                    null
                );
                this._localInventorySeq = this._mpInventorySeq[myUid] || 1;
                this._applyDefaultPlayingViewport?.();
                this.requestRender();
                this._syncViewportAfterLayout();
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
                if (this._inReviewExperience?.()) {
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
                if (this._inReviewExperience?.()) {
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
                this._hostSyncBoard({ immediate: true });
                return true;
            },

            _hostApplyDumpInventoryOnly(uid, tileId) {
                this._hostHydrateOwnedFromBoard?.(uid);
                const owned = [...(this._mpOwned[uid] || [])];
                const idx = owned.findIndex((o) => o.id === tileId);
                if (idx < 0) return { ok: false, reason: 'tile-not-found' };
                const min = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
                if ((this._tilePool?.length ?? 0) < min) return { ok: false, reason: 'short-pool' };
        
                const removed = owned[idx];
                const nextPool = [...this._tilePool];
                const drawn = BananaRules.dumpTile(nextPool, removed.letter, 3);
                if (drawn.length < 3) return { ok: false, reason: 'short-pool' };

                this._tilePool = nextPool;
                owned.splice(idx, 1);
                drawn.forEach((letter) => {
                    owned.push({
                        id: `t-${this._nextTileId++}`,
                        letter,
                        faceUp: true
                    });
                });
                this._mpOwned[uid] = owned;
                return { ok: true };
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

            /** Mirror host peel draw order so guest peel tiles spawn before RTDB echo. */
            _guestApplyOptimisticPeel() {
                if (this.isHost?.() || !this._isMultiplayerMode?.()) return false;
                if (typeof BananaRules === 'undefined') return false;
                const me = this._myUid();
                const uids = this._peelPartyUids(me);
                if (!uids.length || this._tilePool.length < uids.length) return false;

                const pool = [...this._tilePool];
                let nextId = this._nextTileId || 1;
                const drawn = {};
                const drawnIds = {};
                uids.forEach((u) => {
                    const letters = BananaRules.drawFromPool(pool, 1);
                    if (!letters.length) return;
                    const id = `t-${nextId++}`;
                    drawn[u] = letters[0];
                    drawnIds[u] = id;
                });
                const letter = drawn[me];
                const id = drawnIds[me];
                if (!letter || !id) return false;

                const spots = this._planDrawnTileSpots(this.tiles, [letter]);
                if (!spots || spots.length !== 1) return false;

                this._tilePool = pool;
                this._nextTileId = nextId;
                this.tiles.push({
                    id,
                    letter,
                    x: spots[0].x,
                    y: spots[0].y,
                    faceUp: true
                });
                this._persistMpLayout?.();
                this.requestRender();
                return true;
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
                if (typeof this._hostWriteBoard === 'function') {
                    this._hostWriteBoard('playing');
                } else {
                    this._hostSyncBoard({ immediate: true });
                }
            },

            _hostBananasForPlayer(uid, guestLayout = null) {
                if (!this._checker || !BananaGrid) return false;
                if (this._winnerUid || this._victoryRegistered
                    || (typeof this._isBoardInReview === 'function' && this._isBoardInReview())) {
                    return false;
                }
                if (this._tilePool.length) return false;
                const myUid = this._myUid();
                const hand = uid === myUid
                    ? this.tiles
                    : (guestLayout ? this._handFromOwnedAndPositions(uid, guestLayout) : null);
                if (!this._handQualifiesForBananasWin(hand)) return false;
                this._hostSyncLayoutBeforeWin(uid, guestLayout);
                this._onPlayerWins(uid);
                return true;
            },

            /** Dev /win — same host transition as bananas win (sync + review), skip peel validation. */
            _hostDevWinForPlayer(uid, guestLayout = null) {
                if (!this.isHost()) return false;
                if (this._winnerUid || this._victoryRegistered
                    || (typeof this._isBoardInReview === 'function' && this._isBoardInReview())) {
                    return false;
                }
                this._tilePool = [];
                this._hostSyncLayoutBeforeWin(uid, guestLayout);
                this._onPlayerWins(uid);
                return true;
            },

            _hostPeelForPlayer(uid, guestLayout = null) {
                if (!this._checker || !BananaGrid) return false;
                if (this._winnerUid || this._victoryRegistered
                    || (typeof this._isBoardInReview === 'function' && this._isBoardInReview())) {
                    return false;
                }
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
                const hand = uid === myUid
                    ? this.tiles
                    : (guestLayout ? this._handFromOwnedAndPositions(uid, guestLayout) : null);
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
                uids.forEach((u) => {
                    const remote = Array.isArray(roomOwned?.[u])
                        ? roomOwned[u].map((t) => ({ id: t.id, letter: t.letter, faceUp: !!t.faceUp }))
                        : [];
                    const local = Array.isArray(this._mpOwned?.[u])
                        ? this._mpOwned[u].map((t) => ({ id: t.id, letter: t.letter, faceUp: !!t.faceUp }))
                        : [];
                    ownedByUid[u] = local.length ? local : remote;
                });
                if (guestLayout && uid !== myUid && ownedByUid[uid]?.length) {
                    const letterById = {};
                    ownedByUid[uid].forEach((t) => { letterById[t.id] = t.letter; });
                    const fallback = ownedByUid[uid];
                    ownedByUid[uid] = guestLayout.map((p, idx) => ({
                        id: p.id,
                        letter: letterById[p.id] || fallback[idx % Math.max(fallback.length, 1)]?.letter || 'A',
                        faceUp: true
                    }));
                }
                const playerCount = uids.length;
                if (!this._tilePool.length || this._tilePool.length < playerCount) return false;
                const drawn = {};
                const drawnIds = {};
                uids.forEach((u) => {
                    const letters = BananaRules.drawFromPool(this._tilePool, 1);
                    if (!letters.length) return;
                    const id = `t-${this._nextTileId++}`;
                    if (!ownedByUid[u]) ownedByUid[u] = [];
                    ownedByUid[u].push({ id, letter: letters[0], faceUp: true });
                    drawn[u] = letters[0];
                    drawnIds[u] = id;
                });
                if (Object.keys(drawn).length !== playerCount) return false;
                if (guestLayout && uid !== myUid) {
                    const letterById = {};
                    (hand || []).forEach((t) => {
                        if (t?.id) letterById[t.id] = t.letter;
                    });
                    const rebuilt = guestLayout
                        .filter((p) => p?.id != null)
                        .map((p) => ({
                            id: p.id,
                            letter: letterById[p.id] || 'A',
                            faceUp: true
                        }));
                    if (drawnIds[uid] && drawn[uid]) {
                        rebuilt.push({ id: drawnIds[uid], letter: drawn[uid], faceUp: true });
                    }
                    ownedByUid[uid] = rebuilt;
                }
                uids.forEach((u) => {
                    this._mpOwned[u] = ownedByUid[u] || [];
                });
                this._lastPeelDraws = drawn;
                this._peelSeq = (this._peelSeq || 0) + 1;
                this._peelActorUid = uid;
                uids.forEach((u) => this._hostBumpInventorySeq(u));
                if (typeof this._hostCancelPendingBoardSync === 'function') {
                    this._hostCancelPendingBoardSync();
                }
                if (typeof this._hostWriteBoard === 'function') {
                    this._hostWriteBoard('playing');
                } else {
                    this._hostSyncBoard({ immediate: true });
                }
                return true;
            },

            /**
             * @returns {'handled'|'drop'|'retry'} handled = success; drop = stale/permanent fail; retry = leave queued
             */
            _hostHandleBananaInteraction(uid, msg) {
                if (!msg || !this.isHost() || uid === this._myUid()) return 'drop';
                const postWin = !!(this._winnerUid || this._victoryRegistered
                    || (typeof this._isBoardInReview === 'function' && this._isBoardInReview()));
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
                    if (this._hostApplyDump(uid, msg.tileId)) return 'handled';
                    if (Array.isArray(msg.owned) && msg.owned.length) {
                        this._hostSetOwned(uid, msg.owned, false);
                        if (!this._mpInventorySeq?.[uid]) this._mpInventorySeq[uid] = 1;
                        if (this._hostApplyDump(uid, msg.tileId)) return 'handled';
                    }
                    console.warn('[Bananagrams] guest dump failed on host for', uid, msg.tileId);
                    return 'retry';
                }
                if (msg.type === 'peel') {
                    const layout = Array.isArray(msg.positions) ? msg.positions : null;
                    if (Array.isArray(msg.owned) && msg.owned.length) {
                        this._hostSetOwned(uid, msg.owned, false);
                        if (!this._mpInventorySeq?.[uid]) this._mpInventorySeq[uid] = 1;
                    }
                    if (this._hostPeelForPlayer(uid, layout)) return 'handled';
                    return 'drop';
                }
                if (msg.type === 'bananas') {
                    const layout = Array.isArray(msg.positions) ? msg.positions : null;
                    if (Array.isArray(msg.owned) && msg.owned.length) {
                        this._hostSetOwned(uid, msg.owned, false);
                        if (!this._mpInventorySeq?.[uid]) this._mpInventorySeq[uid] = 1;
                    }
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
                    const owned = this._mpOwned?.[uid]
                        || this.roomData?.global?.board?.tilesOwnedByPlayer?.[uid]
                        || [];
                    const ownedIds = new Set(owned.map((o) => o.id));
                    let filtered = ownedIds.size
                        ? msg.tiles.filter((t) => t?.id && ownedIds.has(t.id))
                        : msg.tiles;
                    if (!filtered.length && msg.tiles.length
                        && typeof this._isBoardInReview === 'function'
                        && !this._isBoardInReview()) {
                        filtered = msg.tiles.filter((t) => t?.id);
                    }
                    if (!filtered.length) return 'drop';
                    if (!this._reviewLayouts) this._reviewLayouts = {};
                    this._reviewLayouts[uid] = filtered;
                    if (typeof this._logReviewBoards === 'function') {
                        this._logReviewBoards('host-received-ending', { [uid]: filtered });
                    }
                    if (this._hostMaySyncReview?.()) {
                        const display = this._displayReviewLayoutsFromOrig(
                            this._ensureReviewLayoutsSnapshot()
                        );
                        const fp = this._reviewLayoutsFingerprint(display);
                        const board = this._boardReviewSnapshot?.() || null;
                        const boardFp = board?.reviewLayouts
                            ? this._reviewLayoutsFingerprint(board.reviewLayouts)
                            : null;
                        if (!fp || (fp !== this._reviewLayoutsSyncedFp && fp !== boardFp)) {
                            this._reviewLayoutsSyncedFp = fp;
                            this._hostSyncReviewState();
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
                return (spots || []).map((spot) => ({
                    id: `t-${this._nextTileId++}`,
                    letter: spot.letter,
                    x: spot.x,
                    y: spot.y,
                    faceUp: !!faceUp
                }));
            },

            _applyDrawnLettersToHand(letters, handTiles = this.tiles) {
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
