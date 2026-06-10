/**
 * Bananagrams MP — inventory authority pipeline (stages).
 *
 * Orchestrator: _applyAuthorityPipeline
 * Stages: bundle gate → seq gate → snapshot → project → commit+boundary (atomic rollback).
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-inventory-pipeline.js');

    Object.assign(G.prototype, {
            /** Snapshot before mutating tiles/seq — restored on boundary failure. */
            _capturePipelineRollback(uid) {
                return {
                    uid,
                    tiles: this.tiles,
                    tilesProjectionMode: this._mpTilesProjectionMode,
                    lastTilesProjection: this._lastMpTilesProjection
                        ? { ...this._lastMpTilesProjection }
                        : null,
                    localSeq: this._mpClientInventorySeq?.(uid) ?? 0,
                    hostInvSeq: (this.isHost?.() && uid === this._myUid?.())
                        ? (this._mpInventorySeq?.[uid] ?? 0)
                        : null,
                    started: this.started,
                    projectionFailed: !!this._mpInventoryProjectionFailed
                };
            },

            _restorePipelineRollback(snap) {
                if (!snap) return;
                this._commitMpTilesProjection?.(snap.tiles || [], {
                    mode: snap.tilesProjectionMode ?? 'playing',
                    source: 'pipeline-rollback',
                    tileCount: snap.tiles?.length ?? 0
                });
                if (!this._commitMpTilesProjection) {
                    this.tiles = snap.tiles;
                    this._mpTilesProjectionMode = snap.tilesProjectionMode ?? 'playing';
                }
                this._lastMpTilesProjection = snap.lastTilesProjection
                    ? { ...snap.lastTilesProjection }
                    : null;
                this._localInventorySeq = snap.localSeq;
                if (snap.hostInvSeq != null && snap.uid) {
                    this._hostEnsureMpStores?.();
                    this._mpInventorySeq[snap.uid] = snap.hostInvSeq;
                }
                this.started = snap.started;
                this._mpInventoryProjectionFailed = snap.projectionFailed;
            },

            _pipelineRejectActionBundles(board, uid) {
                const req = this._mpRequireCoherent?.(board, 'bundle', { uid, log: false });
                if (req?.ok !== false) return true;
                this._mpCoherenceBlock?.(board, 'bundle', uid, {
                    _inventoryApplySource: 'pipeline-bundle'
                });
                return false;
            },

            /**
             * @returns {{ kind: 'layout-only'|'continue'|'reject', owned?, remote?, localSeq?, reason? }}
             */
            _pipelineEvaluateSeqGate(board, uid, owned, options = {}) {
                const remote = options.inventorySeq ?? this._boardInventorySeq(board, uid);
                const localSeq = this._mpClientInventorySeq?.(uid) ?? 0;
                const membershipDrift = owned.length > 0
                    && (this.tiles?.length > 0)
                    && this._ownedMembershipDrift(board, uid, owned);
                const runtimeIds = new Set((this.tiles || []).map((t) => t.id));
                const ownedChanged = owned.length !== (this.tiles?.length || 0)
                    || owned.some((o) => !runtimeIds.has(o.id));
                const seqGateOpen = !!(options.reset || options.force || remote > localSeq);
                const phase = this._mpLifecyclePhase?.(board) || 'idle';
                const inPlay = phase === 'pre-split' || phase === 'playing';

                if (!options.reset && !options.force && remote <= localSeq) {
                    if (!membershipDrift && !ownedChanged) {
                        return { kind: 'layout-only', owned, remote, localSeq };
                    }
                    if (inPlay) {
                        this._logInventoryProjectionFailure(
                            membershipDrift ? 'membership-drift-seq-closed' : 'membership-changed-seq-closed',
                            board,
                            uid,
                            { remote, localSeq, ownedLen: owned.length, tilesLen: this.tiles?.length || 0 }
                        );
                        this._scheduleMpInventoryReconcile?.({
                            _inventoryApplySource: 'pipeline-membership-seq-closed'
                        });
                    }
                    return { kind: 'reject', reason: 'seq-closed' };
                }
                return {
                    kind: 'continue',
                    owned,
                    remote,
                    localSeq,
                    membershipDrift,
                    seqGateOpen,
                    inPlay
                };
            },

            _pipelineValidatePreApply(board, uid, gate, options = {}) {
                const { owned, remote, localSeq, membershipDrift, seqGateOpen, inPlay } = gate;
                const snapshotOk = typeof this._isBoardInventorySnapshotConsistent !== 'function'
                    || this._isBoardInventorySnapshotConsistent(board, uid, owned);
                if (!snapshotOk) {
                    this._mpInventoryProjectionFailed = true;
                    if (!this.isHost?.()) {
                        this._logInventoryProjectionFailure('snapshot-inconsistent', board, uid);
                        this._scheduleMpInventoryReconcile?.({
                            _inventoryApplySource: 'pipeline-snapshot-inconsistent'
                        });
                    }
                    return false;
                }
                if (!seqGateOpen && membershipDrift) {
                    this._logInventoryProjectionFailure('membership-drift-seq-closed', board, uid, {
                        remote,
                        localSeq
                    });
                    this._scheduleMpInventoryReconcile?.({
                        _inventoryApplySource: 'pipeline-membership-drift'
                    });
                    return false;
                }
                if (!options.reset && !options.force && inPlay
                    && !owned.length && (this.tiles?.length > 0)) {
                    this._logInventoryProjectionFailure('empty-owned-in-play', board, uid);
                    return false;
                }
                return true;
            },

            _pipelineTryDevSolveBypass(board, uid, options = {}) {
                if (!this._mpDevAuthorityBypassAllowed?.(options)) return false;
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                if (!devSolvePending || !this.isHost?.() || uid !== this._myUid?.()) return false;
                const ownedNow = this._mpOwnedForInventoryApply(board, uid);
                const lettersOk = (this.tiles || []).every((t) => {
                    const letter = t.letter || this._mpLetter?.(t.id) || '';
                    return /^[A-Z]$/.test(letter);
                });
                if (ownedNow.length
                    && this._verifyInventoryMembership?.(ownedNow, this.tiles)
                    && lettersOk) {
                    const remoteSeq = options.inventorySeq ?? this._boardInventorySeq(board, uid);
                    this._bananaDevHook('noteSolveBoardApplied', board);
                    this._localInventorySeq = remoteSeq;
                    this._hostEnsureMpStores?.();
                    this._mpInventorySeq[uid] = remoteSeq;
                    this._hostSyncOwnInventoryProjection?.(uid);
                    this._mpInventoryProjectionFailed = false;
                    return true;
                }
                return false;
            },

            /**
             * Build projected hand without committing seq or mutating rollback snapshot target.
             * @returns {{ ok: true, tiles, stubs, layout } | { ok: false, reason: string }}
             */
            _pipelineBuildProjectedTiles(board, uid, owned, options = {}) {
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                const phase = this._mpLifecyclePhase?.(board) || 'idle';
                const inPlay = phase === 'pre-split' || phase === 'playing';

                if (options.reset) this._clearLocalLayout();
                if (devSolvePending) this._clearLocalLayout();

                const stubs = this._buildMembershipStubs(owned);
                const layoutOpts = {
                    preferAuthorityLayout: !!options.reset,
                    reset: !!options.reset
                };
                const layout = this._layoutMapForPlayer(board, uid, stubs, layoutOpts);
                const layoutSource = this._lastMpLayoutAuthority?.source || 'none';
                const layoutRuntime = this._runtimeTilesForProjection(board, stubs, options);
                let projected = this._projectLayoutOntoMembership(stubs, layout, layoutRuntime);
                projected = this._mpHydrateTiles?.(projected) || projected;
                let resolvedLayout = layout;

                const coerceStartingRackIfStale = (tiles) => {
                    if (!inPlay || !stubs.length || !tiles?.length) {
                        return { tiles, layout: resolvedLayout };
                    }
                    if (this._projectedMatchesRackLayout?.(stubs, tiles)) {
                        return { tiles, layout: resolvedLayout };
                    }
                    const shouldCoerce = options.reset
                        || this._shouldCoerceGuestToRackLayout?.(
                            board, uid, stubs, resolvedLayout, layoutSource, options
                        );
                    if (!shouldCoerce) {
                        return { tiles, layout: resolvedLayout };
                    }
                    const rackTiles = this._rackTilesFromOwned(stubs);
                    const hydrated = this._mpHydrateTiles?.(rackTiles) || rackTiles;
                    const rackLayout = typeof this._layoutFromTiles === 'function'
                        ? this._layoutFromTiles(hydrated)
                        : resolvedLayout;
                    return { tiles: hydrated, layout: rackLayout };
                };

                ({ tiles: projected, layout: resolvedLayout } = coerceStartingRackIfStale(projected));

                const ownedIds = new Set((stubs || []).map((o) => o.id));
                let tileIds = new Set((projected || []).map((t) => t.id));
                if ((projected || []).length !== tileIds.size) {
                    this._logInventoryProjectionFailure('duplicate-runtime-ids', board, uid);
                    if (inPlay) {
                        return { ok: false, reason: 'duplicate-runtime-ids' };
                    }
                    const deduped = [];
                    const seen = new Set();
                    (projected || []).forEach((t) => {
                        if (!t?.id || seen.has(t.id) || !ownedIds.has(t.id)) return;
                        seen.add(t.id);
                        deduped.push(t);
                    });
                    projected = deduped;
                    tileIds = new Set(deduped.map((t) => t.id));
                }
                if (ownedIds.size !== tileIds.size
                    || [...ownedIds].some((id) => !tileIds.has(id))) {
                    projected = this._projectLayoutOntoMembership(stubs, layout, null);
                    projected = this._mpHydrateTiles?.(projected) || projected;
                    ({ tiles: projected, layout: resolvedLayout } = coerceStartingRackIfStale(projected));
                    tileIds = new Set((projected || []).map((t) => t.id));
                }
                if (stubs.length && (ownedIds.size !== tileIds.size
                    || [...ownedIds].some((id) => !tileIds.has(id)))) {
                    this._logInventoryProjectionFailure('merge-membership-mismatch', board, uid);
                    return { ok: false, reason: 'merge-membership-mismatch' };
                }
                if (!this._verifyInventoryMembership(stubs, projected)) {
                    this._logInventoryProjectionFailure('verify-membership-failed', board, uid);
                    return { ok: false, reason: 'verify-membership-failed' };
                }
                return { ok: true, tiles: projected, stubs, layout: resolvedLayout };
            },

            _pipelineApplyProjectedSideEffects(board, uid, stubs, layout, options = {}) {
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                if (!this.isHost?.()) {
                    this._clearGuestDumpPending?.(board);
                    this._mpLetterIntegrityCheck?.('guest-sync-apply');
                    this._mpDistributionInvariantCheck?.('guest-sync-apply');
                }
                if (devSolvePending) this._bananaDevHook('noteSolveBoardApplied', board);
            },

            _pipelinePersistLayoutIfNeeded(board, stubs, layout, options = {}) {
                if (this._shouldPersistMpLayout?.(stubs, layout) !== false
                    && this._shouldPersistMpLayoutFromBoardApply?.(board, stubs, options)) {
                    this._persistMpLayout();
                }
            },

            /**
             * Atomic commit: assign tiles, advance seq, boundary assert — full rollback on failure.
             * Peel/dump action-seq ack and guest boardRevision commit live in _applyMultiplayerBoard
             * lifecycle (_applyBoardLifecycleCommitOnce), not here.
             */
            _pipelineCommitWithBoundary(board, uid, remote, projected, stubs, layout, options = {}) {
                const rollback = this._capturePipelineRollback(uid);
                if (!this._commitRuntimeTileSet(projected, stubs, options)) {
                    this._restorePipelineRollback(rollback);
                    this._mpInventoryProjectionFailed = true;
                    return false;
                }
                this.started = this.tiles.length > 0;
                this._pipelineApplyProjectedSideEffects(board, uid, stubs, layout, options);

                this._localInventorySeq = remote;
                if (this.isHost?.() && uid === this._myUid?.()) {
                    this._hostEnsureMpStores?.();
                    this._mpInventorySeq[uid] = remote;
                    this._hostSyncOwnInventoryProjection?.(uid);
                }

                let committed = true;
                if (!this.isHost?.()) {
                    committed = typeof this._assertGuestInventoryBoundary !== 'function'
                        || this._assertGuestInventoryBoundary(board, uid, 'authority-pipeline');
                } else {
                    committed = typeof this._assertClientInventoryProjection !== 'function'
                        || this._assertClientInventoryProjection(board, uid, 'authority-pipeline');
                }

                if (!committed) {
                    this._restorePipelineRollback(rollback);
                    this._mpInventoryProjectionFailed = true;
                    if (!this.isHost?.()) {
                        this._scheduleMpInventoryReconcile?.({
                            _inventoryApplySource: 'pipeline-boundary-failed'
                        });
                    }
                    return false;
                }

                this._pipelinePersistLayoutIfNeeded(board, stubs, layout, options);
                this._mpInventoryProjectionFailed = false;
                return true;
            },

            /**
             * definitions → authority → projection → UI
             * Replace membership from board authority, project layout, advance inventorySeq.
             */
            _applyAuthorityPipeline(board, uid, options = {}) {
                if (!this.isHost?.()) {
                    const req = this._mpRequireCoherent?.(board, 'inventory-apply', {
                        ...options,
                        uid,
                        log: false
                    });
                    if (req && !req.ok) {
                        this._mpCoherenceBlock?.(board, 'inventory-apply', uid, {
                            ...options,
                            _inventoryApplySource: options._inventoryApplySource || 'pipeline-inventory'
                        });
                        return false;
                    }
                }
                if (!this._pipelineRejectActionBundles(board, uid)) return false;

                const owned = this._mpOwnedForInventoryApply(board, uid);
                const gate = this._pipelineEvaluateSeqGate(board, uid, owned, options);

                if (gate.kind === 'layout-only') {
                    return this._projectLayoutPositionsOnly(board, uid, gate.owned, options) || false;
                }
                if (gate.kind === 'reject') return false;

                if (this._pipelineTryDevSolveBypass(board, uid, options)) return true;
                if (!this._pipelineValidatePreApply(board, uid, gate, options)) return false;

                const built = this._pipelineBuildProjectedTiles(board, uid, owned, options);
                if (!built.ok) {
                    if (built.reason === 'duplicate-runtime-ids'
                        || built.reason === 'merge-membership-mismatch'
                        || built.reason === 'verify-membership-failed') {
                        this._mpInventoryProjectionFailed = true;
                        if (!this.isHost?.() && built.reason === 'duplicate-runtime-ids') {
                            this._scheduleMpInventoryReconcile?.({
                                _inventoryApplySource: 'pipeline-duplicate-runtime-ids'
                            });
                        }
                    }
                    return false;
                }

                return this._pipelineCommitWithBoundary(
                    board,
                    uid,
                    gate.remote,
                    built.tiles,
                    built.stubs,
                    built.layout,
                    options
                );
            }
    });
})(typeof window !== 'undefined' ? window : global);
