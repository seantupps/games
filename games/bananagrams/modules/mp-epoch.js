/**
 * Bananagrams MP — room epoch / reset flag registry (single reader + shared cleanup).
 *
 * | Flag | Role |
 * |------|------|
 * | resetCount (RTDB) | Room epoch — board.seq meaningful within epoch |
 * | _mpAppliedResetCount | Client-applied epoch (seed from room on join) |
 * | _mpEpochSyncedFromRoom | True after first seed from roomData |
 * | _mpAwaitReset | Guest waits for fresh post-reset deal board |
 * | _resetAcknowledgedAt | Recent programmatic reset window (~8s) |
 * | _layoutEpoch() | localStorage stamp (= resetCount) |
 * | board.dealEpoch | Deal-scoped tile id pool |
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-epoch.js');

    Object.assign(G.prototype, {
            _mpEpochFlagsSnapshot(board = null) {
                const room = this.roomData;
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                const roomEpoch = S ? S.readResetCount(room) : (room?.global?.resetCount ?? 0);
                return {
                    roomEpoch,
                    mpAppliedResetCount: this._mpAppliedResetCount ?? 0,
                    mpEpochSyncedFromRoom: !!this._mpEpochSyncedFromRoom,
                    mpAwaitReset: !!this._mpAwaitReset,
                    resetAcknowledgedAt: this._resetAcknowledgedAt ?? null,
                    recentProgrammaticReset: !!this._isRecentProgrammaticReset?.(),
                    layoutEpoch: this._layoutEpoch?.() ?? null,
                    boardDealEpoch: board?.dealEpoch ?? null,
                    boardSeq: board?.seq ?? null,
                    localBoardSeq: this._boardSeq ?? null
                };
            },

            /** Seed client epoch from room — includes epoch 0 (fresh room). */
            _seedMpAppliedResetFromRoom() {
                if (!this._isMultiplayerMode?.() || this._mpEpochSyncedFromRoom) return;
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                const epoch = S ? S.readResetCount(this.roomData) : (this.roomData?.global?.resetCount ?? 0);
                this._mpAppliedResetCount = epoch;
                this._mpEpochSyncedFromRoom = true;
            },

            _mpClearActionSeqForReset() {
                this._lastPeelSeq = 0;
                this._lastDumpSeq = 0;
                this._peelSeq = 0;
                this._dumpSeq = 0;
                this._lastPeelDraws = null;
                this._peelActorUid = null;
                this._dumpActorUid = null;
                this._lastMpDumpTxn = null;
                this._lastMpPeelTxn = null;
                this._lastMpSplitTxn = null;
                this._clearDumpClientState?.();
            },

            /** Shared MP client reset — remote signal (await fresh board). */
            _mpResetForRemoteSignal() {
                this._bananaDevHook?.('resetSolveSeq', this);
                this._setGamePhase?.('playing');
                this._exitReviewLocalState?.();
                this._closeReviewEpoch?.();
                this._hostReviewCompleting = false;
                this._clearClientPhaseMirror?.('epoch-reset');
                this._mpAppliedResetCount = this.roomData?.global?.resetCount
                    ?? this._mpReadResetCount?.()
                    ?? this._mpAppliedResetCount
                    ?? 0;
                this._mpEpochSyncedFromRoom = true;
                this.isOver = false;
                this._victoryRegistered = false;
                this._stopTimer?.();
                this._bannerText = '';
                this._bannerPlacement = 'center';
                this._selectedIds?.clear?.();
                this._selectionHighlight = false;
                this._winnerUid = null;
                this._bananaHandled = {};
                this._bananaAck = {};
                this._mpDeferredBoard = null;
                this._mpClearRevisionClientState?.();
                this._localInventorySeq = 0;
                if (this._mpInvReconcileRaf) {
                    cancelAnimationFrame(this._mpInvReconcileRaf);
                    this._mpInvReconcileRaf = 0;
                }
                this._mpInvReconcileAttempts = 0;
                this._mpInventoryProjectionFailed = false;
                this._mpCanonicalReset?.();
                this._clearLocalLayout?.();
                this._mpClearActionSeqForReset();
                this._winnerBannerUid = null;
                this._mpAwaitReset = true;
                this._clearMpTilesProjection?.('epoch-reset', { clearRegistry: true });
                this.gameStarted = false;
                this._resetAcknowledgedAt = Date.now();
                this.elapsedMs = 0;
                this._timerStart = null;
                this._mpStartedAt = null;
                this._resetPlayingViewportAfterReview?.();
            }
    });
})(typeof window !== 'undefined' ? window : global);
