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

            /** Gameplay/input: board says review or review UI is active. */
            _inReviewExperience() {
                return this._reviewUiActive()
                    || this._isBoardInReview()
                    || !!this._hostReviewTransitionActive;
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
                this._postGameReview = true;
                this._hostReviewTransitionActive = false;
                this._bindReviewViewportReflow();
                this._reviewViewportSettled = false;
                this._reviewFitRetries = 0;
                this._reviewViewportRetry = 0;
                this._mpClientBoardPhase = BananagramsGame.MP_PHASE.REVIEW;
                this._setBoardReadOnly(true);
                this._syncDoneButton();
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
                    const parts = tiles.map((t) => `${t.id}:${Math.round(t.x)},${Math.round(t.y)}`);
                    return `${uid}#${tiles.length}#${parts.join(',')}`;
                }).join('|');
            },

            _reviewLayoutPlayerCount(layouts) {
                return Object.values(layouts || {}).filter((list) => list?.length > 0).length;
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

                if (!owned.length) {
                    const live = Object.values(runtimeById);
                    return live.length ? this._serializeHandTiles(live) : [];
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
                            letter: o.letter,
                            x: coords.x,
                            y: coords.y,
                            faceUp: !!o.faceUp
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
                    this._hostReviewTransitionActive = true;
                    if (typeof this._hostCancelPendingBoardSync === 'function') {
                        this._hostCancelPendingBoardSync();
                    }
                    const me = this._myUid();
                    const hostLayout = this._freezeMyEndingLayout();
                    this._reviewLayouts = {};
                    if (hostLayout.length) {
                        this._reviewLayouts[me] = hostLayout;
                    }
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
                    if (board.winnerUid) {
                        this._winnerUid = board.winnerUid;
                        this.isOver = true;
                    }
                    const orig = board.reviewLayoutsOrig;
                    const hasOrig = orig && Object.keys(orig).length;
                    if (hasOrig || (board.reviewLayouts && Object.keys(board.reviewLayouts).length)) {
                        if (hasOrig) {
                            this._reviewLayouts = {
                                ...(this._reviewLayouts || {}),
                                ...orig
                            };
                        } else {
                            this._reviewLayouts = {
                                ...(this._reviewLayouts || {}),
                                ...board.reviewLayouts
                            };
                        }
                        const display = hasOrig && typeof this._displayReviewLayoutsFromOrig === 'function'
                            ? this._displayReviewLayoutsFromOrig(orig)
                            : board.reviewLayouts;
                        this._reviewLayoutsSyncedFp = this._reviewLayoutsFingerprint(display);
                        this._applyReviewLayouts(display);
                    }
                    this._activateReviewUi();
                    return;
                }

                if (this._boardPhase(board) !== BananagramsGame.MP_PHASE.REVIEW && this._reviewUiActive()) {
                    this._exitReviewLocalState();
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
                const locallyInReview = this._mpClientBoardPhase === BananagramsGame.MP_PHASE.REVIEW
                    || this._isBoardInReview(this._boardReviewSnapshot());
                if (!locallyInReview) return false;
                const hasWinner = !!(this._winnerUid
                    || this.roomData?.winnerUid
                    || this.roomData?.global?.board?.winnerUid
                    || board.winnerUid);
                if (!hasWinner && !this.isOver) return false;
                const incomingSeq = board.seq ?? 0;
                const localSeq = this._boardSeq ?? 0;
                if (incomingSeq < localSeq) return true;
                return incomingSeq <= localSeq;
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
                this._postGameReview = false;
                this._hostReviewTransitionActive = false;
                this._reviewLayouts = null;
                this._reviewLayoutsFp = null;
                this._reviewViewportSettled = false;
                this._reviewAppliedPlayerCount = 0;
                this._endingLayoutsCache = null;
                this._myEndingLayoutPublished = false;
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
                const owned = this._mpOwned?.[uid] || [];
                if (!owned.length) return [];
                const positions = this._mpPlayerLayouts?.[uid] || {};
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
                        return;
                    }
                    const remote = this._captureRemoteEndingLayoutForUid(uid);
                    if (remote.length) layouts[uid] = remote;
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
                const board = this._boardReviewSnapshot();
                const leftReview = board
                    && this._boardPhase(board) === BananagramsGame.MP_PHASE.PLAYING
                    && (board.reviewEpoch ?? 0) === 0;
                if (leftReview) {
                    this._hostReviewCompleting = false;
                }
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

                const seen = new Set();
                const deduped = merged.filter((t) => {
                    if (seen.has(t.id)) return false;
                    seen.add(t.id);
                    return true;
                });

                const prevPlayers = this._reviewAppliedPlayerCount || 0;
                const nextPlayers = this._reviewLayoutPlayerCount(layouts);
                const partySize = uids.length;
                const hadAllPlayers = prevPlayers >= partySize;
                const haveAllPlayers = nextPlayers >= partySize;

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
