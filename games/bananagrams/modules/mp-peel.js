/**
 * Bananagrams MP peel — single mutation surface (parity with mp-dump.js).
 *
 * Flow (one-way):
 *   input → command (guest) / commit (host)
 *   → host authority (_mpOwned, _mpInventorySeq)
 *   → network (board publish)
 *   → projection (guest from board; host runtime from authority snapshot)
 *   → UI (banners via inventory pipeline)
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-peel.js');

    Object.assign(G.prototype, {
            /** Reject partial RTDB merges where peel metadata and inventorySeq diverge. */
            _isBoardPeelBundleCoherent(board) {
                if (!board?.lastPeelTxn) return true;
                const txn = board.lastPeelTxn;
                const peelSeq = board.peelSeq || 0;
                const txnPeel = txn.peelSeq ?? peelSeq;
                if (txnPeel !== peelSeq) return true;
                const after = txn.afterInventorySeq || {};
                const party = txn.partyUids || Object.keys(after);
                for (const uid of party) {
                    if (typeof after[uid] !== 'number') continue;
                    const inv = board.inventorySeq?.[uid] ?? 0;
                    if (inv !== after[uid]) {
                        console.error('[Bananagrams][peel] board truth violation — inventorySeq != lastPeelTxn.afterInventorySeq', {
                            uid: String(uid).slice(-14),
                            inventorySeq: inv,
                            afterInventorySeq: after[uid],
                            peelSeq,
                            txn,
                            snapshot: this._snapshotPeelAuthority?.()
                        });
                        return false;
                    }
                }
                return true;
            },

            /** Active MP players for peel draws — roster with live hands, not stale room slots. */
            _peelPartyUids(actorUid) {
                const roster = this._getPlayerUids().filter(Boolean);
                this._hostEnsureMpStores?.();
                const board = this._mpBoardFromRoom?.(this.roomData) || {};
                const roomOwned = board.tilesOwnedByPlayer || {};
                const localOwned = this._mpOwned || {};
                const handLen = (uid) => {
                    const local = localOwned[uid];
                    if (Array.isArray(local) && local.length > 0) return local.length;
                    const remote = roomOwned[uid];
                    return Array.isArray(remote) ? remote.length : 0;
                };
                let party = roster.filter((uid) => handLen(uid) > 0);
                if (party.length < 2) party = [...roster];
                if (party.length < 2) {
                    const hostUid = this.roomData?.host || this._myUid();
                    party = [...new Set([hostUid, actorUid].filter(Boolean))];
                }
                return [...new Set(party)].sort();
            },

            _hostStageGuestPeelLayout(uid, guestLayout) {
                if (!guestLayout?.length || uid === this._myUid?.()) return;
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                const positions = {};
                guestLayout.forEach((p) => {
                    if (p?.id != null) positions[p.id] = { x: p.x, y: p.y };
                });
                this._mpPlayerLayouts[uid] = positions;
            },

            /** Host peel validation hand — letters from _mpOwned/canonical only, never guest owned. */
            _hostHandForPeelValidation(uid, guestLayout) {
                const myUid = this._myUid?.();
                if (uid === myUid) {
                    return this._snapHandForValidation?.(this.tiles) || this.tiles;
                }
                if (!guestLayout?.length) return null;
                this._hostStageGuestPeelLayout(uid, guestLayout);
                return this._handFromOwnedAndPositions?.(uid, guestLayout) || null;
            },

            _hostValidatePeelGrid(uid, guestLayout) {
                if (!this._checker || !BananaGrid) return false;
                if (!this.canMutatePlayingBoard?.()) return false;
                const handRaw = this._hostHandForPeelValidation(uid, guestLayout);
                if (handRaw?.length) {
                    const origin = { x: this.ORIGIN, y: this.ORIGIN };
                    const layoutOpts = this._rackLayoutOptions?.();
                    if (BananaGrid.isStartingRack(handRaw, origin, layoutOpts)) {
                        return false;
                    }
                }
                const hand = this._snapHandForValidation?.(handRaw) || handRaw;
                if (!hand?.length || hand.length < 3) return false;
                const result = BananaGrid.validateGrid(hand, this._checker);
                if (!result.ok || !this._allTilesPlacedOn?.(hand)) return false;
                return (result.words || []).some((w) => String(w || '').length >= 3);
            },

            /** Host peel baseline — live _mpOwned only; no board hydrate during play. */
            _hostPeelOwnedBaseline(uids) {
                const ownedByUid = {};
                (uids || []).forEach((u) => {
                    if (!this._mpOwned?.[u]?.length) {
                        console.error('[Bananagrams][peel] baseline empty — authority missing', {
                            uid: String(u).slice(-14)
                        });
                    }
                    ownedByUid[u] = (this._mpOwned?.[u] || []).map((t) => ({
                        id: t.id,
                        faceUp: !!t.faceUp
                    }));
                });
                return ownedByUid;
            },

            _hostMutatePeelInventory(actorUid, partyUids) {
                this._mpEnsureIdPoolModeFromPool?.();
                this._hostEnsureMpStores();
                const uids = partyUids || [];
                const playerCount = uids.length;
                if (!playerCount || !this._tilePool?.length || this._tilePool.length < playerCount) {
                    return { ok: false, reason: 'short-pool' };
                }
                if (!this._mpAssertIdPoolForMutation?.('host-peel')) {
                    return { ok: false, reason: 'no-id-pool' };
                }
                this._mpRepairHostPoolPartition?.('pre-host-peel');

                const ownedByUid = this._hostPeelOwnedBaseline(uids);
                const beforePoolLen = this._tilePool.length;
                const beforePoolSig = this._mpLetterSigFromPool?.(this._tilePool)
                    ?? this._mpLetterSigFromLetters?.(this._tilePool);
                const drawn = {};
                const drawnIds = {};
                const drawnTiles = [];

                uids.forEach((u) => {
                    const ids = this._mpDrawIdsFromPool(this._tilePool, 1);
                    if (!ids.length) return;
                    const id = ids[0];
                    if (!ownedByUid[u]) ownedByUid[u] = [];
                    const letter = this._mpLetter(id);
                    ownedByUid[u].push({ id, faceUp: true });
                    drawn[u] = letter;
                    drawnIds[u] = id;
                    drawnTiles.push({ id, letter, player: u });
                });

                if (Object.keys(drawn).length !== playerCount) {
                    return { ok: false, reason: 'draw-failed' };
                }

                uids.forEach((u) => {
                    this._hostSetOwned(u, ownedByUid[u] || [], false, {
                        source: 'host-peel',
                        action: 'peel',
                        ctx: `host-set-owned:${u}`,
                        msgType: 'peel'
                    });
                });

                this._mpPoolAudit?.('peel', {
                    beforePoolSig,
                    returnedTile: null,
                    drawnTiles,
                    afterPoolSig: this._mpLetterSigFromPool?.(this._tilePool)
                        ?? this._mpLetterSigFromLetters?.(this._tilePool),
                    ownedSig: this._mpCombinedOwnedSig?.(),
                    combinedSig: `${this._mpLetterSigFromPool?.(this._tilePool) ?? ''}+${this._mpCombinedOwnedSig?.()}`
                });

                return {
                    ok: true,
                    actorUid,
                    partyUids: uids,
                    drawn,
                    drawnIds,
                    beforePoolLen,
                    afterPoolLen: this._tilePool.length,
                    ownedByUid
                };
            },

            /** Host authority: validate grid, mutate owned/pool, validate txn, bump seq, publish. */
            _hostCommitPeelTransaction(uid, guestLayout = null) {
                if (!uid) return false;
                if (!this._hostAssertLiveCoherence?.('host-live-mutation')) return false;
                if (!this._hostValidatePeelGrid(uid, guestLayout)) return false;

                this._hostEnsureMpStores();
                const partyUids = this._peelPartyUids(uid);
                partyUids.forEach((u) => this._hostEnsurePlayerInventorySeq?.(u));

                const beforeInventorySeq = Object.fromEntries(
                    partyUids.map((u) => [u, this._mpInventorySeq?.[u] || 0])
                );
                const rollback = {
                    owned: Object.fromEntries(
                        partyUids.map((u) => [u, (this._mpOwned?.[u] || []).map((t) => ({ ...t }))])
                    ),
                    pool: [...(this._tilePool || [])],
                    peelSeq: this._peelSeq || 0,
                    invSeq: { ...beforeInventorySeq },
                    peelDraws: this._lastPeelDraws
                };

                const result = this._hostMutatePeelInventory(uid, partyUids);
                if (!result.ok) return false;

                const nextPeelSeq = (rollback.peelSeq || 0) + 1;
                const afterInventorySeq = Object.fromEntries(
                    partyUids.map((u) => [u, (beforeInventorySeq[u] || 0) + 1])
                );
                const txn = {
                    type: 'PEEL',
                    requestId: `${Date.now()}_${uid}`,
                    actorUid: uid,
                    partyUids,
                    drawnIds: result.drawnIds,
                    beforePoolLen: result.beforePoolLen,
                    afterPoolLen: result.afterPoolLen,
                    peelSeq: nextPeelSeq,
                    beforeInventorySeq,
                    afterInventorySeq,
                    beforeOwnedLen: Object.fromEntries(
                        partyUids.map((u) => [u, (rollback.owned[u] || []).length])
                    )
                };

                if (typeof this._hostValidatePeelTxn === 'function'
                    && !this._hostValidatePeelTxn(txn, result.ownedByUid)) {
                    this._hostRollbackPeelTransaction(partyUids, rollback);
                    console.error('[Bananagrams][peel] transaction invariant failed — not publishing', txn);
                    return false;
                }

                partyUids.forEach((u) => this._hostBumpInventorySeq(u));
                this._hostBumpPeel(uid);
                this._lastPeelDraws = result.drawn;
                this._lastMpPeelTxn = txn;

                if (!this._hostAssertPeelPublishBundle(txn, partyUids)) {
                    this._hostRollbackPeelTransaction(partyUids, rollback);
                    return false;
                }

                if (typeof this._hostCancelPendingBoardSync === 'function') {
                    this._hostCancelPendingBoardSync();
                }
                this._hostRepairOwnedFromCanonical?.('host-peel');

                if (!this._hostPublishTxnOrRollback(
                    () => this._hostRollbackPeelTransaction(partyUids, rollback),
                    'peel'
                )) {
                    return false;
                }

                this._hostProjectPeelRuntimeFromAuthority(partyUids);
                if (this.roomData?.global?.board && Array.isArray(this._tilePool)) {
                    this._syncHostPoolOnRoomCaches?.();
                }
                this._mpDistributionInvariantCheck?.('host-peel');
                this._mpLetterIntegrityCheck?.('host-peel');
                this.requestRender?.();
                return true;
            },

            _hostProjectPeelRuntimeFromAuthority(partyUids) {
                if (!this.isHost?.()) return;
                const myUid = this._myUid?.();
                if (myUid && partyUids.includes(myUid)) {
                    this._hostApplyLocalOwnedToTiles?.(myUid);
                }
                this._refreshPoolHud?.();
            },

            _hostRollbackPeelTransaction(partyUids, rollback) {
                this._tilePool = rollback.pool;
                this._peelSeq = rollback.peelSeq;
                this._lastPeelDraws = rollback.peelDraws ?? null;
                this._lastMpPeelTxn = null;
                (partyUids || []).forEach((u) => {
                    this._hostSetOwned(u, rollback.owned[u] || [], false, {
                        source: 'peel-rollback',
                        action: 'sync',
                        ctx: `host-set-owned:${u}`,
                        msgType: 'peel-rollback'
                    });
                    if (rollback.invSeq[u] != null) {
                        this._mpInventorySeq[u] = rollback.invSeq[u];
                    }
                });
            },

            _hostAssertPeelPublishBundle(txn, partyUids) {
                const errors = [];
                const peelSeq = this._peelSeq || 0;
                if (peelSeq !== txn.peelSeq) {
                    errors.push(`peelSeq live=${peelSeq} txn=${txn.peelSeq}`);
                }
                (partyUids || []).forEach((uid) => {
                    const inv = this._mpInventorySeq?.[uid];
                    const after = txn.afterInventorySeq?.[uid];
                    const before = txn.beforeInventorySeq?.[uid];
                    if (inv !== after) {
                        errors.push(`inventorySeq[${String(uid).slice(-8)}]=${inv} txn=${after}`);
                    }
                    if (typeof before === 'number' && after !== before + 1) {
                        errors.push(`txn seq coupling ${before}->${after} for ${String(uid).slice(-8)}`);
                    }
                    const ownedLen = (this._mpOwned?.[uid] || []).length;
                    const beforeLen = txn.beforeOwnedLen?.[uid];
                    if (typeof beforeLen === 'number' && ownedLen !== beforeLen + 1) {
                        errors.push(`ownedLen[${String(uid).slice(-8)}]=${ownedLen} expected=${beforeLen + 1}`);
                    }
                    if (!this._mpUniqueOwnedIds?.(this._mpOwned?.[uid])) {
                        errors.push(`duplicate-owned-ids:${String(uid).slice(-8)}`);
                    }
                });
                if (errors.length) {
                    console.error('[Bananagrams][peel] publish bundle invariant failed', {
                        txn,
                        errors,
                        snapshot: this._snapshotPeelAuthority?.()
                    });
                    return false;
                }
                return true;
            },

            /** Host: serialized board must mirror live peel authority before RTDB write. */
            _hostAssertPeelSerializedBoardAuthority(board) {
                if (!this.isHost?.() || !board) return true;
                const errors = [];
                if ((board.peelSeq || 0) !== (this._peelSeq || 0)) {
                    errors.push(`peelSeq pub=${board.peelSeq} live=${this._peelSeq}`);
                }
                const txn = board.lastPeelTxn;
                if (txn && this._lastMpPeelTxn) {
                    if (txn.peelSeq !== this._lastMpPeelTxn.peelSeq) {
                        errors.push('lastPeelTxn.peelSeq mismatch');
                    }
                    const party = txn.partyUids || [];
                    party.forEach((uid) => {
                        const after = txn.afterInventorySeq?.[uid];
                        if (typeof after === 'number' && board.inventorySeq?.[uid] !== after) {
                            errors.push(`lastPeelTxn.afterInventorySeq != inventorySeq[${String(uid).slice(-8)}]`);
                        }
                    });
                }
                if (errors.length) {
                    console.error('[Bananagrams][peel] serialized board authority mismatch', {
                        errors,
                        snapshot: this._snapshotPeelAuthority?.()
                    });
                    return false;
                }
                return true;
            },

            _hostIsPeelAlreadyApplied(uid, guestLayout) {
                const txn = this._lastMpPeelTxn;
                if (!txn || txn.actorUid !== uid) return false;
                return (this._peelSeq || 0) === (txn.peelSeq ?? this._peelSeq);
            },

            /**
             * Host interaction handler for guest peel commands (layout only — no guest owned).
             * @returns {'handled'|'retry'|'drop'}
             */
            _hostHandlePeelInteraction(uid, msg) {
                const layout = Array.isArray(msg?.positions) ? msg.positions : null;
                if (!layout?.length) return 'drop';
                if (this._hostIsPeelAlreadyApplied(uid, layout)) return 'handled';
                this._mpLetterIntegrityCheck?.('host-peel-reconcile');
                this._mpDistributionInvariantCheck?.('host-peel-reconcile');
                if (this._hostCommitPeelTransaction(uid, layout)) return 'handled';
                console.warn('[Bananagrams][peel] guest peel failed on host — drop', uid);
                return 'drop';
            },

            /** Guest: command only — positions snapshot; no owned letters on wire. */
            _guestSendPeelCommand(positions) {
                const me = this._myUid?.();
                if (!me || !Array.isArray(positions) || !positions.length) return false;
                this._sendBananaInteraction({ type: 'peel', positions });
                return true;
            },

            /** Input entry — host commits locally, guest sends command. Banner after inventory sync. */
            _requestPeel(handForValidation) {
                if (!this._canMutatePlayingHand?.()) return false;
                const me = this._myUid?.();
                if (!me) return false;
                if (this.isHost?.()) {
                    return this._hostCommitPeelTransaction(me, null);
                }
                const hand = handForValidation
                    || this._snapHandForValidation?.(this.tiles)
                    || this.tiles;
                const positions = this._serializePositions?.(hand) || [];
                return this._guestSendPeelCommand(positions);
            },

            _snapshotPeelAuthority() {
                const uid = this._myUid?.();
                const board = this._mpBoardFromRoom?.(this.roomData);
                const peelBundleOk = this._isBoardPeelBundleCoherent?.(board) ?? true;
                return {
                    role: this.isHost?.() ? 'host' : 'guest',
                    uid: uid ? String(uid).slice(-14) : null,
                    peelSeq: this._peelSeq ?? board?.peelSeq ?? 0,
                    boardPeelSeq: board?.peelSeq ?? 0,
                    lastPeelSeq: this._lastPeelSeq ?? 0,
                    peelBundleCoherent: peelBundleOk,
                    pool: this._tilePool?.length ?? 0,
                    lastPeelTxn: board?.lastPeelTxn ?? this._lastMpPeelTxn ?? null,
                    lastPeelDraws: this._lastPeelDraws ?? null
                };
            }
    });
})(typeof window !== 'undefined' ? window : global);
