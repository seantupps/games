/** Bananagrams — gameplay (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before gameplay.js');
    Object.assign(G.prototype, {
            _tryDoubleTapDump(tile, e) {
                if (!e || this._rmbMarqueeUsed) return false;
                const DOUBLE_TAP_MS = 350;
                const DOUBLE_TAP_MAX_DIST = 28;
                const now = Date.now();
                const prev = this._tileDumpTap;
                const near = prev && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_MAX_DIST;
                if (prev?.tileId === tile.id && now - prev.at < DOUBLE_TAP_MS && near) {
                    this._tileDumpTap = null;
                    this.beginGame();
                    if (this._handleDump(tile)) {
                        if (!this._isMultiplayerMode()) this.persistState();
                        this.requestRender();
                        return true;
                    }
                    return false;
                }
                this._tileDumpTap = { tileId: tile.id, at: now, x: e.clientX, y: e.clientY };
                return false;
            },

            _drawCenter() {
                return { x: this.ORIGIN, y: this.ORIGIN };
            },

            _getVisibleWorldBounds() {
                const edgePad = (typeof BananaRules !== 'undefined' ? BananaRules.TILE_GAP : 40) + 8;
                const host = document.getElementById('game-container');
                const GV = typeof GameViewport !== 'undefined' ? GameViewport : null;
                if (host && GV?.clientToWorld) {
                    const rect = host.getBoundingClientRect();
                    const tl = GV.clientToWorld(this, rect.left + edgePad, rect.top + edgePad);
                    const br = GV.clientToWorld(this, rect.right - edgePad, rect.bottom - edgePad);
                    return {
                        left: Math.min(tl.x, br.x),
                        top: Math.min(tl.y, br.y),
                        right: Math.max(tl.x, br.x),
                        bottom: Math.max(tl.y, br.y)
                    };
                }
                const c = this._drawCenter();
                const halfW = 520;
                const halfH = 320;
                return {
                    left: c.x - halfW,
                    top: c.y - halfH,
                    right: c.x + halfW,
                    bottom: c.y + halfH
                };
            },

            _applyDumpToTiles(tiles, tileId) {
                if (!this._tilePool.length) return { ok: false, reason: 'empty-pool' };
                const idx = tiles.findIndex((t) => t.id === tileId);
                if (idx < 0) return { ok: false, reason: 'tile-not-found' };
        
                const removed = tiles[idx];
                const poolCopy = [...this._tilePool];
                const drawn = BananaRules.dumpTile(poolCopy, removed.letter, 3);
                if (drawn.length < 3) return { ok: false, reason: 'short-pool' };
        
                const handAfterRemove = tiles.filter((t) => t.id !== tileId);
                const spots = this._planDrawnTileSpots(handAfterRemove, drawn);
                if (!spots || spots.length !== drawn.length) {
                    return { ok: false, reason: 'spawn-full' };
                }
        
                const realDrawn = BananaRules.dumpTile(this._tilePool, removed.letter, 3);
                if (realDrawn.length !== drawn.length) {
                    return { ok: false, reason: 'pool-race' };
                }
        
                tiles.splice(idx, 1);
                const added = this._materializeDrawnTiles(spots, true);
                added.forEach((t) => tiles.push(t));
                return { ok: true, added, removedId: removed.id };
            },

            _handleDump(tile) {
                if (this._inReviewExperience?.()) return false;
                if (!tile || !this._tilePool.length) return false;
                if (this._isMultiplayerMode()) {
                    if (this.isHost()) {
                        return this._hostApplyDump(this._myUid(), tile.id);
                    }
                    if (!this._tilePool.length) return false;
                    this._sendBananaInteraction({
                        type: 'dump',
                        tileId: tile.id
                    });
                    return true;
                }
                const result = this._applyDumpToTiles(this.tiles, tile.id);
                if (!result.ok) return false;
                this._showBanner('Dump!');
                this.requestRender();
                return true;
            },

            _snapMembers(members) {
                if (!BananaGrid) return;
                const memberIds = new Set(
                    members.map((m) => (m.tile || this.tiles.find((t) => t.id === m.el?.dataset?.tileId))?.id)
                        .filter(Boolean)
                );
                let others = this.tiles.filter((t) => !memberIds.has(t.id));
                members.forEach((m) => {
                    const tile = m.tile || this.tiles.find((t) => t.id === m.el?.dataset?.tileId);
                    if (!tile) return;
                    const snap = BananaGrid.snapTilePosition(tile, others);
                    const moved = Number.isFinite(m.startWorldX) && Number.isFinite(m.startWorldY)
                        ? Math.hypot(tile.x - m.startWorldX, tile.y - m.startWorldY)
                        : 0;
                    const snapBackToStart = Number.isFinite(m.startWorldX) && Number.isFinite(m.startWorldY)
                        && Math.hypot(snap.x - m.startWorldX, snap.y - m.startWorldY) < 1;
                    if (snap.snapped && !(snapBackToStart && moved > 12)) {
                        tile.x = snap.x;
                        tile.y = snap.y;
                        m.worldX = snap.x;
                        m.worldY = snap.y;
                        if (m.el) {
                            const pos = this._tileElPos(tile);
                            m.el.style.left = `${pos.left}px`;
                            m.el.style.top = `${pos.top}px`;
                        }
                    }
                    others = [...others, tile];
                });
            },

            _allTilesPlacedOn(tiles) {
                if (!BananaGrid || typeof BananaRules === 'undefined') return false;
                return BananaGrid.allTilesPlacedInGrid(
                    tiles,
                    { x: this.ORIGIN, y: this.ORIGIN },
                    this._rackLayoutOptions()
                );
            },

            _allTilesPlaced() {
                return this._allTilesPlacedOn(this.tiles);
            },

            _checkPeel() {
                if (this._inReviewExperience?.()) return false;
                if (!this._checker || !BananaGrid) return false;
                if (!this._allTilesPlaced()) return false;
        
                const result = BananaGrid.validateGrid(this.tiles, this._checker);
                if (!result.ok) return false;
        
                if (this._isMultiplayerMode()) {
                    const me = this._myUid();
                    if (this.isHost()) {
                        const ok = this._hostPeelForPlayer(me);
                        if (ok && !this._winnerUid) this._showBanner('Peel!', 2200, { actorUid: me });
                        return ok;
                    }
                    this._sendBananaInteraction({
                        type: 'peel',
                        positions: this._serializePositions()
                    });
                    // Optimistic local feedback; host board sync will reinforce banner + inventory.
                    this._showBanner('Peel!', 2200, { actorUid: me });
                    return true;
                }
        
                if (!this._tilePool.length) {
                    this._onPlayerWins();
                    return true;
                }
                const drawn = BananaRules.drawFromPool(this._tilePool, 1);
                if (!drawn.length) return false;
                if (!this._applyDrawnLettersToHand(drawn)) return false;
                this._showBanner('Peel!');
                this.requestRender();
                return true;
            },

            _syncSelectionClasses() {
                const surface = document.querySelector('.board-pan-layer');
                if (!surface) return;
                surface.querySelectorAll('.tile').forEach((el) => {
                    const on = this._selectionHighlight && this._selectedIds.has(el.dataset.tileId);
                    el.classList.toggle('is-selected', on);
                });
            },

            _setSelection(ids, fromMarquee = false) {
                this._selectedIds = new Set(ids);
                this._selectionHighlight = !!fromMarquee && ids.length > 0;
                this._syncSelectionClasses();
            },

            _tileElPos(tile) {
                const inset = BananagramsGame.TILE_HIT_INSET;
                return { left: Math.round(tile.x - inset), top: Math.round(tile.y - inset) };
            },

            _applyTileWorld(m, worldX, worldY) {
                const tile = m.tile || this.tiles.find((t) => t.id === m.el?.dataset?.tileId);
                if (!tile || !m.el) return;
                tile.x = worldX;
                tile.y = worldY;
                m.worldX = worldX;
                m.worldY = worldY;
                const pos = this._tileElPos(tile);
                m.el.style.transform = '';
                m.el.style.left = `${Math.round(pos.left)}px`;
                m.el.style.top = `${Math.round(pos.top)}px`;
            },

            _getDragGroup(primaryEl) {
                const surface = document.querySelector('.board-pan-layer');
                const primaryId = primaryEl.dataset.tileId;
                const ids = (this._selectionHighlight && this._selectedIds.has(primaryId) && this._selectedIds.size > 1)
                    ? [...this._selectedIds]
                    : [primaryId];
                return ids.map((id) => {
                    const tile = this.tiles.find((t) => t.id === id);
                    const node = surface?.querySelector(`[data-tile-id="${id}"]`);
                    if (!tile || !node) return null;
                    return { el: node, tile };
                }).filter(Boolean);
            },

            _commitTilePositions(members) {
                (members || []).forEach((m) => {
                    const tile = m.tile || this.tiles.find((t) => t.id === m.el?.dataset?.tileId);
                    if (!tile || !m.el) return;
                    tile.x = Math.round(m.worldX != null ? m.worldX : tile.x);
                    tile.y = Math.round(m.worldY != null ? m.worldY : tile.y);
                });
        
            },

            _bindTileDrag(el, tile) {
                if (el.dataset.bananaDragBound) return;
                el.dataset.bananaDragBound = '1';
                const liveTile = () => this.tiles.find((t) => t.id === el.dataset.tileId) || tile;
                const HOLD_DUMP_MS = 450;
                let holdDumpTimer = null;
                const clearHoldDump = () => {
                    if (holdDumpTimer) {
                        clearTimeout(holdDumpTimer);
                        holdDumpTimer = null;
                    }
                };
                this._cancelHoldDump = clearHoldDump;
        
                BaseGame.setupDragging(
                    el,
                    (didDrag, draggedEl, ue, members) => {
                        clearHoldDump();
                        this.beginGame();
                        if (didDrag && ue) {
                            this._tileDumpTap = null;
                            const dragMembers = members || [{ el: draggedEl, tile: liveTile() }];
                            this._snapMembers(dragMembers);
                            this._commitTilePositions(dragMembers);
                            if (this._isMultiplayerMode()) {
                                this._markLocalDrag();
                                this._persistMpLayout();
                            }
                            this._checkPeel();
                            if (!this._isMultiplayerMode()) this.persistState();
                        }
                        this.requestRender();
                    },
                    this,
                    () => {
                        if (this._inReviewExperience?.()) return false;
                        this.beginGame();
                        if (this._isMultiplayerMode()) this._markLocalDrag();
                        return true;
                    },
                    null,
                    {
                        anchor: 'cursor',
                        getGroup: (dragEl) => this._getDragGroup(dragEl),
                        getWorldPosition: (m) => ({ x: m.tile.x, y: m.tile.y }),
                        setWorldPosition: (m, x, y) => this._applyTileWorld(m, x, y)
                    }
                );
                const tryDump = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (this._rmbMarqueeUsed) return;
                    this.beginGame();
                    if (this._handleDump(liveTile())) {
                        if (!this._isMultiplayerMode()) this.persistState();
                        this.requestRender();
                    }
                };
                el.addEventListener('contextmenu', tryDump);
                el.addEventListener('pointerdown', (e) => {
                    if (e.button === 2) {
                        e.preventDefault();
                        return;
                    }
                    if (e.button === 0) {
                        e.stopPropagation();
                        this.beginGame();
                        clearHoldDump();
                        holdDumpTimer = setTimeout(() => {
                            holdDumpTimer = null;
                            if (this._pointerDragging || el.classList.contains('is-dragging')) return;
                            if (this._rmbMarqueeUsed) return;
                            this.beginGame();
                            if (this._handleDump(liveTile())) {
                                if (!this._isMultiplayerMode()) this.persistState();
                                this.requestRender();
                            }
                        }, HOLD_DUMP_MS);
                    }
                });
            },

            _initSelection(surface) {
                if (this._selectionInit || typeof GameSelection === 'undefined') return;
                const host = document.getElementById('game-container');
                if (!host || !surface) return;
                if (!this.isMobileViewport()) {
                    GameSelection.setupMarquee(host, surface, this, {
                        getSelectableElements: () => [...surface.querySelectorAll('.tile')],
                        onSelectionChange: (ids) => this._setSelection(ids, true)
                    });
                }
                surface.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0) return;
                    if (e.target.closest('.tile')) return;
                    this._setSelection([], false);
                });
                this._selectionInit = true;
            }
    });
})(typeof window !== 'undefined' ? window : global);
