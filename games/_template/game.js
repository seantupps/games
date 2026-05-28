/**
 * Template — copy to games/<id>/<id>.js and rename the class.
 * Rules live in shared/platform/logic.js (GameLogic.<id>).
 *
 * Iframe contract for generic SP/MP audits:
 *   getValidMoves, submitMove, isOver, winner, scores, turn
 *   isAuditReady() — MP ready-wait when boardKind is generic
 *   serializeBoard / applyBoard — MP sync
 */
class TemplateGame extends BaseGame {
    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get('mode') || 'classic';
        this.turn = 'P1';
        this.isOver = false;
        this.winner = null;
        this.scores = { P1: 0, P2: 0 };
        this._ticks = 0;
        this._maxTicks = 12;
        this._auditReady = false;

        this.initIdentity('template', this.mode);

        this.onIdentitySynced = () => {
            this.identitySynced = true;
            if (!this.isMultiplayer) {
                this._auditReady = true;
            } else if (this.isHost()) {
                this._seedHostBoard();
            }
            this.updateTurnIndicator?.();
            this.requestRender();
        };

        window.game = this;
    }

    /** Playwright MP/SP ready — set auditReadyCallable: true in registry for generic boardKind. */
    isAuditReady() {
        if (!this.identitySynced) return false;
        if (!this.isMultiplayer) return true;
        if (this._auditReady) return true;
        const board = this.roomData?.global?.board;
        return !!(board && (board.ticks != null || board.initialized));
    }

    _seedHostBoard() {
        if (!this.isHost?.()) return;
        const board = { initialized: true, ticks: 0, turn: 'P1', isOver: false, winner: null };
        if (typeof this.resetGame === 'function') {
            this.resetGame({ board });
        }
        this._ticks = 0;
        this.turn = 'P1';
        this.isOver = false;
        this.winner = null;
        this._auditReady = true;
    }

    getValidMoves() {
        if (this.isOver || !this.isMyTurn?.()) return [];
        return [{ type: 'tick' }];
    }

    submitMove(move) {
        if (!move || this.isOver) return false;
        if (!this.isMyTurn?.()) return false;
        this._ticks += 1;
        if (this._ticks >= this._maxTicks) {
            this.isOver = true;
            this.winner = this.playerRole || this.turn;
            if (this.winner && this.scores[this.winner] != null) {
                this.scores[this.winner] += 1;
            }
        } else {
            this.turn = this.turn === 'P1' ? 'P2' : 'P1';
        }
        this.updateTurnIndicator?.();
        this.requestRender();
        if (this.isMultiplayer && typeof this.syncMove === 'function') {
            this.syncMove(move);
        }
        return true;
    }

    serializeBoard() {
        return {
            initialized: true,
            ticks: this._ticks,
            turn: this.turn,
            isOver: this.isOver,
            winner: this.winner
        };
    }

    applyBoard(board) {
        if (!board) return;
        if (board.ticks != null) this._ticks = board.ticks;
        if (board.turn) this.turn = board.turn;
        if (board.isOver != null) this.isOver = !!board.isOver;
        if (board.winner != null) this.winner = board.winner;
        this._auditReady = !!board.initialized;
        this.requestRender();
    }

    onGameReset() {
        this._ticks = 0;
        this.turn = 'P1';
        this.isOver = false;
        this.winner = null;
        if (this.isMultiplayer && this.isHost?.()) {
            this._seedHostBoard();
        } else {
            this._auditReady = !this.isMultiplayer;
        }
        this.requestRender();
    }

    _render() {
        const el = document.querySelector('.sb-turn');
        if (el) {
            el.textContent = this.isOver
                ? `Game over — ${this.winner || '?'} wins`
                : `${this.turn}'s turn (${this._ticks}/${this._maxTicks})`;
        }
    }
}

const game = new TemplateGame();
