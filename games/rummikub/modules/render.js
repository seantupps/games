/** Rummikub — render tiles on pan layer. */
(function (global) {
    const G = global.RummikubGame;
    if (!G) throw new Error('RummikubGame must be defined before render.js');
    Object.assign(G.prototype, {
        updateTurnIndicator() {
            const turnMsg = typeof HubProtocol !== 'undefined' ? HubProtocol.MSG.UPDATE_TURN : 'update-turn';
            window.parent.postMessage({ type: turnMsg, text: '', color: 'white' }, '*');
        },

        notifyGameRendered() {
            if (this._gameRenderedNotified || window.parent === window) return;
            const visible = this.tiles?.length || 0;
            const container = document.getElementById('game-container');
            const cw = container?.offsetWidth || 0;
            const ch = container?.offsetHeight || 0;
            if (visible === 0 && (cw === 0 || ch === 0)) return;
            this._gameRenderedNotified = true;
            window.parent.postMessage({
                type: 'game-rendered',
                game: this.gameName,
                visible,
                containerW: cw,
                containerH: ch
            }, '*');
        },

        getViewportContentCenter() {
            if (this.tiles?.length) {
                const b = this.getPanZoomWorldVisualBounds();
                if (b && Number.isFinite(b.cy)) {
                    // Rack is centered on ORIGIN.x; keep screen midpoint aligned with it.
                    return { x: this.ORIGIN, y: b.cy };
                }
            }
            return { x: this.ORIGIN, y: this.ORIGIN };
        },

        _applyDefaultPlayingViewport() {
            if (this._preservePlayViewport) return;
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
            const bounds = this.getPanZoomWorldVisualBounds();
            if (bounds && typeof GameViewport !== 'undefined') {
                const host = document.getElementById('game-container');
                const vw = host?.offsetWidth || window.innerWidth || 800;
                const vh = host?.offsetHeight || window.innerHeight || 600;
                const margin = 48;
                const fit = Math.min(
                    (vw - margin * 2) / Math.max(bounds.w, 1),
                    (vh - margin * 2) / Math.max(bounds.h, 1)
                );
                if (Number.isFinite(fit) && fit > 0) {
                    const zoom = Math.min(Math.max(fit, 0.15), 5);
                    this.targetZoom = zoom;
                    this.zoom = zoom;
                    this._fitZoomInitialized = true;
                }
                const focal = this.getViewportContentCenter();
                GameViewport.centerWorldPoint(this, focal.x, focal.y);
            } else if (typeof GameViewport !== 'undefined') {
                GameViewport.centerWorldPoint(this, this.ORIGIN, this.ORIGIN);
            }
        },

        _standardStartingRackViewportBounds() {
            const pad = 48;
            const R = RummikubRules;
            const rackCount = (this.tiles || []).filter((t) => t.zone === 'rack').length || this.tiles.length;
            const { startX, startY, cols } = R.rackOrigin({ x: this.ORIGIN, y: this.ORIGIN }, rackCount);
            const rows = Math.min(R.RACK_ROWS, Math.ceil(rackCount / cols) || 1);
            const rackW = (cols - 1) * R.TILE_GAP + R.TILE_W;
            const rackH = (rows - 1) * R.TILE_H + R.TILE_H;
            const cx = startX + rackW / 2;
            const cy = startY + rackH / 2;
            return {
                w: rackW + pad * 2,
                h: R.HAND_BELOW_CENTER + rackH + pad * 2,
                cx,
                cy: this.ORIGIN + (R.HAND_BELOW_CENTER + rackH) / 2 - 40
            };
        },

        _isStartingRackLayout() {
            const origin = { x: this.ORIGIN, y: this.ORIGIN };
            return RummikubGrid.isStartingRack(this.tiles, origin);
        },

        getPanZoomWorldVisualBounds() {
            const pad = 48;
            const origin = { x: this.ORIGIN, y: this.ORIGIN };
            const hasTable = (this.tiles || []).some((t) => t.zone === 'table');
            if (!this.tiles?.length || (this._isStartingRackLayout() && !hasTable)) {
                return this._standardStartingRackViewportBounds();
            }
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const t of this.tiles) {
                minX = Math.min(minX, t.x);
                minY = Math.min(minY, t.y);
                maxX = Math.max(maxX, t.x + RummikubRules.TILE_W);
                maxY = Math.max(maxY, t.y + RummikubRules.TILE_H);
            }
            return {
                w: maxX - minX + pad * 2,
                h: maxY - minY + pad * 2,
                cx: (minX + maxX) / 2,
                cy: (minY + maxY) / 2
            };
        },

        _tileFaceLabel(tile) {
            if (tile.kind === 'joker') {
                if (tile.as) return String(tile.as.value);
                return 'J';
            }
            return String(tile.value);
        },

        _tileFaceColor(tile) {
            if (tile.kind === 'joker') {
                if (tile.as?.color) return tile.as.color;
                return tile.display === 'R' ? 'R' : 'B';
            }
            return tile.color;
        },

        _ensureHud(container) {
            if (!container.querySelector('.rummikub-hud')) {
                const hud = document.createElement('div');
                hud.className = 'rummikub-hud';
                hud.innerHTML = '<div id="rummikub-timer" class="game-timer" data-testid="game-timer">0:00</div>';
                container.appendChild(hud);
            }
        },

        _render(options = {}) {
            const container = document.getElementById('game-container');
            if (!container) return;

            this._ensureHud(container);
            this._updateHudEl();
            this._syncDoneButton();

            const surface = container.querySelector('.board-pan-layer');
            if (!surface) return;

            const existing = new Set(this.tiles.map((t) => t.id));
            surface.querySelectorAll('.tile').forEach((node) => {
                if (!existing.has(node.dataset.tileId)) node.remove();
            });

            const readOnly = this._postGameReview;
            for (const tile of this.tiles) {
                let el = surface.querySelector(`[data-tile-id="${tile.id}"]`);
                if (!el) {
                    el = document.createElement('div');
                    el.className = 'tile';
                    el.dataset.tileId = tile.id;
                    el.dataset.testid = 'tile';
                    const face = document.createElement('span');
                    face.className = 'tile-face';
                    const val = document.createElement('span');
                    val.className = 'tile-value';
                    face.appendChild(val);
                    el.appendChild(face);
                    surface.appendChild(el);
                }
                const face = el.querySelector('.tile-face');
                const val = el.querySelector('.tile-value');
                const color = this._tileFaceColor(tile);
                if (face) face.dataset.color = color;
                if (val) val.textContent = this._tileFaceLabel(tile);
                el.style.pointerEvents = readOnly ? 'none' : '';
                if (!readOnly && !el.dataset.rummiDragBound) {
                    this._bindTileDrag(el, tile);
                    el.dataset.rummiDragBound = '1';
                }
                if (!el.classList.contains('is-dragging')) {
                    this._applyTileElLayout(el, tile);
                }
                const on = this._selectionHighlight && this._selectedIds.has(tile.id);
                el.classList.toggle('is-selected', on);
            }

            this._initSelection(surface);
            this.notifyGameRendered();

            if (options.skipViewportFlush) return;
            this._flushViewport?.();
        }
    });
})(typeof window !== 'undefined' ? window : global);
