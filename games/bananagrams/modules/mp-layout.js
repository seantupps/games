/** Bananagrams — mp-layout (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-layout.js');
    Object.assign(G.prototype, {
            getPersistKey() {
                const uid = this._myUid() || 'local';
                return `bananagrams_solo_${uid}`;
            },

            getLayoutPersistKey() {
                let room = this.roomId;
                if (!room || room === 'lobby') {
                    try {
                        room = new URLSearchParams(window.location.search).get('room');
                    } catch (_) { /* ignore */ }
                }
                const uid = this._myUid() || 'local';
                return `bananagrams_layout_${room || 'lobby'}_${uid}`;
            },

            getHandPersistKey() {
                let room = this.roomId;
                if (!room || room === 'lobby') {
                    try {
                        room = new URLSearchParams(window.location.search).get('room');
                    } catch (_) { /* ignore */ }
                }
                const uid = this._myUid() || 'local';
                return `bananagrams_hand_${room || 'lobby'}_${uid}`;
            },

            /** MP clients cache layout locally for tab refresh — not network authority. */
            _loadLocalLayout() {
                if (!this._isMultiplayerMode()) return {};
                try {
                    return JSON.parse(localStorage.getItem(this.getLayoutPersistKey()) || '{}') || {};
                } catch (_) {
                    return {};
                }
            },

            _saveLocalLayout(layout) {
                if (!this._isMultiplayerMode()) return;
                try {
                    localStorage.setItem(this.getLayoutPersistKey(), JSON.stringify(layout || {}));
                } catch (_) { /* ignore */ }
            },

            _layoutEpoch() {
                return this._mpReadResetCount?.() ?? 0;
            },

            _loadLocalHandRecord() {
                if (!this._isMultiplayerMode()) return { resetCount: null, hand: [] };
                try {
                    const raw = JSON.parse(localStorage.getItem(this.getHandPersistKey()) || '[]');
                    if (Array.isArray(raw)) return { resetCount: null, hand: raw };
                    if (raw && Array.isArray(raw.hand)) {
                        return {
                            resetCount: Number.isFinite(raw.resetCount) ? raw.resetCount : null,
                            inventorySeq: Number.isFinite(raw.inventorySeq) ? raw.inventorySeq : null,
                            hand: raw.hand
                        };
                    }
                    return { resetCount: null, hand: [] };
                } catch (_) {
                    return { resetCount: null, hand: [] };
                }
            },

            _loadLocalHand() {
                return this._loadLocalHandRecord().hand;
            },

            _saveLocalHand(hand, opts = {}) {
                if (!this._isMultiplayerMode()) return;
                try {
                    const invSeq = Number.isFinite(opts.inventorySeq)
                        ? opts.inventorySeq
                        : (this._mpClientInventorySeq?.(this._myUid?.()) ?? 0);
                    localStorage.setItem(this.getHandPersistKey(), JSON.stringify({
                        resetCount: this._layoutEpoch(),
                        inventorySeq: invSeq,
                        hand: (hand || []).map((t) => ({
                            id: t.id,
                            x: Number.isFinite(t.x) ? Math.round(t.x) : 0,
                            y: Number.isFinite(t.y) ? Math.round(t.y) : 0,
                            faceUp: !!t.faceUp
                        }))
                    }));
                } catch (_) { /* ignore */ }
            },

            _clearLocalLayout() {
                try {
                    localStorage.removeItem(this.getLayoutPersistKey());
                    localStorage.removeItem(this.getHandPersistKey());
                } catch (_) { /* ignore */ }
                this._clearMpClientLayoutStore?.();
            },

            /** Guest session layout store — hot path reads this, not localStorage. */
            _ensureMpClientLayoutStore() {
                if (!this._mpClientLayout) this._mpClientLayout = {};
            },

            _setMpClientLayout(map) {
                this._ensureMpClientLayoutStore();
                this._mpClientLayout = { ...(map || {}) };
            },

            _clearMpClientLayoutStore() {
                this._mpClientLayout = null;
            },

            /** One-time hydrate from localStorage when epoch + membership match. */
            _hydrateMpClientLayoutFromStorage(ownedList) {
                if (!this._isMultiplayerMode?.() || this.isHost?.() || !ownedList?.length) return false;
                const pruned = this._pruneLayout(this._mpClientLayout, ownedList);
                if (Object.keys(pruned).length === ownedList.length) return true;
                const localHand = this._loadLocalHand?.() || [];
                const localLayout = this._loadLocalLayout();
                if (!this._localLayoutMatchesOwned(ownedList, localHand, localLayout)) return false;
                this._setMpClientLayout(this._pruneLayout(localLayout, ownedList));
                return true;
            },

            /** Wire layout — board.tilePositionsByPlayer (host positions on network). */
            _wireLayoutMapForOwned(board, uid, ownedList) {
                const remoteList = board?.tilePositionsByPlayer?.[uid];
                if (!Array.isArray(remoteList) || !remoteList.length || !ownedList?.length) return null;
                const fromBoard = this._pruneLayout(this._positionsMapFromList(remoteList), ownedList);
                if (Object.keys(fromBoard).length === ownedList.length) return fromBoard;
                return null;
            },

            _hostStagedLayoutMap(uid, ownedList) {
                if (!ownedList?.length) return null;
                const staged = this._pruneLayout(this._mpPlayerLayouts?.[uid], ownedList);
                if (Object.keys(staged).length === ownedList.length) return staged;
                return null;
            },

            /** Host active play — staged layouts are publish authority; wire must not backfill. */
            _hostIsPlayingLayoutAuthority() {
                return !!(this.isHost?.() && this.gameStarted && this.canMutatePlayingBoard?.()
                    && !this._reviewUiActive?.());
            },

            /** Flush host runtime hand into staged layout before publish or resolve. */
            _hostRefreshOwnStagedLayoutFromTiles() {
                const me = this._myUid?.();
                if (!me || !(this.tiles?.length)) return;
                if (!this._hostIsPlayingLayoutAuthority?.()) return;
                this._hostEnsureMpStores?.();
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                this._mpPlayerLayouts[me] = this._layoutFromTiles(this.tiles);
            },

            /**
             * Complete staged layout for publish — host-staged only during play.
             * Pre-play / recovery may merge wire when allowWireFallback; never during active play.
             */
            _hostStagedLayoutForPublish(uid, ownedList, opts = {}) {
                const owned = ownedList || [];
                if (!owned.length || !uid) return null;
                const allowWireFallback = !!opts.allowWireFallback;
                const board = opts.board || null;

                if (uid === this._myUid?.()) {
                    this._hostRefreshOwnStagedLayoutFromTiles?.();
                }

                let staged = { ...this._pruneLayout(this._mpPlayerLayouts?.[uid], owned) };

                if (allowWireFallback && Object.keys(staged).length < owned.length && board) {
                    const wire = this._wireLayoutMapForOwned(board, uid, owned);
                    if (wire) {
                        staged = { ...wire, ...staged };
                    }
                }

                const missing = owned.filter((o) => {
                    const p = staged[o.id];
                    return !p || !Number.isFinite(p.x) || !Number.isFinite(p.y);
                });
                if (missing.length) {
                    this._rackTilesFromOwned(missing).forEach((t) => {
                        if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
                            staged[t.id] = { x: Math.round(t.x), y: Math.round(t.y) };
                        }
                    });
                }

                let complete = this._pruneLayout(staged, owned);
                if (Object.keys(complete).length !== owned.length) return null;

                // Pre-play wire recovery only — never clobber a guest peel/win layout during active play.
                if (allowWireFallback && uid !== this._myUid?.() && typeof BananaGrid !== 'undefined') {
                    const positions = Object.entries(complete).map(([id, p]) => ({
                        id,
                        x: p.x,
                        y: p.y
                    }));
                    const hand = this._handFromOwnedAndPositions?.(uid, positions);
                    const origin = { x: this.ORIGIN, y: this.ORIGIN };
                    const rackOpts = this._rackLayoutOptions?.();
                    if (hand?.length && !BananaGrid.isStartingRack(hand, origin, rackOpts)) {
                        const rackTiles = this._rackTilesFromOwned(owned);
                        complete = this._layoutFromTiles(rackTiles);
                    }
                }

                this._hostEnsureMpStores?.();
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                this._mpPlayerLayouts[uid] = complete;
                return complete;
            },

            _runtimeLayoutMapForOwned(ownedList) {
                const owned = ownedList || [];
                if (!owned.length) return {};
                const map = {};
                (this.tiles || []).forEach((t) => {
                    if (!Number.isFinite(t?.x) || !Number.isFinite(t?.y)) return;
                    map[t.id] = { x: Math.round(t.x), y: Math.round(t.y) };
                });
                return this._pruneLayout(map, owned);
            },

            /**
             * Playing layout SSOT — exactly one authority tier per resolve.
             * Drag positions are NOT merged here; pipeline passes runtime via _layoutRuntimeForProjection.
             * @returns {{ source: string, map: Object }}
             */
            _resolvePlayingLayoutMap(board, uid, ownedList, opts = {}) {
                const owned = ownedList || [];
                const empty = { source: 'none', map: {} };
                if (!owned.length) return empty;

                if (!opts.reset && !opts.force && uid === this._myUid?.() && !this.isHost?.()
                    && this._guestHasAuthoritativeLocalLayout?.(owned)) {
                    this._hydrateMpClientLayoutFromStorage?.(owned);
                    const client = this._pruneLayout(this._mpClientLayout, owned);
                    if (Object.keys(client).length === owned.length) {
                        return { source: 'client-layout', map: client };
                    }
                }

                if (opts.preferAuthorityLayout || opts.reset) {
                    if (this.isHost?.()) {
                        const staged = this._hostStagedLayoutMap(uid, owned);
                        if (staged) return { source: 'host-staged', map: staged };
                    }
                    const wire = this._wireLayoutMapForOwned(board, uid, owned);
                    if (wire) return { source: 'wire', map: wire };
                    return empty;
                }

                if (uid !== this._myUid?.()) {
                    const wire = this._wireLayoutMapForOwned(board, uid, owned);
                    return wire ? { source: 'wire', map: wire } : empty;
                }

                const hostPlaying = this.isHost?.() && this.gameStarted
                    && !this._hostMayIngestBoardToAuthority?.(board, opts);
                if (hostPlaying) {
                    const staged = this._hostStagedLayoutMap(uid, owned);
                    if (staged) return { source: 'host-staged', map: staged };
                    if (uid === this._myUid?.()) {
                        const fromRuntime = this._runtimeLayoutMapForOwned(owned);
                        if (Object.keys(fromRuntime).length === owned.length) {
                            return { source: 'host-staged', map: fromRuntime };
                        }
                    }
                    return empty;
                }

                const wireRequired = this._localCacheStaleForBoard(board)
                    || this._isActionInventoryRefresh?.(board);
                if (wireRequired) {
                    const wire = this._wireLayoutMapForOwned(board, uid, owned);
                    if (wire) {
                        this._setMpClientLayout(wire);
                        return { source: 'wire', map: wire };
                    }
                }

                this._hydrateMpClientLayoutFromStorage(owned);
                const client = this._pruneLayout(this._mpClientLayout, owned);
                if (Object.keys(client).length === owned.length) {
                    return { source: 'client-layout', map: client };
                }

                const wireFallback = this._wireLayoutMapForOwned(board, uid, owned);
                if (wireFallback) {
                    this._setMpClientLayout(wireFallback);
                    return { source: 'wire-fallback', map: wireFallback };
                }
                return empty;
            },

            /**
             * After resolve, sync the winning tier into its store and prune stale tiers
             * so tab reload / deferred flush don't read drifted layout maps.
             */
            _mpSyncLayoutStoresFromResolved(board, uid, ownedList, resolved, opts = {}) {
                if (!resolved?.map || !uid || uid !== this._myUid?.()) return;
                const owned = ownedList || [];
                const map = this._pruneLayout(resolved.map, owned);
                if (!Object.keys(map).length) return;

                const source = resolved.source;
                if (source === 'host-staged') {
                    this._hostEnsureMpStores?.();
                    if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                    this._mpPlayerLayouts[uid] = map;
                    if (this._mpClientLayout && Object.keys(this._mpClientLayout).length) {
                        this._mpClientLayout = {};
                    }
                    this._lastMpLayoutPersist = {
                        target: 'host-staged-sync',
                        len: Object.keys(map).length,
                        source,
                        at: Date.now()
                    };
                    return;
                }

                if (source === 'wire' || source === 'wire-fallback' || source === 'client-layout') {
                    this._setMpClientLayout(map);
                    // Guest wire echoes are host rack snapshots — never write them to localStorage.
                    if (source.startsWith('wire')
                        && this.isHost?.()
                        && this._shouldPersistMpLayoutFromBoardApply?.(board, owned, opts)) {
                        this._saveLocalLayout(map);
                        const remote = this._boardInventorySeq?.(board, uid) ?? 0;
                        this._saveLocalHand((this.tiles || []).map((t) => ({
                            id: t.id,
                            faceUp: !!t.faceUp,
                            x: Number.isFinite(t.x) ? Math.round(t.x) : 0,
                            y: Number.isFinite(t.y) ? Math.round(t.y) : 0
                        })), { inventorySeq: remote });
                    }
                    if (this.isHost?.() && this._mpPlayerLayouts?.[uid]) {
                        delete this._mpPlayerLayouts[uid];
                    }
                    this._lastMpLayoutPersist = {
                        target: source.startsWith('wire') ? 'wire-sync' : 'client-layout-sync',
                        len: Object.keys(map).length,
                        source,
                        at: Date.now()
                    };
                }
            },

            _mpLayoutMapsEqual(a, b) {
                const left = a || {};
                const right = b || {};
                const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
                for (const id of keys) {
                    const lp = left[id];
                    const rp = right[id];
                    if (!lp || !rp || lp.x !== rp.x || lp.y !== rp.y) return false;
                }
                return true;
            },

            _mpLayoutStoreSnapshot(board, uid, ownedList) {
                const owned = ownedList || [];
                const resolved = this._resolvePlayingLayoutMap(board, uid, owned);
                const wire = this._wireLayoutMapForOwned(board, uid, owned) || {};
                const client = this._pruneLayout(this._mpClientLayout, owned);
                const hostStaged = this._pruneLayout(this._mpPlayerLayouts?.[uid], owned);
                const runtime = uid === this._myUid?.()
                    ? this._runtimeLayoutMapForOwned(owned)
                    : {};
                let localStorageMap = {};
                if (this._hydrateMpClientLayoutFromStorage(owned)) {
                    localStorageMap = this._pruneLayout(this._mpClientLayout, owned);
                }
                const stores = {
                    wire: { len: Object.keys(wire).length, map: wire },
                    client: { len: Object.keys(client).length, map: client },
                    hostStaged: { len: Object.keys(hostStaged).length, map: hostStaged },
                    runtime: { len: Object.keys(runtime).length, map: runtime },
                    localStorage: { len: Object.keys(localStorageMap).length, map: localStorageMap }
                };
                const drift = [];
                if (resolved.source === 'client-layout' && !this._mpLayoutMapsEqual(client, resolved.map)) {
                    drift.push('client-vs-resolved');
                }
                if (resolved.source === 'host-staged' && !this._mpLayoutMapsEqual(hostStaged, resolved.map)) {
                    drift.push('host-staged-vs-resolved');
                }
                if (resolved.source === 'wire' && !this._mpLayoutMapsEqual(wire, resolved.map)) {
                    drift.push('wire-vs-resolved');
                }
                if (stores.client.len && stores.hostStaged.len
                    && !this._mpLayoutMapsEqual(client, hostStaged)) {
                    drift.push('client-vs-host-staged');
                }
                if (stores.runtime.len && stores.hostStaged.len
                    && !this._mpLayoutMapsEqual(runtime, hostStaged)) {
                    drift.push('runtime-vs-host-staged');
                }
                if (stores.runtime.len && resolved.source === 'host-staged'
                    && !this._mpLayoutMapsEqual(runtime, resolved.map)) {
                    drift.push('runtime-vs-resolved');
                }
                return {
                    uid: uid ? String(uid).slice(-14) : null,
                    resolvedSource: resolved.source,
                    resolvedLen: Object.keys(resolved.map).length,
                    ownedLen: owned.length,
                    stores: {
                        wire: stores.wire.len,
                        client: stores.client.len,
                        hostStaged: stores.hostStaged.len,
                        runtime: stores.runtime.len,
                        localStorage: stores.localStorage.len
                    },
                    drift,
                    lastPersist: this._lastMpLayoutPersist ? { ...this._lastMpLayoutPersist } : null
                };
            },

            _mpLayoutAuthoritySnapshot(board, uid, owned) {
                const resolved = this._resolvePlayingLayoutMap(board, uid, owned || []);
                const ownedList = owned || [];
                const storeSnap = this._mpLayoutStoreSnapshot(board, uid, ownedList);
                return {
                    uid: storeSnap.uid,
                    source: resolved.source,
                    mapLen: Object.keys(resolved.map).length,
                    ownedLen: ownedList.length,
                    wireLen: storeSnap.stores.wire,
                    clientLen: storeSnap.stores.client,
                    hostStagedLen: storeSnap.stores.hostStaged,
                    runtimeLen: storeSnap.stores.runtime,
                    localStorageLen: storeSnap.stores.localStorage,
                    storeDrift: storeSnap.drift,
                    lastPersist: storeSnap.lastPersist,
                    cacheStale: !this.isHost?.() && this._localCacheStaleForBoard?.(board),
                    dragging: !!this._isDraggingHand?.()
                };
            },

            _hasSavedLocalLayoutForOwned(ownedList) {
                if (!ownedList?.length) return false;
                if (this._hydrateMpClientLayoutFromStorage(ownedList)) {
                    const pruned = this._pruneLayout(this._mpClientLayout, ownedList);
                    return Object.keys(pruned).length === ownedList.length;
                }
                return false;
            },

            _layoutFromTiles(tiles) {
                const layout = {};
                (tiles || []).forEach((t) => {
                    if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
                        layout[t.id] = { x: Math.round(t.x), y: Math.round(t.y) };
                    }
                });
                return layout;
            },

            /** Cache local tile positions — one persist target per role to avoid store drift. */
            _persistMpLayout() {
                if (!this._isMultiplayerMode()) return;
                const uid = this._myUid();
                if (!uid) return;
                this._noteMpTilesInPlaceMutation?.('persist-layout-read', {
                    mode: this._inferMpTilesProjectionMode?.()
                });
                const layout = this._layoutFromTiles(this.tiles);
                const len = Object.keys(layout).length;
                const hostPlaying = this.isHost?.()
                    && this.gameStarted
                    && this.canMutatePlayingBoard?.()
                    && !this._reviewUiActive?.();

                if (hostPlaying) {
                    this._hostEnsureMpStores();
                    if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                    this._mpPlayerLayouts[uid] = layout;
                    if (this._mpClientLayout && Object.keys(this._mpClientLayout).length) {
                        this._mpClientLayout = {};
                    }
                    this._lastMpLayoutPersist = {
                        target: 'host-staged',
                        len,
                        at: Date.now()
                    };
                    return;
                }

                this._setMpClientLayout(layout);
                this._saveLocalLayout(layout);
                const board = this._mpBoardFromRoom?.(this.roomData);
                const remote = board
                    ? this._boardInventorySeq?.(board, uid) ?? 0
                    : this._mpClientInventorySeq?.(uid) ?? 0;
                this._saveLocalHand((this.tiles || []).map((t) => ({
                    id: t.id,
                    faceUp: !!t.faceUp,
                    x: Number.isFinite(t.x) ? Math.round(t.x) : 0,
                    y: Number.isFinite(t.y) ? Math.round(t.y) : 0
                })), { inventorySeq: remote });
                this._lastMpLayoutPersist = {
                    target: this.isHost?.() ? 'client+localStorage' : 'guest-client+localStorage',
                    len,
                    at: Date.now()
                };
            },

            /** Deal epoch for storage reads — live room epoch, else persisted hand stamp (tab reload). */
            _dealEpochForStorage() {
                const live = this._layoutEpoch?.() ?? 0;
                if (live > 0) return live;
                const stored = this._loadLocalHandRecord?.().resetCount;
                return typeof stored === 'number' && stored >= 0 ? stored : 0;
            },

            /** True when persisted hand record matches the active deal epoch. */
            _storedHandEpochMatchesDeal(record) {
                const rec = record || {};
                if (rec.resetCount == null) return false;
                const live = this._layoutEpoch?.() ?? 0;
                if (live > 0) return rec.resetCount === live;
                const hand = rec.hand || [];
                if (!hand.length) return false;
                return hand.every((t) => {
                    const parsed = this._mpParseTileId?.(t?.id);
                    return !parsed?.epoch || parsed.epoch === rec.resetCount;
                });
            },

            _pruneLayout(layout, owned, opts = {}) {
                const ids = new Set((owned || []).map((o) => o.id));
                const dealEpoch = Number.isFinite(opts.dealEpoch)
                    ? opts.dealEpoch
                    : this._dealEpochForStorage?.();
                const pruned = {};
                Object.entries(layout || {}).forEach(([id, p]) => {
                    if (!ids.has(id)) return;
                    const parsed = this._mpParseTileId?.(id);
                    if (parsed?.epoch != null && dealEpoch > 0 && parsed.epoch !== dealEpoch) return;
                    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                        pruned[id] = { x: p.x, y: p.y };
                    }
                });
                return pruned;
            },

            _letterMultisetSig(letters) {
                return (letters || []).map((l) => String(l || '').toUpperCase()).sort().join('');
            },

            _localLayoutMatchesOwned(ownedList, localHand, localLayout) {
                if (!ownedList?.length) return false;
                const stored = this._loadLocalHandRecord?.() || { resetCount: null, hand: localHand };
                if (!this._storedHandEpochMatchesDeal?.(stored)) return false;
                const pruned = this._pruneLayout(localLayout, ownedList);
                if (!Object.keys(pruned).length) return false;
                const hand = (stored.hand?.length ? stored.hand : localHand) || [];
                const epochOk = (t) => this._mpIdMatchesDealEpoch?.(t?.id) !== false;
                const ownedIds = ownedList.map((o) => o.id).filter(epochOk).sort();
                if (!hand.length) {
                    return Object.keys(pruned).length === ownedIds.length;
                }
                const handIds = hand.map((t) => t.id).filter(epochOk).sort();
                if (handIds.length !== ownedIds.length) return false;
                return handIds.every((id, i) => id === ownedIds[i]);
            },

            /** True when board inventory/action seq advanced — localStorage must not override wire layout. */
            _localCacheStaleForBoard(board) {
                if (this.isHost?.()) return true;
                const uid = this._myUid?.();
                if (!uid || !board) return true;
                const remote = this._boardInventorySeq?.(board, uid) ?? 0;
                const stored = this._loadLocalHandRecord?.() || { inventorySeq: 0 };
                const cacheSeq = stored.inventorySeq ?? 0;
                const local = Math.max(this._mpClientInventorySeq?.(uid) ?? 0, cacheSeq);
                if (remote > local) return true;
                if (cacheSeq < remote) return true;
                const epoch = this._layoutEpoch?.() ?? 0;
                if (stored.resetCount != null && epoch > 0 && stored.resetCount !== epoch) return true;
                return false;
            },

            _shouldPersistMpLayout(ownedList, appliedLayout) {
                if (!this._isMultiplayerMode() || !this._myUid()) return false;
                if (!ownedList?.length) return true;
                const appliedKeys = Object.keys(appliedLayout || {});
                if (appliedKeys.length) return true;
                return !this._hasSavedLocalLayoutForOwned(ownedList);
            },

            /**
             * Playing layout map — delegates to _resolvePlayingLayoutMap (one authority tier).
             * Drag positions merge in _mergeInventoryWithLayout via _layoutRuntimeForProjection.
             * @param {{ preferAuthorityLayout?: boolean, reset?: boolean }} [opts]
             */
            _layoutMapForPlayer(board, uid, owned, opts = {}) {
                const ownedList = owned || [];
                const remoteList = board?.tilePositionsByPlayer?.[uid];
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                const remoteSolveLayout = this._bananaDevHook(
                    'preferRemoteSolveLayout',
                    board,
                    uid,
                    ownedList,
                    remoteList
                );
                if (remoteSolveLayout) return remoteSolveLayout;
                if (devSolvePending) {
                    if (Array.isArray(remoteList) && remoteList.length) {
                        return this._pruneLayout(this._positionsMapFromList(remoteList), ownedList);
                    }
                    return {};
                }
                const resolved = this._resolvePlayingLayoutMap(board, uid, ownedList, opts);
                this._mpSyncLayoutStoresFromResolved(board, uid, ownedList, resolved, opts);
                this._lastMpLayoutAuthority = {
                    uid: uid ? String(uid).slice(-14) : null,
                    source: resolved.source,
                    mapLen: Object.keys(resolved.map).length,
                    ownedLen: ownedList.length,
                    at: Date.now()
                };
                return resolved.map;
            },

            _importBoardLayoutIfNeeded(board, uid, _layout) {
                return this._layoutMapForPlayer(board, uid, board?.tilesOwnedByPlayer?.[uid] || []);
            },

            /** True when runtime/projected tiles match canonical rack slots for owned membership. */
            _projectedMatchesRackLayout(owned, tiles) {
                const stubs = owned || [];
                const projected = tiles || [];
                if (!stubs.length || projected.length !== stubs.length) return false;
                const rackTiles = this._rackTilesFromOwned(stubs);
                const byId = new Map(rackTiles.map((t) => [t.id, t]));
                const tol = 2;
                return projected.every((t) => {
                    const r = byId.get(t.id);
                    return r
                        && Math.abs((t.x ?? 0) - r.x) <= tol
                        && Math.abs((t.y ?? 0) - r.y) <= tol;
                });
            },

            /** Guest localStorage/client layout for this deal epoch — refresh restore must win over wire. */
            _guestHasAuthoritativeLocalLayout(ownedList) {
                const owned = ownedList || [];
                if (!owned.length || this.isHost?.()) return false;
                const record = this._loadLocalHandRecord?.() || {};
                if (!this._storedHandEpochMatchesDeal?.(record)) return false;
                if (!Array.isArray(record.hand) || !record.hand.length) return false;
                const handIds = new Set(record.hand.map((t) => t?.id).filter(Boolean));
                if (!owned.every((o) => handIds.has(o.id))) return false;
                this._hydrateMpClientLayoutFromStorage?.(owned);
                const client = this._pruneLayout(this._mpClientLayout, owned);
                return Object.keys(client).length === owned.length;
            },

            /**
             * Guest imported wire/client layout must not clobber rack or freeze stale refresh crosswords.
             */
            _shouldCoerceGuestToRackLayout(board, uid, ownedList, layoutMap, source, options = {}) {
                if (this.isHost?.() || uid !== this._myUid?.()) return false;
                const stubs = ownedList || [];
                if (!stubs.length) return false;
                if (options.reset || options.force) return true;
                if (this._guestHasAuthoritativeLocalLayout?.(stubs)) return false;
                const stubsFull = this._buildMembershipStubs?.(stubs) || stubs;
                const projected = this._projectLayoutOntoMembership?.(
                    stubsFull,
                    layoutMap || {},
                    null
                ) || [];
                const hydrated = this._mpHydrateTiles?.(projected) || projected;
                if (this._projectedMatchesRackLayout(stubsFull, hydrated)) return false;

                const runtimeExtra = (this.tiles?.length || 0) > stubsFull.length
                    && !(this._membershipIdSetEquals?.(stubsFull, this.tiles));
                if (runtimeExtra) return true;

                const src = source || this._lastMpLayoutAuthority?.source || 'none';
                if (src === 'wire' || src === 'wire-fallback') return true;
                if (src === 'client-layout') {
                    // Tab reload drops drag timestamps — persisted client tier is authoritative.
                    if (this._guestHasAuthoritativeLocalLayout?.(stubs)) return false;
                    const draggedSinceStart = (this._mpLocalHandDragAt || 0) > (this._mpStartedAt || 0);
                    if (draggedSinceStart) return false;
                    return true;
                }
                return false;
            },

            _rackTilesFromOwned(owned) {
                if (!owned?.length || typeof BananaRules === 'undefined') return [];
                const gap = BananaRules.TILE_GAP;
                const cols = BananaRules.COLS;
                const size = BananaRules.TILE_SIZE;
                const origin = { x: this.ORIGIN, y: this.ORIGIN };
                const startX = origin.x - ((cols - 1) * gap + size) / 2;
                const startY = origin.y + BananaRules.HAND_BELOW_CENTER;
                return owned.map((o, idx) => {
                    const x = startX + (idx % cols) * gap;
                    const y = startY + Math.floor(idx / cols) * gap;
                    if (typeof this._acquireMpRuntimeTile === 'function') {
                        return this._applyRuntimeTileProps(this._acquireMpRuntimeTile(o.id), {
                            letter: this._mpLetter?.(o.id) || '',
                            faceUp: !!o.faceUp,
                            x,
                            y
                        });
                    }
                    return {
                        id: o.id,
                        letter: this._mpLetter?.(o.id) || '',
                        faceUp: !!o.faceUp,
                        x,
                        y
                    };
                });
            }
    });

    if (typeof window !== 'undefined') {
        G.registerMpDebug({
            layoutAuthority() {
                const g = window.game;
                const board = g?._mpBoardFromRoom?.(g.roomData);
                const uid = g?._myUid?.();
                const owned = uid ? (board?.tilesOwnedByPlayer?.[uid] || []) : [];
                return g?._mpLayoutAuthoritySnapshot?.(board, uid, owned) ?? null;
            },
            layoutStores() {
                const g = window.game;
                const board = g?._mpBoardFromRoom?.(g.roomData);
                const uid = g?._myUid?.();
                const owned = uid ? (board?.tilesOwnedByPlayer?.[uid] || []) : [];
                return g?._mpLayoutStoreSnapshot?.(board, uid, owned) ?? null;
            }
        });
    }
})(typeof window !== 'undefined' ? window : global);
