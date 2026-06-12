/**
 * Rummikub puzzle — solo pan-zoom tile board.
 */
class RummikubGame extends BaseGame {
    static TILE_SELECT_EXPAND = 15;

    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get('mode') || 'puzzle';

        this.canvasPanX = 0;
        this.canvasPanY = 0;
        this.WORLD = 4800;
        this.ORIGIN = this.WORLD / 2;

        this.tiles = [];
        this.started = false;
        this.gameStarted = false;
        this.isOver = false;
        this.winner = null;
        this._auditReady = false;
        this._selectedIds = new Set();
        this._selectionHighlight = false;
        this._selectionInit = false;
        this._postGameReview = false;
        this._reviewDone = {};
        this._victoryRegistered = false;
        this._winnerBannerUid = null;
        this.elapsedMs = 0;
        this._timerStart = null;
        this._timerRaf = 0;
        this._timerFrozen = false;
        this._puzzleSeed = 0;
        this._originalMelds = null;
        this.autoInsert = this._loadAutoInsertPref();

        this.initIdentity('rummikub', this.mode);

        this.onIdentitySynced = () => {
            this.identitySynced = true;
            if (!this.isMultiplayer) {
                this._auditReady = true;
                this.setupNewPuzzle();
            }
            this.updateTurnIndicator?.();
            this.requestRender();
        };

        this._bindMobileLayoutRefresh();
        window.game = this;
    }

    _bindMobileLayoutRefresh() {
        const refit = () => {
            if (typeof this.refreshMobileLayout === 'function') this.refreshMobileLayout();
            else if (typeof this.fitBoardToViewport === 'function') this.fitBoardToViewport();
        };
        window.addEventListener('resize', refit);
        window.addEventListener('orientationchange', refit);
        requestAnimationFrame(refit);
    }

    isAuditReady() {
        return this.identitySynced && this.tiles.length > 0;
    }

    getValidMoves() {
        return [];
    }

    submitMove() {
        return false;
    }

    setGameOver(winner = 'P1') {
        if (this.isOver || this._postGameReview) return;
        this._finishVictory(winner);
    }

    onGameReset() {
        this._preservePlayViewport = true;
        this.setupNewPuzzle(0, { preserveViewport: true });
    }

    canMutatePlayingBoard() {
        return !this._postGameReview && !this.isOver;
    }

    _randomSeed() {
        return (Math.floor(Math.random() * 0x7fffffff) >>> 0) || 1;
    }

    _myUid() {
        return this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid') || '';
    }

    _loadAutoInsertPref() {
        try {
            return localStorage.getItem('rummikub_auto_insert') !== '0';
        } catch (_) {
            return true;
        }
    }

    setAutoInsert(enabled) {
        this.autoInsert = !!enabled;
        try {
            localStorage.setItem('rummikub_auto_insert', this.autoInsert ? '1' : '0');
        } catch (_) { /* ignore */ }
    }

    _dropOptions() {
        return { autoInsert: this.autoInsert !== false };
    }

    setupNewPuzzle(attempt = 0, opts = {}) {
        const Core = typeof RummikubCore !== 'undefined' ? RummikubCore : null;
        if (!Core) {
            console.error('[rummikub] RummikubCore bundle missing');
            return;
        }
        if (attempt > 10) {
            console.error('[rummikub] puzzle generation failed after retries');
            return;
        }

        this._stopTimer();
        this._postGameReview = false;
        this._reviewDone = {};
        this._victoryRegistered = false;
        this._winnerBannerUid = null;
        this.isOver = false;
        this.winner = null;
        this.gameStarted = false;
        this.started = true;
        this._selectedIds.clear();
        this._selectionHighlight = false;

        const seed = this._randomSeed();
        this._puzzleSeed = seed;
        const rng = Core.makeRng(seed);
        const placed = RummikubRules.PLACED_COUNT;
        const gen = Core.generateSolvedBoard(rng, placed, 'standard', RummikubRules.GEN_TIMEOUT_MS);
        if (!gen.ok || !gen.puzzle) {
            console.warn('[rummikub] puzzle generation failed, retrying');
            return this.setupNewPuzzle(attempt + 1);
        }

        this._originalMelds = gen.puzzle.melds;
        const peeled = Core.removePercentFromBoard(
            gen.puzzle.grid,
            [],
            gen.puzzle.melds,
            RummikubRules.REMOVE_PERCENT,
            rng
        );
        const start = Core.solveBoardLayout(peeled.grid, peeled.rack, rng, {
            originalMelds: gen.puzzle.melds,
            deadlineMs: RummikubRules.SOLVE_DEADLINE_MS
        });

        const origin = { x: this.ORIGIN, y: this.ORIGIN };
        const tableTiles = RummikubGrid.tilesFromCoreGrid(start.grid, origin);
        const rackTiles = RummikubGrid.layoutRack(
            start.rack.map((t) => ({ ...t })),
            origin
        );
        this.tiles = [...tableTiles, ...rackTiles];
        if (opts.preserveViewport) {
            this.requestRender();
            return;
        }
        this._applyDefaultPlayingViewport?.();
        this._syncViewportAfterLayout?.();
        this.requestRender();
    }

    _coreTile(tile) {
        if (tile.kind === 'joker') {
            const out = { kind: 'joker', id: tile.id, display: tile.display || 'B' };
            if (tile.as) out.as = { ...tile.as };
            return out;
        }
        return { kind: 'number', id: tile.id, color: tile.color, value: tile.value };
    }

}
if (typeof window !== 'undefined') window.RummikubGame = RummikubGame;
