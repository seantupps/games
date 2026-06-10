/** Bananagrams — mp-inventory (prototype mixin). Requires game.js + mp-seq.js first. */
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

            /** Membership read path — one source per role. */
            _mpOwnedForInventoryApply(board, uid) {
                if (!this.isHost?.() || !uid) {
                    return this._boardAuthoritativeOwned(board, uid);
                }
                this._hostEnsureMpStores?.();
                const local = this._mpNormalizeBoardOwned?.(this._mpOwned?.[uid])
                    || (this._mpOwned?.[uid] || []);
                if (this._hostMayIngestBoardToAuthority?.(board)) {
                    if (local.length) return local;
                    return this._boardAuthoritativeOwned(board, uid);
                }
                return local;
            },

            _verifyInventoryMembership(owned, tiles) {
                const ownedIds = new Set((owned || []).map((o) => o.id));
                const tileIds = new Set((tiles || []).map((t) => t.id));
                if (!ownedIds.size) return tileIds.size === 0;
                if ((tiles || []).length !== tileIds.size) return false;
                return ownedIds.size === tileIds.size
                    && [...ownedIds].every((id) => tileIds.has(id));
            },

            /** True when playing inventory pipeline may commit this.tiles (review/win blocks). */
            _mpAllowPlayingTilesCommit(options = {}) {
                if (options.reset && options.force) return true;
                if (options.force && options._hostAuthorityProjection) return true;
                if (options._deferredDragFlush) return true;
                const board = this._mpBoardFromRoom?.(this.roomData);
                return this._shouldProjectPlayingInventory?.(board, options) !== false;
            },

            /** True when review layouts may commit this.tiles. */
            _mpAllowReviewTilesCommit() {
                return this._mpInReviewProjectionPhase?.();
            },

            /**
             * Single write path for this.tiles — records projection mode for debug/triage.
             * @param {'playing'|'review'|'cleared'} mode
             */
            _commitMpTilesProjection(tiles, { mode = 'playing', source = null, tileCount = null, inPlace = false } = {}) {
                this.tiles = tiles || [];
                this._mpTilesProjectionMode = mode;
                this._lastMpTilesProjection = {
                    mode,
                    source: source || null,
                    tileCount: tileCount ?? (this.tiles?.length ?? 0),
                    inPlace: !!inPlace,
                    at: Date.now()
                };
            },

            /** Infer projection mode when in-place edits skip full commit. */
            _inferMpTilesProjectionMode() {
                const stored = this._mpTilesProjectionMode;
                if (stored === 'review' || stored === 'playing' || stored === 'cleared') {
                    return stored;
                }
                if (!(this.tiles?.length)) return 'cleared';
                if (this._mpInReviewProjectionPhase?.()) return 'review';
                return 'playing';
            },

            /** Record in-place runtime tile edits — keeps projection metadata current. */
            _noteMpTilesInPlaceMutation(source, opts = {}) {
                const mode = opts.mode || this._inferMpTilesProjectionMode();
                this._mpTilesProjectionMode = mode;
                this._lastMpTilesProjection = {
                    mode,
                    source: source || null,
                    tileCount: opts.tileCount ?? (this.tiles?.length ?? 0),
                    inPlace: true,
                    at: Date.now(),
                    ...(opts.detail || {})
                };
            },

            /**
             * In-place this.tiles mutation path — membership unchanged, metadata tracked.
             * @param {string} source
             * @param {(tiles: Array) => boolean|void} fn — return true when mutated
             * @returns {boolean} whether fn reported a change
             */
            _mutateMpTilesInPlace(source, fn, opts = {}) {
                if (typeof fn !== 'function') return false;
                const changed = !!fn(this.tiles || []);
                if (changed || opts.noteAlways) {
                    this._noteMpTilesInPlaceMutation(source, {
                        mode: opts.mode,
                        tileCount: opts.tileCount,
                        detail: opts.detail
                    });
                }
                return changed;
            },

            _clearMpTilesProjection(reason = 'clear', options = {}) {
                this._commitMpTilesProjection([], {
                    mode: 'cleared',
                    source: reason,
                    tileCount: 0
                });
                if (options.clearRegistry !== false) {
                    this._clearMpRuntimeTileRegistry?.();
                }
            },

            /** Fail loud — runtime hand must not carry duplicate tile ids. */
            _dedupeRuntimeTiles(ctx = 'dedupe') {
                const tiles = this.tiles || [];
                if (!tiles.length) return false;
                const seen = new Set();
                const out = [];
                tiles.forEach((t) => {
                    if (!t?.id || seen.has(t.id)) return;
                    seen.add(t.id);
                    out.push(t);
                });
                if (out.length === tiles.length) return false;
                const detail = { ctx, before: tiles.length, after: out.length };
                if (typeof BananaDev !== 'undefined' && BananaDev.failAuthorityCommit) {
                    BananaDev.failAuthorityCommit('duplicate runtime tile ids', detail);
                } else {
                    console.error('[Bananagrams][inventory] duplicate runtime tile ids', detail);
                }
                this._commitMpTilesProjection(out, {
                    mode: this._mpTilesProjectionMode === 'review' ? 'review' : 'playing',
                    source: `dedupe-${ctx}`,
                    tileCount: out.length
                });
                return true;
            },

            /** Centralized inventory/board divergence snapshot (dev, test, reconcile). */
            _snapshotInventoryProjection(board, uid, why = 'snapshot') {
                const owned = uid
                    ? (board?.tilesOwnedByPlayer?.[uid] || [])
                    : [];
                const lastApply = this._lastMpInventoryApply || null;
                const seq = typeof this._snapshotMpSeqMatrix === 'function'
                    ? this._snapshotMpSeqMatrix(board, uid, why)
                    : null;
                const base = {
                    why,
                    role: this.isHost?.() ? 'host' : 'guest',
                    uid: uid ? String(uid).slice(-14) : null,
                    seq,
                    boardInventorySeq: seq?.inventory?.board
                        ?? (uid ? (this._boardInventorySeq?.(board, uid) ?? board?.inventorySeq?.[uid] ?? 0) : 0),
                    localInventorySeq: seq?.inventory?.local
                        ?? (uid ? this._mpClientInventorySeq?.(uid) : 0),
                    hostInventorySeq: seq?.inventory?.hostLive ?? null,
                    inventoryLag: seq?.inventory?.lag ?? false,
                    hostPublishPending: seq?.inventory?.hostPublishPending ?? false,
                    boardSeq: seq?.lifecycle?.boardSeq ?? board?.seq ?? null,
                    localBoardSeq: seq?.lifecycle?.localBoardSeq ?? this._boardSeq ?? null,
                    ownedLen: Array.isArray(owned) ? owned.length : 0,
                    tilesLen: this.tiles?.length ?? 0,
                    handUnique: new Set((this.tiles || []).map((t) => t?.id).filter(Boolean)).size,
                    poolLen: this._tilePool?.length ?? 0,
                    boardPoolLen: Array.isArray(board?.pool) ? board.pool.length : null,
                    gameStarted: !!(this.gameStarted || board?.gameStarted),
                    started: !!(this.started || board?.started),
                    preSplitDeal: this._isPreSplitDealBoard?.(board) ?? false,
                    dumpSeq: seq?.actions?.dumpBoard ?? board?.dumpSeq ?? null,
                    peelSeq: seq?.actions?.peelBoard ?? board?.peelSeq ?? null,
                    lastDumpSeq: seq?.actions?.dumpLast ?? this._lastDumpSeq ?? null,
                    lastPeelSeq: seq?.actions?.peelLast ?? this._lastPeelSeq ?? null,
                    dumpPending: seq?.actions?.dumpPending ?? false,
                    peelPending: seq?.actions?.peelPending ?? false,
                    dumpPendingTileId: this._mpGuestDumpUiPending?.()?.tileId ?? null,
                    inventoryApplyGen: seq?.inventoryApplyGen ?? this._mpInventoryApplyGen ?? 0,
                    lastInventoryApply: lastApply ? { ...lastApply } : null,
                    reconcileAttempts: seq?.reconcileAttempts ?? this._mpInvReconcileAttempts ?? 0,
                    lastPoolApply: this._lastMpPoolApply ? { ...this._lastMpPoolApply } : null,
                    tilesProjection: this._lastMpTilesProjection ? { ...this._lastMpTilesProjection } : null,
                    tilesProjectionMode: this._mpTilesProjectionMode ?? null,
                    lastBoardApply: this._lastBoardApply ? { ...this._lastBoardApply } : null,
                    tilesProjectionMode: this._mpTilesProjectionMode ?? 'none',
                    lastTilesProjection: this._lastMpTilesProjection
                        ? { ...this._lastMpTilesProjection }
                        : null
                };
                if (typeof this._mpCoherenceSnapshot === 'function') {
                    base.coherence = this._mpCoherenceSnapshot(board, uid, why);
                }
                return base;
            },

            _nextMpInventoryApplyGen() {
                this._mpInventoryApplyGen = (this._mpInventoryApplyGen || 0) + 1;
                return this._mpInventoryApplyGen;
            },

            _noteMpInventoryApply(source, gen, result, board, uid) {
                this._lastMpInventoryApply = {
                    source: source || null,
                    gen: gen ?? null,
                    result: result || null,
                    at: Date.now(),
                    remote: uid ? this._boardInventorySeq(board, uid) : null,
                    local: uid ? this._mpClientInventorySeq?.(uid) : 0,
                    hostPublishPending: uid ? this._hostInventoryPublishPending?.(uid, board) : false
                };
            },

            /** Whether this board tick needs an inventory apply (lag, empty hand, membership drift). */
            _mpInventoryApplyIntent(board, uid, options = {}) {
                if (!board || !uid) return null;
                const inventoryLags = this._mpInventorySeqLag?.(board, uid) ?? false;
                const ownedLen = board.tilesOwnedByPlayer?.[uid]?.length || 0;
                const tilesLen = this.tiles?.length || 0;
                const emptyWithOwned = tilesLen === 0 && ownedLen > 0;
                const membershipDrift = ownedLen > 0 && tilesLen > 0
                    && this._ownedMembershipDrift(board, uid);

                if (options.reset || options.force) {
                    return {
                        force: !!(options.force || inventoryLags || emptyWithOwned || membershipDrift)
                    };
                }
                if (!inventoryLags && !emptyWithOwned && !membershipDrift) {
                    return null;
                }
                if (this.isHost?.() && !emptyWithOwned && !membershipDrift && !inventoryLags) {
                    return null;
                }
                return {
                    force: !!(inventoryLags || emptyWithOwned || membershipDrift)
                };
            },

            /** Guest still behind authority after a failed apply — eligible for async RAF retry. */
            _mpInventoryNeedsRetry(board, uid) {
                if (!board || !uid || this.isHost?.()) return false;
                if (this._mpPendingRevisionBoard) return true;
                const req = this._mpRequireCoherent?.(board, 'inventory-apply', { uid, log: false });
                if (req && !req.ok) return true;
                const ownedLen = board.tilesOwnedByPlayer?.[uid]?.length || 0;
                const tilesLen = this.tiles?.length || 0;
                return this._mpInventorySeqLag?.(board, uid)
                    || (ownedLen > 0 && tilesLen === 0);
            },

            /**
             * Guest inventory lag retry — independent of board.seq advancement.
             * Polls roomData until inventorySeq is projected or attempts exhaust.
             */
            _scheduleMpInventoryReconcile(options = {}) {
                if (!this._isMultiplayerMode?.()) return;
                if (this._mpInvReconcileRaf) return;
                this._mpInvReconcileRaf = requestAnimationFrame(() => {
                    this._mpInvReconcileRaf = 0;
                    const board = this._mpBoardFromRoom(this.roomData);
                    const uid = this._myUid?.();
                    if (!board || !uid) return;
                    const source = options._inventoryApplySource || 'reconcile-raf';
                    const changed = this._applyMpInventoryAxis(board, uid, {
                        force: true,
                        _inventoryApplySource: source
                    });
                    if (changed) {
                        this._mpInvReconcileAttempts = 0;
                        this._mpInventoryProjectionFailed = false;
                        this.requestRender?.();
                        this._syncViewportAfterLayout?.();
                        return;
                    }
                    if (this._mpInventoryNeedsRetry(board, uid)) {
                        this._mpInvReconcileAttempts = (this._mpInvReconcileAttempts || 0) + 1;
                        const attempts = this._mpInvReconcileAttempts;
                        if (attempts === 20 || attempts === 40 || attempts === 60) {
                            this._logMpDiagnostic?.('reconcile-retry', board, uid, {
                                attempts,
                                applySource: source,
                                exhausted: attempts >= 60
                            });
                        }
                        if (attempts < 60) {
                            this._scheduleMpInventoryReconcile({ _inventoryApplySource: source });
                        } else {
                            this._logInventoryProjectionFailure('reconcile-exhausted', board, uid, {
                                attempts,
                                applySource: source
                            });
                        }
                    }
                });
            },

            /**
             * Network membership snapshot — board.tilesOwnedByPlayer only.
             * Host writes authority to _mpOwned, publishes board, then projects from that snapshot.
             */
            _boardAuthoritativeOwned(board, uid) {
                return this._mpNormalizeBoardOwned?.(
                    board?.tilesOwnedByPlayer?.[uid]
                ) || [];
            },

            _isInventorySyncedWithBoard(board, uid) {
                if (!board || !uid) return true;
                if (this.isHost?.() && uid === this._myUid?.()
                    && this.gameStarted && this.canMutatePlayingBoard?.()
                    && !this._reviewUiActive?.()
                    && this._hostIsActivePlayAuthority?.(board)) {
                    const owned = this._mpNormalizeBoardOwned?.(this._mpOwned?.[uid])
                        || this._mpOwned?.[uid]
                        || [];
                    if (owned.length && !this._verifyInventoryMembership(owned, this.tiles)) {
                        return false;
                    }
                    return true;
                }
                const remote = this._boardInventorySeq(board, uid);
                if (remote > this._mpClientInventorySeq?.(uid)) return false;
                const owned = this._boardAuthoritativeOwned(board, uid);
                if (owned.length && !this._verifyInventoryMembership(owned, this.tiles)) {
                    return false;
                }
                return true;
            },

            /** Model tiles for render — must match this.tiles (SSOT; no render-layer membership filter). */
            _tilesForRender() {
                return this.tiles || [];
            },

            /** Stable runtime tile objects — same reference across inventory applies. */
            _acquireMpRuntimeTile(id) {
                if (!id) return null;
                if (!this._mpRuntimeTileById) this._mpRuntimeTileById = {};
                let tile = this._mpRuntimeTileById[id];
                if (!tile) {
                    tile = { id, letter: '', faceUp: true, x: 0, y: 0 };
                    this._mpRuntimeTileById[id] = tile;
                }
                return tile;
            },

            _applyRuntimeTileProps(tile, props = {}) {
                if (!tile) return tile;
                if (props.letter != null && props.letter !== '') tile.letter = props.letter;
                if (props.faceUp != null) tile.faceUp = !!props.faceUp;
                if (Number.isFinite(props.x)) tile.x = props.x;
                if (Number.isFinite(props.y)) tile.y = props.y;
                return tile;
            },

            _ejectMpRuntimeTiles(keepIds) {
                const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
                Object.keys(this._mpRuntimeTileById || {}).forEach((id) => {
                    if (!keep.has(id)) delete this._mpRuntimeTileById[id];
                });
            },

            _clearMpRuntimeTileRegistry() {
                this._mpRuntimeTileById = {};
            },

            _commitRuntimeTileSet(tiles, owned, options = {}) {
                if (!this._mpAllowPlayingTilesCommit?.(options)) {
                    this._logInventoryProjectionFailure?.('playing-tiles-blocked-by-phase', null, this._myUid?.(), {
                        source: options._inventoryApplySource || 'pipeline',
                        projectionMode: this._mpTilesProjectionMode
                    });
                    return false;
                }
                const ids = new Set((owned || []).map((o) => o.id));
                this._ejectMpRuntimeTiles(ids);
                this._commitMpTilesProjection(tiles || [], {
                    mode: 'playing',
                    source: options._inventoryApplySource || 'pipeline',
                    tileCount: (tiles || []).length
                });
                return true;
            },

            _makeRuntimeTileFromOwned(o, rt, pos, tileLetter) {
                const letter = tileLetter(o.id);
                return this._applyRuntimeTileProps(this._acquireMpRuntimeTile(o.id), {
                    letter,
                    faceUp: !!(o.faceUp || rt?.faceUp),
                    x: pos.x,
                    y: pos.y
                });
            },

            /** Membership layer — ids/faceUp from authority (letters hydrated at projection). */
            _buildMembershipStubs(owned) {
                return (owned || []).map((o) => ({
                    id: o.id,
                    faceUp: !!o.faceUp
                }));
            },

            /** Layout layer — positions/spawn only; membership is already fixed in owned. */
            _projectLayoutOntoMembership(owned, layout, layoutRuntime) {
                return this._mergeInventoryWithLayout(owned, layout, layoutRuntime);
            },

            /** Layout projection only — preserve x/y for tiles still in authoritative owned. */
            _layoutRuntimeForProjection(owned) {
                const ownedIds = new Set((owned || []).map((o) => o.id));
                const seen = new Set();
                return (this.tiles || []).filter((t) => {
                    if (!ownedIds.has(t.id) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) {
                        return false;
                    }
                    if (seen.has(t.id)) return false;
                    seen.add(t.id);
                    return true;
                });
            },

            /**
             * During play reuse registry objects when ids still match authority membership.
             * Stable object identity removes peel/dump mid-drag heuristics.
             */
            _shouldKeepRuntimeTiles(board, owned) {
                const ownedIds = new Set((owned || []).map((o) => o.id));
                const runtime = this._layoutRuntimeForProjection(owned);
                if (!runtime.length || !ownedIds.size) return false;
                return runtime.every((t) => ownedIds.has(t.id)
                    && Number.isFinite(t.x) && Number.isFinite(t.y));
            },

            _runtimeTilesForProjection(board, owned, options = {}) {
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                const preferAuthorityLayout = !!options.reset;
                if (devSolvePending || preferAuthorityLayout) return null;
                if (options.keepRuntime || this._shouldKeepRuntimeTiles(board, owned)) {
                    return this._layoutRuntimeForProjection(owned);
                }
                return null;
            },

            /** True when authority owned ids match runtime membership exactly. */
            _membershipIdSetEquals(owned, tiles) {
                const ownedIds = new Set((owned || []).map((o) => o.id));
                const runtimeIds = new Set((tiles || []).map((t) => t.id));
                if (!ownedIds.size && !runtimeIds.size) return true;
                if (ownedIds.size !== runtimeIds.size) return false;
                return [...ownedIds].every((id) => runtimeIds.has(id));
            },

            /**
             * Position-only projection — never changes membership (ids/count).
             * Used when inventorySeq unchanged and authority ids match runtime.
             */
            _projectLayoutPositionsOnly(board, uid, owned, options = {}) {
                if (!owned?.length || !(this.tiles || []).length) return false;
                if (!this._membershipIdSetEquals(owned, this.tiles)) {
                    this._logInventoryProjectionFailure('layout-positions-membership-mismatch', board, uid);
                    return false;
                }
                const layout = this._layoutMapForPlayer(board, uid, owned, options);
                const layoutSource = this._lastMpLayoutAuthority?.source || 'none';
                const stubs = this._buildMembershipStubs?.(owned) || owned;
                if (this._shouldCoerceGuestToRackLayout?.(board, uid, stubs, layout, layoutSource, options)) {
                    const rackTiles = this._rackTilesFromOwned(stubs);
                    const byId = new Map(rackTiles.map((t) => [t.id, t]));
                    const moved = this._mutateMpTilesInPlace('layout-positions-rack-coerce', (tiles) => {
                        let changed = false;
                        tiles.forEach((t) => {
                            const r = byId.get(t.id);
                            if (!r) return;
                            if (t.x !== r.x || t.y !== r.y) {
                                t.x = r.x;
                                t.y = r.y;
                                changed = true;
                            }
                        });
                        return changed;
                    }, { mode: 'playing' });
                    if (moved) {
                        this._setMpClientLayout?.(this._layoutFromTiles?.(this.tiles) || {});
                        this.requestRender?.();
                    }
                    return moved;
                }
                if (!options.reset && !options.force && this.tiles?.length
                    && this._projectedMatchesRackLayout?.(stubs, this.tiles)) {
                    let projected = this._projectLayoutOntoMembership(stubs, layout, null);
                    projected = this._mpHydrateTiles?.(projected) || projected;
                    if (!this._projectedMatchesRackLayout?.(stubs, projected)) {
                        return false;
                    }
                }
                const moved = this._mutateMpTilesInPlace('layout-positions-only', (tiles) => {
                    let changed = false;
                    tiles.forEach((t) => {
                        const p = layout?.[t.id];
                        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
                        if (t.x !== p.x || t.y !== p.y) {
                            t.x = p.x;
                            t.y = p.y;
                            changed = true;
                        }
                    });
                    return changed;
                }, { mode: this._inferMpTilesProjectionMode() });
                if (!moved) return false;
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                if (devSolvePending) this._bananaDevHook('noteSolveBoardApplied', board);
                if (this._shouldPersistMpLayout?.(owned, layout) !== false
                    && this._shouldPersistMpLayoutFromBoardApply?.(board, owned, options)) {
                    this._persistMpLayout();
                } else if (this.isHost?.() && uid === this._myUid?.()) {
                    this._hostRefreshOwnStagedLayoutFromTiles?.();
                }
                return true;
            },

            /** Guest: RTDB layout echoes must not clobber a complete local layout cache. */
            _shouldPersistMpLayoutFromBoardApply(board, owned, options = {}) {
                if (this.isHost?.()) return true;
                if (options.force || options.reset) return true;
                const ownedList = owned || [];
                if (!ownedList.length) return false;
                const localLayout = this._loadLocalLayout?.() || {};
                const localHand = this._loadLocalHand?.() || [];
                if (this._localLayoutMatchesOwned?.(ownedList, localHand, localLayout)) {
                    return false;
                }
                this._hydrateMpClientLayoutFromStorage?.(ownedList);
                const pruned = this._pruneLayout?.(this._mpClientLayout, ownedList) || {};
                if (Object.keys(pruned).length === ownedList.length) return false;
                if (this._isActionInventoryRefresh?.(board)) return true;
                const stored = this._loadLocalHandRecord?.() || { resetCount: null, hand: [] };
                if (!this._storedHandEpochMatchesDeal?.(stored)) return true;
                return false;
            },

            /** Internal — only _applyMpInventoryFromBoard should call the authority pipeline. */
            _replaceInventoryFromAuthority(board, uid, options = {}) {
                return this._applyAuthorityPipeline(board, uid, options);
            },

            /**
             * Action-class board apply — inventory seq, peel/dump seq, membership drift, spawn.
             * Must never be deferred during drag; only layout-only applies defer.
             */
            _mpIsActionClassBoardApply(board, uid, options = {}) {
                if (!board || !uid) return false;
                if (options.reset || options.force) return true;
                if (this._mpInventorySeqLag?.(board, uid)) return true;
                if ((board.peelSeq || 0) > (this._lastPeelSeq || 0)) return true;
                if ((board.dumpSeq || 0) > (this._lastDumpSeq || 0)) {
                    const dumpActor = board.lastDumpTxn?.actorUid;
                    // Remote dumps don't change this player's hand — must not bust layout cache.
                    if (!dumpActor || dumpActor === uid || this._mpInventorySeqLag?.(board, uid)) {
                        return true;
                    }
                }
                if (this._ownedMembershipDrift(board, uid)) return true;
                if (this._bananaDevHook('pendingSolveLayout', board) === true) return true;
                const owned = this._boardAuthoritativeOwned(board, uid);
                if (!(this.tiles?.length) && owned.length > 0) return true;
                return false;
            },

            /** Position-only apply — same membership, inventorySeq unchanged, no action seq advance. */
            _mpIsLayoutOnlyBoardApply(board, uid, options = {}) {
                if (!board || !uid) return false;
                if (options.force || options.reset) return false;
                if (this._mpIsActionClassBoardApply(board, uid, options)) return false;
                const owned = this._boardAuthoritativeOwned(board, uid);
                if (!owned.length || !(this.tiles?.length)) return false;
                return this._membershipIdSetEquals(owned, this.tiles);
            },

            _isActionInventoryRefresh(board) {
                const uid = this._myUid?.();
                if (!board || !uid) return false;
                // Guest tab reload: apply-class spawn must not prefer wire over localStorage layout.
                if (!this.isHost?.() && !(this.tiles?.length)) {
                    const owned = this._boardAuthoritativeOwned(board, uid);
                    if (owned.length && !this._mpInventorySeqLag?.(board, uid)) {
                        const localHand = this._loadLocalHand?.() || [];
                        const localLayout = this._loadLocalLayout?.() || {};
                        if (this._localLayoutMatchesOwned?.(owned, localHand, localLayout)) {
                            return false;
                        }
                    }
                }
                return this._mpIsActionClassBoardApply(board, uid, {});
            },

            _ownedMembershipDrift(board, uid, owned = null) {
                const list = owned
                    || this._mpNormalizeBoardOwned?.(
                        board?.tilesOwnedByPlayer?.[uid]
                    )
                    || [];
                if (!list.length || !(this.tiles || []).length) return false;
                const ownedIds = new Set(list.map((o) => o.id));
                const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                if (ownedIds.size !== runtimeIds.size) return true;
                return list.some((o) => !runtimeIds.has(o.id));
            },

            _finishMergedHand(placed, owned) {
                const hydrated = this._mpHydrateTiles?.(placed) || placed;
                const want = (owned || []).length;
                if (want && hydrated.length !== want) {
                    return this._rackTilesFromOwned(owned);
                }
                if (want) {
                    const ownedIds = new Set((owned || []).map((o) => o.id));
                    const have = new Set((hydrated || []).map((t) => t.id));
                    if (ownedIds.size !== have.size
                        || [...ownedIds].some((id) => !have.has(id))) {
                        return this._rackTilesFromOwned(owned);
                    }
                }
                return hydrated;
            },

            _mergeInventoryWithLayout(owned, layout, runtimeTiles) {
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
                const handById = {};
                if (!this._isMultiplayerMode?.()) {
                    (this._loadLocalHand?.() || []).forEach((h) => {
                        handById[h.id] = h;
                    });
                }
                (runtimeTiles || []).forEach((t) => {
                    runtimeById[t.id] = t;
                });

                const placed = [];
                const needSpawn = [];
                (owned || []).forEach((o) => {
                    if (dragging && runtimeById[o.id]) {
                        const rt = runtimeById[o.id];
                        if (Number.isFinite(rt.x) && Number.isFinite(rt.y)) {
                            placed.push(this._makeRuntimeTileFromOwned(o, rt, rt, tileLetter));
                        } else {
                            needSpawn.push(o);
                        }
                        return;
                    }
                    if (runtimeById[o.id]) {
                        const rt = runtimeById[o.id];
                        if (Number.isFinite(rt.x) && Number.isFinite(rt.y)) {
                            placed.push(this._makeRuntimeTileFromOwned(o, rt, rt, tileLetter));
                        } else if (layoutMap[o.id]
                            && Number.isFinite(layoutMap[o.id].x)
                            && Number.isFinite(layoutMap[o.id].y)) {
                            placed.push(this._makeRuntimeTileFromOwned(o, rt, layoutMap[o.id], tileLetter));
                        } else {
                            needSpawn.push(o);
                        }
                    } else if (layoutMap[o.id]) {
                        const hand = handById[o.id];
                        placed.push(this._applyRuntimeTileProps(this._acquireMpRuntimeTile(o.id), {
                            letter: tileLetter(o.id),
                            faceUp: !!(hand?.faceUp ?? o.faceUp),
                            x: layoutMap[o.id].x,
                            y: layoutMap[o.id].y
                        }));
                    } else {
                        needSpawn.push(o);
                    }
                });
        
                if (!needSpawn.length) return this._finishMergedHand(placed, owned);
                return this._finishMergedHand(
                    this._spawnTilesForOwned(placed, needSpawn, owned, tileLetter),
                    owned
                );
            },

            /** Spawn allocation only — separate from membership/layout placement. */
            _spawnTilesForOwned(placed, needSpawn, owned, tileLetter) {
                if (needSpawn.length === (owned || []).length) {
                    return this._rackTilesFromOwned(owned);
                }
                if (!this.isHost?.()) {
                    const board = this._mpBoardFromRoom?.(this.roomData);
                    const req = this._mpRequireCoherent?.(board, 'spawn-render', { log: false });
                    if (req && !req.ok) {
                        return placed;
                    }
                }
                if (typeof BananaRules === 'undefined') {
                    return this._rackTilesFromOwned(owned);
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
                const out = [...placed];
                if (spots && spots.length === needSpawn.length) {
                    needSpawn.forEach((o, i) => {
                        out.push(this._applyRuntimeTileProps(this._acquireMpRuntimeTile(o.id), {
                            letter: tileLetter(o.id),
                            faceUp: !!o.faceUp,
                            x: spots[i].x,
                            y: spots[i].y
                        }));
                    });
                    return out;
                }
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
                    if (x < left || y < top || x + size > viewportNow.right - pad
                        || y + size > viewportNow.bottom - pad) {
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
                        ? this._applyRuntimeTileProps(this._acquireMpRuntimeTile(o.id), {
                            letter: tileLetter(o.id),
                            faceUp: !!o.faceUp,
                            x: found.x,
                            y: found.y
                        })
                        : this._rackTilesFromOwned([o])[0];
                    forceVisible.push(tile);
                    used.push(tile);
                });
                if (forceVisible.some((t) => Number.isFinite(t?.x) && Number.isFinite(t?.y))) {
                    console.warn('[Bananagrams] viewport spawn full — forced visible fallback', needSpawn.length);
                } else {
                    console.warn('[Bananagrams] viewport spawn full — rack fallback', needSpawn.length);
                }
                forceVisible.forEach((t) => out.push(t));
                return out;
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
                this._hostSyncOwnInventoryProjection?.(uid);
            },

            /**
             * Host recovery — sync inventorySeq from board echo without bumping.
             * Only called from gated board→authority ingress (mirror/hydrate/reconcile).
             */
            _hostSyncInventorySeqFromBoardEcho(uid, seq, inReview = false) {
                if (!this.isHost?.() || !uid || typeof seq !== 'number') return;
                this._hostEnsureMpStores();
                const current = this._mpInventorySeq[uid] || 0;
                if (!inReview && current > 0 && seq < current) {
                    console.warn('[Bananagrams][mirror] stale inventorySeq echo ignored', {
                        player: String(uid).slice(-14),
                        echo: seq,
                        live: current
                    });
                    return;
                }
                if (!inReview && current >= seq) return;
                this._mpInventorySeq[uid] = Math.max(current, seq);
                this._hostSyncOwnInventoryProjection?.(uid);
            },

            /** Block network → host _mpOwned writes during active play. */
            _hostIsNetworkOwnedIngress(meta = {}) {
                const blocked = new Set([
                    'rtdb', 'mirror-board', 'hydrate-board', 'reconcile-board',
                    'dump-hydrate', 'dump-resync', 'dump-board-realign'
                ]);
                return blocked.has(meta.source) || blocked.has(meta.msgType);
            },

            _hostSetOwned(uid, owned, bumpInventory = true, meta = {}) {
                this._hostEnsureMpStores();
                const source = meta.source || 'unknown';
                if (this.isHost?.() && this.gameStarted && this.canMutatePlayingBoard?.()
                    && this._hostIsNetworkOwnedIngress(meta)) {
                    console.error('[HOST_SET_OWNED] blocked network ingress during play', {
                        player: String(uid).slice(-14),
                        source,
                        msgType: meta.msgType || null
                    });
                    return;
                }
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
                if (this.isHost?.() && normalized.length
                    && !this._mpUniqueOwnedIds?.(normalized)) {
                    console.error('[HOST_SET_OWNED] duplicate tile ids after normalize', {
                        player: String(uid).slice(-14),
                        source,
                        action,
                        n: normalized.length
                    });
                }
                this._mpOwned[uid] = normalized;
                if (bumpInventory) this._hostBumpInventorySeq(uid);
                this._hostRepairOwnedFromCanonical?.(`after-set-owned:${uid}`);
            },

            /** Restore host inventory from RTDB only before play — never during active play. */
            _hostHydrateOwnedFromBoard(uid) {
                if (!this.isHost() || !uid) return false;
                const board = this._mpBoardFromRoom(this.roomData);
                if (!this._hostMayIngestBoardToAuthority?.(board)) {
                    console.error('[Bananagrams][inventory] refusing board hydrate — active play authority', {
                        uid: String(uid).slice(-14)
                    });
                    return false;
                }
                if (this._mpOwned?.[uid]?.length) return true;
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
                if (this._isMultiplayerMode?.()) {
                    this._mpAssertProductionAuthorityPath?.('_hostSetPlayerTiles', meta);
                    if (!meta.allowTilesToOwned) {
                        throw new Error(
                            '[MP] _hostSetPlayerTiles forbidden — update layout only, not membership'
                        );
                    }
                    if (!this._mpDevAuthorityBypassAllowed?.(meta)) {
                        throw new Error(
                            '[MP] _hostSetPlayerTiles requires devAuthorityBypass in MP — '
                            + 'use inventory pipeline for production paths'
                        );
                    }
                    console.warn('[Bananagrams][dev] _hostSetPlayerTiles authority bypass', {
                        uid: uid ? String(uid).slice(-14) : null,
                        source: meta.source || null,
                        tileCount: (tiles || []).length
                    });
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
                    const merged = this._mergeInventoryWithLayout(owned, positions, null);
                    this._commitMpTilesProjection(
                        this._mpHydrateTiles?.(merged) || merged,
                        { mode: 'playing', source: 'host-set-player-tiles' }
                    );
                    this._hostSyncOwnInventoryProjection?.(uid);
                    this._setMpClientLayout?.(positions);
                    this._saveLocalLayout?.(positions);
                    this._saveLocalHand?.(this.tiles);
                }
            },

            _markLocalDrag() {
                this._localDragUntil = Date.now() + 32;
                this._mpLocalHandDragAt = Date.now();
            },

            /** Drag ended — flush deferred layout board apply on next frame (fallback timer 120ms). */
            _endLocalDragAndFlushDeferred() {
                this._localDragUntil = Date.now() + 32;
                if (this._canMutatePlayingHand?.()) {
                    this._persistMpLayout?.();
                }
                if (this._mpDeferredBoard && this._canMutatePlayingHand?.()) {
                    this._persistMpLayout?.();
                }
                const runFlush = () => {
                    if (this._isDraggingHand()) return;
                    this._flushDeferredBoardApply();
                };
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(runFlush);
                } else {
                    runFlush();
                }
                if (this._deferredFlushTimer) {
                    clearTimeout(this._deferredFlushTimer);
                }
                this._deferredFlushTimer = setTimeout(() => {
                    this._deferredFlushTimer = 0;
                    runFlush();
                }, 120);
            },

            _clearLocalDragDebounce() {
                this._localDragUntil = 0;
                if (this._deferredFlushTimer) {
                    clearTimeout(this._deferredFlushTimer);
                    this._deferredFlushTimer = 0;
                }
                this._mpDeferredBoard = null;
            },

            _isDraggingHand() {
                return this.isDragging || Date.now() < this._localDragUntil;
            },

            /** Host: project runtime from authority snapshot — never from board echo. */
            _hostApplyLocalOwnedToTiles(uid, removedTileId = null) {
                if (!this.isHost?.() || uid !== this._myUid()) return;
                this._hostEnsureMpStores();
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                if (removedTileId && this._mpPlayerLayouts[uid]) {
                    const next = { ...this._mpPlayerLayouts[uid] };
                    delete next[removedTileId];
                    this._mpPlayerLayouts[uid] = next;
                }
                const board = typeof this._hostAuthorityBoardSnapshot === 'function'
                    ? this._hostAuthorityBoardSnapshot(this._getPlayerUids?.())
                    : null;
                if (!board) {
                    this._logInventoryProjectionFailure('host-local-no-snapshot', null, uid);
                    return;
                }
                const invSeq = this._mpInventorySeq?.[uid] || 0;
                if (this._applyMpInventoryAxis(board, uid, {
                    force: true,
                    inventorySeq: invSeq,
                    _hostAuthorityProjection: true,
                    _inventoryApplySource: 'host-local-owned'
                })) {
                    this.requestRender?.();
                }
            },

            /**
             * Drag-deferred catch-up after drag ends — delegates to board lifecycle
             * (_applyDeferredDragBoardFlush → _applyMultiplayerBoard).
             */
            _flushDeferredBoardApply() {
                const stale = this._mpDeferredBoard;
                this._mpDeferredBoard = null;
                if (!stale || this._isDraggingHand()) return;
                if (!this.canMutatePlayingBoard?.() || this._reviewUiActive?.()) return;
                const uid = this._myUid();
                const board = this._mpBoardFromRoom?.(this.roomData) || stale;
                if (!uid || !board) return;
                if (!this._shouldProjectPlayingInventory?.(board, {})) return;
                if (this.gameStarted && !board.gameStarted) return;

                const actionClass = this._mpIsActionClassBoardApply(board, uid, {});
                this._applyDeferredDragBoardFlush?.(board, { actionClass });
            },

            _serializePositions(tiles = this.tiles) {
                return tiles.map((t) => ({ id: t.id, x: t.x, y: t.y }));
            },

            /**
             * Host recovery only — pre-play / review. During play board echo is downstream;
             * never write _mpOwned, _mpInventorySeq, or layout stores from network.
             * Layout enters only via inventory/layout projection (_applyMpInventoryAxis).
             */
            _mirrorHostInventoryFromBoard(board) {
                if (!this.isHost() || !board) return;
                if (!this._hostMayIngestBoardToAuthority?.(board)) return;
                if (typeof this._isRecentProgrammaticReset === 'function'
                    && this._isRecentProgrammaticReset()) {
                    return;
                }
                const inReview = this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                if (board.tilesOwnedByPlayer) {
                    Object.entries(board.tilesOwnedByPlayer).forEach(([playerUid, owned]) => {
                        if (!Array.isArray(owned) || !owned.length) return;
                        if (!inReview && this._mpOwned?.[playerUid]?.length) return;
                        this._hostSetOwned(playerUid, owned, false, {
                            source: 'mirror-board',
                            action: 'sync',
                            ctx: `host-set-owned:${playerUid}`,
                            msgType: 'mirror-board'
                        });
                    });
                }
                if (board.inventorySeq) {
                    Object.entries(board.inventorySeq).forEach(([playerUid, seq]) => {
                        this._hostSyncInventorySeqFromBoardEcho(playerUid, seq, inReview);
                    });
                }
            },

            _isRecentProgrammaticReset() {
                return !!(this._resetAcknowledgedAt
                    && (Date.now() - this._resetAcknowledgedAt) < 8000);
            },

            _applyMpInventoryFromBoard(board, uid, options = {}) {
                const axisOwned = !!options._inventoryApplyGen;
                if (this.isHost?.() && this.gameStarted && this.canMutatePlayingBoard?.()
                    && !options.reset && !options._hostAuthorityProjection
                    && this._boardPhase(board) !== BananagramsGame.MP_PHASE.REVIEW) {
                    this._logInventoryProjectionFailure('host-board-inventory-blocked', board, uid, {
                        applySource: options._inventoryApplySource || 'board-inventory'
                    });
                    return false;
                }
                if (!this._shouldProjectPlayingInventory?.(board, options)) {
                    if (!this.isHost?.()) {
                        if (this._mpInventorySeqLag?.(board, uid) && !axisOwned) {
                            this._logInventoryProjectionFailure('projection-gate-blocked', board, uid, {
                                remote: this._boardInventorySeq(board, uid),
                                local: this._mpClientInventorySeq?.(uid)
                            });
                            this._scheduleMpInventoryReconcile?.({
                                _inventoryApplySource: options._inventoryApplySource || 'gate-blocked'
                            });
                        }
                    }
                    return false;
                }
                if (this._mpAwaitReset && board && !this._isFreshPostResetBoard?.(board)) {
                    this._logInventoryProjectionFailure('await-reset-blocked', board, uid, {
                        epochFlags: this._mpEpochFlagsSnapshot?.(board)
                    });
                    return false;
                }
                if (!options.force && !options.reset && !options._deferredDragFlush && this._isDraggingHand()) {
                    if (this.gameStarted && board && !board.gameStarted) {
                        this._logInventoryProjectionFailure('drag-split-mismatch', board, uid);
                        return false;
                    }
                    if (this._mpIsLayoutOnlyBoardApply(board, uid, options)) {
                        this._mpDeferredBoard = board;
                        if (this._canMutatePlayingHand?.()) {
                            this._persistMpLayout?.();
                        }
                        this._logInventoryProjectionFailure('drag-deferred', board, uid);
                        return false;
                    }
                    this._logMpDiagnostic?.('drag-action-apply', board, uid, {
                        remote: this._boardInventorySeq(board, uid),
                        local: this._mpClientInventorySeq?.(uid),
                        peelBoard: board?.peelSeq || 0,
                        dumpBoard: board?.dumpSeq || 0
                    });
                }
                if (!options.force && !options.reset && this.gameStarted && board && !board.gameStarted) {
                    this._logInventoryProjectionFailure('pre-split-blocked', board, uid);
                    return false;
                }
                // Guest: ignore duplicate reset-class applies once a hand is visible.
                if (options.reset && !this.isHost?.() && !this._mpAwaitReset
                    && (this.tiles?.length || 0) > 0) {
                    const ownedCheck = this._boardAuthoritativeOwned(board, uid);
                    const lettersWouldShuffle = ownedCheck.some((o) => {
                        const rt = this.tiles.find((t) => t.id === o.id);
                        return rt && rt.letter !== o.letter;
                    });
                    if (this.gameStarted || board?.gameStarted || lettersWouldShuffle) {
                        return false;
                    }
                    options = { ...options, reset: false, force: false };
                }
                const remote = this._boardInventorySeq(board, uid);
                const localSeq = this._mpClientInventorySeq?.(uid) ?? 0;
                const shouldApply = options.reset || options.force
                    || this._mpIsActionClassBoardApply(board, uid, options)
                    || this._mpIsLayoutOnlyBoardApply(board, uid, options);

                if (!shouldApply) return false;

                const handBefore = this.tiles?.length || 0;
                const hadTiles = handBefore > 0;
                const phase = this._mpLifecyclePhase?.(board) || 'idle';
                const inPlayForce = phase === 'pre-split' || phase === 'playing';
                const ownedForce = this._mpOwnedForInventoryApply(board, uid);
                if (options.force && !options.reset && inPlayForce
                    && !ownedForce.length && hadTiles) {
                    this._logInventoryProjectionFailure('force-empty-owned', board, uid);
                    return false;
                }

                let applied = this._replaceInventoryFromAuthority(board, uid, {
                    ...options,
                    inventorySeq: remote
                });
                if (!applied) {
                    this._mpInventoryProjectionFailed = true;
                    if (this._mpInventorySeqLag?.(board, uid) && !axisOwned) {
                        this._scheduleMpInventoryReconcile?.({
                            _inventoryApplySource: options._inventoryApplySource || 'apply-failed'
                        });
                    }
                    return false;
                }
                this._mpAwaitReset = false;
                if (options.reset || (options.force && !hadTiles && (this.tiles?.length || 0) > 0)) {
                    if (typeof this._applyDefaultPlayingViewport === 'function') {
                        this._applyDefaultPlayingViewport();
                    } else {
                        this.centerViewOnOrigin();
                    }
                }
                if (applied) {
                    this.requestRender?.();
                }
                return true;
            }
    });
})(typeof window !== 'undefined' ? window : global);
