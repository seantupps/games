/**
 * Bananagrams MP — consolidated __bananaMpDebug entry (load last among MP modules).
 *
 * Individual helpers register via BananagramsGame.registerMpDebug from feature modules;
 * this file owns snapshot(), gamePhase(), and help() discoverability.
 */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) return;

    const HELP = {
        snapshot: 'Full triage bundle — seq, epoch, inventory, coherence, revision, phase, layout',
        clientState: 'Stable ptest read API — prefer over private game fields in page.evaluate',
        gamePhase: 'Phase SSOT — _clientMpPhaseSnapshot (wire, transition, command, reviewProjection)',
        seqMatrix: 'All seq counters (inventory, peel/dump, pool, board apply)',
        inventorySnapshot: 'Inventory projection + tilesProjection mode',
        inventoryCounters: 'Host/guest inventory seq stores (wire, local, hostLive, client)',
        coherence: 'Unified coherence flags (inventorySynced, bundles, revision)',
        requireCoherent: 'Run coherence gate for ctx (default | host-live-mutation | …)',
        revision: 'boardRevision / structural apply key gate state',
        layoutAuthority: 'Resolved layout tier + store drift summary',
        layoutStores: 'All layout stores side-by-side (wire, client, host-staged, runtime, localStorage)',
        guestDumpUiPending: 'Guest dump UI overlay (renderOnly — not authority)',
        guestHandMutationAllowed: 'Guest peel/dump/drag gate (_canMutatePlayingHand)',
        guestAuthorityReady: 'Guest wire authority ready for hand mutations',
        displayPoolLen: 'HUD pool count (_tilePool; guest mirrors wire on apply)',
        hostPoolStores: 'Host live pool vs roomData/canonical copies (debug triage)',
        help: 'This listing'
    };

    Object.assign(G.prototype, {
        /** Stable fields for ptests — maps internal stores to one read surface. */
        _mpDebugClientState() {
            const board = this._mpBoardFromRoom?.(this.roomData);
            const uid = this._myUid?.();
            const room = this.roomData;
            const roomEpoch = (typeof RtdbSchema !== 'undefined' && room
                && typeof RtdbSchema.readResetCount === 'function')
                ? RtdbSchema.readResetCount(room)
                : (room?.global?.resetCount ?? 0);
            let layoutEpoch = null;
            let layoutEpochMismatch = false;
            try {
                const rec = typeof this._loadLocalHandRecord === 'function'
                    ? this._loadLocalHandRecord()
                    : null;
                layoutEpoch = rec?.resetCount ?? null;
                layoutEpochMismatch = layoutEpoch != null && roomEpoch > 0 && layoutEpoch !== roomEpoch;
            } catch (_) { /* ignore */ }

            const dumpUi = this._mpGuestDumpUiPending?.() ?? null;
            return {
                role: this.isHost?.() ? 'host' : 'guest',
                uid: uid ? String(uid).slice(-14) : null,
                handCount: this.tiles?.length ?? 0,
                gameStarted: !!this.gameStarted,
                clientInventorySeq: uid ? (this._mpClientInventorySeq?.(uid) ?? 0) : 0,
                boardInventorySeq: uid ? (this._boardInventorySeq?.(board, uid) ?? 0) : 0,
                hostLiveInventorySeq: uid && this.isHost?.()
                    ? (this._hostLiveInventorySeq?.(uid) ?? null)
                    : null,
                lastPeelSeq: this._lastPeelSeq ?? 0,
                lastDumpSeq: this._lastDumpSeq ?? 0,
                boardPeelSeq: board?.peelSeq ?? 0,
                boardDumpSeq: board?.dumpSeq ?? 0,
                boardSeq: board?.seq ?? null,
                boardRevision: board?.boardRevision ?? null,
                appliedRevision: this._mpAppliedBoardRevision ?? 0,
                structuralApplyKey: this._mpGuestAppliedStructuralKey ?? null,
                revisionPending: !!this._mpPendingRevisionBoard,
                localPoolLen: this._tilePool?.length ?? 0,
                boardPoolLen: Array.isArray(board?.pool) ? board.pool.length : null,
                displayPoolLen: this._mpDisplayPoolLen?.() ?? null,
                dumpUiPending: dumpUi,
                dumpPendingTileId: dumpUi?.tileId ?? null,
                mpAwaitReset: !!this._mpAwaitReset,
                mpAppliedResetCount: this._mpAppliedResetCount ?? 0,
                roomResetCount: roomEpoch,
                layoutEpoch,
                layoutEpochMismatch,
                inventoryProjectionFailed: !!this._mpInventoryProjectionFailed,
                canMutateHand: this._canMutatePlayingHand?.() ?? null,
                guestAuthorityReady: this._mpGuestAuthorityReadyForPlay?.() ?? null,
                phase: board?.phase ?? null,
                winnerUid: board?.winnerUid ?? this._winnerUid ?? null
            };
        }
    });

    G.registerMpDebug({
        help() {
            return { apis: HELP, registered: Object.keys(window.__bananaMpDebug || {}).sort() };
        },
        gamePhase() {
            const g = window.game;
            return g?.gamePhaseSnapshot?.() ?? null;
        },
        snapshot() {
            const g = window.game;
            const board = g?._mpBoardFromRoom?.(g.roomData);
            const uid = g?._myUid?.();
            return {
                seq: g?._snapshotMpSeqMatrix?.(board, uid, 'debug') ?? null,
                epoch: g?._mpEpochFlagsSnapshot?.(board) ?? null,
                inventory: g?._snapshotInventoryProjection?.(board, uid, 'debug') ?? null,
                inventoryCounters: g?._snapshotHostInventoryCounters?.(board, uid) ?? null,
                coherence: g?._mpCoherenceSnapshot?.(board, uid, 'debug') ?? null,
                revision: g?._mpRevisionSnapshot?.(board) ?? null,
                gamePhase: g?.gamePhaseSnapshot?.() ?? null,
                dump: g?._snapshotDumpAuthority?.() ?? null,
                peel: g?._snapshotPeelAuthority?.() ?? null,
                split: g?._snapshotSplitAuthority?.() ?? null,
                layout: g?._mpLayoutAuthoritySnapshot?.(
                    board,
                    uid,
                    board?.tilesOwnedByPlayer?.[uid]
                ) ?? null,
                tilesProjection: {
                    mode: g?._mpTilesProjectionMode ?? 'none',
                    last: g._lastMpTilesProjection ? { ...g._lastMpTilesProjection } : null
                },
                hostPool: g?._snapshotHostPoolStores?.() ?? null,
                clientState: g?._mpDebugClientState?.() ?? null
            };
        },
        /**
         * Stable ptest contract — prefer over reading game private fields in evaluate().
         * Used by ptests/games/bananagrams/lib/mp-debug-bridge.js.
         */
        clientState() {
            const g = window.game;
            return g?._mpDebugClientState?.() ?? null;
        }
    });
})(typeof window !== 'undefined' ? window : global);
