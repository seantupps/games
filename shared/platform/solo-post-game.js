/**
 * Solo puzzle post-game review + hub win banner helpers (pan-zoom tile games).
 * Games mix in via SoloPostGame.mixinProto(options) on their prototype.
 */
(function (global) {
    /**
     * @param {object} [options]
     * @param {string} [options.doneBtnId='game-done-btn']
     * @param {string} [options.doneBtnClass='game-done-btn']
     * @param {(game: object) => void} [options.onEnterReview]
     * @param {(game: object) => void} [options.onLeaveReset] — new round after Done
     */
    function mixinProto(options = {}) {
        const doneBtnId = options.doneBtnId || 'game-done-btn';
        const doneBtnClass = options.doneBtnClass || 'game-done-btn';

        return {
            _playerColor(uid) {
                if (!uid || uid === this._myUid?.()) return null;
                const pd = this.roomData?.playerData?.[uid];
                return pd?.color || null;
            },

            _bannerColorForUid(uid) {
                if (!uid || uid === this._myUid?.()) {
                    return getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim()
                        || '#3b82f6';
                }
                return this._playerColor(uid)
                    || getComputedStyle(document.documentElement).getPropertyValue('--opponent-color').trim()
                    || '#ef4444';
            },

            _dismissHubWinBanner() {
                if (typeof HubWinBannerPayload !== 'undefined') {
                    HubWinBannerPayload.postWinBanner({ visible: false });
                    return;
                }
                const msg = typeof HubProtocol !== 'undefined' && HubProtocol.MSG?.UPDATE_WIN_BANNER
                    ? HubProtocol.MSG.UPDATE_WIN_BANNER
                    : 'update-win-banner';
                window.parent.postMessage({ type: msg, visible: false }, '*');
            },

            _registerVictoryWithoutAutoReset(winner, victoryOptions = {}) {
                const defaultFade = (typeof window !== 'undefined' && window.FIVE_VICTORY_DWELL_MS)
                    ? Number(window.FIVE_VICTORY_DWELL_MS)
                    : 4000;
                const fadeMs = victoryOptions.autoFadeMs ?? defaultFade;
                const me = this._myUid?.() || null;

                if (this._victoryRegistered) {
                    this._postHubWinBanner({
                        visible: true,
                        winner,
                        bannerText: this._formatTime(this.elapsedMs),
                        bannerColor: this._bannerColorForUid(me)
                    });
                    return;
                }

                this._registerVictoryState(winner, {
                    winnerUid: victoryOptions.winnerUid,
                    bannerText: this._formatTime(this.elapsedMs),
                    bannerColor: this._bannerColorForUid(me),
                    autoFadeMs: fadeMs
                });
            },

            _soloReviewKey() {
                return this._myUid?.() || 'solo';
            },

            _reviewUiActive() {
                return !!this._postGameReview;
            },

            _canShowDoneButton() {
                return this._reviewUiActive();
            },

            isPostGameBlocking() {
                return this._reviewUiActive();
            },

            _exitReviewLocalState() {
                this._postGameReview = false;
                this._setBoardReadOnly?.(false);
                this._syncDoneButton();
                window.parent.postMessage({ type: 'post-game-blocking', active: false }, '*');
            },

            _activateReviewUi() {
                if (this._postGameReview) return;
                this._postGameReview = true;
                this._setBoardReadOnly?.(true);
                this._syncDoneButton();
                window.parent.postMessage({ type: 'post-game-blocking', active: true }, '*');
            },

            _enterPostGameReview() {
                this.clearAutoReset?.();
                this.isOver = true;
                this._freezeTimerOnVictory?.();
                this._activateReviewUi();
                this.requestRender?.();
                if (typeof options.onEnterReview === 'function') {
                    options.onEnterReview(this);
                }
            },

            _onDonePressed() {
                if (!this._reviewUiActive()) return;
                const me = this._soloReviewKey();
                if (this._reviewDone[me]) return;
                this._reviewDone[me] = true;
                this._leavePostGameReview(true);
            },

            _leavePostGameReview(triggerReset) {
                this._exitReviewLocalState();

                if (!triggerReset) {
                    this.requestRender?.();
                    return;
                }

                this._reviewDone = {};
                this._victoryRegistered = false;
                this._winnerBannerUid = null;
                this.isOver = false;
                this.winner = null;
                this._dismissHubWinBanner();
                if (typeof this.onGameReset === 'function') {
                    this.onGameReset();
                } else if (typeof options.onLeaveReset === 'function') {
                    options.onLeaveReset(this);
                }
                this.requestRender?.();
                this._syncViewportAfterLayout?.();
            },

            _syncDoneButton() {
                let btn = document.getElementById(doneBtnId);
                const showDone = this._canShowDoneButton();
                if (!showDone) {
                    if (btn) btn.classList.remove('show');
                    return;
                }
                if (!btn) {
                    btn = document.createElement('button');
                    btn.type = 'button';
                    btn.id = doneBtnId;
                    btn.className = doneBtnClass;
                    btn.dataset.testid = doneBtnId;
                    btn.textContent = 'Done';
                    btn.addEventListener('click', () => this._onDonePressed());
                    (document.body || document.getElementById('game-container'))?.appendChild(btn);
                }
                btn.classList.add('show');
                btn.disabled = false;
                btn.textContent = 'Done';
                btn.style.color = this._bannerColorForUid(this._myUid?.());
            }
        };
    }

    global.SoloPostGame = { mixinProto };
})(typeof window !== 'undefined' ? window : global);
