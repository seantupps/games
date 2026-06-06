/** Bananagrams — mp-review (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-review.js');
    Object.assign(G.prototype, {
            _boardReviewSnapshot() {
                return this.roomData?.global?.board || null;
            },

            _boardPhase(board) {
                if (!board) return BananagramsGame.MP_PHASE.PLAYING;
                const p = board.phase;
                if (p === BananagramsGame.MP_PHASE.REVIEW
                    || p === BananagramsGame.MP_PHASE.PLAYING
                    || p === BananagramsGame.MP_PHASE.IDLE) {
                    return p;
                }
                return board.reviewPhase === true
                    ? BananagramsGame.MP_PHASE.REVIEW
                    : BananagramsGame.MP_PHASE.PLAYING;
            },

            _isBoardInReview(board = this._boardReviewSnapshot()) {
                return this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
            },

            /** UI-only: review viewport, drag lock, Done — set from board apply, not a sync authority. */
            _reviewUiActive() {
                return !!this._postGameReview;
            },

            /** Gameplay/input: board says review or review UI is active (projection / read-only). */
            _inReviewExperience() {
                return !this.canMutatePlayingBoard();
            },

            /**
             * One-way projection gate — playing inventory may rebuild this.tiles only while
             * global/board is in playing phase AND the client is not in win/review.
             * Review tiles are projected only from reviewLayouts (_applyReviewLayouts).
             */
            _shouldProjectPlayingInventory(board, options = {}) {
                if (options.reset && options.force) return true;
                if (this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW) return false;
                if (this._reviewUiActive?.()) return false;
                if (this._mpClientBoardPhase === BananagramsGame.MP_PHASE.REVIEW && !options.reset) {
                    return false;
                }
                if (!this.canMutatePlayingBoard?.()) return false;
                return true;
            },

            /** Playing board snapshots that fail the projection gate must not mutate client state. */
            _shouldApplyPlayingBoardSnapshot(board, options = {}) {
                if (!board || options.reset) return true;
                if (this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW) return true;
                if (this._shouldProjectPlayingInventory(board, options)) return true;
                // Post-Done redeal / SPLIT — fresh playing board after review closed locally.
                if (board.gameStarted && !board.winnerUid && !this._winnerUid && !this.isOver
                    && !this._reviewUiActive?.() && !this._hostReviewTransitionActive) {
                    return true;
                }
                return false;
            },

            /** Re-project merged review tiles if playing inventory clobbered this.tiles. */
            _ensureReviewTilesProjected(board) {
                if (!board || this._boardPhase(board) !== BananagramsGame.MP_PHASE.REVIEW) return;
                const partyUids = this._getPlayerUids();
                if (partyUids.length < 2) return;
                const orig = board.reviewLayoutsOrig || board.reviewLayouts || this._reviewLayouts;
                if (!this._reviewLayoutsReady(orig, partyUids)) return;
                const display = typeof this._displayReviewLayoutsFromOrig === 'function'
                    ? this._displayReviewLayoutsFromOrig(orig)
                    : orig;
                const expectedTiles = Object.values(display || {})
                    .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
                const visiblePlayers = new Set((this.tiles || [])
                    .map((t) => t.ownerUid || this._myUid())
                    .filter(Boolean)).size;
                if ((this.tiles?.length || 0) >= expectedTiles
                    && visiblePlayers >= partyUids.length) {
                    return;
                }
                this._reviewLayoutsFp = null;
                this._applyReviewLayouts(display);
                this._mpAssertReviewProjection(board, 'ensureReviewTilesProjected');
            },

            /** Fail loud in dev/test when runtime tiles drift from board reviewLayouts authority. */
            _mpAssertReviewProjection(board, label = 'review-projection') {
                if (!board || this._boardPhase(board) !== BananagramsGame.MP_PHASE.REVIEW) return;
                const partyUids = this._getPlayerUids();
                if (partyUids.length < 2) return;
                const layouts = board.reviewLayoutsOrig || board.reviewLayouts || this._reviewLayouts;
                if (!this._reviewLayoutsReady(layouts, partyUids)) return;
                const expectedTiles = Object.values(layouts || {})
                    .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
                const counts = {};
                partyUids.forEach((u) => { counts[u] = 0; });
                (this.tiles || []).forEach((t) => {
                    const o = t.ownerUid || this._myUid();
                    if (counts[o] != null) counts[o] += 1;
                });
                const missing = partyUids.filter((u) => !counts[u]);
                const drift = (this.tiles?.length || 0) < expectedTiles || missing.length;
                if (!drift) return;
                const detail = {
                    label,
                    tileCount: this.tiles?.length,
                    expectedTiles,
                    counts,
                    missing,
                    boardSeq: board.seq,
                    reviewEpoch: board.reviewEpoch
                };
                if (typeof BananaDev !== 'undefined' && BananaDev.failAuthorityCommit) {
                    BananaDev.failAuthorityCommit('review projection drift', detail);
                } else if (this._reviewTraceOn()) {
                    console.warn('[REVIEW] projection drift', detail);
                }
            },

            _setGamePhase(phase) {
                if (!phase || this._gamePhase === phase) return;
                this._gamePhase = phase;
            },

            /**
             * Single derived phase for command gating (host authority + dev commands).
             * Most restrictive signal wins — stored _gamePhase never overrides win/review flags.
             * @returns {'playing'|'win-pending'|'review'|'done'}
             */
            deriveGamePhase() {
                if (this._hostReviewCompleting) return 'done';
                const order = { playing: 0, 'win-pending': 1, review: 2, done: 3 };
                const candidates = [];
                if (this._reviewUiActive?.() || this._isBoardInReview?.()) {
                    candidates.push('review');
                }
                if (this._hostReviewTransitionActive) candidates.push('win-pending');
                if (this._winnerUid || this._victoryRegistered || this.isOver) {
                    candidates.push('win-pending');
                }
                if (this.isHost?.() && this._gamePhase && this._gamePhase !== 'playing') {
                    candidates.push(this._gamePhase);
                }
                if (!candidates.length) return 'playing';
                return candidates.reduce(
                    (best, phase) => (order[phase] >= order[best] ? phase : best),
                    'playing'
                );
            },

            /** Host playing writes, peel, dump, drag, dev solve — only while phase is playing. */
            canMutatePlayingBoard() {
                return this.deriveGamePhase() === 'playing';
            },

            /** @deprecated alias — use !canMutatePlayingBoard() */
            isPostWinOrReview() {
                return !this.canMutatePlayingBoard();
            },

            /** Dev/test snapshot when phase flags drift from board.phase. */
            gamePhaseSnapshot() {
                const board = typeof this._boardReviewSnapshot === 'function'
                    ? this._boardReviewSnapshot()
                    : null;
                return {
                    phase: this.deriveGamePhase(),
                    storedPhase: this._gamePhase || null,
                    postGameReview: !!this._postGameReview,
                    hostReviewTransition: !!this._hostReviewTransitionActive,
                    hostReviewCompleting: !!this._hostReviewCompleting,
                    boardPhase: board ? this._boardPhase(board) : null,
                    winnerUid: this._winnerUid || null,
                    victoryRegistered: !!this._victoryRegistered,
                    isOver: !!this.isOver,
                    boardSeq: this._boardSeq ?? 0,
                    devSolveSeq: this._devSolveSeq ?? 0
                };
            },

            /** Whether host may write review payloads to RTDB. */
            _hostMayWriteReviewBoard() {
                if (!this.isHost() || !this._isMultiplayerMode()) return false;
                if (this._hostReviewCompleting) return false;
                return !!(
                    this._hostReviewTransitionActive
                    || this._isBoardInReview()
                    || (this._winnerUid && this.isOver)
                );
            },

            _activateReviewUi() {
                if (this._postGameReview) {
                    this._hostReviewTransitionActive = false;
                    return;
                }
                this._setGamePhase('review');
                this._postGameReview = true;
                this._hostReviewTransitionActive = false;
                this._bindReviewViewportReflow();
                this._reviewViewportSettled = false;
                this._reviewFitRetries = 0;
                this._reviewViewportRetry = 0;
                this._mpClientBoardPhase = BananagramsGame.MP_PHASE.REVIEW;
                this._setBoardReadOnly(true);
                this._syncDoneButton();
                if (this._isMultiplayerMode?.() && this._winnerUid && !this._victoryRegistered) {
                    const hostUid = this.roomData?.host || '';
                    const hubWinner = this._winnerUid === hostUid ? 'P1' : 'P2';
                    this.clearAutoReset?.();
                    this._registerVictoryWithoutAutoReset(hubWinner, { winnerUid: this._winnerUid });
                }
                window.parent.postMessage({ type: 'post-game-blocking', active: true }, '*');
            },

            _soloReviewKey() {
                return this._myUid() || 'solo';
            },

            _canShowDoneButton() {
                const inReview = this._reviewUiActive()
                    || (this._isMultiplayerMode() && this._isBoardInReview());
                if (!inReview) return false;
                return !this._isMultiplayerMode() || this.isHost();
            },

            isPostGameBlocking() {
                if (!this._isMultiplayerMode()) {
                    return this._reviewUiActive();
                }
                return this.isHost() && this._isBoardInReview();
            },

            _reviewTraceOn() {
                try {
                    return localStorage.getItem('five_banana_trace_review') === '1';
                } catch (_) {
                    return false;
                }
            },

            _reviewPlayerLabel(uid) {
                const pd = this.roomData?.playerData?.[uid];
                const host = this.roomData?.host || '';
                if (uid === host) return 'P1-host';
                const uids = this._getPlayerUids();
                const idx = uids.indexOf(uid);
                return idx >= 0 ? `P${idx + 1}` : uid?.slice(-6) || '?';
            },

            _compactReviewTiles(list) {
                return (list || []).map((t) => ({
                    id: t.id,
                    letter: t.letter,
                    x: Math.round(t.x),
                    y: Math.round(t.y)
                }));
            },

            _logReviewBoards(phase, layoutsByUid) {
                if (!this._reviewTraceOn()) return;
                const uids = this._getPlayerUids();
                const payload = { phase, players: {} };
                uids.forEach((uid) => {
                    payload.players[this._reviewPlayerLabel(uid)] = {
                        uid,
                        color: this._playerColor(uid),
                        tileCount: layoutsByUid?.[uid]?.length ?? 0,
                        tiles: this._compactReviewTiles(layoutsByUid?.[uid])
                    };
                });
                console.log('[REVIEW]', JSON.stringify(payload));
            },

            _reviewLayoutsFingerprint(layouts) {
                const uids = Object.keys(layouts || {}).sort();
                return uids.map((uid) => {
                    const tiles = layouts[uid] || [];
                    const parts = tiles.map((t) => {
                        const letter = String(t?.letter || '').toUpperCase();
                        return `${t.id}:${letter}:${Math.round(t.x)},${Math.round(t.y)}`;
                    });
                    return `${uid}#${tiles.length}#${parts.join(',')}`;
                }).join('|');
            },

            _reviewLayoutPlayerCount(layouts) {
                return Object.values(layouts || {}).filter((list) => list?.length > 0).length;
            },

            _reviewLayoutsReady(layouts, partyUids = null) {
                const uids = (partyUids || this._getPlayerUids()).filter(Boolean);
                if (uids.length < 2) return true;
                return uids.every((uid) => Array.isArray(layouts?.[uid]) && layouts[uid].length > 0);
            },

            /** Authoritative end-of-game layout for one uid on THIS client only. */
            _captureEndingLayoutForUid(uid) {
                const me = this._myUid();
                if (uid !== me) return [];

                const board = this._boardReviewSnapshot();
                const owned = this._mpOwned?.[me]
                    || board?.tilesOwnedByPlayer?.[me]
                    || [];

                const runtimeById = {};
                (this.tiles || []).forEach((t) => {
                    if (t.ownerUid && t.ownerUid !== me) return;
                    runtimeById[t.id] = t;
                });
                const runtimeMine = Object.values(runtimeById);
                const boardOwned = board?.tilesOwnedByPlayer?.[me] || [];
                const letterForId = (id, runtimeLetter) => {
                    const fromBoard = boardOwned.find((o) => o.id === id)?.letter
                        || owned.find((o) => o.id === id)?.letter;
                    if (this._isMultiplayerMode?.()) {
                        if (this.isHost?.()) {
                            return this._mpCanonicalLetter?.(id, fromBoard || runtimeLetter, 'ending-capture')
                                || fromBoard || runtimeLetter;
                        }
                        return this._mpNormLetter?.(fromBoard || runtimeLetter) || runtimeLetter;
                    }
                    return runtimeLetter;
                };

                if (runtimeMine.length > 0) {
                    const ownedIds = new Set(owned.map((o) => o.id));
                    const source = owned.length
                        ? runtimeMine.filter((t) => ownedIds.has(t.id))
                        : runtimeMine;
                    const extras = owned.length
                        ? runtimeMine.filter((t) => !ownedIds.has(t.id))
                        : [];
                    const merged = [...source, ...extras];
                    const use = merged.length ? merged : runtimeMine;
                    return this._serializeHandTiles(use.map((t) => ({
                        id: t.id,
                        letter: letterForId(t.id, t.letter),
                        x: t.x,
                        y: t.y,
                        faceUp: !!t.faceUp
                    })));
                }

                const ownedOnRuntime = owned.filter((o) => runtimeById[o.id]).length;
                const ownedLetterDrift = owned.some((o) => {
                    const rt = runtimeById[o.id];
                    return rt && String(rt.letter).toUpperCase() !== String(o.letter).toUpperCase();
                });
                if (ownedLetterDrift && owned.length) {
                    return this._serializeHandTiles(owned.map((o) => {
                        const rt = runtimeById[o.id];
                        return {
                            id: o.id,
                            letter: letterForId(o.id, o.letter),
                            x: rt?.x,
                            y: rt?.y,
                            faceUp: !!(rt?.faceUp ?? o.faceUp)
                        };
                    }).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y)));
                }
                const runtimeIsAuthoritative = runtimeMine.length > 0
                    && (!owned.length
                        || runtimeMine.length > owned.length
                        || (owned.length && !ownedOnRuntime));
                if (runtimeIsAuthoritative) {
                    const ownedIds = new Set(owned.map((o) => o.id));
                    const source = owned.length
                        ? runtimeMine.filter((t) => ownedIds.has(t.id))
                        : runtimeMine;
                    return this._serializeHandTiles(source.map((t) => ({
                        id: t.id,
                        letter: letterForId(t.id, t.letter),
                        x: t.x,
                        y: t.y,
                        faceUp: !!t.faceUp
                    })));
                }

                if (!owned.length) {
                    return runtimeMine.length ? this._serializeHandTiles(runtimeMine) : [];
                }

                let layout = this._layoutMapForPlayer(board, me, owned);
                if (!Object.keys(layout).length) {
                    layout = this._pruneLayout(this._layoutFromTiles(this.tiles), owned);
                }

                const merged = [];
                owned.forEach((o) => {
                    const rt = runtimeById[o.id];
                    const pick = (x, y) => (
                        Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
                    );
                    let coords = rt ? pick(rt.x, rt.y) : null;
                    if (!coords) {
                        const saved = layout[o.id];
                        coords = saved ? pick(saved.x, saved.y) : null;
                    }
                    if (coords) {
                        merged.push({
                            id: o.id,
                            letter: letterForId(o.id, rt?.letter ?? o.letter),
                            x: coords.x,
                            y: coords.y,
                            faceUp: rt ? !!rt.faceUp : !!o.faceUp
                        });
                    }
                });

                const mergedIds = new Set(merged.map((t) => t.id));
                const missing = owned.filter((o) => !mergedIds.has(o.id));
                if (missing.length) {
                    const fallback = this._rackTilesFromOwned(missing);
                    merged.push(...fallback);
                }

                if (merged.length) return this._serializeHandTiles(merged);

                const fallback = this._mergeInventoryWithLayout(owned, layout, Object.values(runtimeById));
                return this._serializeHandTiles(fallback);
            },

            _freezeMyEndingLayout() {
                const me = this._myUid();
                if (!me) return [];
                const tiles = this._captureEndingLayoutForUid(me);
                if (!this._endingLayoutsCache) this._endingLayoutsCache = {};
                if (tiles.length) {
                    this._endingLayoutsCache[me] = tiles;
                    this._logReviewBoards('original-ending-frozen', { [me]: tiles });
                }
                return tiles;
            },

            _onMpVictoryAnnounced(board) {
                if (!this._isMultiplayerMode() || this._isBoardInReview()) return;
                if (this._reviewUiActive()) return;
                if (this._myEndingLayoutPublished) return;
                this._freezeMyEndingLayout();
                this._publishMyEndingLayout();
            },

            _publishMyEndingLayout() {
                const me = this._myUid();
                const tiles = this._endingLayoutsCache?.[me]
                    || this._captureEndingLayoutForUid(me);
                if (!tiles?.length) return;

                if (this.isHost()) {
                    if (!this._reviewLayouts) this._reviewLayouts = {};
                    this._reviewLayouts[me] = tiles;
                    this._myEndingLayoutPublished = true;
                    return;
                }

                if (this._myEndingLayoutPublished) return;
                this._myEndingLayoutPublished = true;
                this._logReviewBoards('publish-ending-to-host', { [me]: tiles });
                this._sendBananaInteraction({
                    type: 'victory-layout',
                    tiles
                });
            },

            _listTilesBounds(tiles) {
                const size = (typeof BananaRules !== 'undefined' && BananaRules.TILE_SIZE) || 40;
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                (tiles || []).forEach((t) => {
                    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) return;
                    minX = Math.min(minX, t.x);
                    minY = Math.min(minY, t.y);
                    maxX = Math.max(maxX, t.x + size);
                    maxY = Math.max(maxY, t.y + size);
                });
                if (!isFinite(minX)) return null;
                return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
            },

            /** Pack each player's ending board so no tiles overlap in the combined review view. */
            _arrangeReviewLayoutsForDisplay(layouts) {
                const gap = (typeof BananaRules !== 'undefined' && BananaRules.TILE_GAP)
                    ? BananaRules.TILE_GAP * 3
                    : 120;
                const uids = this._getPlayerUids().filter((u) => layouts?.[u]?.length);
                if (uids.length <= 1) return { ...(layouts || {}) };

                const vis = this.getVisibleViewportSize?.()
                    || { width: window.innerWidth, height: window.innerHeight };
                const portrait = vis.height > vis.width;

                const arranged = {};
                let cursorMaxX = -Infinity;
                let cursorMaxY = -Infinity;
                let cursorMinY = Infinity;
                let cursorMinX = Infinity;

                uids.forEach((uid, idx) => {
                    const tiles = layouts[uid] || [];
                    const bounds = this._listTilesBounds(tiles);
                    if (!bounds) {
                        arranged[uid] = tiles.map((t) => ({ ...t }));
                        return;
                    }

                    let dx = 0;
                    let dy = 0;
                    if (idx > 0) {
                        if (portrait) {
                            dx = Math.round(cursorMinX - bounds.minX);
                            if (bounds.minY < cursorMaxY + gap) {
                                dy = Math.ceil(cursorMaxY + gap - bounds.minY);
                            }
                        } else {
                            dy = Math.round(cursorMinY - bounds.minY);
                            if (bounds.minX + dx < cursorMaxX + gap) {
                                dx = Math.ceil(cursorMaxX + gap - bounds.minX);
                            }
                        }
                    } else {
                        cursorMinY = bounds.minY;
                        cursorMinX = bounds.minX;
                    }

                    arranged[uid] = tiles.map((t) => ({
                        ...t,
                        x: Math.round(t.x + dx),
                        y: Math.round(t.y + dy)
                    }));
                    const placed = this._listTilesBounds(arranged[uid]);
                    if (portrait) {
                        cursorMaxY = placed.maxY;
                        cursorMinX = Math.min(cursorMinX, placed.minX);
                    } else {
                        cursorMaxX = placed.maxX;
                        cursorMinY = Math.min(cursorMinY, placed.minY);
                    }
                });

                return arranged;
            },

            _reviewDbgOn() {
                try {
                    return localStorage.getItem('five_review_dbg') === '1'
                        || new URLSearchParams(window.location.search).has('reviewDbg');
                } catch (_) {
                    return false;
                }
            },

            _reviewDbg(tag, detail = {}) {
                if (!this._reviewDbgOn()) return;
                console.log('[REVIEW-VP]', tag, {
                    role: this.playerRole,
                    uid: typeof this._myUid === 'function' ? this._myUid() : null,
                    tiles: this.tiles?.length ?? 0,
                    settled: !!this._reviewViewportSettled,
                    zoom: this.zoom,
                    panX: this.canvasPanX,
                    panY: this.canvasPanY,
                    ...detail
                });
            },

            _canvasLayoutMetrics() {
                const host = document.getElementById('game-container');
                const canvas = document.getElementById('board-canvas');
                if (!host || !canvas) return { ok: false, reason: 'missing-nodes' };
                void host.offsetHeight;
                void canvas.offsetHeight;
                const cr = canvas.getBoundingClientRect();
                return {
                    ok: canvas.clientWidth > 0 && canvas.clientHeight > 0,
                    cw: canvas.clientWidth,
                    ch: canvas.clientHeight,
                    crw: cr.width,
                    crh: cr.height,
                    hostW: host.clientWidth,
                    hostH: host.clientHeight
                };
            },

            _isCanvasLayoutReady() {
                return !!this._canvasLayoutMetrics().ok;
            },

            _bindReviewViewportReflow() {
                if (this._reviewViewportReflowBound) return;
                this._reviewViewportReflowBound = true;
                const reflow = () => {
                    if (this._headedMpReviewLock) return;
                    const inReview = typeof this._inReviewExperience === 'function'
                        ? this._inReviewExperience()
                        : this._reviewUiActive();
                    if (!inReview || !this.tiles?.length) return;
                    this._reviewDbg('reflow-event', { metrics: this._canvasLayoutMetrics() });
                    this._scheduleReviewViewportBurst('resize');
                };
                window.addEventListener('resize', reflow);
                if (window.visualViewport) {
                    window.visualViewport.addEventListener('resize', reflow);
                    window.visualViewport.addEventListener('scroll', reflow);
                }
            },

            _scheduleReviewViewportBurst(source = 'unknown') {
                if (this._headedMpReviewLock) return;
                if (!this._inReviewExperience?.()) return;
                this._reviewDbg('burst', { source });
                const run = () => {
                    if (!this.tiles?.length) return;
                    const shouldRefit = !this._reviewViewportSettled
                        || source === 'resize'
                        || source === 'apply-review-layouts';
                    if (shouldRefit) {
                        this._fitReviewViewportOnce();
                    } else {
                        this._flushReviewViewportImmediate({ paintOnly: true });
                    }
                };
                run();
                requestAnimationFrame(() => {
                    run();
                    requestAnimationFrame(run);
                });
            },

            _syncReviewDom() {
                if (typeof this._render === 'function') {
                    this._render({ skipViewportFlush: true });
                }
            },

            _applyReviewViewportTransform() {
                if (typeof GameViewport === 'undefined') return false;
                const bounds = this._reviewTilesBounds(this.tiles);
                this.targetZoom = this.zoom;
                if (bounds) {
                    GameViewport.centerWorldPoint(this, bounds.cx, bounds.cy);
                }
                const applied = GameViewport.applyPanZoom(this);
                if (typeof GameViewport.reflowOnResize === 'function') {
                    GameViewport.reflowOnResize(this);
                }
                const canvas = document.getElementById('board-canvas');
                if (canvas) {
                    void canvas.offsetHeight;
                    canvas.getBoundingClientRect();
                }
                return applied;
            },

            _flushReviewViewportImmediate(options = {}) {
                if (this._headedMpReviewLock) return;
                if (!this._inReviewExperience?.()) return;
                if (!this._isCanvasLayoutReady()) {
                    const retry = (this._reviewViewportRetry = (this._reviewViewportRetry || 0) + 1);
                    this._reviewDbg('flush-defer-zero-canvas', {
                        retry,
                        metrics: this._canvasLayoutMetrics()
                    });
                    if (retry <= 16) {
                        requestAnimationFrame(() => this._flushReviewViewportImmediate(options));
                    }
                    return;
                }
                this._reviewViewportRetry = 0;
                const bounds = this._reviewTilesBounds(this.tiles);
                this._applyReviewViewportTransform();
                this._reviewDbg('flush-ok', {
                    bounds,
                    metrics: this._canvasLayoutMetrics(),
                    focal: this._viewportFocal
                });
                if (!options.paintOnly) {
                    this.requestRender();
                    if (window.parent !== window) {
                        window.parent.postMessage({
                            type: 'game-rendered',
                            game: this.gameName,
                            visible: this.tiles?.length || 0
                        }, '*');
                    }
                }
            },

            _reviewTilesBounds(tiles = this.tiles) {
                const size = (typeof BananaRules !== 'undefined' && BananaRules.TILE_SIZE) || 40;
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                (tiles || []).forEach((t) => {
                    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) return;
                    minX = Math.min(minX, t.x);
                    minY = Math.min(minY, t.y);
                    maxX = Math.max(maxX, t.x + size);
                    maxY = Math.max(maxY, t.y + size);
                });
                if (!isFinite(minX)) return null;
                return {
                    minX,
                    minY,
                    maxX,
                    maxY,
                    cx: (minX + maxX) / 2,
                    cy: (minY + maxY) / 2,
                    w: maxX - minX,
                    h: maxY - minY
                };
            },

            centerViewOnReviewBoards() {
                const bounds = this._reviewTilesBounds();
                if (!bounds) {
                    this.centerViewOnOrigin();
                    return;
                }
                if (typeof GameViewport !== 'undefined' && GameViewport.centerWorldPoint) {
                    GameViewport.centerWorldPoint(this, bounds.cx, bounds.cy);
                }
            },

            _fitReviewViewportOnce() {
                if (this._headedMpReviewLock) return;
                if (!this._inReviewExperience?.()) return;
                if (!this._isCanvasLayoutReady()) {
                    const retry = (this._reviewFitRetries = (this._reviewFitRetries || 0) + 1);
                    this._reviewDbg('fit-defer-zero-canvas', { retry, metrics: this._canvasLayoutMetrics() });
                    if (retry <= 16) {
                        requestAnimationFrame(() => this._fitReviewViewportOnce());
                    }
                    return;
                }
                this._reviewFitRetries = 0;
                this._syncReviewDom();
                const bounds = this._reviewTilesBounds(this.tiles);
                if (!bounds) {
                    this._reviewDbg('fit-no-bounds', { tileCount: this.tiles?.length ?? 0 });
                    return;
                }
                const fitBox = this._reviewFitViewportBox();
                const vw = fitBox.width;
                const vh = fitBox.height;
                const margin = fitBox.margin;
                const scaleX = Math.max(vw - margin * 2, 1) / Math.max(bounds.w, 1);
                const scaleY = Math.max(vh - margin * 2, 1) / Math.max(bounds.h, 1);
                const fit = Math.min(Math.max(Math.min(scaleX, scaleY), 0.2), 5);
                this.targetZoom = fit;
                this.zoom = fit;
                this._fitZoomInitialized = true;
                this._mobileLayoutAnchorLocked = true;
                this._mobileContentBounds = {
                    w: bounds.w,
                    h: bounds.h,
                    cx: bounds.cx,
                    cy: bounds.cy
                };
                this._reviewDbg('fit', {
                    vw,
                    vh,
                    margin,
                    fit,
                    bounds,
                    fitBox,
                    metrics: this._canvasLayoutMetrics()
                });
                this._flushReviewViewportImmediate({ paintOnly: true });
                this._reviewViewportSettled = true;
                this._scheduleReviewViewportBurst('fit-done');
            },

            _reviewFitViewportBox() {
                const metrics = this._canvasLayoutMetrics();
                const vis = this.getVisibleViewportSize?.()
                    || { width: window.innerWidth, height: window.innerHeight };
                const baseW = Math.max(1, Math.min(vis.width || 1, metrics.cw || vis.width || 1));
                const baseH = Math.max(1, Math.min(vis.height || 1, metrics.ch || vis.height || 1));
                const mobile = this.isMobileViewport?.();
                const margin = mobile ? 20 : 28;
                const canvas = document.getElementById('board-canvas');
                const cr = canvas?.getBoundingClientRect?.();
                if (!cr || !cr.width || !cr.height) {
                    return { width: baseW, height: baseH, margin, topInset: 0, bottomInset: 0 };
                }

                const safeGap = mobile ? 10 : 8;
                let topInset = 0;
                let bottomInset = 0;
                const check = (el) => {
                    if (!el) return;
                    const style = getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
                    const r = el.getBoundingClientRect();
                    if (!r.width || !r.height) return;
                    const overlapH = Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top);
                    const overlapW = Math.min(cr.right, r.right) - Math.max(cr.left, r.left);
                    if (overlapH <= 0 || overlapW <= 0) return;
                    const centerY = r.top + r.height / 2;
                    if (centerY <= cr.top + cr.height / 2) {
                        topInset = Math.max(topInset, Math.max(0, r.bottom - cr.top) + safeGap);
                    } else {
                        bottomInset = Math.max(bottomInset, Math.max(0, cr.bottom - r.top) + safeGap);
                    }
                };

                check(document.querySelector('.scoreboard.show'));
                check(document.getElementById('banana-hud'));
                check(document.querySelector('#banana-banner.is-visible'));
                check(document.querySelector('#banana-done-btn.show'));

                return {
                    width: baseW,
                    height: Math.max(1, baseH - topInset - bottomInset),
                    margin,
                    topInset,
                    bottomInset
                };
            },

            _enterPostGameReview(winnerUid) {
                this.clearAutoReset();
                this.isOver = true;
                this._reviewLayoutsFp = null;
                this._reviewLayoutsSyncedFp = null;
                this._reviewAppliedPlayerCount = 0;
                this._freezeTimerOnVictory();
                if (winnerUid) this._winnerUid = winnerUid;

                if (this._isMultiplayerMode()) {
                    if (!this.isHost()) return;
                    this._setGamePhase('win-pending');
                    this._mpFreezeFinalAuthoritySnapshot?.();
                    this._tilePool = [];
                    this._hostReviewTransitionActive = true;
                    this._reviewEndingLayoutsFrozen = true;
                    if (typeof this._hostCancelPendingBoardSync === 'function') {
                        this._hostCancelPendingBoardSync();
                    }
                    this._reviewLayouts = {};
                    const myUid = this._myUid();
                    const mine = this._freezeMyEndingLayout();
                    if (mine.length) this._reviewLayouts[myUid] = mine;
                    if (typeof this._processBananaInteractions === 'function') {
                        this._processBananaInteractions(this.roomData?.interactions?.banana);
                    }
                    // Loser layouts come from victory-layout (client runtime). Do not seed from
                    // stale host-owned inventory — that poisons reviewLayoutsOrig before sync.
                    this._hostSyncReviewState();
                    return;
                }
                this._activateReviewUi();
                this.requestRender();
                this.centerViewOnReviewBoards();
                this._syncViewportAfterLayout();
            },

            _applyMpReviewFromBoard(board) {
                if (!this._isMultiplayerMode() || !board) return;
                if (this._hostReviewCompleting) return;
                if (this._isStaleReviewBoard(board)) return;

                if (this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW) {
                    const shouldPublish = !this.isHost()
                        && !this._myEndingLayoutPublished;
                    if (shouldPublish) {
                        this._freezeMyEndingLayout();
                        this._publishMyEndingLayout();
                    }
                    this._freezeTimerOnVictory();
                    this._tilePool = [];
                    if (board.winnerUid) {
                        this._winnerUid = board.winnerUid;
                        this.isOver = true;
                    }
                    const orig = board.reviewLayoutsOrig;
                    const hasOrig = orig && Object.keys(orig).length;
                    const hasDisplay = board.reviewLayouts && Object.keys(board.reviewLayouts).length;
                    if (hasOrig || hasDisplay) {
                        const partyUids = this._getPlayerUids();
                        let origMerged = {
                            ...(this._reviewLayouts || {}),
                            ...(hasOrig ? orig : board.reviewLayouts)
                        };
                        if (!this.isHost()) {
                            const me = this._myUid();
                            if (!origMerged[me]?.length) {
                                const mine = this._endingLayoutsCache?.[me]
                                    || this._captureEndingLayoutForUid(me);
                                if (mine?.length) origMerged[me] = mine;
                            }
                        }
                        this._reviewLayouts = origMerged;
                        if (!this._reviewLayoutsReady(origMerged, partyUids)) {
                            return;
                        }
                        const display = typeof this._displayReviewLayoutsFromOrig === 'function'
                            ? this._displayReviewLayoutsFromOrig(origMerged)
                            : (hasDisplay ? board.reviewLayouts : origMerged);
                        this._reviewLayoutsSyncedFp = this._reviewLayoutsFingerprint(display);
                        this._applyReviewLayouts(display);
                        this._activateReviewUi();
                        this._ensureReviewTilesProjected(board);
                        this._mpAssertReviewProjection(board, 'applyMpReviewFromBoard');
                    }
                    return;
                }

                if (this._boardPhase(board) !== BananagramsGame.MP_PHASE.REVIEW && this._reviewUiActive()) {
                    if (!this._winnerUid && !this.isOver && !this._hostReviewTransitionActive) {
                        this._exitReviewLocalState();
                    }
                }
            },

            _dismissHubWinBanner() {
                window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
            },

            /**
             * Ignore late RTDB/room snapshots still in "playing" after we have entered post-game review.
             * Applying them used to call _exitReviewLocalState() and wipe review before review board synced.
             */
            _isStalePlayingBoardWhileInReview(board, options = {}) {
                if (!board || options.reset) return false;
                if (this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW) return false;
                if (this._shouldApplyPlayingBoardSnapshot(board, options)) return false;
                const incomingSeq = board.seq ?? 0;
                const localSeq = this._boardSeq ?? 0;
                if (incomingSeq < localSeq) return true;
                return true;
            },

            _isStaleReviewBoard(board) {
                if (!board || this._boardPhase(board) !== BananagramsGame.MP_PHASE.REVIEW) {
                    return false;
                }
                if (this._hostReviewCompleting) return true;
                const epoch = board.reviewEpoch ?? 0;
                const closed = this._mpReviewEpochClosed ?? 0;
                if (epoch > 0 && epoch <= closed) return true;
                const snap = this._boardReviewSnapshot();
                const playingClosed = snap?.reviewEpochClosed ?? 0;
                if (epoch > 0 && epoch <= playingClosed) return true;
                return false;
            },

            _noteReviewEpochFromBoard(board) {
                const epoch = board?.reviewEpoch ?? 0;
                if (epoch > 0) {
                    this._mpReviewEpoch = Math.max(this._mpReviewEpoch || 0, epoch);
                }
            },

            _closeReviewEpoch() {
                const closing = this._mpReviewEpoch || 0;
                if (closing > 0) {
                    this._mpReviewEpochClosed = Math.max(this._mpReviewEpochClosed ?? 0, closing);
                }
                this._mpReviewEpoch = 0;
            },

            /** Host: may sync review layouts to global/board. */
            _hostMaySyncReview() {
                return this._hostMayWriteReviewBoard();
            },

            _clearPostGameVictoryState() {
                this._victoryRegistered = false;
                this.isOver = false;
                this._winnerUid = null;
                this.winner = null;
                this._winnerBannerUid = null;
            },

            /** Drop review fit-zoom / focal so the next hand uses the normal playing viewport. */
            _resetPlayingViewportAfterReview() {
                this._reviewFitRetries = 0;
                this._reviewViewportRetry = 0;
                this._fitZoomInitialized = false;
                this._mobileLayoutAnchorLocked = false;
                this._mobileContentBounds = null;
                this.canvasPanX = 0;
                this.canvasPanY = 0;
                const defZoom = typeof this.getDefaultZoomForViewport === 'function'
                    ? this.getDefaultZoomForViewport()
                    : 1;
                this.zoom = defZoom;
                this.targetZoom = defZoom;
                this._viewportFocal = null;
                if (typeof GameViewport !== 'undefined') {
                    GameViewport.centerWorldPoint(this, this.ORIGIN, this.ORIGIN);
                    GameViewport.applyPanZoom(this);
                }
                this._reviewViewportGeneration = (this._reviewViewportGeneration || 0) + 1;
            },

            _exitReviewLocalState() {
                const wasInReviewPhase = this._mpClientBoardPhase === BananagramsGame.MP_PHASE.REVIEW;
                const hadReviewViewport = !!this._reviewViewportSettled;
                const leavingVictory = this._reviewUiActive() || this._victoryRegistered || this.isOver;
                const needsViewportReset = leavingVictory || wasInReviewPhase || hadReviewViewport;
                this._setGamePhase('playing');
                this._postGameReview = false;
                this._hostReviewTransitionActive = false;
                this._reviewLayouts = null;
                this._reviewLayoutsFp = null;
                this._reviewViewportSettled = false;
                this._reviewAppliedPlayerCount = 0;
                this._endingLayoutsCache = null;
                this._myEndingLayoutPublished = false;
                this._reviewEndingLayoutsFrozen = false;
                this._mpReviewEpoch = 0;
                this._reviewLayoutsSyncedFp = null;
                if (leavingVictory) {
                    this._clearPostGameVictoryState();
                    this._dismissHubWinBanner();
                }
                if (needsViewportReset) {
                    this._resetPlayingViewportAfterReview();
                }
                if (this._mpClientBoardPhase === BananagramsGame.MP_PHASE.REVIEW) {
                    this._mpClientBoardPhase = BananagramsGame.MP_PHASE.PLAYING;
                }
                this._setBoardReadOnly(false);
                this._syncDoneButton();
                window.parent.postMessage({ type: 'post-game-blocking', active: false }, '*');
            },

            _captureRemoteEndingLayoutForUid(uid) {
                if (!uid || uid === this._myUid()) return [];
                const board = this._boardReviewSnapshot?.() || this._mpBoardFromRoom?.(this.roomData) || {};
                const owned = this._mpOwned?.[uid]
                    || board?.tilesOwnedByPlayer?.[uid]
                    || [];
                if (!owned.length) return [];
                const roomList = board?.tilePositionsByPlayer?.[uid];
                let positions = {};
                if (Array.isArray(roomList) && roomList.length) {
                    positions = { ...this._positionsMapFromList(roomList) };
                }
                const staged = this._mpPlayerLayouts?.[uid] || {};
                if (Object.keys(staged).length) {
                    positions = { ...positions, ...staged };
                }
                if (!Object.keys(positions).length) {
                    positions = this._layoutMapForPlayer(board, uid, owned);
                }
                const merged = [];
                owned.forEach((o) => {
                    const p = positions[o.id];
                    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                        merged.push({
                            id: o.id,
                            letter: o.letter,
                            x: Math.round(p.x),
                            y: Math.round(p.y),
                            faceUp: !!o.faceUp
                        });
                    }
                });
                const mergedIds = new Set(merged.map((t) => t.id));
                const missing = owned.filter((o) => !mergedIds.has(o.id));
                if (missing.length) {
                    merged.push(...this._rackTilesFromOwned(missing));
                }
                if (!merged.length) return [];
                return this._serializeHandTiles(merged);
            },

            _ensureReviewLayoutsSnapshot() {
                const layouts = { ...(this._reviewLayouts || {}) };
                this._getPlayerUids().forEach((uid) => {
                    if (layouts[uid]?.length) return;
                    if (uid === this._myUid()) {
                        const frozen = this._endingLayoutsCache?.[uid]
                            || this._captureEndingLayoutForUid(uid);
                        if (frozen.length) layouts[uid] = frozen;
                    }
                });
                this._reviewLayouts = layouts;
                return layouts;
            },

            _displayReviewLayoutsFromOrig(origLayouts) {
                return this._arrangeReviewLayoutsForDisplay(origLayouts || {});
            },

            /** @param {object} [options] forwarded to _hostWriteBoard('review', …) */
            _hostSyncReviewState(options = {}) {
                this._hostWriteBoard('review', options);
            },

            _hostBeginNextRound() {
                if (!this.isHost() || !this._isMultiplayerMode()) return;
                this._setGamePhase('done');
                this._hostReviewCompleting = true;
                this._dismissHubWinBanner();
                this._closeReviewEpoch();
                this._exitReviewLocalState();
                this._clearPostGameVictoryState();
                this.updateMetadata({ winner: null, winnerUid: null });
                this.gameStarted = false;
                this._mpStartedAt = null;
                this._stopTimer();
                this.resetGame();
                this._hostReviewCompleting = false;
            },

            _applyReviewLayouts(layouts) {
                const fingerprint = this._reviewLayoutsFingerprint(layouts);
                if (fingerprint && fingerprint === this._reviewLayoutsFp) {
                    const expectedPlayers = this._reviewLayoutPlayerCount(layouts);
                    const expectedTiles = Object.values(layouts || {})
                        .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
                    const visiblePlayers = new Set((this.tiles || [])
                        .map((t) => t.ownerUid || this._myUid())
                        .filter(Boolean)).size;
                    if (visiblePlayers >= expectedPlayers && (this.tiles?.length || 0) >= expectedTiles) {
                        return;
                    }
                }

                const uids = this._getPlayerUids();
                const merged = [];
                const counts = {};
                Object.entries(layouts || {}).forEach(([ownerUid, list]) => {
                    const tiles = list || [];
                    counts[ownerUid] = tiles.length;
                    tiles.forEach((t) => {
                        merged.push({
                            id: t.id,
                            letter: t.letter,
                            x: t.x,
                            y: t.y,
                            faceUp: true,
                            ownerUid
                        });
                    });
                });

                const missing = uids.filter((uid) => !(counts[uid] > 0));
                if (missing.length && this._reviewTraceOn()) {
                    console.warn('[REVIEW] apply missing players', missing, counts);
                }

                if (!merged.length) return;

                const canonicalOwner = (id) => {
                    const board = this._boardReviewSnapshot?.() || {};
                    for (const uid of uids) {
                        const owned = this._mpOwned?.[uid]
                            || board.tilesOwnedByPlayer?.[uid]
                            || [];
                        if (owned.some((o) => o.id === id)) return uid;
                    }
                    return null;
                };

                const byId = new Map();
                merged.forEach((t) => {
                    if (!t?.id) return;
                    const canon = canonicalOwner(t.id) || t.ownerUid;
                    const existing = byId.get(t.id);
                    if (!existing) {
                        byId.set(t.id, { ...t, ownerUid: canon });
                        return;
                    }
                    if (canon && t.ownerUid === canon && existing.ownerUid !== canon) {
                        byId.set(t.id, { ...t, ownerUid: canon });
                    }
                });
                const deduped = [...byId.values()];

                const prevPlayers = this._reviewAppliedPlayerCount || 0;
                const nextPlayers = this._reviewLayoutPlayerCount(layouts);
                const partySize = uids.length;
                const hadAllPlayers = prevPlayers >= partySize;
                const haveAllPlayers = nextPlayers >= partySize;

                if (partySize >= 2) {
                    if (!this._reviewLayoutsReady(layouts, uids)) {
                        return;
                    }
                    if (hadAllPlayers && !haveAllPlayers) {
                        return;
                    }
                }

                this.tiles = deduped;
                this._reviewLayoutsFp = fingerprint;
                this._reviewAppliedPlayerCount = nextPlayers;
                this._setBoardReadOnly(true);
                this._logReviewBoards('applied-on-client', layouts);
                this._syncReviewDom();

                const shouldFitViewport = !this._reviewViewportSettled
                    || (!hadAllPlayers && haveAllPlayers);
                if (shouldFitViewport) {
                    this._reviewViewportSettled = false;
                    this._fitReviewViewportOnce();
                } else {
                    this._flushReviewViewportImmediate();
                }
                this.requestRender();
                this._scheduleReviewViewportBurst('apply-review-layouts');
            },

            _setBoardReadOnly(readOnly) {
                const surface = document.querySelector('.board-pan-layer');
                if (surface) surface.classList.toggle('is-review-frozen', !!readOnly);
            },

            _reviewColorForUid(uid) {
                const fromRoom = uid ? this._playerColor(uid) : null;
                if (fromRoom) return fromRoom;
                return this._bannerColorForUid(uid);
            },

            _onDonePressed() {
                if (this._isMultiplayerMode()) {
                    if (!this.isHost() || !this._isBoardInReview()) {
                        return;
                    }
                    this._hostBeginNextRound();
                    return;
                }

                if (!this._reviewUiActive()) return;
                const me = this._soloReviewKey();
                if (this._reviewDone[me]) return;
                this._reviewDone[me] = true;
                this._leavePostGameReview(true);
            },

            _leavePostGameReview(triggerReset) {
                this._exitReviewLocalState();

                if (!triggerReset) {
                    this.requestRender();
                    return;
                }

                this._reviewDone = {};
                this._victoryRegistered = false;
                this._winnerBannerUid = null;
                this._winnerUid = null;
                this.isOver = false;
                this.winner = null;
                this._dismissHubWinBanner();
                this.onGameReset();
                this.setupNewHand();
                this.requestRender();
                this._syncViewportAfterLayout();
            },

            _syncDoneButton() {
                let btn = document.getElementById('banana-done-btn');
                const showDone = this._canShowDoneButton();
                if (!showDone) {
                    if (btn) btn.classList.remove('show');
                    return;
                }
                if (!btn) {
                    btn = document.createElement('button');
                    btn.type = 'button';
                    btn.id = 'banana-done-btn';
                    btn.className = 'banana-done-btn';
                    btn.dataset.testid = 'banana-done-btn';
                    btn.textContent = 'Done';
                    btn.addEventListener('click', () => this._onDonePressed());
                    (document.body || document.getElementById('game-container'))?.appendChild(btn);
                }
                btn.classList.add('show');
                btn.disabled = false;
                btn.textContent = 'Done';
                btn.style.color = this._bannerColorForUid(this._myUid());
            }
    });
})(typeof window !== 'undefined' ? window : global);
