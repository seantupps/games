/**
 * Pan-zoom board viewport session helpers (Bananagrams-style default framing).
 */
(function (global) {
    function mixinProto() {
        return {
            centerViewOnOrigin() {
                if (typeof GameViewport !== 'undefined') {
                    GameViewport.centerWorldPoint(this, this.ORIGIN, this.ORIGIN);
                }
            },

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
                const inReview = this._reviewUiActive?.()
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
            }
        };
    }

    global.PanZoomSession = { mixinProto };
})(typeof window !== 'undefined' ? window : global);
