/** Rummikub — session / timer (solo). */
(function (global) {
    const G = global.RummikubGame;
    if (!G) throw new Error('RummikubGame must be defined before session.js');
    if (typeof PanZoomSession !== 'undefined') {
        Object.assign(G.prototype, PanZoomSession.mixinProto());
    }
    const _baseSyncViewportAfterLayout = G.prototype._syncViewportAfterLayout;
    Object.assign(G.prototype, {
        _syncViewportAfterLayout() {
            if (this._preservePlayViewport) {
                this._preservePlayViewport = false;
                if (typeof GameViewport !== 'undefined') {
                    GameViewport.applyPanZoom(this);
                }
                this.requestRender?.();
                return;
            }
            if (typeof _baseSyncViewportAfterLayout === 'function') {
                _baseSyncViewportAfterLayout.call(this);
            }
        },

        _usesGameTimer() {
            if (typeof GameAdapter !== 'undefined' && GameAdapter.cap) {
                return GameAdapter.cap(this, 'supportsGameTimer');
            }
            return true;
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

        _formatTime(ms) {
            const sec = Math.max(0, Math.floor(ms / 1000));
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            return `${m}:${String(s).padStart(2, '0')}`;
        },

        beginGame() {
            if (this.gameStarted || !this.canMutatePlayingBoard()) return;
            this.gameStarted = true;
            this._timerFrozen = false;
            this._timerStart = Date.now();
            this._startTimer();
            this.requestRender();
        },

        _hasBoardLeftStartingRack() {
            if (!this.tiles?.length || !this.canMutatePlayingBoard()) return false;
            return !RummikubGrid.isStartingRack(this.tiles, { x: this.ORIGIN, y: this.ORIGIN });
        },

        _ensurePlayStartedFromBoardActivity() {
            if (!this.canMutatePlayingBoard() || !this._hasBoardLeftStartingRack()) return;
            if (!this.gameStarted) {
                this.beginGame();
                return;
            }
            if (!this._usesGameTimer() || this._timerFrozen) return;
            if (this._timerRaf && this._timerStart != null) return;
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

        _freezeTimerOnVictory() {
            this._timerFrozen = true;
            if (this._timerRaf) {
                cancelAnimationFrame(this._timerRaf);
                this._timerRaf = 0;
            }
            if (this._timerStart != null) {
                this.elapsedMs = Math.max(0, Date.now() - this._timerStart);
            }
            this._updateHudEl();
        },

        _updateHudEl() {
            const el = document.getElementById('rummikub-timer')
                || document.querySelector('.game-timer');
            if (el) {
                el.textContent = this._formatTime(this.elapsedMs);
                const mine = getComputedStyle(document.documentElement)
                    .getPropertyValue('--theme-color').trim() || '#3b82f6';
                el.style.color = mine;
            }
        }
    });
})(typeof window !== 'undefined' ? window : global);
