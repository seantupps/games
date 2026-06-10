/**
 * Bananagrams MP — host/guest authority asymmetry.
 *
 * Host truth: _mpOwned, _tilePool, _mpInventorySeq (never repaired from board during play).
 * Client reads: _mpClientInventorySeq only — wire via _boardInventorySeq for lag/publish checks.
 * Guest truth: room.global.board
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-host-authority.js');

    Object.assign(G.prototype, {
            /** Dev-only MP authority bypass — production must use inventory pipeline. */
            _mpDevAuthorityBypassAllowed(meta = {}) {
                if (!this._isMultiplayerMode?.()) return true;
                return meta.devAuthorityBypass === true
                    || (typeof BananaDev !== 'undefined' && BananaDev.allowAuthorityBypass === true);
            },

            _mpAssertProductionAuthorityPath(fnName, meta = {}) {
                if (!this._isMultiplayerMode?.() || this._mpDevAuthorityBypassAllowed(meta)) return;
                throw new Error(
                    `[MP] ${fnName} forbidden in production MP — use inventory pipeline or dev bundle`
                );
            },

            /**
             * Board → host _mpOwned / _mpInventorySeq / _tilePool ingress allowed only outside active play,
             * or during reset recovery, review, or win transitions.
             */
            _hostMayIngestBoardToAuthority(board, options = {}) {
                if (!this.isHost?.()) return false;
                const inReview = board
                    && this._boardPhase(board) === BananagramsGame.MP_PHASE.REVIEW;
                if (inReview || this._reviewUiActive?.() || this._hostReviewTransitionActive) {
                    return true;
                }
                const winActive = !!(board?.winnerUid || this._winnerUid
                    || this._victoryRegistered || this.isOver);
                if (winActive) return true;
                const prePlay = !this.gameStarted && !board?.gameStarted;
                if (prePlay) return true;
                // Host SSOT during play — never hydrate authority/canonical from board echoes
                // (including force:true deferred drag flushes and post-reset recovery window).
                if (this.gameStarted && this.canMutatePlayingBoard?.()) return false;
                if (options.force || options.reset || options.allowHostFullApply) return true;
                if (typeof this._isRecentProgrammaticReset === 'function'
                    && this._isRecentProgrammaticReset()) {
                    return true;
                }
                return true;
            },

            _hostOwnedIdList(owned) {
                return (owned || []).map((o) => o?.id).filter(Boolean).sort();
            },

            _hostPoolListEqual(a, b) {
                const left = a || [];
                const right = b || [];
                if (left.length !== right.length) return false;
                for (let i = 0; i < left.length; i++) {
                    if (left[i] !== right[i]) return false;
                }
                return true;
            },

            /**
             * Fail loud before publish or when host receives board during play.
             * Board is host output — mismatches log/assert, never mutate authority.
             */
            _hostAssertPublishBoardAuthority(board) {
                if (!this.isHost?.() || !board) return true;
                const errors = [];
                const uids = this._getPlayerUids?.() || [];
                const party = uids.length ? uids : Object.keys(board.tilesOwnedByPlayer || {});

                party.forEach((uid) => {
                    const pub = board.inventorySeq?.[uid];
                    const live = this._mpInventorySeq?.[uid];
                    if (pub !== live) {
                        errors.push(`inventorySeq[${String(uid).slice(-8)}]=${pub} live=${live}`);
                    }
                    const pubOwned = board.tilesOwnedByPlayer?.[uid] || [];
                    const liveOwned = this._mpOwned?.[uid] || [];
                    const pubIds = this._hostOwnedIdList(pubOwned);
                    const liveIds = this._hostOwnedIdList(liveOwned);
                    if (pubIds.length !== liveIds.length
                        || pubIds.some((id, i) => id !== liveIds[i])) {
                        errors.push(`owned[${String(uid).slice(-8)}] pub=${pubIds.length} live=${liveIds.length}`);
                    }
                });

                const livePool = this._tilePool || [];
                const pubPool = board.pool || [];
                if (!this._hostPoolListEqual(pubPool, livePool)) {
                    errors.push(`pool pub=${pubPool.length} live=${livePool.length}`);
                }

                if ((board.dumpSeq || 0) !== (this._dumpSeq || 0)) {
                    errors.push(`dumpSeq pub=${board.dumpSeq} live=${this._dumpSeq}`);
                }
                if ((board.peelSeq || 0) !== (this._peelSeq || 0)) {
                    errors.push(`peelSeq pub=${board.peelSeq} live=${this._peelSeq}`);
                }

                const dumpTxn = board.lastDumpTxn;
                if (dumpTxn && this._lastMpDumpTxn) {
                    if (dumpTxn.dumpSeq !== this._lastMpDumpTxn.dumpSeq) {
                        errors.push('lastDumpTxn.dumpSeq mismatch');
                    }
                    const actor = dumpTxn.actorUid;
                    if (actor && board.inventorySeq?.[actor] !== dumpTxn.afterInventorySeq) {
                        errors.push('lastDumpTxn.afterInventorySeq != inventorySeq[actor]');
                    }
                }

                if (errors.length) {
                    console.error('[Bananagrams][host] publish board authority mismatch', {
                        errors,
                        boardSeq: board.seq ?? null,
                        dump: this._snapshotDumpAuthority?.(),
                        peel: this._snapshotPeelAuthority?.(),
                        split: this._snapshotSplitAuthority?.()
                    });
                    return false;
                }
                return true;
            },

            /** Dump recovery only — never realign host _mpOwned from board during play. */
            _hostRealignOwnedForDump(uid, tileId, board) {
                if (!this.isHost?.() || !uid || !tileId) return false;
                if (!this._hostMayIngestBoardToAuthority(board, { reason: 'dump-realign' })) {
                    console.error('[Bananagrams][dump] refusing board realign during play', {
                        uid: String(uid).slice(-14),
                        tileId
                    });
                    return false;
                }
                const remote = board?.tilesOwnedByPlayer?.[uid];
                if (!Array.isArray(remote) || !remote.length) return false;
                this._hostSetOwned(uid, remote, false, {
                    source: 'dump-board-realign',
                    action: 'sync',
                    ctx: `host-set-owned:${uid}`,
                    msgType: 'dump-board-realign'
                });
                return true;
            },

            /**
             * Host playing publish echo — lifecycle/seq only; runtime hand from _mpOwned authority.
             * Must not rehydrate _mpOwned/_tilePool or run guest inventory pipeline.
             */
            _applyHostPublishEcho(board, traceLabel, applyOptions = {}) {
                board = this._normalizeMpBoard(board);
                const uid = this._myUid?.();
                this._noteBoardApply('host-publish-echo', traceLabel, board);

                this._mirrorBananaAckFromBoard(board);

                if (board.seq != null) {
                    this._boardSeq = board.seq;
                }
                if (uid) {
                    this._hostSyncOwnInventoryProjection?.(uid);
                }

                this._applyMpSharedGameState(board, {
                    inventorySynced: true,
                    poolReason: 'host-publish-echo',
                    hostSkipCanonical: true,
                    hostSkipBanners: true
                });

                this._syncClientPhaseFromBoard(board);
                this._commitMpActionSeqFromBoard(board);
                this._refreshHostPoolHud?.();
                if (uid) {
                    this._hostApplyLocalOwnedToTiles?.(uid);
                }
                this._updateHudEl?.();
                this.renderScoreboard();
                this.requestRender?.();

                if (this._doneTraceOn?.()) {
                    console.log('[Bananagrams][host] publish echo committed', {
                        traceLabel,
                        boardSeq: board.seq,
                        localInventorySeq: uid ? this._mpClientInventorySeq?.(uid) : null,
                        hostInventorySeq: uid ? this._hostLiveInventorySeq(uid) : null
                    });
                }
                return true;
            },

            /** Host active play — board ingress that matches authority → echo; mismatch → fail loud. */
            _hostApplyPlayingBoardIngress(board, traceLabel, options = {}) {
                if (!this._hostAssertPublishBoardAuthority(board)) {
                    this._logInventoryProjectionFailure?.('host-authority-mismatch', board, this._myUid?.(), {
                        traceLabel,
                        applySource: options.applySource || 'host-ingress'
                    });
                    return false;
                }
                return this._applyHostPublishEcho(board, traceLabel, options);
            }
    });
})(typeof window !== 'undefined' ? window : global);
