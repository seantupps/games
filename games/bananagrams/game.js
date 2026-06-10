/**
 * Bananagrams — solo and multiplayer (2–8 players, shared bunch).
 *
 * MP state ownership (one writer per kind of truth):
 * - Firebase `global/board`: lifecycle, inventory, review layouts, tile positions (MP).
 * - Layout playing SSOT: host active play → `_mpPlayerLayouts` only at publish (no wire backfill);
 *   guest `_resolvePlayingLayoutMap` picks client / wire / localStorage; drag merges at projection.
 *   localStorage is tab-refresh persistence only; drag positions live in `_mpRuntimeTileById` at merge time.
 * - Runtime `this.tiles`: UI projection only — `_commitMpTilesProjection` (reassign) or
 *   `_mutateMpTilesInPlace` (in-place x/y/faceUp); both update `_lastMpTilesProjection`.
 * - Layout persist: host playing → `_mpPlayerLayouts` only; guest → `_mpClientLayout` + localStorage.
 * - Host live play: `_mpRequireCoherent` enforced during mutations; `_hostAssertLiveCoherence` pre-txn.
 * - Legacy boards (no boardRevision): same structural gate via composite apply key.
 *
 * Inventory pipeline (definitions → authority → network → projection → UI):
 * - Host writes `_mpOwned` (authority), validates txn, publishes board snapshot.
 * - All clients project from `board.tilesOwnedByPlayer` when `inventorySeq` advances.
 * - Layout (x/y) is a separate projection step; `this.tiles` is UI-only.
 * - `inventorySeq` reconcile is independent of `board.seq` (RTDB deep-merge safe).
 * - Inventory apply: `_applyMpInventoryAxis` only (one apply per board tick; RAF retry async).
 * - Seq counters: see modules/mp-seq.js — client reads use `_mpClientInventorySeq`;
 *   wire reads use `_boardInventorySeq` only (lag/publish-pending/bundle). Host live writes `_mpInventorySeq`.
 * - Pool projection: `_applyBoardPoolOnce` once per board tick — `_applyPoolFromBoardAuthority`.
 *   Guest: `_tilePool` mirrors wire `board.pool` on every apply — single pool SSOT for HUD/eligibility.
 * - Host playing publish: `_applyHostPublishEcho` — lifecycle/seq only; hand from _mpOwned authority.
 * - Host active play: board is output only — never repair _mpOwned/_tilePool from wire.
 * - Guest playing apply: monotonic `boardRevision` + inventory catch-up when revision applied but inventorySeq lags.
 * - Board apply entry: `_applyMultiplayerBoard` (network/applyState/applyBoard v2); host publish via
 *   `_hostPublishBoard` → echo or full apply; txn commits share `_hostPublishTxnOrRollback`.
 * - Canonical merge: `_mpMergeCanonicalFromBoard` (pre-inventory + lifecycle).
 * - Debug triage: `__bananaMpDebug.help()` lists APIs; `snapshot()` / `gamePhase()` consolidated in mp-debug.js.
 * - Phase: `_clientMpPhaseSnapshot` (wire-primary command + transition); mirror via `_syncClientPhaseFromBoard`.
 * - `this.tiles` dual-mode gated at commit — `_mpAllowPlayingTilesCommit` / `_mpAllowReviewTilesCommit`;
 *   in-place edits via `_mutateMpTilesInPlace` keep projection metadata in sync.
 */
class BananagramsGame extends BaseGame {
    static TILE_HIT_INSET = 0;

    /** MP lifecycle on global/board.phase ('playing' | 'review' | 'idle'). */
    static MP_PHASE = {
        PLAYING: 'playing',
        REVIEW: 'review',
        IDLE: 'idle'
    };

    /** Merge debug helpers into window.__bananaMpDebug (load-order safe). */
    static registerMpDebug(patch) {
        if (typeof window === 'undefined' || !patch) return;
        window.__bananaMpDebug = window.__bananaMpDebug || {};
        Object.assign(window.__bananaMpDebug, patch);
    }

    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get('mode') || 'solo';
        this._mpOwned = null;
        this._mpPlayerLayouts = null;
        this._mpInventorySeq = null;
        this._boardSeq = 0;
        /** Host: monotonic full-snapshot revision stamped on every publish. */
        this._mpBoardRevision = 0;
        /** Guest: last coherent boardRevision applied to playing lifecycle. */
        this._mpAppliedBoardRevision = 0;
        this._mpPendingRevisionBoard = null;
        /** MP: last global.resetCount applied — new epoch allows lower board.seq. */
        this._mpAppliedResetCount = 0;
        /** True once this session seeded _mpAppliedResetCount from room (refresh/join). */
        this._mpEpochSyncedFromRoom = false;
        this._winnerUid = null;
        this._mpScores = {};

        this.canvasPanX = 0;
        this.canvasPanY = 0;
        this.WORLD = 4800;
        this.ORIGIN = this.WORLD / 2;
        this.tiles = [];
        /** 'none' | 'playing' | 'review' | 'cleared' — which projection last wrote this.tiles. */
        this._mpTilesProjectionMode = 'none';
        this._lastMpTilesProjection = null;
        /** Guest: last coherent structural apply key (revision or legacy composite). */
        this._mpGuestAppliedStructuralKey = null;
        /** Guest: inventorySeq committed with last applied boardRevision. */
        this._mpLastInventorySeqAtRevision = 0;
        /** MP: stable tile object registry keyed by id — survives inventory applies. */
        this._mpRuntimeTileById = {};
        /** Guest playing: in-memory layout map (id → {x,y}); localStorage is persistence only. */
        this._mpClientLayout = null;
        /** Last layout authority resolution — debug/triage. */
        this._lastMpLayoutAuthority = null;
        /** Last _persistMpLayout target — debug/triage store drift. */
        this._lastMpLayoutPersist = null;
        this.started = false;
        this.gameStarted = false;
        this._tilePool = [];
        this._nextTileId = 0;
        this._selectedIds = new Set();
        this._selectionHighlight = false;
        this._selectionInit = false;
        this._checker = null;
        this._dictReady = false;
        this.elapsedMs = 0;
        this._timerStart = null;
        this._timerRaf = 0;
        /** True after win — blocks HUD timer tick and MP startedAt resync. */
        this._timerFrozen = false;
        this._bannerText = '';
        this._bannerPlacement = 'center';
        this._bannerUntil = 0;
        this._bananaHandled = {};
        this._bananaAck = {};
        this._hostSyncQueued = false;
        this._hostSyncRaf = 0;
        this._mpDeferredBoard = null;
        this._deferredFlushTimer = 0;
        this._mpStartedAt = null;
        this._localInventorySeq = 0;
        /** rAF handle for guest inventory lag reconciliation (independent of board.seq). */
        this._mpInvReconcileRaf = 0;
        this._mpInvReconcileAttempts = 0;
        /** Monotonic id for inventory apply attempts (debugging). */
        this._mpInventoryApplyGen = 0;
        /** Last inventory apply outcome — source, gen, result. */
        this._lastMpInventoryApply = null;
        /** Last pool mirror from board authority — reason, prev/next len. */
        this._lastMpPoolApply = null;
        /** Last board apply — source (network | host-publish-echo | …), trace, seq. */
        this._lastBoardApply = null;
        /** Set when authority pipeline fails — blocks render until reconcile succeeds. */
        this._mpInventoryProjectionFailed = false;
        /** Guest dump in flight — UI/input only; model and render stay on this.tiles until authority. */
        this._guestDumpPendingTileId = null;
        this._guestDumpPendingAtLocalSeq = null;
        this._lastMpDumpTxn = null;
        this._lastMpPeelTxn = null;
        this._lastMpSplitTxn = null;
        this._localDragUntil = 0;
        this._peelSeq = 0;
        this._lastPeelSeq = 0;
        this._peelActorUid = null;
        this._dumpSeq = 0;
        this._lastDumpSeq = 0;
        this._dumpActorUid = null;
        this._lastPeelDraws = null;
        this._winnerBannerUid = null;
        this._mpAwaitReset = false;
        this._bannerTimer = 0;
        this._rmbMarqueeUsed = false;
        this._rmbMarqueeUsedTimer = 0;
        this._postGameReview = false;
        /** Host-authoritative derived phase mirror ('playing'|'win-pending'|'review'|'done'). */
        this._gamePhase = 'playing';
        /** Host only: true while writing the first review board (before board.phase is review). */
        this._hostReviewTransitionActive = false;
        this._reviewLayouts = null;
        this._reviewLayoutsFp = null;
        this._reviewAppliedPlayerCount = 0;
        this._reviewViewportSettled = false;
        /** MP: uid → tile list captured at win time (before review merge). */
        this._endingLayoutsCache = null;
        this._myEndingLayoutPublished = false;
        /** Last applied MP board phase on this client (review → playing needs inventory reset). */
        this._mpClientBoardPhase = null;
        /** Solo post-game Done only (local); MP lifecycle is on global/board.phase. */
        this._reviewDone = {};
        this._hostReviewCompleting = false;
        /** MP: ignore review boards at or below this epoch after host Done. */
        this._mpReviewEpochClosed = 0;
        this._mpReviewEpoch = 0;
        this._reviewLayoutsSyncedFp = null;
        /** True while in an active MP party room (used to detect MP → solo transitions). */
        this._mpSessionActive = false;

        window.game = this;
        this.onIdentitySynced = () => {
            this._reconcileMpMode();
            this.identitySynced = true;
            if (this._isMultiplayerMode()) {
                this._seedMpAppliedResetFromRoom?.();
                if (this._dictReady) this._maybeSetupMultiplayer();
                const board = this._mpBoardFromRoom();
                if (board?.version >= 2) {
                    const reset = !!this._mpAwaitReset;
                    this._applyMultiplayerBoard(board, { force: true, reset });
                    if (reset) this._mpAwaitReset = false;
                }
            } else if (!this.started) {
                if (!this.loadPersistedState()) this.setupNewHand();
            }
            this.renderScoreboard();
            this._syncViewportAfterLayout();
        };

        this.initIdentity('bananagrams', this.mode);
        this._reconcileMpMode();
        this._loadDictionary();

        if (!this._isMultiplayerMode() && !this.started) {
            if (!this.loadPersistedState()) this.setupNewHand();
        }
        this.identitySynced = true;
        this.requestRender();
        this._syncViewportAfterLayout();
    }

    /** Dev hooks (games/bananagrams/dev/). No-op when dev bundle is not loaded. */
    _bananaDevHook(name, ...args) {
        const fn = typeof BananaDev !== 'undefined' && BananaDev[name];
        return fn ? fn(this, ...args) : undefined;
    }
}
if (typeof window !== 'undefined') window.BananagramsGame = BananagramsGame;
