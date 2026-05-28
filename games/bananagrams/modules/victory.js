/** Bananagrams — victory (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before victory.js');
    Object.assign(G.prototype, {
            _onPlayerWins(winnerUid = null) {
                const mp = this._isMultiplayerMode();
                if (mp && winnerUid) {
                    this._winnerUid = winnerUid;
                    this._mpScores[winnerUid] = (this._mpScores[winnerUid] || 0) + 1;
                    if (this.isHost()) {
                        this._finishVictory(winnerUid);
                    }
                    return;
                }
                this._finishVictory(winnerUid);
            },

            setGameOver(winner, options = {}) {
                if (this._isMultiplayerMode()) {
                    if (this._victoryRegistered || this._isBoardInReview()) return;
                    const hubWinner = options.winnerUid === (this.roomData?.host || '')
                        ? 'P1'
                        : 'P2';
                    this._registerVictoryWithoutAutoReset(hubWinner, {
                        winnerUid: options.winnerUid
                    });
                    return;
                }
                this._finishVictory(null);
            },

            _finishVictory(winnerUid = null) {
                if (this._victoryRegistered || this._isBoardInReview()) return;

                const mp = this._isMultiplayerMode();
                const uid = mp ? winnerUid : null;
                if (mp && uid) this._winnerUid = uid;

                const hubWinner = mp
                    ? (uid === (this.roomData?.host || '') ? 'P1' : 'P2')
                    : 'P1';
                if (!this._winnerBannerUid) {
                    this._winnerBannerUid = uid || 'solo';
                }
                this.clearAutoReset();
                this._freezeTimerOnVictory();
                if (mp) {
                    this._registerVictoryWithoutAutoReset(hubWinner, {
                        winnerUid: uid || undefined
                    });
                    this._enterPostGameReview(uid);
                    return;
                }
                this._registerVictoryWithoutAutoReset(hubWinner, { winnerUid: uid || undefined });
                this._enterPostGameReview(uid);
            },

            /** Dev /win — calls _onPlayerWins (same entry as real empty-bunch peel win). */
            debugTriggerWin() {
                if (this._victoryRegistered || this._isBoardInReview()) return;
                if (typeof this._isBoardInReview === 'function' && this._isBoardInReview()) return;

                const mp = this._isMultiplayerMode();
                const uid = this._myUid();
                if (mp) {
                    if (!uid) return;
                    if (this.isHost()) {
                        this._onPlayerWins(uid);
                        return;
                    }
                    this._sendBananaInteraction({
                        type: 'dev-win',
                        uid
                    });
                    return;
                }
                this._onPlayerWins();
            },

            _registerVictoryWithoutAutoReset(winner, options = {}) {
                const defaultFade = (typeof window !== 'undefined' && window.FIVE_VICTORY_DWELL_MS)
                    ? Number(window.FIVE_VICTORY_DWELL_MS)
                    : 4000;
                const fadeMs = options.autoFadeMs ?? defaultFade;

                if (this._victoryRegistered) {
                    if (!this._isMultiplayerMode()) {
                        this._postHubWinBanner({
                            visible: true,
                            winner,
                            bannerText: this._formatTime(this.elapsedMs),
                            bannerColor: this._bannerColorForUid(this._myUid())
                        });
                    } else {
                        this._postHubWinBanner({
                            visible: true,
                            winner,
                            winnerUid: options.winnerUid || undefined,
                            autoFadeMs: fadeMs
                        });
                    }
                    return;
                }

                if (!this._isMultiplayerMode()) {
                    this._registerVictoryState(winner, {
                        winnerUid: options.winnerUid,
                        bannerText: this._formatTime(this.elapsedMs),
                        bannerColor: this._bannerColorForUid(this._myUid()),
                        autoFadeMs: fadeMs
                    });
                    return;
                }

                this._registerVictoryState(winner, {
                    winnerUid: options.winnerUid,
                    autoFadeMs: fadeMs
                });
            }
    });
})(typeof window !== 'undefined' ? window : global);
