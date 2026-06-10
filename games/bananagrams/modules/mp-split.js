/**
 * Bananagrams MP split — single mutation surface (parity with mp-dump.js / mp-peel.js).
 *
 * Flow (one-way):
 *   input → command (guest) / commit (host)
 *   → host authority (gameStarted, startedAt, face-up)
 *   → network (board publish + lastSplitTxn bundle)
 *   → projection (guest from coherent board bundle)
 *   → UI (face-up, timer)
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-split.js');

    Object.assign(G.prototype, {
            _readRoomResetCount() {
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                return S ? S.readResetCount(this.roomData) : (this.roomData?.global?.resetCount ?? 0);
            },

            /** Inline bundle checks for snapshots — must not call _snapshotSplitAuthority (recursion). */
            _splitBundleCoherentInline(board) {
                if (!board?.lastSplitTxn) return true;
                if (!board.gameStarted) return true;
                const txn = board.lastSplitTxn;
                const resetCount = this._readRoomResetCount();
                if (typeof txn.resetCount === 'number' && txn.resetCount !== resetCount) return false;
                if (typeof txn.startedAt === 'number' && txn.startedAt !== board.startedAt) return false;
                if (typeof txn.afterBoardSeq === 'number' && (board.seq ?? 0) < txn.afterBoardSeq) {
                    return false;
                }
                return true;
            },

            /** Reject partial RTDB merges where split metadata and lifecycle fields diverge. */
            _isBoardSplitBundleCoherent(board) {
                if (!board?.lastSplitTxn) return true;
                if (!board.gameStarted) return true;
                const txn = board.lastSplitTxn;
                const resetCount = this._readRoomResetCount();
                if (typeof txn.resetCount === 'number' && txn.resetCount !== resetCount) {
                    console.error('[Bananagrams][split] board truth violation — resetCount != lastSplitTxn.resetCount', {
                        roomResetCount: resetCount,
                        txnResetCount: txn.resetCount,
                        boardSeq: board.seq ?? null,
                        txn
                    });
                    return false;
                }
                if (board.gameStarted && typeof txn.startedAt === 'number'
                    && txn.startedAt !== board.startedAt) {
                    console.error('[Bananagrams][split] board truth violation — startedAt != lastSplitTxn.startedAt', {
                        boardStartedAt: board.startedAt ?? null,
                        txnStartedAt: txn.startedAt,
                        boardSeq: board.seq ?? null,
                        txn
                    });
                    return false;
                }
                if (typeof txn.afterBoardSeq === 'number' && (board.seq ?? 0) < txn.afterBoardSeq) {
                    console.error('[Bananagrams][split] board truth violation — board.seq < lastSplitTxn.afterBoardSeq', {
                        boardSeq: board.seq ?? null,
                        afterBoardSeq: txn.afterBoardSeq,
                        gameStarted: board.gameStarted ?? null,
                        txn
                    });
                    return false;
                }
                return true;
            },

            /** Guest: trust gameStarted flip only when split bundle is coherent. */
            _mpGuestWireGameStarted(board) {
                if (!board?.gameStarted) return false;
                if (board.lastSplitTxn) {
                    return this._isBoardSplitBundleCoherent(board);
                }
                if (!board.startedAt) return false;
                const uid = this._myUid?.();
                if (uid) {
                    const owned = board.tilesOwnedByPlayer?.[uid];
                    if (!Array.isArray(owned) || !owned.length) return false;
                    const inv = board.inventorySeq?.[uid] ?? 0;
                    if (inv < 1) return false;
                }
                return true;
            },

            _hostRollbackSplitTransaction(rollback) {
                this.gameStarted = rollback.gameStarted;
                this._mpStartedAt = rollback.mpStartedAt;
                Object.entries(rollback.ownedFaceUp || {}).forEach(([uid, list]) => {
                    const owned = this._mpOwned?.[uid];
                    if (!owned?.length) return;
                    const faceById = {};
                    (list || []).forEach((e) => { faceById[e.id] = e.faceUp; });
                    owned.forEach((t) => {
                        if (faceById[t.id] !== undefined) t.faceUp = faceById[t.id];
                    });
                });
                this._lastMpSplitTxn = null;
            },

            /** Fail loud at publish boundary — gameStarted, startedAt, board.seq must match txn bundle. */
            _hostAssertSplitPublishBundle(txn) {
                const errors = [];
                if (!this.gameStarted) errors.push('gameStarted=false');
                if (this._mpStartedAt !== txn.startedAt) {
                    errors.push(`startedAt live=${this._mpStartedAt} txn=${txn.startedAt}`);
                }
                const expectedSeq = (this._boardSeq || 0) + 1;
                if (txn.afterBoardSeq !== expectedSeq) {
                    errors.push(`afterBoardSeq=${txn.afterBoardSeq} expected=${expectedSeq}`);
                }
                const resetCount = this._readRoomResetCount();
                if (txn.resetCount !== resetCount) {
                    errors.push(`resetCount txn=${txn.resetCount} room=${resetCount}`);
                }
                if (errors.length) {
                    console.error('[Bananagrams][split] publish bundle invariant failed', {
                        txn,
                        errors,
                        snapshot: this._snapshotSplitAuthority?.()
                    });
                    return false;
                }
                return true;
            },

            /** Host: serialized board must mirror live split authority before RTDB write. */
            _hostAssertSerializedSplitBoardAuthority(board) {
                if (!this.isHost?.() || !board) return true;
                const txn = board.lastSplitTxn;
                if (!txn || !this._lastMpSplitTxn) return true;
                const errors = [];
                if (board.gameStarted !== true) errors.push('gameStarted!=true');
                if (board.startedAt !== txn.startedAt) {
                    errors.push(`startedAt pub=${board.startedAt} txn=${txn.startedAt}`);
                }
                // board.seq advances on peel/dump after split — only require split epoch not rolled back.
                if ((board.seq ?? 0) < txn.afterBoardSeq) {
                    errors.push(`seq pub=${board.seq} txn=${txn.afterBoardSeq}`);
                }
                if (txn.afterBoardSeq !== this._lastMpSplitTxn.afterBoardSeq) {
                    errors.push('lastSplitTxn.afterBoardSeq mismatch');
                }
                const resetCount = this._readRoomResetCount();
                if (txn.resetCount !== resetCount) {
                    errors.push(`resetCount pub=${txn.resetCount} room=${resetCount}`);
                }
                if (errors.length) {
                    console.error('[Bananagrams][split] serialized board authority mismatch', {
                        errors,
                        snapshot: this._snapshotSplitAuthority?.()
                    });
                    return false;
                }
                return true;
            },

            /** Host authority: flip play state, validate, publish atomically with lastSplitTxn. */
            _hostCommitSplitTransaction() {
                if (this.gameStarted) return false;
                this._exitReviewLocalState?.();
                this._setGamePhase?.('playing');
                if (this._reviewUiActive?.() || this._hostReviewCompleting) return false;

                const startedAt = Date.now();
                const resetCount = Math.max(
                    this.lastResetCount ?? 0,
                    this._readRoomResetCount()
                );
                const afterBoardSeq = (this._boardSeq || 0) + 1;
                const rollback = {
                    gameStarted: this.gameStarted,
                    mpStartedAt: this._mpStartedAt,
                    ownedFaceUp: {}
                };
                Object.entries(this._mpOwned || {}).forEach(([uid, owned]) => {
                    rollback.ownedFaceUp[uid] = (owned || []).map((t) => ({
                        id: t.id,
                        faceUp: !!t.faceUp
                    }));
                });

                this.gameStarted = true;
                this._mpStartedAt = startedAt;
                Object.values(this._mpOwned || {}).forEach((owned) => {
                    (owned || []).forEach((t) => { t.faceUp = true; });
                });
                this._syncMpTimerFromBoard(startedAt);

                const txn = {
                    type: 'SPLIT',
                    requestId: `${Date.now()}_split`,
                    resetCount,
                    startedAt,
                    afterBoardSeq
                };

                if (typeof this._hostValidateSplitTxn === 'function'
                    && !this._hostValidateSplitTxn(txn)) {
                    this._hostRollbackSplitTransaction(rollback);
                    console.error('[Bananagrams][split] transaction invariant failed — not publishing', txn);
                    return false;
                }

                this._lastMpSplitTxn = txn;

                if (!this._hostAssertSplitPublishBundle(txn)) {
                    this._hostRollbackSplitTransaction(rollback);
                    return false;
                }

                if (!this._hostPublishTxnOrRollback(
                    () => this._hostRollbackSplitTransaction(rollback),
                    'split'
                )) {
                    return false;
                }

                this._mpAppliedResetCount = resetCount;
                this._mpEpochSyncedFromRoom = true;
                this._mpAwaitReset = false;

                this.requestRender?.();
                return true;
            },

            _snapshotSplitAuthority() {
                const board = this._mpBoardFromRoom?.(this.roomData);
                const txn = board?.lastSplitTxn ?? this._lastMpSplitTxn ?? null;
                return {
                    gameStarted: this.gameStarted,
                    boardGameStarted: board?.gameStarted ?? null,
                    mpStartedAt: this._mpStartedAt ?? null,
                    boardStartedAt: board?.startedAt ?? null,
                    boardSeq: board?.seq ?? null,
                    localBoardSeq: this._boardSeq ?? null,
                    resetCount: this._readRoomResetCount(),
                    lastSplitTxn: txn,
                    coherent: this._splitBundleCoherentInline?.(board) ?? null
                };
            }
    });
})(typeof window !== 'undefined' ? window : global);
