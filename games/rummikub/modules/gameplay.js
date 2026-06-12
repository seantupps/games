/** Rummikub — drag, snap, selection (Bananagrams-style). */
(function (global) {
    const G = global.RummikubGame;
    if (!G) throw new Error('RummikubGame must be defined before gameplay.js');
    Object.assign(G.prototype, {
        _liveTileForDrag(m) {
            if (m?.tile) {
                const hit = this.tiles.find((t) => t.id === m.tile.id);
                if (hit) {
                    m.tile = hit;
                    return hit;
                }
            }
            return m.tile || null;
        },

        _tileHitExpand(tile) {
            const pad = this.isMobileViewport?.()
                ? G.TILE_SELECT_EXPAND
                : 0;
            if (!pad || typeof TileLayout === 'undefined') {
                return { left: 0, top: 0, right: 0, bottom: 0 };
            }
            const others = this.tiles.filter((t) => t.id !== tile.id);
            const stepX = RummikubRules.TILE_GAP;
            const stepY = tile.zone === 'table'
                ? RummikubRules.BOARD_ROW_STEP
                : RummikubRules.TILE_H;
            return TileLayout.computeHitExpand(tile, others, { pad, stepX, stepY });
        },

        _tileElLayout(tile) {
            const R = RummikubRules;
            const hit = this._tileHitExpand(tile);
            if (typeof TileLayout !== 'undefined') {
                return TileLayout.tileElLayout(tile, hit, R.TILE_W, R.TILE_H);
            }
            return {
                left: Math.round(tile.x),
                top: Math.round(tile.y),
                width: R.TILE_W,
                height: R.TILE_H,
                faceLeft: 0,
                faceTop: 0
            };
        },

        _applyTileElLayout(el, tile) {
            if (!el || !tile) return;
            const layout = this._tileElLayout(tile);
            el.style.width = `${layout.width}px`;
            el.style.height = `${layout.height}px`;
            el.style.left = `${layout.left}px`;
            el.style.top = `${layout.top}px`;
            const face = el.querySelector('.tile-face');
            if (face) {
                face.style.left = `${layout.faceLeft}px`;
                face.style.top = `${layout.faceTop}px`;
            }
        },

        _applyTileWorld(m, worldX, worldY) {
            const tile = this._liveTileForDrag(m);
            if (!tile || !m.el) return;
            tile.x = worldX;
            tile.y = worldY;
            m.worldX = worldX;
            m.worldY = worldY;
            m.el.style.transform = '';
            const face = m.el.querySelector('.tile-face');
            const faceLeft = face ? parseFloat(face.style.left) || 0 : 0;
            const faceTop = face ? parseFloat(face.style.top) || 0 : 0;
            m.el.style.left = `${Math.round(worldX - faceLeft)}px`;
            m.el.style.top = `${Math.round(worldY - faceTop)}px`;
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

        _setSelection(ids, highlight) {
            this._selectedIds = new Set(ids);
            this._selectionHighlight = highlight;
            this._syncSelectionClasses();
        },

        _syncSelectionClasses() {
            const surface = document.querySelector('.board-pan-layer');
            if (!surface) return;
            surface.querySelectorAll('.tile').forEach((el) => {
                const on = this._selectionHighlight && this._selectedIds.has(el.dataset.tileId);
                el.classList.toggle('is-selected', on);
            });
        },

        hasActiveTileSelection() {
            return !!(this._selectionHighlight && this._selectedIds.size > 0);
        },

        shouldBlockViewportPan() {
            return !!this._mobileMarqueeActive;
        },

        /** Tap/click — select a valid meld/pair in the same zone (table or rack) or a single tile. */
        _selectTileByClick(tile) {
            if (!tile || !this.canMutatePlayingBoard()) return;
            const meldIds = this._validMeldIdsForTile?.(tile);
            if (meldIds?.length > 1) {
                this._setSelection(meldIds, true);
                return;
            }
            this._setSelection([tile.id], true);
        },

        _syncTableTileElements() {
            const surface = document.querySelector('.board-pan-layer');
            if (!surface) return;
            (this.tiles || []).forEach((tile) => {
                if (tile.zone !== 'table') return;
                const el = surface.querySelector(`[data-tile-id="${tile.id}"]`);
                if (el) this._applyTileElLayout(el, tile);
            });
        },

        _syncAllTileElements() {
            const surface = document.querySelector('.board-pan-layer');
            if (!surface) return;
            (this.tiles || []).forEach((tile) => {
                const el = surface.querySelector(`[data-tile-id="${tile.id}"]`);
                if (el) this._applyTileElLayout(el, tile);
            });
        },

        _refineTableAlignment() {
            const origin = { x: this.ORIGIN, y: this.ORIGIN };
            const changed = RummikubGrid.refineTableAlignment(this.tiles, origin);
            if (changed) this._syncTableTileElements();
            return changed;
        },

        _commitTilePositions(members) {
            if (!members?.length) return;
            this._rebindDragMembers(members);
            const origin = { x: this.ORIGIN, y: this.ORIGIN };
            const memberIds = new Set(members.map((m) => this._liveTileForDrag(m)?.id).filter(Boolean));
            const dropOpts = this._dropOptions?.();

            if (members.length > 1) {
                const groupTiles = members
                    .map((m) => this._liveTileForDrag(m))
                    .filter(Boolean);
                const others = this.tiles.filter((t) => !memberIds.has(t.id));
                const resolved = RummikubGrid.resolveGroupDrop(groupTiles, others, origin, dropOpts);
                resolved.forEach((tile) => {
                    const m = members.find((mem) => this._liveTileForDrag(mem)?.id === tile.id);
                    const live = this.tiles.find((t) => t.id === tile.id);
                    if (live) Object.assign(live, tile);
                    if (m?.el) this._applyTileElLayout(m.el, live || tile);
                });
            } else {
                let placed = this.tiles.filter((t) => !memberIds.has(t.id));
                members.forEach((m) => {
                    const tile = this._liveTileForDrag(m);
                    if (!tile) return;
                    const resolved = RummikubGrid.resolveDrop(tile, placed, origin, dropOpts);
                    Object.assign(tile, resolved);
                    placed = [...placed, tile];
                    if (m.el) this._applyTileElLayout(m.el, tile);
                });
            }

            if (RummikubGrid.handHasOverlaps(this.tiles)) {
                this.tiles = RummikubGrid.resolveBoardOverlaps(
                    this.tiles,
                    origin,
                    dropOpts
                );
                members.forEach((m) => {
                    const tile = this._liveTileForDrag(m);
                    const live = tile && this.tiles.find((t) => t.id === tile.id);
                    if (live && m.el) this._applyTileElLayout(m.el, live);
                });
            }
            this._refineTableAlignment();
            this._syncAllTileElements();
            this._ensurePlayStartedFromBoardActivity();
        },

        _rebindDragMembers(members) {
            (members || []).forEach((m) => this._liveTileForDrag(m));
        },

        _bindTileDrag(el, tile) {
            if (el.dataset.rummiDragBound) return;
            el.dataset.rummiDragBound = '1';
            const liveTile = () => this.tiles.find((t) => t.id === el.dataset.tileId) || tile;

            BaseGame.setupDragging(
                el,
                (didDrag, draggedEl, _ue, members) => {
                    this.beginGame();
                    if (!didDrag) {
                        this._selectTileByClick(liveTile());
                        return;
                    }
                    const dragMembers = members || [{ el: draggedEl, tile: liveTile() }];
                    this._commitTilePositions(dragMembers);
                    this._checkWin();
                    this.requestRender();
                },
                this,
                () => {
                    if (!this.canMutatePlayingBoard()) return false;
                    this.beginGame();
                    return true;
                },
                null,
                {
                    anchor: 'cursor',
                    getGroup: (dragEl) => this._getDragGroup(dragEl),
                    getWorldPosition: (m) => ({ x: m.tile.x, y: m.tile.y }),
                    setWorldPosition: (m, x, y) => this._applyTileWorld(m, x, y),
                    onDragBegin: (_members, dragEl) => {
                        const id = dragEl?.dataset?.tileId;
                        if (!id || !this._selectionHighlight || !this._selectedIds.size) return;
                        if (!this._selectedIds.has(id)) this._setSelection([], false);
                    }
                }
            );
        },

        _initMobileBackgroundGestures(host) {
            if (this._mobileBgInit || !host) return;
            let down = null;
            const slop = 5;
            host.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                if (e.target.closest('.tile, .piece')) return;
                down = { x: e.clientX, y: e.clientY, id: e.pointerId };
                this._bgGestureWasMarquee = false;
            }, true);
            host.addEventListener('pointerup', (e) => {
                if (!down || e.pointerId !== down.id) return;
                if (e.target.closest('.tile, .piece')) return;
                const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop;
                const wasPan = !!this._viewportPanning;
                const wasMarquee = !!this._bgGestureWasMarquee;
                down = null;
                if (!moved && !wasPan && !wasMarquee) {
                    this._setSelection([], false);
                }
            }, true);
            this._mobileBgInit = true;
        },

        _initSelection(surface) {
            if (this._selectionInit || typeof GameSelection === 'undefined') return;
            const host = document.getElementById('game-container');
            if (!host || !surface) return;
            const marqueeOpts = {
                getSelectableElements: () => [...surface.querySelectorAll('.tile')],
                onSelectionChange: (ids) => this._setSelection(ids, true)
            };
            if (this.isMobileViewport()) {
                this._initMobileBackgroundGestures(host);
                GameSelection.setupMobileMarquee(host, surface, this, {
                    ...marqueeOpts,
                    onClearSelection: () => this._setSelection([], false)
                });
            } else {
                GameSelection.setupMarquee(host, surface, this, marqueeOpts);
                surface.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0) return;
                    if (e.target.closest('.tile')) return;
                    this._setSelection([], false);
                });
            }
            this._selectionInit = true;
        },

        reportBoardState() {
            const resultType = typeof HubProtocol !== 'undefined'
                ? (HubProtocol.MSG?.BOARD_STATE_INSPECT_RESULT
                    || HubProtocol.MSG?.BANANA_BOARD_STATE_RESULT)
                : 'board-state-inspect-result';
            const post = (summary, lines = []) => {
                window.parent.postMessage({
                    type: resultType || 'board-state-inspect-result',
                    ok: true,
                    summary,
                    lines
                }, '*');
            };
            if (!this.canMutatePlayingBoard?.()) {
                post('Board is not in active play.');
                return;
            }
            const tiles = this.tiles || [];
            if (!tiles.length) {
                post('No tiles loaded.');
                return;
            }
            const diag = this._evaluateWinCondition?.('state') || null;
            const unmatched = diag?.partition?.unmatchedTileBriefs || [];
            const summary = unmatched.length
                ? `${unmatched.length} unmatched`
                : 'All matched';
            post(summary, unmatched);
        }
    });
})(typeof window !== 'undefined' ? window : global);
