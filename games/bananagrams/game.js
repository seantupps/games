/**
 * Bananagrams — solo and multiplayer (2–8 players, shared bunch).
 *
 * MP state ownership (one writer per kind of truth):
 * - Firebase `global/board`: lifecycle, inventory, review layouts, tile positions (MP).
 * - localStorage: solo tile persistence only; MP positions come from global/board.
 * - Runtime `this.tiles`: UI projection only — playing hand from inventory merge OR
 *   review merge from board.reviewLayouts; never both. `_postGameReview` is UI chrome only.
 *
 * Inventory changes (peel/dump/deal) only touch host `_mpOwned` → board sync.
 * Clients refresh playing hands only via `_rebuildHandFromBoard()` when
 * `_shouldProjectPlayingInventory()` allows. Review uses `_applyReviewLayouts()` only.
 */
class BananagramsGame extends BaseGame {
    static TILE_HIT_INSET = 0;

    /** MP lifecycle on global/board.phase ('playing' | 'review' | 'idle'). */
    static MP_PHASE = {
        PLAYING: 'playing',
        REVIEW: 'review',
        IDLE: 'idle'
    };

    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get('mode') || 'solo';
        this._mpOwned = null;
        this._mpPlayerLayouts = null;
        this._mpInventorySeq = null;
        this._boardSeq = 0;
        /** MP: last global.resetCount applied — new epoch allows lower board.seq. */
        this._mpAppliedResetCount = 1;
        /** True once this session seeded _mpAppliedResetCount from room (refresh/join). */
        this._mpEpochSyncedFromRoom = false;
        this._winnerUid = null;
        this._mpScores = {};

        this.canvasPanX = 0;
        this.canvasPanY = 0;
        this.WORLD = 4800;
        this.ORIGIN = this.WORLD / 2;
        this.tiles = [];
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
