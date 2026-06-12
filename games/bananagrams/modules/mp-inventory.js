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

            _boardInventorySeq(board, uid) {
                return board?.inventorySeq?.[uid] ?? 0;
            },

            /** Host: prefer live _mpOwned when board echo lags (partial RTDB merge). */
            _mpOwnedForInventoryApply(board, uid) {
                const fromBoard = this._mpNormalizeBoardOwned?.(
                    board?.tilesOwnedByPlayer?.[uid] || board?.hands?.[uid]
                ) || [];
                if (!this.isHost?.() || !uid) return fromBoard;
                this._hostEnsureMpStores?.();
                const local = this._mpNormalizeBoardOwned?.(this._mpOwned?.[uid])
                    || (this._mpOwned?.[uid] || []);
                if (!local.length) return fromBoard;
                if (!fromBoard.length) return local;
                const localSeq = this._mpInventorySeq?.[uid] || 0;
                const boardSeq = this._boardInventorySeq(board, uid);
                if (localSeq > boardSeq) return local;
                if (local.length > fromBoard.length) return local;
                return fromBoard;
            },

            _ownedMembershipDrift(board, uid, owned = null) {
                const list = owned
                    || this._mpNormalizeBoardOwned?.(
                        board?.tilesOwnedByPlayer?.[uid] || board?.hands?.[uid]
                    )
                    || [];
                if (!list.length || !(this.tiles || []).length) return false;
                const ownedIds = new Set(list.map((o) => o.id));
                const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                if (ownedIds.size !== runtimeIds.size) return true;
                return list.some((o) => !runtimeIds.has(o.id));
            },

            _finishMergedHand(placed, owned) {
                let hand = placed;
                if (BananaGrid?.resolveHandPositions && !this._isDraggingHand?.()) {
                    hand = BananaGrid.resolveHandPositions(placed);
                }
                const hydrated = this._mpHydrateTiles?.(hand) || hand;
                const want = (owned || []).length;
                if (want && hydrated.length !== want) {
                    return this._rackTilesFromOwned(owned);
                }
                return hydrated;
            },

            _mergeInventoryWithLayout(owned, layout, runtimeTiles, mergeOpts = {}) {
                if (this._isDraggingHand?.()) {
                    this._syncLiveDragTilesFromDom?.();
                }
                if (!this.isHost?.() && this._guestDumpHandFloor != null
                    && (owned?.length || 0) < this._guestDumpHandFloor) {
                    const keep = (runtimeTiles?.length ? runtimeTiles : this.tiles) || [];
                    if (keep.length >= this._guestDumpHandFloor) return keep;
                }
                const forceLayoutIds = mergeOpts.forceLayoutIds;
                const tileLetter = (id) => {
                    if (this._mpPoolUsesTileIds?.()) return this._mpLetter(id) || '';
                    return '';
                };
                if (!owned?.length) {
                    if (this._isMultiplayerMode?.()) return [];
                    if (runtimeTiles?.length) {
                        return this._finishMergedHand(
                            runtimeTiles.map((t) => ({
                                id: t.id,
                                letter: t.letter,
                                faceUp: !!t.faceUp,
                                x: t.x,
                                y: t.y
                            })),
                            []
                        );
                    }
                    return [];
                }
                const layoutMap = layout || {};
                const runtimeById = {};
                const dragging = this._isDraggingHand();
                const draggingIds = this._getDraggingTileIds?.() || new Set();
                const handById = {};
                (this._loadLocalHand?.() || []).forEach((h) => {
                    handById[h.id] = h;
                });
                (runtimeTiles || []).forEach((t) => {
                    runtimeById[t.id] = t;
                });
                if (this._isDraggingHand?.() && !runtimeTiles?.length && this.tiles?.length) {
                    this.tiles.forEach((t) => {
                        runtimeById[t.id] = t;
                    });
                }

                const tileFromOwnedAndRuntime = (o, rt, pos) => {
                    if (rt) {
                        rt.letter = tileLetter(o.id);
                        rt.faceUp = !!(o.faceUp || rt.faceUp);
                        rt.x = pos.x;
                        rt.y = pos.y;
                        return rt;
                    }
                    return {
                        id: o.id,
                        letter: tileLetter(o.id),
                        faceUp: !!o.faceUp,
                        x: pos.x,
                        y: pos.y
                    };
                };
        
                const placed = [];
                const needSpawn = [];
                (owned || []).forEach((o) => {
                    // Dump draws (incl. same-id pool redraw) must leave the hold spot — never keep drag coords.
                    if (forceLayoutIds?.has(o.id)) {
                        if (layoutMap[o.id]
                            && Number.isFinite(layoutMap[o.id].x)
                            && Number.isFinite(layoutMap[o.id].y)) {
                            placed.push(tileFromOwnedAndRuntime(o, runtimeById[o.id], layoutMap[o.id]));
                        } else {
                            needSpawn.push(o);
                        }
                        return;
                    }
                    if ((dragging || draggingIds.has(o.id)) && runtimeById[o.id]) {
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
                            letter: tileLetter(o.id),
                            faceUp: !!(hand?.faceUp ?? o.faceUp),
                            x: layoutMap[o.id].x,
                            y: layoutMap[o.id].y
                        });
                    } else {
                        needSpawn.push(o);
                    }
                });
        
                if (!needSpawn.length) return this._finishMergedHand(placed, owned);
        
                if (needSpawn.length === (owned || []).length) {
                    return this._finishMergedHand(this._rackTilesFromOwned(owned), owned);
                }
        
                if (typeof BananaRules === 'undefined') {
                    return this._finishMergedHand(this._rackTilesFromOwned(owned), owned);
                }
        
                const letters = needSpawn.map((o) => tileLetter(o.id));
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
                            letter: tileLetter(o.id),
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
                                letter: tileLetter(o.id),
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
                return this._finishMergedHand(placed, owned);
            },

            _handFromOwnedAndPositions(uid, positions) {
                const hand = (positions || []).map((p) => {
                    const o = this._mpOwned?.[uid]?.find((t) => t.id === p.id);
                    return {
                        id: p.id,
                        letter: this._mpLetter?.(p.id) || '?',
                        x: p.x,
                        y: p.y,
                        faceUp: o?.faceUp ?? true
                    };
                });
                if (typeof this._snapHandForValidation === 'function') {
                    return this._snapHandForValidation(hand);
                }
                return hand;
            },

            _hostRepairOwnedFromCanonical(context = 'repair-owned-canonical') {
                if (!this.isHost?.()) return;
                this._hostEnsureMpStores();
                Object.keys(this._mpOwned || {}).forEach((uid) => {
                    const list = this._mpOwned[uid];
                    if (!Array.isArray(list)) return;
                    this._mpOwned[uid] = list.map((t) => this._mpStripOwnedEntry(t)).filter(Boolean);
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

            _hostSetOwned(uid, owned, bumpInventory = true, meta = {}) {
                this._hostEnsureMpStores();
                const source = meta.source || 'unknown';
                const action = meta.action || this._mpTraceParseAction?.(meta.ctx || source) || 'sync';
                const ctx = meta.ctx || `host-set-owned:${uid}`;
                const incoming = owned || [];
                const prev = this._mpOwned?.[uid] || [];
                if (this.isHost?.() && uid !== this._myUid?.() && incoming.length < prev.length
                    && meta.msgType === 'dump') {
                    console.warn('[HOST_SET_OWNED] guest dump snapshot shorter than host owned', {
                        player: String(uid).slice(-14),
                        incoming: incoming.length,
                        prev: prev.length
                    });
                }
                if (this.isHost?.() && uid !== this._myUid?.()) {
                    const bad = (owned || []).filter((t) => {
                        const c = this._mpCanonicalById?.[t.id];
                        const observed = this._mpNormLetter(t.letter);
                        return c && observed && /^[A-Z]$/.test(observed) && observed !== c;
                    });
                    if (bad.length) {
                        console.error('[HOST_SET_OWNED]', {
                            player: String(uid).slice(-14),
                            source,
                            action,
                            msgType: meta.msgType || null,
                            n: (owned || []).length,
                            drift: bad.slice(0, 4).map((t) => `${t.id}:${t.letter}≠${this._mpCanonicalById[t.id]}`)
                        });
                    }
                }
                (owned || []).forEach((t) => {
                    this.traceTileLetter?.({
                        ctx,
                        playerId: uid,
                        tileId: t.id,
                        observedLetter: t.letter || this._mpLetter?.(t.id),
                        canonicalLetter: this._mpCanonicalById?.[t.id],
                        source,
                        round: this._mpTraceRound?.()
                    });
                });
                const normalized = this._mpIngressNormalizeOwned?.(owned, ctx, {
                    source,
                    playerId: uid,
                    registerIfMissing: meta.registerIfMissing === true
                }) || owned;
                this._mpOwned[uid] = normalized;
                if (bumpInventory) this._hostBumpInventorySeq(uid);
                this._hostRepairOwnedFromCanonical?.(`after-set-owned:${uid}`);
            },

            /** Restore one player's host inventory from RTDB when local _mpOwned was lost. */
            _hostHydrateOwnedFromBoard(uid) {
                if (!this.isHost() || !uid) return false;
                if (this._mpOwned?.[uid]?.length) return true;
                if (typeof this._isRecentProgrammaticReset === 'function'
                    && this._isRecentProgrammaticReset()) {
                    return false;
                }
                const board = this._mpBoardFromRoom(this.roomData);
                const remote = board?.tilesOwnedByPlayer?.[uid];
                if (!Array.isArray(remote) || !remote.length) return false;
                if (this._mpIdPoolActive) {
                    remote.forEach((t) => {
                        if (t?.id) this._mpAssertIdDealEpoch?.(t.id, `hydrate-board:${uid}`);
                    });
                }
                this._hostSetOwned(uid, remote, false, {
                    source: 'rtdb',
                    action: 'sync',
                    ctx: `host-set-owned:${uid}`,
                    msgType: 'hydrate-board'
                });
                return true;
            },

            _hostSetPlayerTiles(uid, tiles, bumpInventory = true, meta = {}) {
                if (this._isMultiplayerMode?.() && !meta.allowTilesToOwned) {
                    throw new Error('[MP] _hostSetPlayerTiles forbidden — update layout only, not membership');
                }
                const { owned, positions } = this._splitTiles(tiles);
                if (meta.allowTilesToOwned && this.isHost?.() && this._mpPoolIsIdBased?.()) {
                    const prevOwned = this._mpOwned?.[uid] || [];
                    const nextIds = new Set(owned.map((t) => t.id));
                    prevOwned.forEach((t) => {
                        if (!t?.id || nextIds.has(t.id)) return;
                        this._mpAssertIdDealEpoch?.(t.id, 'evict-to-pool');
                        this._tilePool.push(t.id);
                    });
                }
                this._hostSetOwned(uid, owned, bumpInventory, meta);
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                this._mpPlayerLayouts[uid] = positions;
                if (uid === this._myUid()) {
                    this.tiles = this._mergeInventoryWithLayout(owned, positions, null);
                    this.tiles = this._mpHydrateTiles?.(this.tiles) || this.tiles;
                }
            },

            _markLocalDrag() {
                if (this._deferredFlushTimer) {
                    clearTimeout(this._deferredFlushTimer);
                    this._deferredFlushTimer = 0;
                }
            },

            _endLocalDragSession() {
                if (this._deferredFlushTimer) {
                    clearTimeout(this._deferredFlushTimer);
                }
                this._deferredFlushTimer = setTimeout(() => {
                    this._deferredFlushTimer = 0;
                    this._flushDeferredBoardApply?.();
                }, 0);
            },

            _getDraggingTileIds() {
                const surface = document.querySelector('.board-pan-layer');
                if (!surface) return new Set();
                return new Set(
                    [...surface.querySelectorAll('.tile.is-dragging')]
                        .map((el) => el.dataset.tileId)
                        .filter(Boolean)
                );
            },

            /** Copy world coords from live drag DOM into `this.tiles` before inventory merge. */
            _syncLiveDragTilesFromDom() {
                const surface = document.querySelector('.board-pan-layer');
                if (!surface || !this.tiles?.length) return;
                const dragging = surface.querySelectorAll('.tile.is-dragging');
                if (!dragging.length) return;
                dragging.forEach((el) => {
                    const id = el.dataset.tileId;
                    const tile = this.tiles.find((t) => t.id === id);
                    if (!tile) return;
                    const face = el.querySelector('.tile-face');
                    const faceLeft = face ? parseFloat(face.style.left) || 0 : 0;
                    const faceTop = face ? parseFloat(face.style.top) || 0 : 0;
                    const left = parseFloat(el.style.left);
                    const top = parseFloat(el.style.top);
                    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
                    tile.x = Math.round(left + faceLeft);
                    tile.y = Math.round(top + faceTop);
                });
            },

            _clearLocalDragAfterDump() {
                this.isDragging = false;
                this._pointerDragging = false;
            },

            _isDraggingHand() {
                return !!(this._pointerDragging || this.isDragging);
            },

            /** Dump draw ids: newly owned + same id redrawn from pool after dump. */
            _dumpDrawForceLayoutIds(preTiles, owned) {
                const ownedList = owned || [];
                const prevIds = new Set((preTiles || []).map((t) => t.id));
                const ownedIdSet = new Set(ownedList.map((o) => o.id));
                const newDrawIds = ownedList.filter((o) => !prevIds.has(o.id)).map((o) => o.id);
                const drawIds = new Set(newDrawIds);
                const pendingId = this._guestPendingDumpTile?.id
                    || this._guestOptimisticDumpRemovedId;
                if (pendingId && ownedIdSet.has(pendingId)) drawIds.add(pendingId);
                return drawIds;
            },

            /**
             * Guest: place dump draws in this client's visible viewport (ignore host board coords).
             * Host inventory is authoritative; display positions for dump draws are guest-local.
             */
            _guestPlaceDumpDrawsInViewport(drawIds) {
                if (this.isHost?.() || !drawIds?.size || typeof BananaRules === 'undefined') {
                    return false;
                }
                const drawTiles = (this.tiles || []).filter((t) => drawIds.has(t.id));
                if (!drawTiles.length) return false;
                const anchor = (this.tiles || []).filter(
                    (t) => !drawIds.has(t.id) && Number.isFinite(t.x) && Number.isFinite(t.y)
                );
                const letters = drawTiles.map((t) => t.letter);
                let spots = typeof this._planDrawnTileSpots === 'function'
                    ? this._planDrawnTileSpots(anchor, letters)
                    : null;
                const hold = this._guestPendingDumpTile
                    || this._guestPreDumpSnapshot?.find(
                        (p) => p.id === this._guestOptimisticDumpRemovedId
                    )
                    || null;
                const size = BananaRules.TILE_SIZE || 40;
                const gap = BananaRules.TILE_GAP || 8;
                const minDist = size + gap;
                if (hold && Number.isFinite(hold.x) && spots?.length === drawTiles.length) {
                    spots = spots.map((spot, i) => {
                        if (Math.hypot(spot.x - hold.x, spot.y - hold.y) < minDist) {
                            return {
                                x: hold.x + minDist * 2,
                                y: hold.y + i * size
                            };
                        }
                        return spot;
                    });
                }
                const viewport = this._getVisibleWorldBounds();
                if (!spots || spots.length !== drawTiles.length
                    || !BananaRules.spawnSpotsInViewport(spots, viewport)) {
                    const forced = BananaRules.spawnForceVisibleSlots(anchor, letters, viewport);
                    if (forced?.length === drawTiles.length) {
                        spots = forced;
                    }
                }
                const byId = {};
                drawTiles.forEach((t, i) => { byId[t.id] = spots[i]; });
                this.tiles = (this.tiles || []).map((t) => {
                    const spot = byId[t.id];
                    return spot ? { ...t, x: spot.x, y: spot.y } : t;
                });
                drawTiles.forEach((t) => this._purgeLocalLayoutIds?.([t.id]));
                return true;
            },

            _guestLockDumpSpawnPositions(drawIds, dumpSeq) {
                if (!drawIds?.size || !dumpSeq) return;
                const byId = {};
                (this.tiles || []).forEach((t) => {
                    if (drawIds.has(t.id) && Number.isFinite(t.x) && Number.isFinite(t.y)) {
                        byId[t.id] = { x: t.x, y: t.y };
                    }
                });
                this._guestDumpSpawnLock = { seq: dumpSeq, byId };
            },

            /** Prevent board echo / layout cache from jittering dump draws after first placement. */
            _guestRestoreDumpSpawnLock() {
                const lock = this._guestDumpSpawnLock;
                if (!lock?.byId || !Object.keys(lock.byId).length) return false;
                let changed = false;
                this.tiles = (this.tiles || []).map((t) => {
                    const pos = lock.byId[t.id];
                    if (!pos) return t;
                    if (t.x === pos.x && t.y === pos.y) return t;
                    changed = true;
                    return { ...t, x: pos.x, y: pos.y };
                });
                return changed;
            },

            /** Drop stale pre/post-dump board echoes while guest dump is in flight or just applied (LAN RTDB lag). */
            _guestIsStalePreDumpBoard(board, owned, uid) {
                if (this.isHost?.()) return false;
                const ownedList = owned || [];
                const ownedLen = ownedList.length;
                const dumpSeqNow = board?.dumpSeq || 0;
                const lastLayout = this._lastGuestDumpLayoutSeq || 0;
                const ownDump = board?.dumpActorUid === uid;

                const pendingId = this._guestPendingDumpTile?.id;
                if (pendingId) {
                    const sentAt = this._guestDumpSeqAtSend ?? 0;
                    if (dumpSeqNow > sentAt && ownDump) return false;
                    if (ownedList.some((o) => o.id === pendingId)) return true;
                }

                const baseline = this._guestDumpBaselineOwnedCount;
                if (baseline != null && ownDump && dumpSeqNow >= lastLayout) {
                    const localCount = this.tiles?.length || 0;
                    const expectedAfter = baseline + 2;
                    if (ownedLen === baseline && localCount >= expectedAfter) return true;

                    const baselineIds = this._guestDumpBaselineIds;
                    if (baselineIds?.size && ownedLen === baselineIds.size) {
                        const ownedSet = new Set(ownedList.map((o) => o.id));
                        if ([...baselineIds].every((id) => ownedSet.has(id))) return true;
                    }
                }

                return false;
            },

            /** Guest: reject board inventory that would drop locked dump spawns or rewind pre-dump hand. */
            _guestShouldRejectDumpInventoryApply(board, owned, uid) {
                if (this.isHost?.()) return false;

                const ownedList = owned || [];
                const localCount = this.tiles?.length || 0;
                const dumpSeqNow = board?.dumpSeq || 0;
                const lastLayout = this._lastGuestDumpLayoutSeq || 0;
                const ownDump = board?.dumpActorUid === uid;

                if (this._guestIsStalePreDumpBoard(board, ownedList, uid)) return true;

                const handFloor = this._guestDumpHandFloor;
                if (handFloor != null && ownedList.length < handFloor
                    && (this.tiles?.length || 0) >= handFloor) {
                    return true;
                }

                if (ownDump && lastLayout > 0 && dumpSeqNow >= lastLayout && ownedList.length < localCount) {
                    return true;
                }

                const lock = this._guestDumpSpawnLock;
                if (lock?.seq === dumpSeqNow && lock?.byId) {
                    const ownedSet = new Set(ownedList.map((o) => o.id));
                    for (const id of Object.keys(lock.byId)) {
                        if ((this.tiles || []).some((t) => t.id === id) && !ownedSet.has(id)) return true;
                    }
                }

                return false;
            },

            _guestSyncBoardOwnedFromLocal(uid) {
                const board = this.roomData?.global?.board;
                if (!board || !uid) return;
                const owned = (this.tiles || []).map((t) => ({ id: t.id, faceUp: !!t.faceUp }));
                if (!board.tilesOwnedByPlayer) board.tilesOwnedByPlayer = {};
                board.tilesOwnedByPlayer[uid] = owned;
                if (board.hands) board.hands[uid] = owned;
            },

            _guestStripLockedDumpDrawsFromLayout(layout, dumpSeq) {
                const lock = this._guestDumpSpawnLock;
                if (!layout || lock?.seq !== dumpSeq || !lock?.byId) return layout;
                const next = { ...layout };
                Object.keys(lock.byId).forEach((id) => { delete next[id]; });
                return next;
            },

            /** Host: mirror _mpOwned onto live tiles immediately after peel/dump inventory commit. */
            _hostApplyLocalOwnedToTiles(uid, removedTileId = null, drawnIds = null, preDumpTiles = null) {
                if (!this.isHost?.() || uid !== this._myUid()) return;
                if (!this.canMutatePlayingBoard?.()) return;
                this._hostEnsureMpStores();
                if (this._isDraggingHand?.()) {
                    this._syncLiveDragTilesFromDom?.();
                }
                const owned = this._mpNormalizeBoardOwned?.(this._mpOwned?.[uid])
                    || (this._mpOwned?.[uid] || []);
                if (!owned.length) return;
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                if (removedTileId && this._mpPlayerLayouts[uid]) {
                    const next = { ...this._mpPlayerLayouts[uid] };
                    const sameIdRedraw = Array.isArray(drawnIds)
                        && drawnIds.includes(removedTileId);
                    if (!sameIdRedraw) delete next[removedTileId];
                    this._mpPlayerLayouts[uid] = next;
                }
                const snapshot = preDumpTiles?.length
                    ? preDumpTiles
                    : (this.tiles || []).map((t) => ({ id: t.id, x: t.x, y: t.y }));
                const forceLayoutIds = drawnIds?.length ? new Set(drawnIds) : null;
                let runtime = removedTileId
                    ? (this.tiles || []).filter((t) => t.id !== removedTileId)
                    : (this.tiles || []);
                if (forceLayoutIds?.size) {
                    runtime = runtime.filter((t) => !forceLayoutIds.has(t.id));
                }
                const posList = Object.entries(this._mpPlayerLayouts[uid] || {}).map(([id, p]) => ({
                    id,
                    x: p.x,
                    y: p.y
                }));
                const board = { tilePositionsByPlayer: { [uid]: posList }, gameStarted: this.gameStarted };
                const layout = this._layoutMapForPlayer(board, uid, owned, {
                    preferBoardLayout: !!(forceLayoutIds?.size)
                });
                const keepRuntime = forceLayoutIds?.size
                    ? runtime.length > 0
                    : (this._isDraggingHand?.() || this._shouldKeepRuntimeTiles(board, owned));
                this.tiles = this._mergeInventoryWithLayout(
                    owned,
                    layout,
                    keepRuntime ? runtime : null,
                    { forceLayoutIds }
                );
                if (this.tiles.length !== owned.length) {
                    this.tiles = this._mergeInventoryWithLayout(owned, layout, null, { forceLayoutIds });
                }
                this.tiles = this._mpHydrateTiles?.(this.tiles) || this.tiles;
                this._localInventorySeq = this._mpInventorySeq?.[uid] || 0;
                this.started = this.tiles.length > 0;
                this._persistMpLayout?.();
                this.requestRender?.();
            },

            _shouldKeepRuntimeTiles(board, owned) {
                const ownedIds = new Set((owned || []).map((o) => o.id));
                const runtime = (this.tiles || []).filter((t) => ownedIds.has(t.id));
                const runtimeMatchesOwned = ownedIds.size > 0
                    && runtime.length === ownedIds.size
                    && runtime.every((t) => ownedIds.has(t.id)
                        && Number.isFinite(t.x) && Number.isFinite(t.y));
                const runtimeSubsetOfOwned = runtime.length > 0
                    && runtime.every((t) => ownedIds.has(t.id)
                        && Number.isFinite(t.x) && Number.isFinite(t.y));
                const inventoryGrew = runtimeSubsetOfOwned && owned.length > runtime.length;
                if (board?.gameStarted || this.gameStarted) {
                    if (runtimeMatchesOwned) return true;
                    return inventoryGrew;
                }
                if (!ownedIds.size || !runtime.length) return false;
                if (runtime.length !== ownedIds.size) return inventoryGrew;
                return runtimeMatchesOwned;
            },

            _flushDeferredBoardApply() {
                const board = this._mpDeferredBoard;
                if (!board || this._isDraggingHand()) return;
                if (!this.canMutatePlayingBoard?.() || this._reviewUiActive?.()) {
                    this._mpDeferredBoard = null;
                    return;
                }
                if (!this._shouldProjectPlayingInventory?.(board, { force: true })) {
                    this._mpDeferredBoard = null;
                    return;
                }
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
                const owned = this._mpOwnedForInventoryApply(board, uid);
                if (this._guestShouldRejectDumpInventoryApply(board, owned, uid)) {
                    if (!this.isHost?.()) {
                        this._guestSyncBoardOwnedFromLocal(uid);
                        this._guestRestoreDumpSpawnLock();
                    }
                    return false;
                }
                const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                if (!options.reset && !owned.length && !this.isHost()) {
                    const cachedRec = this._loadLocalHandRecord?.() || { resetCount: null, hand: [] };
                    const epoch = this._layoutEpoch?.() ?? 0;
                    const cached = (cachedRec.resetCount != null && epoch > 0 && cachedRec.resetCount !== epoch)
                        ? []
                        : (cachedRec.hand || []);
                    if (cached.length) {
                        // Layout-only cache — letters require board owned; wait for sync.
                        return false;
                    }
                }
                if (!options.reset && inPlay && !owned.length && (this.tiles?.length > 0)) {
                    return false;
                }
                if (options.reset) this._clearLocalLayout();
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                if (devSolvePending) this._clearLocalLayout();
                const layout = this._layoutMapForPlayer(board, uid, owned);
                const runtime = devSolvePending
                    ? null
                    : ((options.keepRuntime || this._isDraggingHand?.() || this._shouldKeepRuntimeTiles(board, owned))
                        ? this.tiles
                        : null);
                this.tiles = this._mergeInventoryWithLayout(owned, layout, runtime);
                this.tiles = this._mpHydrateTiles?.(this.tiles) || this.tiles;
                if (devSolvePending) this._bananaDevHook('noteSolveBoardApplied', board);
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
                if (typeof this._isRecentProgrammaticReset === 'function'
                    && this._isRecentProgrammaticReset()) {
                    return;
                }
                this._hostEnsureMpStores();
                const inReview = this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                // Host is authoritative for _mpOwned during play; RTDB echoes can lag behind
                // in-memory peel/dump/dump-reconcile — never clobber live owned from board echo.
                if (board.tilesOwnedByPlayer) {
                    Object.entries(board.tilesOwnedByPlayer).forEach(([playerUid, owned]) => {
                        if (!Array.isArray(owned) || !owned.length) return;
                        if (!inReview && this._mpOwned[playerUid]?.length) return;
                        const normalized = this._mpIngressNormalizeOwned?.(owned, 'mirror-board', {
                            source: 'mirror-board',
                            playerId: playerUid
                        }) || owned;
                        this._mpOwned[playerUid] = this._mpCanonicalRepairOwned(
                            normalized,
                            `mirror-board:${playerUid}`
                        );
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
                        if (!inReview && this._mpPlayerLayouts[playerUid]
                            && Object.keys(this._mpPlayerLayouts[playerUid]).length) {
                            return;
                        }
                        this._mpPlayerLayouts[playerUid] = this._positionsMapFromList(list);
                    });
                }
            },

            _applyRemoteInventory(board, uid, options = {}) {
                if (this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW && !options.reset) {
                    return false;
                }
                const remoteOwned = this._mpNormalizeBoardOwned?.(
                    board.tilesOwnedByPlayer?.[uid] || board.hands?.[uid]
                ) || [];
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
                const owned = this._mpNormalizeBoardOwned?.(
                    board.tilesOwnedByPlayer?.[uid] || board.hands?.[uid]
                ) || [];
                const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                const ownedChanged = owned.length !== (this.tiles?.length || 0)
                    || owned.some((o) => !runtimeIds.has(o.id));
                if (remote <= (this._localInventorySeq || 0) && !ownedChanged) {
                    return false;
                }
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                if (devSolvePending) this._clearLocalLayout();
                const layout = this._layoutMapForPlayer(board, uid, owned);
                const runtime = devSolvePending
                    ? null
                    : (this._shouldKeepRuntimeTiles(board, owned) ? this.tiles : null);
                this.tiles = this._mergeInventoryWithLayout(owned, layout, runtime);
                this.tiles = this._mpHydrateTiles?.(this.tiles) || this.tiles;
                this._localInventorySeq = remote;
                if (this._isMultiplayerMode?.() && !this.isHost?.()) {
                    this._mpLetterIntegrityCheck?.('guest-sync-apply');
                    this._mpDistributionInvariantCheck?.('guest-sync-apply');
                }
                if (devSolvePending) this._bananaDevHook('noteSolveBoardApplied', board);
                if (this._shouldPersistMpLayout?.(owned, layout) !== false) {
                    this._persistMpLayout();
                }
                return true;
            },

            _isRecentProgrammaticReset() {
                return !!(this._resetAcknowledgedAt
                    && (Date.now() - this._resetAcknowledgedAt) < 8000);
            },

            _applyMpInventoryFromBoard(board, uid, options = {}) {
                if (!this._shouldProjectPlayingInventory?.(board, options)) {
                    return false;
                }
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
                    const ownedCheck = this._mpNormalizeBoardOwned?.(
                        board.tilesOwnedByPlayer?.[uid] || board.hands?.[uid]
                    ) || [];
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
                    const ownedForce = this._mpOwnedForInventoryApply(board, uid);
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
                        keepRuntime: !options.reset
                            && this._bananaDevHook('pendingSolveLayout', board) !== true
                            && this._shouldKeepRuntimeTiles(board, ownedForce)
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
                    const owned = this._mpOwnedForInventoryApply(board, uid);
                    if (this._guestShouldRejectDumpInventoryApply(board, owned, uid)) {
                        if (!this.isHost?.()) {
                            this._guestSyncBoardOwnedFromLocal(uid);
                            if (this._guestRestoreDumpSpawnLock()) {
                                layoutChanged = true;
                            }
                        }
                        return false;
                    }
                    const inPlay = !!(this.gameStarted || board.gameStarted || this.started);
                    if (!options.reset && !options.force && inPlay
                        && !owned.length && (this.tiles?.length > 0)) {
                        return false;
                    }
                    const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                    const ownedChanged = owned.length !== (this.tiles?.length || 0)
                        || owned.some((o) => !runtimeIds.has(o.id));
                    const localSeq = this._localInventorySeq || 0;
                    const recentReset = this._isRecentProgrammaticReset();
                    if (this.isHost?.() && recentReset) {
                        if ((board.peelSeq || 0) > 0 || (board.dumpSeq || 0) > 0) return false;
                        const freshDeal = (this._mpInventorySeq?.[uid] || 0) <= 1
                            && owned.length >= (this._handSizeForParty?.() || 1);
                        if (remote > localSeq && remote > 1 && freshDeal) return false;
                    }
                    if (this.isHost?.() && remote < localSeq) {
                        const allowFresh = recentReset && this._isFreshPostResetBoard?.(board);
                        if (!allowFresh) return false;
                    }
                    if (this.isHost?.() && remote === localSeq && ownedChanged) {
                        const runtimeIdSet = new Set((this.tiles || []).map((t) => t.id));
                        const boardHasNewIds = owned.some((o) => !runtimeIdSet.has(o.id));
                        if (!boardHasNewIds) return false;
                    }
                    const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                    const runtimeIdSet = new Set((this.tiles || []).map((t) => t.id));
                    const ownedIdSet = new Set((owned || []).map((o) => o.id));
                    const extraRuntime = (this.tiles || []).some((t) => !ownedIdSet.has(t.id));
                    const countMismatch = owned.length !== (this.tiles?.length || 0);
                    if (remote > localSeq || ownedChanged || devSolvePending) {
                        if (devSolvePending) this._clearLocalLayout();
                        const dumpSeqNow = board?.dumpSeq || 0;
                        const guestOwnDump = board?.dumpActorUid === uid;
                        const guestDumpAdvanced = !this.isHost?.()
                            && guestOwnDump
                            && dumpSeqNow > (this._lastGuestDumpLayoutSeq || 0);
                        if (guestDumpAdvanced) {
                            this._guestDumpSpawnLock = null;
                        }
                        const snapshot = this._guestPreDumpSnapshot?.length
                            ? this._guestPreDumpSnapshot
                            : (this.tiles || []).map((t) => ({
                                id: t.id,
                                x: t.x,
                                y: t.y
                            }));
                        const dumpDrawIds = guestDumpAdvanced
                            ? this._dumpDrawForceLayoutIds(snapshot, owned)
                            : null;
                        let layout = this._layoutMapForPlayer(board, uid, owned);
                        layout = this._guestStripLockedDumpDrawsFromLayout(layout, dumpSeqNow);
                        if (dumpDrawIds?.size) {
                            this._purgeLocalLayoutIds?.([...dumpDrawIds]);
                            dumpDrawIds.forEach((id) => { delete layout[id]; });
                        }
                        const keepRuntime = this._isDraggingHand?.()
                            || this._shouldKeepRuntimeTiles(board, owned);
                        const inventoryGrew = (owned?.length || 0) > (this.tiles?.length || 0);
                        const forceFullMerge = !this._isDraggingHand?.()
                            && (devSolvePending
                                || (countMismatch && extraRuntime && !inventoryGrew));
                        let runtime = forceFullMerge
                            ? null
                            : (keepRuntime ? this.tiles : null);
                        if (guestDumpAdvanced && dumpDrawIds?.size && runtime?.length) {
                            runtime = runtime.filter((t) => !dumpDrawIds.has(t.id));
                        }
                        if (!this.isHost?.() && guestOwnDump
                            && (this._lastGuestDumpLayoutSeq || 0) > 0
                            && dumpSeqNow <= (this._lastGuestDumpLayoutSeq || 0)
                            && owned.length < (this.tiles?.length || 0)) {
                            this._guestSyncBoardOwnedFromLocal(uid);
                            if (this._guestRestoreDumpSpawnLock()) layoutChanged = true;
                        } else {
                            this.tiles = this._mergeInventoryWithLayout(
                                owned,
                                layout,
                                runtime,
                                dumpDrawIds?.size ? { forceLayoutIds: dumpDrawIds } : {}
                            );
                            this.tiles = this._mpHydrateTiles?.(this.tiles) || this.tiles;
                        }
                        if (guestDumpAdvanced && dumpDrawIds?.size) {
                            this._guestPlaceDumpDrawsInViewport(dumpDrawIds);
                            this._guestLockDumpSpawnPositions(dumpDrawIds, dumpSeqNow);
                            this._lastGuestDumpLayoutSeq = dumpSeqNow;
                            this._guestPreDumpSnapshot = null;
                            this._guestOptimisticDumpRemovedId = null;
                            this._guestPendingDumpTile = null;
                            this._guestDumpSeqAtSend = null;
                            this._guestDumpHandFloor = owned.length;
                            this._guestSyncBoardOwnedFromLocal(uid);
                        }
                        if (!this.isHost?.() && this._guestRestoreDumpSpawnLock()) {
                            layoutChanged = true;
                        }
                        if (guestDumpAdvanced && dumpDrawIds?.size && typeof this._render === 'function') {
                            this._render();
                        }
                        this._localInventorySeq = remote;
                        if (this._isMultiplayerMode?.() && !this.isHost?.()) {
                            this._mpLetterIntegrityCheck?.('guest-sync-apply');
                            this._mpDistributionInvariantCheck?.('guest-sync-apply');
                        }
                        if (devSolvePending) this._bananaDevHook('noteSolveBoardApplied', board);
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
