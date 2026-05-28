/** Bananagrams — render (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before render.js');
    Object.assign(G.prototype, {
            renderScoreboard() {
                this.updateTurnIndicator();
                let sb = document.querySelector('.scoreboard');
                if (!this._isMultiplayerMode()) {
                    if (sb) sb.classList.remove('show');
                    return;
                }
                if (!sb) {
                    sb = document.createElement('div');
                    sb.className = 'scoreboard';
                    sb.style.pointerEvents = 'none';
                    document.body.appendChild(sb);
                }
                sb.classList.add('show');
                const rows = this._getMpScoreRows();
                sb.innerHTML = rows.map((row, i) => {
                    const sep = i > 0 ? '<span class="score-divider">-</span>' : '';
                    const cls = row.uid === this._myUid() ? 'score-user' : 'score-ai';
                    const style = row.uid !== this._myUid() && row.color
                        ? ` style="color:${row.color}"`
                        : '';
                    return `${sep}<span class="${cls}"${style}>${row.score}</span>`;
                }).join('');
            },

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
                const inReview = this._inReviewExperience?.()
                    || (typeof this._isBoardInReview === 'function' && this._isBoardInReview());
                if (inReview && typeof this._reviewTilesBounds === 'function') {
                    const b = this._reviewTilesBounds(this.tiles);
                    if (b) return { x: b.cx, y: b.cy };
                }
                return { x: this.ORIGIN, y: this.ORIGIN };
            },

            getPanZoomWorldVisualBounds() {
                const pad = 48;
                const size = BananaRules.TILE_SIZE;
                const gap = BananaRules.TILE_GAP;
                const below = BananaRules.HAND_BELOW_CENTER;
                const o = this.ORIGIN;
                const tiles = this.tiles;
                if (!tiles?.length) {
                    const cols = BananaRules.COLS;
                    const rows = 3;
                    const w = (cols - 1) * gap + size + pad * 2;
                    const h = (rows - 1) * gap + size + pad * 2;
                    return {
                        w,
                        h: below + h + pad * 3,
                        cx: o,
                        cy: o
                    };
                }
                let minX = Infinity;
                let minY = o - pad * 3;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const t of tiles) {
                    if (t.x == null || t.y == null) continue;
                    minX = Math.min(minX, t.x);
                    maxX = Math.max(maxX, t.x + size);
                    minY = Math.min(minY, t.y);
                    maxY = Math.max(maxY, t.y + size);
                }
                minX -= pad;
                maxX += pad;
                maxY += pad;
                const inReview = this._inReviewExperience?.()
                    || (typeof this._isBoardInReview === 'function' && this._isBoardInReview());
                if (inReview && typeof this._reviewTilesBounds === 'function') {
                    const rb = this._reviewTilesBounds(tiles);
                    if (rb) {
                        return { w: rb.w, h: rb.h, cx: rb.cx, cy: rb.cy };
                    }
                }
                return {
                    w: maxX - minX,
                    h: maxY - minY,
                    cx: (minX + maxX) / 2,
                    cy: (minY + maxY) / 2
                };
            },

            getValidMoves() {
                return [];
            },

            _ensureOverlays(container) {
                if (!container.querySelector('#banana-hud')) {
                    const hud = document.createElement('div');
                    hud.id = 'banana-hud';
                    hud.className = 'banana-hud';
                    hud.dataset.testid = 'banana-hud';
        
                    const timer = document.createElement('div');
                    timer.id = 'banana-timer';
                    timer.className = 'banana-timer';
                    timer.dataset.testid = 'banana-timer';
                    timer.textContent = '0:00';
                    hud.appendChild(timer);
        
                    const poolRow = document.createElement('div');
                    poolRow.className = 'banana-pool-row';
                    poolRow.dataset.testid = 'banana-pool-row';
                    const poolLabel = document.createElement('span');
                    poolLabel.className = 'banana-pool-label';
                    poolLabel.textContent = 'BUNCH';
                    const pool = document.createElement('span');
                    pool.id = 'banana-pool-count';
                    pool.className = 'banana-pool-count';
                    pool.dataset.testid = 'banana-pool-count';
                    pool.textContent = '0';
                    poolRow.appendChild(poolLabel);
                    poolRow.appendChild(pool);
                    hud.appendChild(poolRow);
        
                    container.appendChild(hud);
                }
                if (!document.getElementById('banana-banner')) {
                    const banner = document.createElement('div');
                    banner.id = 'banana-banner';
                    banner.className = 'banana-banner';
                    banner.dataset.testid = 'banana-banner';
                    document.body.appendChild(banner);
                }
            },

            _render(options = {}) {
                const container = document.getElementById('game-container');
                if (!container) return;
        
                this._ensureOverlays(container);
                this._syncBannerEl();
                if (typeof GameDevOverlay !== 'undefined') {
                    GameDevOverlay.sync(this);
                }
                this._updateHudEl();
        
                const surface = container.querySelector('.board-pan-layer');
                if (!surface) return;
        
                const existing = new Set(this.tiles.map((t) => t.id));
                surface.querySelectorAll('.tile').forEach((node) => {
                    if (!existing.has(node.dataset.tileId)) node.remove();
                });
        
                const inset = BananagramsGame.TILE_HIT_INSET;
                const hitSize = 40 + inset * 2;
        
                this.tiles.forEach((tile) => {
                    let el = surface.querySelector(`[data-tile-id="${tile.id}"]`);
                    if (!el) {
                        el = document.createElement('div');
                        el.className = 'tile';
                        el.dataset.tileId = tile.id;
                        el.dataset.testid = 'tile';
                        const face = document.createElement('span');
                        face.className = 'tile-face';
                        face.textContent = tile.letter;
                        el.appendChild(face);
                        surface.appendChild(el);
                    }
                    const face = el.querySelector('.tile-face');
                    if (this._inReviewExperience?.()) {
                        el.style.pointerEvents = 'none';
                        const owner = tile.ownerUid || this._myUid();
                        const color = typeof this._reviewColorForUid === 'function'
                            ? this._reviewColorForUid(owner)
                            : this._bannerColorForUid(owner);
                        if (color) el.style.setProperty('--tile-owner-color', color);
                        el.classList.add('is-review-tile');
                        if (face && color) {
                            face.style.background = color;
                            face.style.borderColor = `color-mix(in srgb, ${color} 70%, #000)`;
                        }
                    } else {
                        el.style.pointerEvents = '';
                        el.classList.remove('is-review-tile');
                        if (face) {
                            face.style.background = '';
                            face.style.borderColor = '';
                        }
                    }
                    if (!this._inReviewExperience?.() && !el.dataset.bananaDragBound) {
                        this._bindTileDrag(el, tile);
                        el.dataset.bananaDragBound = '1';
                    }
                    if (face) face.textContent = tile.letter;
                    el.style.width = `${hitSize}px`;
                    el.style.height = `${hitSize}px`;
                    const showFace = tile.faceUp || this.gameStarted;
                    el.classList.toggle('is-face-down', !showFace);
                    if (!el.classList.contains('is-dragging')) {
                        const pos = this._tileElPos(tile);
                        el.style.left = `${pos.left}px`;
                        el.style.top = `${pos.top}px`;
                    }
                    const on = this._selectionHighlight && this._selectedIds.has(tile.id);
                    el.classList.toggle('is-selected', on);
                });
        
                this._initSelection(surface);
                this._syncDoneButton();
                if (options.skipViewportFlush) {
                    return;
                }
                if (this._inReviewExperience?.()
                    && typeof this._flushReviewViewportImmediate === 'function') {
                    this._flushReviewViewportImmediate({ paintOnly: true });
                } else {
                    this._flushViewport();
                }
            }
    });
})(typeof window !== 'undefined' ? window : global);
