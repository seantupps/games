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

            _bunchLenForDump() {
                if (typeof this._mpAuthoritativeBunchLen === 'function') {
                    return this._mpAuthoritativeBunchLen();
                }
                return this._tilePool?.length ?? 0;
            },

            _canDumpFromBunch() {
                const min = typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3;
                return this._bunchLenForDump() >= min;
            },

            _applyDumpToTiles(tiles, tileId) {
                if (!this._canDumpFromBunch()) return { ok: false, reason: 'short-pool' };
                const idx = tiles.findIndex((t) => t.id === tileId);
                if (idx < 0) return { ok: false, reason: 'tile-not-found' };
        
                const removed = tiles[idx];
                // Compute dump once on a pool copy, then commit that snapshot.
                // This avoids RNG divergence between preview and commit.
                const nextPool = [...this._tilePool];
                const drawn = BananaRules.dumpTile(nextPool, removed.letter, 3);
                if (drawn.length < 3) return { ok: false, reason: 'short-pool' };
        
                const handAfterRemove = tiles.filter((t) => t.id !== tileId);
                const spots = this._planDrawnTileSpots(handAfterRemove, drawn);
                if (!spots || spots.length !== drawn.length) {
                    return { ok: false, reason: 'spawn-full' };
                }

                this._tilePool = nextPool;
                tiles.splice(idx, 1);
                const added = this._materializeDrawnTiles(spots, true);
                added.forEach((t) => tiles.push(t));
                return { ok: true, added, removedId: removed.id };
            },

            _handleDump(tile) {
                if (this._inReviewExperience?.()) return false;
                if (!tile || !this._canDumpFromBunch()) return false;
                if (this._isMultiplayerMode()) {
                    const me = this._myUid();
                    if (this.isHost()) {
                        const ok = this._hostApplyDump(me, tile.id);
                        // Match peel behavior: show immediate local action feedback.
                        if (ok) this._showBanner('Dump!', 2200, { actorUid: me });
                        return ok;
                    }
                    const ownedSnapshot = (this.tiles || []).map((t) => ({
                        id: t.id,
                        letter: t.letter,
                        faceUp: !!t.faceUp
                    }));
                    this._sendBananaInteraction({
                        type: 'dump',
                        tileId: tile.id,
                        owned: ownedSnapshot
                    });
                    // Optimistic local feedback; host board sync reinforces banner + inventory.
                    this._showBanner('Dump!', 2200, { actorUid: me });
                    return true;
                }
                const result = this._applyDumpToTiles(this.tiles, tile.id);
                if (!result.ok) return false;
                this._soloDistributionInvariantCheck?.('solo-dump');
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

            /** Bunch empty + full connected valid grid (MP win / solo win). */
            _handQualifiesForBananasWin(hand) {
                if (!this._checker || !BananaGrid) return false;
                if (!hand?.length || hand.length < 3) return false;
                const bunchLen = typeof this._mpAuthoritativeBunchLen === 'function'
                    ? this._mpAuthoritativeBunchLen()
                    : this._tilePool.length;
                if (bunchLen) return false;
                const result = BananaGrid.validateGrid(hand, this._checker);
                if (!result.ok || !this._allTilesPlacedOn(hand)) return false;
                if (!BananaGrid.eachTileOccupiesUniqueCell(hand)) return false;
                if (!BananaGrid.isConnected(hand)) return false;
                return (result.words || []).some((w) => String(w || '').length >= 3);
            },

            _isHandDragActive() {
                return !!(this._pointerDragging || this.isDragging);
            },

            /** Peel/win validation only after pointer-up and drag flags are cleared. */
            _schedulePeelAfterDragRelease() {
                if (this._peelAfterDragQueued) return;
                this._peelAfterDragQueued = true;
                queueMicrotask(() => {
                    this._peelAfterDragQueued = false;
                    if (this._isHandDragActive()) return;
                    this._checkPeel();
                });
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
                if (this._inReviewExperience?.()) {
                    post('Board is in post-game review — no live crossword to check.');
                    return;
                }
                if (!this._dictReady || !this._checker || !BananaGrid) {
                    post('Dictionary is not loaded yet.');
                    return;
                }
                const tiles = this.tiles || [];
                if (!tiles.length) {
                    post('No tiles on your board.');
                    return;
                }
                const origin = { x: this.ORIGIN, y: this.ORIGIN };
                const layoutOpts = this._rackLayoutOptions?.() || {};
                const lines = [];
                if (this._isHandDragActive()) {
                    lines.push('(Still dragging — positions may change when you release.)');
                }
                if (BananaGrid.isStartingRack(tiles, origin, layoutOpts)) {
                    post('All tiles are still on the starting rack — nothing to check yet.');
                    return;
                }
                const rackBounds = BananaGrid.getRackBounds(
                    origin,
                    layoutOpts.cols,
                    layoutOpts.gap,
                    layoutOpts.tileSize,
                    layoutOpts.handBelowCenter
                );
                const onRack = tiles.filter((t) => BananaGrid.isTileInRack(t, rackBounds, layoutOpts.tileSize));
                if (onRack.length) {
                    lines.push(`${onRack.length} tile(s) still on the rack — place them before peeling.`);
                }
                if (!BananaGrid.eachTileOccupiesUniqueCell(tiles)) {
                    lines.push('Two or more tiles share the same grid cell.');
                }
                const { connected, valid, invalid } = BananaGrid.inspectBoardWords(tiles, this._checker);
                if (!connected) {
                    lines.push('Crossword is disconnected (tiles must form one connected grid).');
                }
                if (!valid.length && !invalid.length) {
                    lines.push('No words of length 2+ on the board yet.');
                }
                if (valid.length) {
                    lines.push(`Valid: ${valid.join(', ')}`);
                }
                if (invalid.length) {
                    lines.push(`Invalid: ${invalid.join(', ')}`);
                }
                const placed = this._allTilesPlacedOn(tiles);
                const hasThree = valid.some((w) => w.length >= 3);
                const crosswordOk = connected && !invalid.length && valid.length && hasThree && placed
                    && BananaGrid.eachTileOccupiesUniqueCell(tiles);
                let summary;
                if (crosswordOk) {
                    if (!this._tilePool?.length) {
                        summary = 'Solved — valid crossword and bunch is empty (win ready).';
                    } else {
                        summary = 'Solved — valid crossword (peel ready).';
                    }
                } else if (!invalid.length && valid.length) {
                    summary = 'All words on the board are valid, but the grid is not peel-ready yet.';
                } else if (invalid.length) {
                    summary = `Invalid word(s): ${invalid.join(', ')}`;
                } else {
                    summary = 'No valid crossword yet.';
                }
                post(summary, lines);
            },

            _checkPeel() {
                if (this._inReviewExperience?.()) return false;
                if (this._winnerUid || this._victoryRegistered) return false;
                if (typeof this._isBoardInReview === 'function' && this._isBoardInReview()) return false;
                if (this._isHandDragActive()) return false;
                if (!this._checker || !BananaGrid) return false;
                if ((this.tiles?.length || 0) < 3) return false;
                if (!this._allTilesPlaced()) return false;
        
                const result = BananaGrid.validateGrid(this.tiles, this._checker);
                if (!result.ok) return false;
                const hasThreeTileWord = (result.words || []).some((w) => String(w || '').length >= 3);
                if (!hasThreeTileWord) return false;
        
                if (this._isMultiplayerMode()) {
                    const me = this._myUid();
                    const partySize = (typeof this._peelPartyUids === 'function'
                        ? this._peelPartyUids(me)
                        : this._getPlayerUids()).filter(Boolean).length || 2;

                    if (this._handQualifiesForBananasWin(this.tiles)) {
                        if (this.isHost()) {
                            if (this._hostBananasForPlayer(me)) return true;
                        } else if (this._mpAuthoritativeBunchLen() === 0) {
                            const ownedSnapshot = (this.tiles || []).map((t) => ({
                                id: t.id,
                                letter: t.letter,
                                faceUp: !!t.faceUp
                            }));
                            this._sendBananaInteraction({
                                type: 'bananas',
                                positions: this._serializePositions(),
                                owned: ownedSnapshot
                            });
                            return true;
                        }
                    }

                    const bunchLen = typeof this._mpAuthoritativeBunchLen === 'function'
                        ? this._mpAuthoritativeBunchLen()
                        : this._tilePool.length;
                    if (bunchLen < partySize) return false;

                    if (this.isHost()) {
                        const ok = this._hostPeelForPlayer(me);
                        if (ok && !this._winnerUid) this._showBanner('Peel!', 2200, { actorUid: me });
                        return ok;
                    }
                    const ownedSnapshot = (this.tiles || []).map((t) => ({
                        id: t.id,
                        letter: t.letter,
                        faceUp: !!t.faceUp
                    }));
                    const positionsSnapshot = this._serializePositions();
                    this._guestApplyOptimisticPeel?.();
                    this._sendBananaInteraction({
                        type: 'peel',
                        positions: positionsSnapshot,
                        owned: ownedSnapshot
                    });
                    // Optimistic tile + banner; host board sync reconciles inventory.
                    this._showBanner('Peel!', 2200, { actorUid: me });
                    return true;
                }
        
                if (!this._tilePool.length) {
                    if (!BananaGrid.eachTileOccupiesUniqueCell(this.tiles)) return false;
                    this._onPlayerWins();
                    return true;
                }
                const drawn = BananaRules.drawFromPool(this._tilePool, 1);
                if (!drawn.length) return false;
                if (!this._applyDrawnLettersToHand(drawn)) return false;
                this._soloDistributionInvariantCheck?.('solo-peel');
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
                    const others = this.tiles.filter((t) => t.id !== tile.id);
                    const snap = BananaGrid.snapTilePosition(tile, others);
                    if (snap.snapped) {
                        tile.x = snap.x;
                        tile.y = snap.y;
                    } else {
                        tile.x = Math.round(tile.x);
                        tile.y = Math.round(tile.y);
                    }
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
                            this._schedulePeelAfterDragRelease();
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
