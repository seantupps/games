/**
 * Bananagrams MP dump — single mutation surface.
 *
 * Flow (one-way):
 *   input → command (guest) / commit (host)
 *   → host authority (_mpOwned, _mpInventorySeq)
 *   → network (board publish)
 *   → projection (guest from board; host runtime from authority snapshot)
 *   → UI (pending indicator on guest — no render/membership lie)
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-dump.js');

    const dumpDrawCount = () => (
        typeof BananaRules !== 'undefined' ? BananaRules.DUMP_DRAW_COUNT : 3
    );

    Object.assign(G.prototype, {
            /** Reject partial RTDB merges where dump metadata and inventorySeq diverge. */
            _isBoardDumpBundleCoherent(board) {
                if (!board?.lastDumpTxn) return true;
                const txn = board.lastDumpTxn;
                const dumpSeq = board.dumpSeq || 0;
                const txnDump = txn.dumpSeq ?? dumpSeq;
                if (txnDump !== dumpSeq) return true;
                const actor = txn.actorUid;
                if (!actor || typeof txn.afterInventorySeq !== 'number') return true;
                const inv = board.inventorySeq?.[actor] ?? 0;
                if (inv !== txn.afterInventorySeq) {
                    console.error('[Bananagrams][dump] board truth violation — inventorySeq != lastDumpTxn.afterInventorySeq', {
                        actor: String(actor).slice(-14),
                        inventorySeq: inv,
                        afterInventorySeq: txn.afterInventorySeq,
                        dumpSeq,
                        txn,
                        snapshot: this._snapshotDumpAuthority?.()
                    });
                    return false;
                }
                return true;
            },

            _hostEnsurePlayerInventorySeq(uid) {
                this._hostEnsureMpStores?.();
                if (!this._mpInventorySeq[uid] || this._mpInventorySeq[uid] < 1) {
                    this._mpInventorySeq[uid] = 1;
                }
            },

            _hostMutateDumpInventory(uid, tileId) {
                this._mpEnsureIdPoolModeFromPool?.();
                this._hostEnsureMpStores();
                const owned = [...(this._mpOwned?.[uid] || [])];
                if (!owned.length) {
                    console.error('[Bananagrams][dump] host authority empty — refusing board hydrate during dump', {
                        uid: String(uid).slice(-14),
                        tileId
                    });
                    return { ok: false, reason: 'empty-authority' };
                }
                const idx = owned.findIndex((o) => o.id === tileId);
                if (idx < 0) {
                    console.error('[Bananagrams][dump] tile not in host authority', {
                        uid: String(uid).slice(-14),
                        tileId,
                        ownedLen: owned.length
                    });
                    return { ok: false, reason: 'tile-not-found' };
                }
                const min = dumpDrawCount();
                if ((this._tilePool?.length ?? 0) < min) return { ok: false, reason: 'short-pool' };

                const removed = owned[idx];
                const beforePoolSig = this._mpLetterSigFromPool?.(this._tilePool)
                    ?? this._mpLetterSigFromLetters?.(this._tilePool);
                if (!this._mpAssertIdPoolForMutation?.('host-dump')) {
                    return { ok: false, reason: 'no-id-pool' };
                }
                this._mpRepairHostPoolPartition?.('pre-host-dump');
                if ((this._tilePool?.length ?? 0) < min) {
                    return { ok: false, reason: 'short-pool' };
                }
                owned.splice(idx, 1);
                const handAfterRemove = new Set(owned.map((t) => t.id));
                const nextPool = [...this._tilePool];
                const drawnIds = this._mpDumpTileIdToPool(nextPool, removed.id, min, {
                    handAfterRemove
                });
                if (drawnIds.length < min) {
                    return { ok: false, reason: 'short-pool' };
                }
                this._tilePool = nextPool;
                drawnIds.forEach((id) => {
                    owned.push({ id, faceUp: true });
                });

                this._hostSetOwned(uid, owned, false, {
                    source: 'host-dump',
                    action: 'dump',
                    ctx: `host-set-owned:${uid}`,
                    msgType: 'dump'
                });
                this._mpPoolAudit?.('dump', {
                    beforePoolSig,
                    returnedTile: { id: removed.id },
                    drawnIds,
                    afterPoolSig: this._mpLetterSigFromPool?.(this._tilePool)
                        ?? this._mpLetterSigFromLetters?.(this._tilePool)
                });
                return { ok: true, removedId: removed.id, addedTileIds: drawnIds.slice() };
            },

            /** Host authority: mutate owned/pool, validate, bump seq, publish atomically. */
            _hostCommitDumpTransaction(uid, tileId) {
                if (!uid || !tileId) return false;
                if (!this._hostAssertLiveCoherence?.('host-live-mutation')) return false;
                this._hostEnsureMpStores();
                this._hostEnsurePlayerInventorySeq(uid);
                const beforeSeq = this._mpInventorySeq[uid];
                const rollback = {
                    owned: (this._mpOwned[uid] || []).map((t) => ({ ...t })),
                    pool: [...(this._tilePool || [])],
                    invSeq: beforeSeq,
                    dumpSeq: this._dumpSeq || 0
                };
                const result = this._hostMutateDumpInventory(uid, tileId);
                if (!result.ok) return false;

                const nextDumpSeq = (rollback.dumpSeq || 0) + 1;
                const txn = {
                    type: 'DUMP',
                    requestId: `${Date.now()}_${tileId}`,
                    actorUid: uid,
                    dumpedTileId: result.removedId,
                    addedTileIds: result.addedTileIds || [],
                    beforeInventorySeq: beforeSeq,
                    afterInventorySeq: beforeSeq + 1,
                    beforeOwnedLen: rollback.owned.length,
                    dumpSeq: nextDumpSeq
                };
                const ownedAfter = this._mpOwned[uid] || [];
                if (typeof this._hostValidateDumpTxn === 'function'
                    && !this._hostValidateDumpTxn(txn, ownedAfter)) {
                    this._hostRollbackDumpTransaction(uid, rollback);
                    console.error('[Bananagrams][dump] transaction invariant failed — not publishing', txn);
                    return false;
                }

                this._hostBumpInventorySeq(uid);
                this._hostBumpDump(uid);
                this._lastMpDumpTxn = txn;

                if (!this._hostAssertDumpPublishBundle(uid, txn)) {
                    this._hostRollbackDumpTransaction(uid, rollback);
                    return false;
                }

                // authority → network → runtime projection (host hand only)
                if (!this._hostPublishTxnOrRollback(
                    () => this._hostRollbackDumpTransaction(uid, rollback),
                    'dump'
                )) {
                    return false;
                }
                this._hostProjectRuntimeFromAuthority(uid, result.removedId || tileId);
                this._mpDistributionInvariantCheck?.('host-dump');
                this._mpLetterIntegrityCheck?.('host-dump');
                return true;
            },

            /** Host runtime hand — project from _mpOwned only, never from board echo. */
            _hostProjectRuntimeFromAuthority(uid, removedTileId = null) {
                if (!this.isHost?.() || uid !== this._myUid?.()) return;
                this._hostApplyLocalOwnedToTiles?.(uid, removedTileId);
            },

            _hostRollbackDumpTransaction(uid, rollback) {
                this._hostSetOwned(uid, rollback.owned, false, {
                    source: 'dump-rollback',
                    action: 'sync',
                    ctx: `host-set-owned:${uid}`,
                    msgType: 'dump-rollback'
                });
                this._tilePool = rollback.pool;
                this._mpInventorySeq[uid] = rollback.invSeq;
                this._dumpSeq = rollback.dumpSeq;
                this._lastMpDumpTxn = null;
            },

            /** Fail loud at publish boundary — inventorySeq, dumpSeq, owned must match txn bundle. */
            _hostAssertDumpPublishBundle(uid, txn) {
                const errors = [];
                const inv = this._mpInventorySeq?.[uid];
                const ownedLen = (this._mpOwned?.[uid] || []).length;
                const dumpSeq = this._dumpSeq || 0;
                if (inv !== txn.afterInventorySeq) {
                    errors.push(`inventorySeq live=${inv} txn=${txn.afterInventorySeq}`);
                }
                if (dumpSeq !== txn.dumpSeq) {
                    errors.push(`dumpSeq live=${dumpSeq} txn=${txn.dumpSeq}`);
                }
                if (typeof txn.beforeOwnedLen === 'number' && ownedLen !== txn.beforeOwnedLen + 2) {
                    errors.push(`ownedLen=${ownedLen} expected=${txn.beforeOwnedLen + 2}`);
                }
                if (txn.afterInventorySeq !== txn.beforeInventorySeq + 1) {
                    errors.push(`txn seq coupling ${txn.beforeInventorySeq}->${txn.afterInventorySeq}`);
                }
                if (!this._mpUniqueOwnedIds?.(this._mpOwned?.[uid])) {
                    errors.push('duplicate-owned-ids');
                }
                if (errors.length) {
                    console.error('[Bananagrams][dump] publish bundle invariant failed', {
                        uid: uid ? String(uid).slice(-14) : null,
                        txn,
                        errors,
                        snapshot: this._snapshotDumpAuthority()
                    });
                    return false;
                }
                return true;
            },

            /** @see mp-host-authority.js — _hostAssertPublishBoardAuthority */

            /** Idempotent replay — same tile already dumped in last committed txn. */
            _hostIsDumpAlreadyApplied(uid, tileId) {
                const txn = this._lastMpDumpTxn;
                if (!txn || txn.actorUid !== uid || txn.dumpedTileId !== tileId) return false;
                return (this._dumpSeq || 0) === (txn.dumpSeq ?? this._dumpSeq);
            },

            _hostIsDumpRecordedOnBoard(uid, tileId) {
                const board = this._mpBoardFromRoom?.(this.roomData);
                const txn = board?.lastDumpTxn;
                if (!txn || txn.actorUid !== uid || txn.dumpedTileId !== tileId) return false;
                return (board?.dumpSeq || 0) >= (txn.dumpSeq ?? 0);
            },

            _hostPlayerOwnsTile(uid, tileId) {
                return !!(this._mpOwned?.[uid]?.some((o) => o.id === tileId));
            },

            /**
             * Host interaction handler for guest dump commands.
             * @returns {'handled'|'retry'|'drop'}
             */
            _hostHandleDumpInteraction(uid, msg) {
                if (!msg?.tileId) return 'drop';
                if (this._hostIsDumpAlreadyApplied(uid, msg.tileId)) return 'handled';
                this._mpLetterIntegrityCheck?.('host-dump-reconcile');
                this._mpDistributionInvariantCheck?.('host-dump-reconcile');
                if (this._hostCommitDumpTransaction(uid, msg.tileId)) return 'handled';
                if (!this._hostPlayerOwnsTile(uid, msg.tileId)) {
                    if (this._hostIsDumpAlreadyApplied(uid, msg.tileId)
                        || this._hostIsDumpRecordedOnBoard(uid, msg.tileId)) {
                        return 'handled';
                    }
                    console.warn('[Bananagrams][dump] tile missing but dump not recorded — retry', uid, msg.tileId);
                    return 'retry';
                }
                console.warn('[Bananagrams][dump] guest dump failed on host — will retry', uid, msg.tileId);
                return 'retry';
            },

            /** Guest dump UI overlay — render/input only; never authority or membership. */
            _mpGuestDumpUiPending() {
                const tileId = this._guestDumpPendingTileId;
                if (!tileId) return null;
                return {
                    tileId,
                    renderOnly: true,
                    atLocalSeq: this._guestDumpPendingAtLocalSeq ?? null
                };
            },

            /** Guest: mark dump in flight for UI/input — does not hide from render or change tiles. */
            _guestMarkDumpPending(tileId) {
                if (!tileId || !Array.isArray(this.tiles)) return false;
                if (!this.tiles.some((t) => t.id === tileId)) return false;
                this._guestDumpPendingTileId = tileId;
                this._guestDumpPendingAtLocalSeq = this._mpClientInventorySeq?.(this._myUid?.()) ?? 0;
                return true;
            },

            /** Cleared when board inventory seq advances past the pending stamp. */
            _clearGuestDumpPending(board) {
                if (!this._guestDumpPendingTileId) return;
                if (!board) {
                    this._guestDumpPendingTileId = null;
                    this._guestDumpPendingAtLocalSeq = null;
                    return;
                }
                const uid = this._myUid?.();
                const remote = uid ? this._boardInventorySeq(board, uid) : 0;
                const local = uid ? (this._mpClientInventorySeq?.(uid) ?? 0) : 0;
                const pendingAt = this._guestDumpPendingAtLocalSeq ?? 0;
                if (remote > pendingAt || remote > local) {
                    this._guestDumpPendingTileId = null;
                    this._guestDumpPendingAtLocalSeq = null;
                }
            },

            /** Guest: command only — interaction + UI pending; no membership or render change. */
            _guestSendDumpCommand(tileId) {
                const me = this._myUid?.();
                if (!me || !tileId) return false;
                if (this._mpGuestDumpUiPending?.()) return false;
                if (!this._guestMarkDumpPending(tileId)) return false;
                this._sendBananaInteraction({ type: 'dump', tileId });
                this.requestRender?.();
                return true;
            },

            /** Input entry — host commits locally, guest sends command. Banner after inventory sync. */
            _requestDump(tile) {
                if (!tile?.id) return false;
                if (this.isHost?.()) {
                    return this._hostCommitDumpTransaction(this._myUid(), tile.id);
                }
                if (!this._canMutatePlayingHand?.()) return false;
                return this._guestSendDumpCommand(tile.id);
            },

            _clearDumpClientState() {
                this._guestDumpPendingTileId = null;
                this._guestDumpPendingAtLocalSeq = null;
                this._holdDumpConsumedPointers?.clear?.();
                this._cancelHoldDump?.();
            },

            _snapshotDumpAuthority() {
                const uid = this._myUid?.();
                const board = this._mpBoardFromRoom?.(this.roomData);
                const dumpBundleOk = this._isBoardDumpBundleCoherent?.(board) ?? true;
                return {
                    role: this.isHost?.() ? 'host' : 'guest',
                    uid: uid ? String(uid).slice(-14) : null,
                    dumpSeq: this._dumpSeq ?? board?.dumpSeq ?? 0,
                    boardDumpSeq: board?.dumpSeq ?? 0,
                    lastDumpSeq: this._lastDumpSeq ?? 0,
                    clientInventorySeq: uid != null ? (this._mpClientInventorySeq?.(uid) ?? 0) : 0,
                    boardInventorySeq: uid != null ? (board?.inventorySeq?.[uid] ?? 0) : 0,
                    hostInventorySeq: uid != null ? (this._mpInventorySeq?.[uid] ?? null) : null,
                    dumpBundleCoherent: dumpBundleOk,
                    handTiles: (this.tiles || []).length,
                    handUnique: new Set((this.tiles || []).map((t) => t.id)).size,
                    boardOwnedLen: uid != null
                        ? (board?.tilesOwnedByPlayer?.[uid]?.length ?? null)
                        : null,
                    hostOwnedLen: uid != null ? (this._mpOwned?.[uid]?.length ?? null) : null,
                    pool: this._tilePool?.length ?? 0,
                    dumpPending: this._mpGuestDumpUiPending?.() ?? null,
                    dumpPendingTileId: this._guestDumpPendingTileId ?? null,
                    dumpPendingAtLocalSeq: this._guestDumpPendingAtLocalSeq ?? null,
                    lastDumpTxn: board?.lastDumpTxn ?? this._lastMpDumpTxn ?? null,
                    resetCount: this._mpAppliedResetCount ?? 0,
                    dealEpoch: board?.dealEpoch ?? null
                };
            }
    });

    if (typeof window !== 'undefined') {
        G.registerMpDebug({
            guestDumpUiPending() {
                return window.game?._mpGuestDumpUiPending?.() ?? null;
            }
        });
        window.__bananaDumpDebug = {
            /** Ptest/dev: `page.evaluate(() => __bananaDumpDebug.snapshot())` */
            snapshot() {
                return window.__bananaMpDebug?.snapshot?.() ?? null;
            },
            seqMatrix() {
                return window.__bananaMpDebug?.seqMatrix?.() ?? null;
            },
            inventorySnapshot() {
                return window.__bananaMpDebug?.inventorySnapshot?.() ?? null;
            }
        };
    }
})(typeof window !== 'undefined' ? window : global);
