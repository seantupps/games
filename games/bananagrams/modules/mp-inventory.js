/** Bananagrams — mp-inventory (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-inventory.js');
    Object.assign(G.prototype, {
            _cloneTiles(tiles) {
                return (tiles || []).map((t) => ({ ...t }));
            },

            _splitTiles(tiles) {
                const owned = (tiles || []).map((t) => ({
                    id: t.id,
                    letter: t.letter,
                    faceUp: !!t.faceUp
                }));
                const positions = {};
                (tiles || []).forEach((t) => {
                    if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
                        positions[t.id] = { x: t.x, y: t.y };
                    }
                });
                return { owned, positions };
            },

            _mergeInventoryWithLayout(owned, layout, runtimeTiles) {
                if (!owned?.length) {
                    if (runtimeTiles?.length) {
                        return runtimeTiles.map((t) => ({
                            id: t.id,
                            letter: t.letter,
                            faceUp: !!t.faceUp,
                            x: t.x,
                            y: t.y
                        }));
                    }
                    return [];
                }
                const layoutMap = layout || {};
                const runtimeById = {};
                const dragging = this._isDraggingHand();
                (runtimeTiles || []).forEach((t) => {
                    runtimeById[t.id] = t;
                });
        
                const placed = [];
                const needSpawn = [];
                (owned || []).forEach((o) => {
                    if (dragging && runtimeById[o.id]) {
                        const rt = runtimeById[o.id];
                        placed.push({
                            id: o.id,
                            letter: o.letter,
                            faceUp: !!o.faceUp,
                            x: rt.x,
                            y: rt.y
                        });
                        return;
                    }
                    if (layoutMap[o.id]) {
                        placed.push({
                            id: o.id,
                            letter: o.letter,
                            faceUp: !!o.faceUp,
                            x: layoutMap[o.id].x,
                            y: layoutMap[o.id].y
                        });
                    } else if (runtimeById[o.id]) {
                        const rt = runtimeById[o.id];
                        placed.push({
                            id: o.id,
                            letter: o.letter,
                            faceUp: !!o.faceUp,
                            x: rt.x,
                            y: rt.y
                        });
                    } else {
                        needSpawn.push(o);
                    }
                });
        
                if (!needSpawn.length) return placed;
        
                if (needSpawn.length === (owned || []).length) {
                    return this._rackTilesFromOwned(owned);
                }
        
                if (typeof BananaRules === 'undefined') return placed;
        
                const letters = needSpawn.map((o) => o.letter);
                const viewport = this._getVisibleWorldBounds();
                const visOpts = { visibilityBounds: viewport };
                const bounds = BananaRules.spawnEffectiveBounds(placed, viewport);
                let spots = BananaRules.spawnAllocateSlots(placed, letters, bounds, visOpts);
                if (!spots || spots.length !== needSpawn.length) {
                    spots = BananaRules.spawnAllocateSlots(placed, letters, viewport, visOpts);
                }
                if (!spots || spots.length !== needSpawn.length) {
                    const cluster = BananaRules.spawnClusterBounds(placed);
                    if (cluster) {
                        spots = BananaRules.spawnAllocateSlots(
                            placed,
                            letters,
                            BananaRules.intersectBounds(cluster, viewport),
                            visOpts
                        );
                    }
                }
                if (spots && spots.length === needSpawn.length) {
                    needSpawn.forEach((o, i) => {
                        placed.push({
                            id: o.id,
                            letter: o.letter,
                            faceUp: !!o.faceUp,
                            x: spots[i].x,
                            y: spots[i].y
                        });
                    });
                } else {
                    console.warn('[Bananagrams] viewport spawn full — rack fallback', needSpawn.length);
                    this._rackTilesFromOwned(needSpawn).forEach((t) => placed.push(t));
                }
                return placed;
            },

            _handFromOwnedAndPositions(uid, positions) {
                return (positions || []).map((p) => {
                    const o = this._mpOwned?.[uid]?.find((t) => t.id === p.id);
                    return {
                        id: p.id,
                        letter: o?.letter || '?',
                        x: p.x,
                        y: p.y,
                        faceUp: o?.faceUp ?? true
                    };
                });
            },

            _hostEnsureMpStores() {
                if (!this._mpOwned) this._mpOwned = {};
                if (!this._mpInventorySeq) this._mpInventorySeq = {};
            },

            _hostBumpInventorySeq(uid) {
                this._hostEnsureMpStores();
                this._mpInventorySeq[uid] = (this._mpInventorySeq[uid] || 0) + 1;
            },

            _hostSetOwned(uid, owned, bumpInventory = true) {
                this._hostEnsureMpStores();
                this._mpOwned[uid] = (owned || []).map((t) => ({
                    id: t.id,
                    letter: t.letter,
                    faceUp: !!t.faceUp
                }));
                if (bumpInventory) this._hostBumpInventorySeq(uid);
            },

            /** Restore one player's host inventory from RTDB when local _mpOwned was lost. */
            _hostHydrateOwnedFromBoard(uid) {
                if (!this.isHost() || !uid) return false;
                if (this._mpOwned?.[uid]?.length) return true;
                const board = this._mpBoardFromRoom(this.roomData);
                const remote = board?.tilesOwnedByPlayer?.[uid];
                if (!Array.isArray(remote) || !remote.length) return false;
                this._hostSetOwned(uid, remote, false);
                return true;
            },

            _hostSetPlayerTiles(uid, tiles, bumpInventory = true) {
                const { owned, positions } = this._splitTiles(tiles);
                this._hostSetOwned(uid, owned, bumpInventory);
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                this._mpPlayerLayouts[uid] = positions;
                if (uid === this._myUid()) {
                    this.tiles = this._mergeInventoryWithLayout(owned, positions, null);
                }
            },

            _markLocalDrag() {
                this._localDragUntil = Date.now() + 500;
                if (this._deferredFlushTimer) {
                    clearTimeout(this._deferredFlushTimer);
                }
                this._deferredFlushTimer = setTimeout(() => {
                    this._deferredFlushTimer = 0;
                    this._flushDeferredBoardApply();
                }, 520);
            },

            _isDraggingHand() {
                return this.isDragging || Date.now() < this._localDragUntil;
            },

            _flushDeferredBoardApply() {
                const board = this._mpDeferredBoard;
                if (!board || this._isDraggingHand()) return;
                this._mpDeferredBoard = null;
                const uid = this._myUid();
                const owned = board.tilesOwnedByPlayer?.[uid] || [];
                const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                if (inPlay && !owned.length && (this.tiles?.length > 0)) {
                    return;
                }
                if (this._applyMpInventoryFromBoard(board, uid, { force: true })) {
                    this.requestRender();
                    this._syncViewportAfterLayout();
                }
            },

            _serializePositions(tiles = this.tiles) {
                return tiles.map((t) => ({ id: t.id, x: t.x, y: t.y }));
            },

            _rebuildHandFromBoard(board, options = {}) {
                const uid = this._myUid();
                const owned = board.tilesOwnedByPlayer?.[uid] || [];
                const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                if (!options.reset && inPlay && !owned.length && (this.tiles?.length > 0)) {
                    return false;
                }
                if (options.reset) this._clearLocalLayout();
                const layout = this._layoutMapForPlayer(board, uid, owned);
                const runtime = options.keepRuntime ? this.tiles : null;
                this.tiles = this._mergeInventoryWithLayout(owned, layout, runtime);
                this.started = this.tiles.length > 0;
                this._localInventorySeq = this._boardInventorySeq(board, uid);
                this._persistMpLayout();
                return true;
            },

            _rebuildTilesFromInventory(board, uid, options = {}) {
                return this._rebuildHandFromBoard(board, options);
            },

            _mirrorHostInventoryFromBoard(board) {
                if (!this.isHost() || !board) return;
                this._hostEnsureMpStores();
                // Host is authoritative for _mpOwned; RTDB echoes can be partial — merge in, never
                // wipe players missing from a stale board snapshot.
                if (board.tilesOwnedByPlayer) {
                    Object.entries(board.tilesOwnedByPlayer).forEach(([playerUid, owned]) => {
                        if (Array.isArray(owned) && owned.length) {
                            this._mpOwned[playerUid] = owned.map((t) => ({
                                id: t.id,
                                letter: t.letter,
                                faceUp: !!t.faceUp
                            }));
                        }
                    });
                }
                if (board.inventorySeq) {
                    Object.entries(board.inventorySeq).forEach(([playerUid, seq]) => {
                        if (typeof seq === 'number') this._mpInventorySeq[playerUid] = seq;
                    });
                }
                if (board.tilePositionsByPlayer) {
                    if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                    Object.entries(board.tilePositionsByPlayer).forEach(([playerUid, list]) => {
                        if (!Array.isArray(list)) return;
                        this._mpPlayerLayouts[playerUid] = this._positionsMapFromList(list);
                    });
                }
            },

            _applyRemoteInventory(board, uid, options = {}) {
                if (this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW && !options.reset) {
                    return false;
                }
                const remoteOwned = board.tilesOwnedByPlayer?.[uid] || [];
                const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                if (!options.reset && !options.force && inPlay
                    && !remoteOwned.length && (this.tiles?.length > 0)) {
                    return false;
                }
                if (options.force || options.reset) {
                    this._rebuildHandFromBoard(board, options);
                    return true;
                }
                const remote = this._boardInventorySeq(board, uid);
                const owned = board.tilesOwnedByPlayer?.[uid] || [];
                const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                const ownedChanged = owned.length !== (this.tiles?.length || 0)
                    || owned.some((o) => !runtimeIds.has(o.id));
                if (remote <= (this._localInventorySeq || 0) && !ownedChanged) return false;
                const layout = this._layoutMapForPlayer(board, uid, owned);
                this.tiles = this._mergeInventoryWithLayout(owned, layout, this.tiles);
                this._localInventorySeq = remote;
                this._persistMpLayout();
                return true;
            },

            _applyMpInventoryFromBoard(board, uid, options = {}) {
                if (!options.force && !options.reset && this._isDraggingHand()) {
                    this._mpDeferredBoard = board;
                    return false;
                }
                let layoutChanged = false;
                if (options.reset || options.force) {
                    const ownedForce = board.tilesOwnedByPlayer?.[uid] || [];
                    const inPlayForce = !!(this.gameStarted || board.gameStarted || this.started);
                    if (options.force && !options.reset && inPlayForce
                        && !ownedForce.length && (this.tiles?.length > 0)) {
                        return false;
                    }
                    if (this._rebuildHandFromBoard(board, { ...options, reset: options.reset })) {
                        layoutChanged = true;
                        this._mpAwaitReset = false;
                        if (options.force) this.centerViewOnOrigin();
                    }
                } else {
                    const remote = this._boardInventorySeq(board, uid);
                    const owned = board.tilesOwnedByPlayer?.[uid] || [];
                    const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                    if (!options.reset && !options.force && inPlay
                        && !owned.length && (this.tiles?.length > 0)) {
                        return false;
                    }
                    const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                    const ownedChanged = owned.length !== (this.tiles?.length || 0)
                        || owned.some((o) => !runtimeIds.has(o.id));
                    const localSeq = this._localInventorySeq || 0;
                    if (this.isHost?.() && remote < localSeq) return false;
                    if (this.isHost?.() && remote === localSeq && ownedChanged) return false;
                    if (remote > localSeq || ownedChanged) {
                        const layout = this._layoutMapForPlayer(board, uid, owned);
                        this.tiles = this._mergeInventoryWithLayout(owned, layout, this.tiles);
                        this._localInventorySeq = remote;
                        this._persistMpLayout();
                        layoutChanged = true;
                    }
                    if (!this.tiles.length && board.tilesOwnedByPlayer?.[uid]?.length) {
                        this._rebuildHandFromBoard(board, {});
                        layoutChanged = true;
                        this._mpAwaitReset = false;
                    }
                }
                return layoutChanged;
            }
    });
})(typeof window !== 'undefined' ? window : global);
