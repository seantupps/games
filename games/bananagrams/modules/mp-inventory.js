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
                const handById = {};
                (this._loadLocalHand?.() || []).forEach((h) => {
                    handById[h.id] = h;
                });
                (runtimeTiles || []).forEach((t) => {
                    runtimeById[t.id] = t;
                });

                const tileFromOwnedAndRuntime = (o, rt, pos) => ({
                    id: o.id,
                    // Keep runtime letters when merging live tiles — stale board owned can
                    // echo a redeal/shuffle with the same ids but different letters.
                    letter: rt?.letter || o.letter,
                    faceUp: !!(o.faceUp || rt?.faceUp),
                    x: pos.x,
                    y: pos.y
                });
        
                const placed = [];
                const needSpawn = [];
                (owned || []).forEach((o) => {
                    if (dragging && runtimeById[o.id]) {
                        const rt = runtimeById[o.id];
                        if (Number.isFinite(rt.x) && Number.isFinite(rt.y)) {
                            placed.push(tileFromOwnedAndRuntime(o, rt, rt));
                        } else {
                            needSpawn.push(o);
                        }
                        return;
                    }
                    // Prefer current in-memory tile positions over cached layout snapshots.
                    // This avoids full-board translations when a stale layout map lags behind
                    // live drag/snap state during peel/dump inventory updates.
                    if (runtimeById[o.id]) {
                        const rt = runtimeById[o.id];
                        if (Number.isFinite(rt.x) && Number.isFinite(rt.y)) {
                            placed.push(tileFromOwnedAndRuntime(o, rt, rt));
                        } else if (layoutMap[o.id]
                            && Number.isFinite(layoutMap[o.id].x)
                            && Number.isFinite(layoutMap[o.id].y)) {
                            placed.push(tileFromOwnedAndRuntime(o, rt, layoutMap[o.id]));
                        } else {
                            needSpawn.push(o);
                        }
                    } else if (layoutMap[o.id]) {
                        const hand = handById[o.id];
                        placed.push({
                            id: o.id,
                            letter: hand?.letter || o.letter,
                            faceUp: !!(hand?.faceUp ?? o.faceUp),
                            x: layoutMap[o.id].x,
                            y: layoutMap[o.id].y
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
                    // If the viewport allocator is saturated, force-place newly added tiles
                    // in currently visible cells (instead of origin rack, which may be offscreen).
                    const forceVisible = [];
                    const gap = BananaRules.TILE_GAP;
                    const size = BananaRules.TILE_SIZE;
                    const pad = BananaRules.spawnViewportPad();
                    const viewportNow = this._getVisibleWorldBounds();
                    const left = viewportNow.left + pad;
                    const top = viewportNow.top + pad;
                    const right = viewportNow.right - pad - size;
                    const bottom = viewportNow.bottom - pad - size;
                    const minGX = Math.ceil(left / gap) * gap;
                    const maxGX = Math.floor(right / gap) * gap;
                    const minGY = Math.ceil(top / gap) * gap;
                    const maxGY = Math.floor(bottom / gap) * gap;
                    const used = [...placed];
                    const canPlace = (x, y) => {
                        if (x < left || y < top || x + size > viewportNow.right - pad || y + size > viewportNow.bottom - pad) {
                            return false;
                        }
                        for (const t of used) {
                            if (BananaRules.tilesOverlap(x, y, t.x, t.y, size)) return false;
                        }
                        return true;
                    };
                    let cursorY = maxGY;
                    let cursorX = minGX;
                    needSpawn.forEach((o) => {
                        let found = null;
                        for (let y = cursorY; y >= minGY && !found; y -= gap) {
                            for (let x = cursorX; x <= maxGX; x += gap) {
                                if (canPlace(x, y)) {
                                    found = { x, y };
                                    break;
                                }
                            }
                            cursorX = minGX;
                        }
                        if (!found) {
                            for (let y = minGY; y <= maxGY && !found; y += gap) {
                                for (let x = minGX; x <= maxGX; x += gap) {
                                    if (canPlace(x, y)) {
                                        found = { x, y };
                                        break;
                                    }
                                }
                            }
                        }
                        const tile = found
                            ? {
                                id: o.id,
                                letter: o.letter,
                                faceUp: !!o.faceUp,
                                x: found.x,
                                y: found.y
                            }
                            : this._rackTilesFromOwned([o])[0];
                        forceVisible.push(tile);
                        used.push(tile);
                    });
                    if (forceVisible.some((t) => Number.isFinite(t?.x) && Number.isFinite(t?.y))) {
                        console.warn('[Bananagrams] viewport spawn full — forced visible fallback', needSpawn.length);
                    } else {
                        console.warn('[Bananagrams] viewport spawn full — rack fallback', needSpawn.length);
                    }
                    forceVisible.forEach((t) => placed.push(t));
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
                if (!this._mpLastKnownOwned) this._mpLastKnownOwned = {};
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
                if (this._mpOwned[uid].length) {
                    this._mpLastKnownOwned[uid] = this._mpOwned[uid].map((t) => ({ ...t }));
                }
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

            _shouldKeepRuntimeTiles(board, owned) {
                if (board?.gameStarted || this.gameStarted) {
                    return !!(this.tiles?.length);
                }
                const ownedIds = new Set((owned || []).map((o) => o.id));
                if (!ownedIds.size || !this.tiles?.length) return false;
                if (this.tiles.length !== ownedIds.size) return false;
                return this.tiles.every((t) => ownedIds.has(t.id)
                    && Number.isFinite(t.x) && Number.isFinite(t.y));
            },

            _flushDeferredBoardApply() {
                const board = this._mpDeferredBoard;
                if (!board || this._isDraggingHand()) return;
                if (this.gameStarted && !board.gameStarted) {
                    this._mpDeferredBoard = null;
                    return;
                }
                this._mpDeferredBoard = null;
                const uid = this._myUid();
                const owned = board.tilesOwnedByPlayer?.[uid] || [];
                const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                if (inPlay && !owned.length && (this.tiles?.length > 0)) {
                    return;
                }
                if (typeof this._applyMpActionBanners === 'function') {
                    this._applyMpActionBanners(board);
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
                const owned = board.tilesOwnedByPlayer?.[uid]
                    || board.hands?.[uid]
                    || [];
                const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                if (!options.reset && !owned.length && !this.isHost()) {
                    const cachedRec = this._loadLocalHandRecord?.() || { resetCount: null, hand: [] };
                    const epoch = this._layoutEpoch?.() ?? 0;
                    const cached = (cachedRec.resetCount != null && epoch > 0 && cachedRec.resetCount !== epoch)
                        ? []
                        : (cachedRec.hand || []);
                    if (cached.length) {
                        this.tiles = cached.map((t) => ({
                            id: t.id,
                            letter: t.letter,
                            faceUp: !!t.faceUp,
                            x: t.x,
                            y: t.y
                        }));
                        this.started = this.tiles.length > 0;
                        this._persistMpLayout();
                        return true;
                    }
                }
                if (!options.reset && inPlay && !owned.length && (this.tiles?.length > 0)) {
                    return false;
                }
                if (options.reset) this._clearLocalLayout();
                const layout = this._layoutMapForPlayer(board, uid, owned);
                const runtime = (options.keepRuntime || this._shouldKeepRuntimeTiles(board, owned))
                    ? this.tiles
                    : null;
                this.tiles = this._mergeInventoryWithLayout(owned, layout, runtime);
                this.started = this.tiles.length > 0;
                this._localInventorySeq = this._boardInventorySeq(board, uid);
                if (this._shouldPersistMpLayout?.(owned, layout) !== false) {
                    this._persistMpLayout();
                }
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
                const remoteOwned = board.tilesOwnedByPlayer?.[uid]
                    || board.hands?.[uid]
                    || [];
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
                const owned = board.tilesOwnedByPlayer?.[uid]
                    || board.hands?.[uid]
                    || [];
                const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                const ownedChanged = owned.length !== (this.tiles?.length || 0)
                    || owned.some((o) => !runtimeIds.has(o.id));
                if (remote <= (this._localInventorySeq || 0) && !ownedChanged) return false;
                const layout = this._layoutMapForPlayer(board, uid, owned);
                const runtime = this._shouldKeepRuntimeTiles(board, owned) ? this.tiles : null;
                this.tiles = this._mergeInventoryWithLayout(owned, layout, runtime);
                this._localInventorySeq = remote;
                if (this._shouldPersistMpLayout?.(owned, layout) !== false) {
                    this._persistMpLayout();
                }
                return true;
            },

            _applyMpInventoryFromBoard(board, uid, options = {}) {
                if (this._mpAwaitReset && board && !this._isFreshPostResetBoard?.(board)) {
                    return false;
                }
                if (!options.force && !options.reset && this._isDraggingHand()) {
                    const incomingPeel = board?.peelSeq || 0;
                    const incomingDump = board?.dumpSeq || 0;
                    const urgentInventoryEvent = incomingPeel > (this._lastPeelSeq || 0)
                        || incomingDump > (this._lastDumpSeq || 0);
                    if (urgentInventoryEvent) {
                        // Peel/dump spawns should feel instant on observers even during short
                        // drag debounce windows; apply now instead of deferring ~500ms.
                    } else if (this.gameStarted && board && !board.gameStarted) {
                        return false;
                    } else {
                    this._mpDeferredBoard = board;
                    return false;
                    }
                }
                if (!options.force && !options.reset && this.gameStarted && board && !board.gameStarted) {
                    return false;
                }
                // Guest: ignore duplicate reset-class applies once a hand is visible.
                if (options.reset && !this.isHost?.() && (this.tiles?.length || 0) > 0) {
                    const ownedCheck = board.tilesOwnedByPlayer?.[uid]
                        || board.hands?.[uid]
                        || [];
                    const lettersWouldShuffle = ownedCheck.some((o) => {
                        const rt = this.tiles.find((t) => t.id === o.id);
                        return rt && rt.letter !== o.letter;
                    });
                    if (this.gameStarted || board?.gameStarted || lettersWouldShuffle) {
                        return false;
                    }
                    options = { ...options, reset: false, force: false };
                }
                let layoutChanged = false;
                if (options.reset || options.force) {
                    const hadTiles = (this.tiles?.length || 0) > 0;
                    const ownedForce = board.tilesOwnedByPlayer?.[uid]
                        || board.hands?.[uid]
                        || [];
                    const inPlayForce = !!(this.gameStarted || board.gameStarted || this.started);
                    if (options.force && !options.reset && inPlayForce
                        && !ownedForce.length && (this.tiles?.length > 0)) {
                        return false;
                    }
                    if (this._rebuildHandFromBoard(board, {
                        ...options,
                        reset: options.reset,
                        // Force-applies during active play should preserve live runtime tiles
                        // to prevent full-board translations on peel/dump sync.
                        keepRuntime: !options.reset && this._shouldKeepRuntimeTiles(board, ownedForce)
                    })) {
                        layoutChanged = true;
                        this._mpAwaitReset = false;
                        // Default rack framing on true resets (same as refresh / hub re-click).
                        if (options.reset || (options.force && !hadTiles && (this.tiles?.length || 0) > 0)) {
                            if (typeof this._applyDefaultPlayingViewport === 'function') {
                                this._applyDefaultPlayingViewport();
                            } else {
                                this.centerViewOnOrigin();
                            }
                        }
                    }
                } else {
                    const remote = this._boardInventorySeq(board, uid);
                    const owned = board.tilesOwnedByPlayer?.[uid]
                        || board.hands?.[uid]
                        || [];
                    const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                    if (!options.reset && !options.force && inPlay
                        && !owned.length && (this.tiles?.length > 0)) {
                        return false;
                    }
                    const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                    const ownedChanged = owned.length !== (this.tiles?.length || 0)
                        || owned.some((o) => !runtimeIds.has(o.id));
                    const ownedLettersChanged = !ownedChanged && (this.tiles || []).length
                        && owned.some((o) => {
                            const rt = (this.tiles || []).find((t) => t.id === o.id);
                            return rt && rt.letter !== o.letter;
                        });
                    const localSeq = this._localInventorySeq || 0;
                    if (this.isHost?.() && remote < localSeq) return false;
                    if (this.isHost?.() && remote === localSeq && ownedChanged) return false;
                    if (ownedLettersChanged && this._shouldKeepRuntimeTiles(board, owned)) {
                        if (!this._hasSavedLocalLayoutForOwned?.(owned)) {
                            return false;
                        }
                    }
                    if (remote > localSeq || ownedChanged) {
                        const layout = this._layoutMapForPlayer(board, uid, owned);
                        const runtime = this._shouldKeepRuntimeTiles(board, owned) ? this.tiles : null;
                        this.tiles = this._mergeInventoryWithLayout(owned, layout, runtime);
                        this._localInventorySeq = remote;
                        if (this._shouldPersistMpLayout?.(owned, layout) !== false) {
                            this._persistMpLayout();
                        }
                        layoutChanged = true;
                    }
                    if (!this.tiles.length && (board.tilesOwnedByPlayer?.[uid]?.length || board.hands?.[uid]?.length)) {
                        this._rebuildHandFromBoard(board, {});
                        layoutChanged = true;
                        this._mpAwaitReset = false;
                    }
                }
                return layoutChanged;
            }
    });
})(typeof window !== 'undefined' ? window : global);
