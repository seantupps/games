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
                if (!inParty) {
                    if (this.mode !== 'solo') {
                        this.mode = 'solo';
                        if (typeof GameAdapter !== 'undefined') GameAdapter.refreshCapabilities(this);
                    }
                    return;
                }
                if (this.mode === 'multiplayer') return;
                this.mode = 'multiplayer';
                if (typeof GameAdapter !== 'undefined') GameAdapter.refreshCapabilities(this);
                try {
                    localStorage.removeItem(this.getPersistKey());
                } catch (_) { /* ignore */ }
                this.renderScoreboard();
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
                if (this._inReviewExperience?.()
                    || (typeof this._isBoardInReview === 'function' && this._isBoardInReview())) {
                    return;
                }
                if (this._isMultiplayerMode()) {
                    if (this.isHost()) {
                        this._hostBeginSplit();
                    } else {
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
                if (this._timerFrozen || this._inReviewExperience?.()) {
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
                this._bannerActorUid = options.actorUid ?? this._myUid();
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

            _flushViewport() {
                if (typeof GameViewport === 'undefined') return;
                if (!this._viewportFocal) {
                    GameViewport.centerWorldPoint(this, this.ORIGIN, this.ORIGIN);
                } else {
                    GameViewport.applyPanZoom(this);
                }
            },

            _syncViewportAfterLayout() {
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
                        if (inReview) {
                            if (!this._reviewViewportSettled) {
                                this._fitReviewViewportOnce?.();
                            }
                        } else if (this._mobileLayoutAnchorLocked
                            && typeof this.refreshMobileLayoutViewportOnly === 'function') {
                            this.refreshMobileLayoutViewportOnly();
                        } else {
                            this.refreshMobileLayout?.();
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
                    localStorage.setItem(this.getPersistKey(), JSON.stringify(this.serializeBoard()));
                } catch (_) { /* ignore quota */ }
            },

            loadPersistedState() {
                try {
                    const raw = localStorage.getItem(this.getPersistKey());
                    if (!raw) return false;
                    const board = JSON.parse(raw);
                    if (!board || !Array.isArray(board.tiles) || !board.tiles.length) return false;
                    if (board.version === 2 || board.bagMode === 'multiplayer') {
                        localStorage.removeItem(this.getPersistKey());
                        return false;
                    }
                    const expected = typeof BananaRules !== 'undefined' ? BananaRules.SOLO_HAND : null;
                    const soloPoolMax = typeof BananaRules !== 'undefined'
                        ? Math.max(
                            BananaRules.poolTotal(BananaRules.SOLO_FAST_TILE_BAG),
                            BananaRules.poolTotal(BananaRules.SOLO_CLASSIC_TILE_BAG)
                        )
                        : 72;
                    if (Array.isArray(board.pool) && board.pool.length > soloPoolMax) {
                        localStorage.removeItem(this.getPersistKey());
                        return false;
                    }
                    if (expected != null) {
                        if (board.soloHandSize != null && board.soloHandSize !== expected) return false;
                        if (board.soloHandSize == null && board.tiles.length !== expected) return false;
                    }
                    this.applyBoard(board);
                    return true;
                } catch (_) {
                    return false;
                }
            },

    async _loadDictionary() {
        if (typeof BananaDictionary === 'undefined') return;
        try {
            const { nodes } = await BananaDictionary.loadWordlist('dict/enable.bin.gz');
            this._checker = BananaDictionary.createChecker(nodes);
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
