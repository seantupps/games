/** Rummikub — solo victory (delegates review + banner to SoloPostGame). */
(function (global) {
    const G = global.RummikubGame;
    if (!G) throw new Error('RummikubGame must be defined before victory.js');
    if (typeof SoloPostGame === 'undefined') {
        throw new Error('solo-post-game.js must load before victory.js');
    }

    Object.assign(G.prototype, SoloPostGame.mixinProto({
        onEnterReview(game) {
            if (typeof GameViewport !== 'undefined') {
                GameViewport.applyPanZoom(game);
            }
        }
    }));

    Object.assign(G.prototype, {
        _finishVictory(winnerUid = null) {
            if (this._postGameReview) return;

            if (!this._winnerBannerUid) {
                this._winnerBannerUid = winnerUid || 'solo';
            }
            this.clearAutoReset?.();
            this._freezeTimerOnVictory();
            this._registerVictoryWithoutAutoReset('P1');
            this._enterPostGameReview();
        }
    });
})(typeof window !== 'undefined' ? window : global);
