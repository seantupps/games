/**
 * Bananagrams MP — projection / epoch / reconcile logging registry.
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-log.js');

    /** ctx id → { category, severity, retry?, desc } */
    G.INVENTORY_PROJECTION_CTX = {
        'dump-bundle-incoherent': { category: 'pipeline', severity: 'error', retry: true, desc: 'lastDumpTxn vs inventorySeq diverged' },
        'peel-bundle-incoherent': { category: 'pipeline', severity: 'error', retry: true, desc: 'lastPeelTxn vs inventorySeq diverged' },
        'split-bundle-incoherent': { category: 'pipeline', severity: 'error', retry: true, desc: 'lastSplitTxn vs gameStarted/startedAt/seq diverged' },
        'membership-drift-seq-closed': { category: 'pipeline', severity: 'error', retry: true, desc: 'membership drift while seq gate closed' },
        'membership-changed-seq-closed': { category: 'pipeline', severity: 'error', retry: true, desc: 'owned changed while seq gate closed' },
        'snapshot-inconsistent': { category: 'pipeline', severity: 'error', retry: true, desc: 'board inventory snapshot inconsistent' },
        'empty-owned-in-play': { category: 'pipeline', severity: 'error', retry: false, desc: 'empty owned during play' },
        'duplicate-runtime-ids': { category: 'pipeline', severity: 'error', retry: true, desc: 'duplicate tile ids in runtime hand' },
        'merge-membership-mismatch': { category: 'pipeline', severity: 'error', retry: false, desc: 'projected tiles != authority membership' },
        'verify-membership-failed': { category: 'pipeline', severity: 'error', retry: false, desc: 'membership verify failed after project' },
        'layout-positions-membership-mismatch': { category: 'layout', severity: 'error', retry: false, desc: 'layout-only apply id mismatch' },
        'projection-gate-blocked': { category: 'gate', severity: 'warn', retry: true, desc: 'inventory projection gate blocked apply' },
        'await-reset-blocked': { category: 'epoch', severity: 'warn', retry: true, desc: 'guest awaiting fresh post-reset board' },
        'epoch-stale-board-skipped': { category: 'epoch', severity: 'warn', retry: true, desc: 'epoch bumped but board not fresh deal' },
        'drag-split-mismatch': { category: 'gate', severity: 'warn', retry: false, desc: 'drag deferred — split mismatch' },
        'drag-deferred': { category: 'gate', severity: 'info', retry: true, desc: 'layout-only apply deferred for drag' },
        'drag-action-apply': { category: 'gate', severity: 'info', retry: false, desc: 'action-class apply during drag (not deferred)' },
        'pre-split-blocked': { category: 'gate', severity: 'warn', retry: false, desc: 'pre-split board blocked mid-game' },
        'revision-deferred': { category: 'revision', severity: 'info', retry: true, desc: 'guest waiting for coherent boardRevision bundle' },
        'coherence-blocked': { category: 'coherence', severity: 'info', retry: true, desc: 'apply/render blocked until coherence gate passes' },
        'host-authority-mismatch': { category: 'host', severity: 'error', retry: false, desc: 'host board ingress diverged from live authority' },
        'host-board-inventory-blocked': { category: 'host', severity: 'warn', retry: false, desc: 'board inventory pipeline blocked during host play' },
        'reconcile-exhausted': { category: 'reconcile', severity: 'error', retry: false, desc: 'inventory reconcile RAF exhausted' },
        'reconcile-retry': { category: 'reconcile', severity: 'info', retry: true, desc: 'inventory reconcile retry' },
        'inventory-apply-no-op': { category: 'apply', severity: 'info', retry: false, desc: 'inventory axis no-op' },
        'lifecycle-blocked-pending-inventory': { category: 'lifecycle', severity: 'warn', retry: true, desc: 'lifecycle blocked pending inventory' },
        'host-partial-party': { category: 'host', severity: 'warn', retry: true, desc: 'partial party dealt on host' },
        'host-local-no-snapshot': { category: 'host', severity: 'error', retry: false, desc: 'host local project missing snapshot' },
        'host-initial-deal': { category: 'host', severity: 'error', retry: false, desc: 'host initial deal projection failed' },
        'pool-drift': { category: 'conservation', severity: 'error', retry: false, desc: 'host pool drift vs published board' },
        'pool-cache-drift': { category: 'conservation', severity: 'error', retry: true, desc: 'guest _tilePool cache != wire board.pool after mirror' },
        'owned-tiles-drift': { category: 'conservation', severity: 'error', retry: false, desc: 'owned + pool != expected total' },
        'partial-party-owned': { category: 'conservation', severity: 'warn', retry: true, desc: 'partial party owned on board' },
        'seq-lag-after-apply': { category: 'boundary', severity: 'error', retry: true, desc: 'seq lag after apply' },
        'membership-drift-after-apply': { category: 'boundary', severity: 'error', retry: true, desc: 'membership drift after apply' },
        'boundary-duplicate-runtime-ids': { category: 'boundary', severity: 'error', retry: true, desc: 'duplicate runtime ids at boundary' },
        'boundary-owned-count-mismatch': { category: 'boundary', severity: 'error', retry: true, desc: 'owned count != unique hand ids' },
        'boundary-membership-mismatch': { category: 'boundary', severity: 'error', retry: true, desc: 'membership mismatch at boundary' },
        'boundary-seq-not-synced': { category: 'boundary', severity: 'error', retry: true, desc: 'localSeq != remote at boundary' },
        'boundary-dump-tile-still-owned': { category: 'boundary', severity: 'error', retry: true, desc: 'dumped tile still in hand' },
        'boundary-dump-added-count': { category: 'boundary', severity: 'error', retry: true, desc: 'dump draw count wrong' },
        'boundary-dump-added-missing': { category: 'boundary', severity: 'error', retry: true, desc: 'dump draw ids missing from hand' },
        'boundary-dump-owned-len': { category: 'boundary', severity: 'error', retry: true, desc: 'dump owned len coupling failed' },
        'boundary-dump-seq-coupling': { category: 'boundary', severity: 'error', retry: true, desc: 'dump inventory seq coupling failed' },
        'boundary-peel-drawn-missing': { category: 'boundary', severity: 'error', retry: true, desc: 'peel drawn tile missing' },
        'boundary-peel-owned-len': { category: 'boundary', severity: 'error', retry: true, desc: 'peel owned len coupling failed' },
        'boundary-peel-seq-coupling': { category: 'boundary', severity: 'error', retry: true, desc: 'peel inventory seq coupling failed' },
        'pool-lag': { category: 'pool', severity: 'warn', retry: true, desc: 'action seq advanced but board.pool unchanged' },
        'pool-cache-lag': { category: 'pool', severity: 'error', retry: true, desc: 'guest _tilePool != wire board.pool after apply (should not occur)' }
    };

    Object.assign(G.prototype, {
            _inventoryProjectionCtxMeta(ctx) {
                const reg = G.INVENTORY_PROJECTION_CTX?.[ctx];
                return reg || { category: 'unknown', severity: 'error', retry: null, desc: ctx };
            },

            _logInventoryProjectionFailure(ctx, board, uid, extra = {}) {
                const meta = this._inventoryProjectionCtxMeta(ctx);
                const coherence = typeof this._mpCoherenceSnapshot === 'function'
                    ? this._mpCoherenceSnapshot(board, uid, ctx)
                    : null;
                const payload = {
                    ctx,
                    ...meta,
                    coherence,
                    coherenceFailed: coherence?.failed?.length ? coherence.failed : null,
                    ...this._snapshotInventoryProjection?.(board, uid, ctx),
                    ...extra
                };
                const tag = '[Bananagrams][inventory-projection]';
                if (meta.severity === 'info') {
                    console.info(tag, payload);
                } else if (meta.severity === 'warn') {
                    console.warn(tag, payload);
                } else {
                    console.error(tag, payload);
                }
            },

            /** Epoch / pool / reconcile diagnostics — structured like inventory projection. */
            _logMpDiagnostic(ctx, board, uid, extra = {}) {
                const meta = this._inventoryProjectionCtxMeta(ctx);
                const coherence = typeof this._mpCoherenceSnapshot === 'function'
                    ? this._mpCoherenceSnapshot(board, uid, ctx)
                    : null;
                const payload = {
                    ctx,
                    ...meta,
                    coherence,
                    coherenceFailed: coherence?.failed?.length ? coherence.failed : null,
                    uid: uid ? String(uid).slice(-14) : null,
                    epoch: this._mpReadResetCount?.() ?? null,
                    mpAppliedResetCount: this._mpAppliedResetCount ?? null,
                    mpAwaitReset: !!this._mpAwaitReset,
                    mpEpochSynced: !!this._mpEpochSyncedFromRoom,
                    ...extra
                };
                if (typeof this._snapshotMpSeqMatrix === 'function') {
                    payload.seq = this._snapshotMpSeqMatrix(board, uid, ctx);
                }
                const tag = '[Bananagrams][mp-diagnostic]';
                if (meta.severity === 'info') {
                    console.info(tag, payload);
                } else if (meta.severity === 'warn') {
                    console.warn(tag, payload);
                } else {
                    console.error(tag, payload);
                }
            }
    });
})(typeof window !== 'undefined' ? window : global);
