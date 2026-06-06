/** Bananagrams — session (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before session.js');
    Object.assign(G.prototype, {
            _myUid() {
                return this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid') || '';
            },

            _isMultiplayerMode() {
                return this.isMultiplayer && this.roomId !== 'lobby' && this.mode === 'multiplayer';
            },

            _reconcileMpMode() {
                const inParty = this.isMultiplayer && this.roomId && this.roomId !== 'lobby';
                const wasInParty = !!this._mpSessionActive;

                if (!inParty) {
                    if (this.mode !== 'solo') {
                        this.mode = 'solo';
                        if (typeof GameAdapter !== 'undefined') GameAdapter.refreshCapabilities(this);
                    }
                    if (wasInParty) {
                        this._leaveMultiplayerForSolo();
                    }
                    this._mpSessionActive = false;
                    return;
                }

                const enteringMp = !wasInParty;
                this._mpSessionActive = true;

                if (enteringMp) {
                    this._prepareForMultiplayerSession();
                }

                if (this.mode === 'multiplayer') {
                    this.renderScoreboard();
                    return;
                }
                this.mode = 'multiplayer';
                if (typeof GameAdapter !== 'undefined') GameAdapter.refreshCapabilities(this);
                this.renderScoreboard();
            },

            /** Drop MP runtime state and restore the solo board (solo localStorage is preserved). */
            _leaveMultiplayerForSolo() {
                if (typeof this._exitReviewLocalState === 'function') {
                    this._exitReviewLocalState();
                }
                this._dismissHubWinBanner?.();
                this._hostReviewCompleting = false;
                this._hostReviewTransitionActive = false;
                this._mpClientBoardPhase = null;
                this._mpOwned = null;
                this._mpPlayerLayouts = null;
                this._mpInventorySeq = null;
                this._mpCanonicalReset?.();
                this._mpDeferredBoard = null;
                this._mpAwaitReset = false;
                this._reviewLayouts = null;
                this._reviewLayoutsFp = null;
                this._reviewAppliedPlayerCount = 0;
                this._endingLayoutsCache = null;
                this._myEndingLayoutPublished = false;
                this._reviewEndingLayoutsFrozen = false;
                this._mpReviewEpoch = 0;
                this._reviewLayoutsSyncedFp = null;
                this._boardSeq = 0;
                this._bananaHandled = {};
                this._bananaAck = {};
                this._winnerUid = null;
                this._victoryRegistered = false;
                this._postGameReview = false;
                this.isOver = false;
                this.winner = null;
                this._stopTimer();
                this.tiles = [];
                this._tilePool = [];
                this.started = false;
                this.gameStarted = false;
                this._nextTileId = 0;
                this.elapsedMs = 0;
                this._timerFrozen = false;
                this._bannerText = '';
                this._selectedIds.clear();
                this._selectionHighlight = false;
                this._peelSeq = 0;
                this._lastPeelSeq = 0;
                this._dumpSeq = 0;
                this._lastDumpSeq = 0;
                this._peelActorUid = null;
                this._dumpActorUid = null;
                this._lastPeelDraws = null;
                this._winnerBannerUid = null;
                this._mpStartedAt = null;
                this._localInventorySeq = 0;
                this._mpScores = {};
                this.canvasPanX = 0;
                this.canvasPanY = 0;
                this._viewportFocal = null;
                this._fitZoomInitialized = false;
                this._mobileLayoutAnchorLocked = false;
                this._mobileContentBounds = null;

                const board = this.roomData?.global?.board;
                if (board?.version >= 2 && this.roomData?.global) {
                    this.roomData = {
                        ...this.roomData,
                        global: { ...this.roomData.global, board: null }
                    };
                }

                if (!this.loadPersistedState()) {
                    this.setupNewHand();
                }
                this._applyDefaultPlayingViewport?.();
                this._syncViewportAfterLayout?.();
                this.requestRender?.();
            },

            /** Clear solo runtime before MP board sync; do not wipe solo localStorage. */
            _prepareForMultiplayerSession() {
                this._exitReviewLocalState?.();
                this._dismissHubWinBanner?.();
                this._stopTimer();
                this._mpOwned = null;
                this._mpPlayerLayouts = null;
                this._mpInventorySeq = null;
                this._mpDeferredBoard = null;
                this._postGameReview = false;
                this._hostReviewTransitionActive = false;
                this.tiles = [];
                this._tilePool = [];
                this.started = false;
                this.gameStarted = false;
                this._nextTileId = 0;
                this.isOver = false;
                this._winnerUid = null;
                this._victoryRegistered = false;
                this._bannerText = '';
                this._selectedIds.clear();
                this._selectionHighlight = false;
                this.elapsedMs = 0;
                this._timerFrozen = false;
                this._peelSeq = 0;
                this._dumpSeq = 0;
                this._localInventorySeq = 0;
                this.canvasPanX = 0;
                this.canvasPanY = 0;
                this._viewportFocal = null;
                this._fitZoomInitialized = false;
                this._mobileLayoutAnchorLocked = false;
                this._mobileContentBounds = null;
                this.requestRender?.();
            },

            isMyTurn() {
                if (this._isMultiplayerMode() && !this.hasCap('supportsTurnIndicator')) {
                    return this.roomId !== 'lobby' && !this.isOver;
                }
                return super.isMyTurn();
            },

            _tileBagMode() {
                return this._isMultiplayerMode() ? 'multiplayer' : 'solo';
            },

            _bagConfig() {
                if (typeof BananaRules === 'undefined') return { soloVariant: 'fast', bunchCount: null };
                try {
                    return BananaRules.resolveBagConfig(new URLSearchParams(window.location.search));
                } catch (_) {
                    return { soloVariant: 'fast', bunchCount: null };
                }
            },

            _buildTilePool() {
                const cfg = this._bagConfig();
                const mode = this._tileBagMode();
                const bag = BananaRules.getTileBag(mode, cfg);
                return BananaRules.buildShuffledPool(bag, cfg.bunchCount);
            },

            /** Host-only: pool + all players' _mpOwned must match the MP bag (id-pool mode). */
            _mpDistributionInvariantCheck(context = 'unknown') {
                if (!this.isHost?.() || !this._isMultiplayerMode?.()
                    || typeof BananaRules === 'undefined') {
                    return true;
                }
                this._mpEnsureIdPoolModeFromPool?.();
                if (!this._mpPoolIsIdBased?.()) {
                    if (this.started || this.gameStarted) {
                        console.error('[Bananagrams] MP distribution check without id pool', { context });
                        this._lastMpDistCheck = { context, ok: false, reason: 'no-id-pool' };
                        return false;
                    }
                    return true;
                }
                return this._mpIdPoolInvariantCheck?.(context) ?? true;
            },

            _soloDistributionInvariantCheck(context = 'unknown') {
                if (this._isMultiplayerMode() || typeof BananaRules === 'undefined') return true;
                const bagLabel = this._soloBagLabel();
                const bag = bagLabel === 'solo-classic'
                    ? BananaRules.SOLO_CLASSIC_TILE_BAG
                    : BananaRules.SOLO_FAST_TILE_BAG;
                const counts = {};
                const add = (letter) => {
                    const ch = String(letter || '').toUpperCase();
                    if (!/^[A-Z]$/.test(ch)) return;
                    counts[ch] = (counts[ch] || 0) + 1;
                };
                (this.tiles || []).forEach((t) => add(t?.letter));
                (this._tilePool || []).forEach((l) => add(l));
                for (const [letter, n] of Object.entries(counts)) {
                    const max = bag[letter] || 0;
                    if (n > max) {
                        console.error('[Bananagrams] solo distribution invariant failed', {
                            context,
                            bag: bagLabel,
                            letter,
                            count: n,
                            max
                        });
                        return false;
                    }
                }
                return true;
            },

            _soloBagLabel() {
                const cfg = this._bagConfig();
                return cfg.soloVariant === 'classic' ? 'solo-classic' : 'solo-fast';
            },

            _getPlayerUids() {
                const pd = this.roomData?.playerData || {};
                return Object.keys(pd)
                    .filter((id) => pd[id] != null && typeof pd[id] === 'object')
                    .sort();
            },

            _handSizeForParty() {
                if (!this._isMultiplayerMode()) return BananaRules.SOLO_HAND;
                try {
                    const fromUrl = parseInt(new URLSearchParams(window.location.search).get('hand') || '', 10);
                    if (fromUrl > 0) return fromUrl;
                } catch (_) { /* ignore */ }
                if (typeof BananaRules !== 'undefined' && BananaRules.MP_HAND_OVERRIDE != null) {
                    return BananaRules.MP_HAND_OVERRIDE;
                }
                return BananaRules.startingHandSize(this._getPlayerUids().length || 2);
            },

            _rackLayoutOptions() {
                return {
                    cols: BananaRules.COLS,
                    gap: BananaRules.TILE_GAP,
                    tileSize: BananaRules.TILE_SIZE,
                    handBelowCenter: BananaRules.HAND_BELOW_CENTER,
                    handSize: this._handSizeForParty()
                };
            },

            _usesGameTimer() {
                return typeof GameAdapter !== 'undefined' && GameAdapter.cap(this, 'supportsGameTimer');
            },

            _stopTimer() {
                if (this._timerRaf) {
                    cancelAnimationFrame(this._timerRaf);
                    this._timerRaf = 0;
                }
                this._timerStart = null;
                this._timerFrozen = false;
                this.elapsedMs = 0;
            },

            beginGame() {
                if (this.gameStarted) return;
                if (!this.canMutatePlayingBoard?.()) {
                    return;
                }
                if (this._isMultiplayerMode()) {
                    if (this.isHost()) {
                        this._hostBeginSplit();
                    } else {
                        this._guestBeginSplit();
                        this._sendBananaInteraction({ type: 'split' });
                    }
                    return;
                }
                this.gameStarted = true;
                this._timerFrozen = false;
                this.tiles.forEach((t) => { t.faceUp = true; });
                this._timerStart = Date.now();
                this._startTimer();
                this.persistState();
                this.requestRender();
            },

            /** True when any tile has left the default pre-SPLIT rack layout. */
            _hasBoardLeftStartingRack() {
                if (!this.tiles?.length || !this.canMutatePlayingBoard?.()) return false;
                if (typeof this._isStartingRackLayout === 'function') {
                    return !this._isStartingRackLayout();
                }
                return false;
            },

            /**
             * Start (or repair) the elapsed timer when tiles leave the starting rack —
             * e.g. drag, touch, or dev /b solve placing tiles on the board.
             */
            _ensurePlayStartedFromBoardActivity() {
                if (!this.canMutatePlayingBoard?.() || !this._hasBoardLeftStartingRack()) return;

                if (!this.gameStarted) {
                    this.beginGame();
                    return;
                }

                if (!this._usesGameTimer() || this._timerFrozen) return;
                if (this._timerRaf && this._timerStart != null) return;

                const startedAt = this._mpStartedAt || Date.now();
                if (this._isMultiplayerMode()) {
                    if (this.isHost?.()) {
                        if (!this._mpStartedAt) {
                            this._mpStartedAt = startedAt;
                            this._hostSyncBoard?.({ immediate: true });
                        }
                        this._syncMpTimerFromBoard(this._mpStartedAt || startedAt);
                    } else {
                        this._timerStart = startedAt;
                        this._startTimer();
                    }
                    return;
                }

                this._timerStart = this._timerStart || Date.now();
                this._startTimer();
            },

            _startTimer() {
                if (!this._usesGameTimer() || this._timerFrozen) return;
                if (this._timerRaf) return;
                const tick = () => {
                    if (!this.gameStarted || this._timerFrozen) {
                        this._timerRaf = 0;
                        return;
                    }
                    if (this._timerStart != null) {
                        this.elapsedMs = Math.max(0, Date.now() - this._timerStart);
                    }
                    this._updateHudEl();
                    this._timerRaf = requestAnimationFrame(tick);
                };
                this._timerRaf = requestAnimationFrame(tick);
            },

            _syncMpTimerFromBoard(startedAt) {
                if (this._timerFrozen || !this.canMutatePlayingBoard?.()) {
                    return;
                }
                if (!this._usesGameTimer() || !startedAt || !this.gameStarted) return;
                this.elapsedMs = Math.max(0, Date.now() - startedAt);
                this._timerStart = Date.now() - this.elapsedMs;
                if (this._timerRaf) {
                    cancelAnimationFrame(this._timerRaf);
                    this._timerRaf = 0;
                }
                this._startTimer();
            },

            _freezeTimerOnVictory() {
                if (!this._usesGameTimer()) return;
                this._timerFrozen = true;
                if (this._timerStart != null) {
                    this.elapsedMs = Math.max(0, Date.now() - this._timerStart);
                }
                if (this._timerRaf) {
                    cancelAnimationFrame(this._timerRaf);
                    this._timerRaf = 0;
                }
                this._timerStart = null;
                this._updateHudEl();
            },

            _formatTime(ms) {
                const s = Math.floor(ms / 1000);
                const m = Math.floor(s / 60);
                const r = s % 60;
                return `${m}:${String(r).padStart(2, '0')}`;
            },

            _playerColor(uid) {
                if (uid === this._myUid()) return null;
                const pd = this.roomData?.playerData?.[uid];
                return pd?.color || null;
            },

            _getMpScoreRows() {
                const me = this._myUid();
                const uids = this._getPlayerUids();
                const ordered = uids.length
                    ? [me, ...uids.filter((id) => id !== me).sort()]
                    : [me];
                return ordered.map((uid) => ({
                    uid,
                    score: (this._mpScores && this._mpScores[uid]) || 0,
                    color: uid === me
                        ? 'var(--theme-color, #3b82f6)'
                        : (this._playerColor(uid) || 'var(--opponent-color, #ef4444)')
                }));
            },

            _updateHudEl() {
                if (this._isMultiplayerMode()) this.renderScoreboard();
                if (this._usesGameTimer()) {
                    const timer = document.getElementById('banana-timer');
                    if (timer) {
                        timer.textContent = this._formatTime(this.elapsedMs);
                        const mine = getComputedStyle(document.documentElement)
                            .getPropertyValue('--theme-color').trim() || '#3b82f6';
                        timer.style.color = mine;
                    }
                }
                const pool = document.getElementById('banana-pool-count');
                if (pool) pool.textContent = String(this._tilePool.length);
            },

            _bannerColorForUid(uid) {
                if (!uid || uid === this._myUid()) {
                    return getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim()
                        || '#3b82f6';
                }
                return this._playerColor(uid)
                    || getComputedStyle(document.documentElement).getPropertyValue('--opponent-color').trim()
                    || '#ef4444';
            },

            _syncBannerEl() {
                const banner = document.getElementById('banana-banner');
                if (!banner) return;
                banner.textContent = this._bannerText;
                banner.classList.toggle('is-visible', !!this._bannerText);
                const atTop = this._bannerPlacement === 'top';
                banner.classList.toggle('banana-banner--top', atTop);
                const actionBanner = this._bannerText === 'Peel!' || this._bannerText === 'Dump!';
                if (actionBanner && this._bannerActorUid) {
                    banner.style.color = this._bannerColorForUid(this._bannerActorUid);
                } else {
                    banner.style.color = '#fff';
                }
            },

            _showBanner(text, ms = 2200, options = {}) {
                if (this._bannerTimer) {
                    clearTimeout(this._bannerTimer);
                    this._bannerTimer = 0;
                }
                this._bannerText = text;
                this._bannerActorUid = Object.prototype.hasOwnProperty.call(options, 'actorUid')
                    ? options.actorUid
                    : this._myUid();
                this._bannerPlacement = (text === 'Peel!' || text === 'Dump!') ? 'top' : 'center';
                this._bannerUntil = Date.now() + ms;
                this._syncBannerEl();
                this.requestRender();
                this._bannerTimer = setTimeout(() => {
                    this._bannerTimer = 0;
                    if (Date.now() >= this._bannerUntil - 50) {
                        this._bannerText = '';
                        this._bannerActorUid = null;
                        this._syncBannerEl();
                        this.requestRender();
                    }
                }, ms + 80);
            },

            centerViewOnOrigin() {
                if (typeof GameViewport !== 'undefined') {
                    GameViewport.centerWorldPoint(this, this.ORIGIN, this.ORIGIN);
                }
            },

            /** Mobile + desktop default rack framing (same as fresh page load / refresh). */
            _applyDefaultPlayingViewport() {
                this._fitZoomInitialized = false;
                this._mobileLayoutAnchorLocked = false;
                this._mobileContentBounds = null;
                this._viewportFocal = null;
                this.canvasPanX = 0;
                this.canvasPanY = 0;
                if (this.isMobileViewport?.() && this._usesPanZoomBoard?.()) {
                    this.refreshMobileLayout?.();
                    this._flushViewport();
                    return;
                }
                const center = typeof this.getViewportContentCenter === 'function'
                    ? this.getViewportContentCenter()
                    : { x: this.ORIGIN, y: this.ORIGIN };
                if (typeof GameViewport !== 'undefined') {
                    GameViewport.centerWorldPoint(this, center.x, center.y);
                }
            },

            _flushViewport() {
                if (typeof GameViewport === 'undefined') return;
                if (!this._viewportFocal) {
                    GameViewport.centerWorldPoint(this, this.ORIGIN, this.ORIGIN);
                } else {
                    GameViewport.applyPanZoom(this);
                }
            },

            _syncViewportAfterLayout() {
                if (this._devBoardSolveSkipViewport) return;
                const inReview = this._inReviewExperience?.()
                    || (typeof this._isBoardInReview === 'function' && this._isBoardInReview());
                if (inReview && this._reviewViewportSettled) {
                    const flush = () => {
                        if (typeof this._flushReviewViewportImmediate === 'function') {
                            this._flushReviewViewportImmediate();
                        } else if (typeof GameViewport !== 'undefined') {
                            GameViewport.applyPanZoom(this);
                        }
                        this.requestRender?.();
                    };
                    flush();
                    requestAnimationFrame(flush);
                    return;
                }
                const run = () => {
                    if (this.isMobileViewport?.()) {
                        const preservePlayViewport = !!(this.gameStarted && this._fitZoomInitialized);
                        if (inReview) {
                            if (!this._reviewViewportSettled) {
                                this._fitReviewViewportOnce?.();
                            }
                        } else if (!preservePlayViewport) {
                            if (this._mobileLayoutAnchorLocked
                                && typeof this.refreshMobileLayoutViewportOnly === 'function') {
                                this.refreshMobileLayoutViewportOnly();
                            } else {
                                this.refreshMobileLayout?.();
                            }
                        }
                    }
                    this._flushViewport();
                };
                requestAnimationFrame(() => {
                    run();
                    requestAnimationFrame(run);
                });
            },

            persistState() {
                if (this._isMultiplayerMode()) return;
                try {
                    const payload = JSON.stringify(this.serializeBoard());
                    localStorage.setItem(this.getPersistKey(), payload);
                    // Stable fallback key for solo mobile refresh when uid/session identity shifts.
                    localStorage.setItem('bananagrams_solo', payload);
                } catch (_) { /* ignore quota */ }
            },

            loadPersistedState() {
                try {
                    const boardFitsSoloBag = (board, expectedBagLabel) => {
                        if (typeof BananaRules === 'undefined') return true;
                        const countLetters = (list) => {
                            const counts = {};
                            (list || []).forEach((entry) => {
                                const letter = typeof entry === 'string' ? entry : entry?.letter;
                                const ch = String(letter || '').toUpperCase();
                                if (!/^[A-Z]$/.test(ch)) return;
                                counts[ch] = (counts[ch] || 0) + 1;
                            });
                            return counts;
                        };
                        const mergeCounts = (a, b) => {
                            const out = { ...(a || {}) };
                            Object.entries(b || {}).forEach(([k, v]) => {
                                out[k] = (out[k] || 0) + v;
                            });
                            return out;
                        };
                        const used = mergeCounts(
                            countLetters(board.tiles),
                            countLetters(board.pool)
                        );
                        const fitsBag = (bag) => Object.entries(used).every(
                            ([letter, n]) => n <= (bag[letter] || 0)
                        );
                        const bagByLabel = {
                            'solo-fast': BananaRules.SOLO_FAST_TILE_BAG,
                            'solo-classic': BananaRules.SOLO_CLASSIC_TILE_BAG
                        };
                        const targetLabel = expectedBagLabel || this._soloBagLabel?.() || 'solo-fast';
                        const targetBag = bagByLabel[targetLabel] || BananaRules.SOLO_FAST_TILE_BAG;
                        // Always validate against the currently selected solo bag.
                        if (!fitsBag(targetBag)) return false;
                        // If the save declares bagMode, it must match current selected bag.
                        if (board.bagMode && board.bagMode !== targetLabel) return false;
                        return true;
                    };

                    const expectedBagLabel = this._soloBagLabel?.() || 'solo-fast';
                    const keys = [...new Set([this.getPersistKey(), 'bananagrams_solo'])];
                    for (const key of keys) {
                        const raw = localStorage.getItem(key);
                        if (!raw) continue;
                        let board = null;
                        try {
                            board = JSON.parse(raw);
                        } catch (_) {
                            continue;
                        }
                        if (!board || !Array.isArray(board.tiles) || !board.tiles.length) continue;
                        if (board.version === 2 || board.bagMode === 'multiplayer') {
                            localStorage.removeItem(key);
                            continue;
                        }
                        const expected = typeof BananaRules !== 'undefined' ? BananaRules.SOLO_HAND : null;
                        const soloPoolMax = typeof BananaRules !== 'undefined'
                            ? Math.max(
                                BananaRules.poolTotal(BananaRules.SOLO_FAST_TILE_BAG),
                                BananaRules.poolTotal(BananaRules.SOLO_CLASSIC_TILE_BAG)
                            )
                            : 72;
                        if (Array.isArray(board.pool) && board.pool.length > soloPoolMax) {
                            localStorage.removeItem(key);
                            continue;
                        }
                        if (expected != null) {
                            if (board.soloHandSize != null && board.soloHandSize !== expected) continue;
                            // Legacy boards without soloHandSize can be in-progress; only enforce starting
                            // hand count when the saved game has not started yet.
                            if (board.soloHandSize == null && !board.gameStarted && board.tiles.length !== expected) {
                                continue;
                            }
                        }
                        if (!boardFitsSoloBag(board, expectedBagLabel)) {
                            localStorage.removeItem(key);
                            continue;
                        }
                        this.applyBoard(board);
                        // Normalize both keys to the most recent valid board.
                        const normalized = JSON.stringify(board);
                        localStorage.setItem(this.getPersistKey(), normalized);
                        localStorage.setItem('bananagrams_solo', normalized);
                        return true;
                    }
                    return false;
                } catch (_) {
                    return false;
                }
            },

    _dictOverrideKey() {
        return 'bananagrams_dict_overrides_v1';
    },

    _loadDictOverrides() {
        try {
            const raw = localStorage.getItem(this._dictOverrideKey());
            const parsed = raw ? JSON.parse(raw) : {};
            return {
                add: Array.isArray(parsed?.add) ? parsed.add : [],
                remove: Array.isArray(parsed?.remove) ? parsed.remove : []
            };
        } catch (_) {
            return { add: [], remove: [] };
        }
    },

    _saveDictOverrides(overrides) {
        try {
            localStorage.setItem(this._dictOverrideKey(), JSON.stringify({
                add: [...(overrides?.add || [])],
                remove: [...(overrides?.remove || [])]
            }));
        } catch (_) { /* ignore */ }
    },

    _buildCheckerWithOverrides(baseChecker, overrides = {}) {
        if (!baseChecker) return null;
        const add = new Set((overrides.add || []).map((w) => String(w).toLowerCase()).filter(Boolean));
        const remove = new Set((overrides.remove || []).map((w) => String(w).toLowerCase()).filter(Boolean));
        return {
            isPrefix(str) {
                const s = String(str || '').toLowerCase();
                if (!s) return false;
                if (baseChecker.isPrefix(s)) return true;
                for (const w of add) {
                    if (w.startsWith(s)) return true;
                }
                return false;
            },
            isWord(str) {
                const s = String(str || '').toLowerCase();
                if (!s) return false;
                if (add.has(s)) return true;
                if (remove.has(s)) return false;
                return baseChecker.isWord(s);
            }
        };
    },

    applyDictionaryAdjustments(adjustments = {}) {
        if (!this._baseChecker) {
            window.parent.postMessage({
                type: 'dict-adjust-result',
                ok: false,
                message: 'Dictionary is not loaded yet.'
            }, '*');
            return;
        }
        const norm = (list) => (Array.isArray(list) ? list : [])
            .map((w) => String(w || '').trim().toLowerCase())
            .filter((w) => /^[a-z]+$/.test(w));
        const addList = norm(adjustments.add);
        const removeList = norm(adjustments.remove);
        const invalid = [];
        (Array.isArray(adjustments.add) ? adjustments.add : []).forEach((w) => {
            if (!/^[a-z]+$/.test(String(w || '').trim().toLowerCase())) invalid.push(String(w || '').trim());
        });
        (Array.isArray(adjustments.remove) ? adjustments.remove : []).forEach((w) => {
            if (!/^[a-z]+$/.test(String(w || '').trim().toLowerCase())) invalid.push(String(w || '').trim());
        });

        const current = this._dictOverrides || this._loadDictOverrides();
        const add = new Set(current.add || []);
        const remove = new Set(current.remove || []);
        addList.forEach((w) => {
            add.add(w);
            remove.delete(w);
        });
        removeList.forEach((w) => {
            remove.add(w);
            add.delete(w);
        });

        this._dictOverrides = { add: [...add], remove: [...remove] };
        this._saveDictOverrides(this._dictOverrides);
        this._checker = this._buildCheckerWithOverrides(this._baseChecker, this._dictOverrides);
        this.requestRender();

        const effectiveAdded = [];
        const effectiveRemoved = [];
        const applyFailures = [];
        addList.forEach((w) => {
            if (this._checker?.isWord?.(w)) effectiveAdded.push(w);
            else applyFailures.push(`+${w}`);
        });
        removeList.forEach((w) => {
            if (!this._checker?.isWord?.(w)) effectiveRemoved.push(w);
            else applyFailures.push(`-${w}`);
        });

        const msg = `Dictionary updated`
            + (invalid.length ? ` (ignored: ${invalid.join(', ')})` : '')
            + (applyFailures.length ? ` (verify failed: ${applyFailures.join(', ')})` : '');
        window.parent.postMessage({
            type: 'dict-adjust-result',
            ok: applyFailures.length === 0,
            message: msg,
            added: addList,
            removed: removeList,
            effectiveAdded,
            effectiveRemoved,
            invalid,
            applyFailures,
            totals: {
                add: this._dictOverrides.add.length,
                remove: this._dictOverrides.remove.length
            }
        }, '*');
    },

    async _loadDictionary() {
        if (typeof BananaDictionary === 'undefined') return;
        try {
            const { nodes, header } = await BananaDictionary.loadWordlist('dict/enable.bin.gz');
            this._dictNodes = nodes;
            this._dictHeader = header || {};
            this._baseChecker = BananaDictionary.createChecker(nodes);
            this._dictOverrides = this._loadDictOverrides();
            this._checker = this._buildCheckerWithOverrides(this._baseChecker, this._dictOverrides);
        } catch (err) {
            console.warn('[Bananagrams] wordlist load failed', err);
        }
        this._dictReady = true;
        if (this._isMultiplayerMode()) {
            this._maybeSetupMultiplayer();
        }
        this.requestRender();
        this._syncViewportAfterLayout();
    }
    });
})(typeof window !== 'undefined' ? window : global);
