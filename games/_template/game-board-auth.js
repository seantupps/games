/**
 * Board-authoritative template — use with --sync=board-authoritative.
 * MP: guests send commands; host publishes global/board v2+ with board.seq.
 * Do NOT use submitMove → sendEvent in MP.
 *
 * Requires: shared/platform/mp-board-auth.js (loaded before this file)
 */
class TemplateBoardAuthGame extends BaseGame {
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

        if (typeof MpBoardAuth !== 'undefined') {
            MpBoardAuth.initBoardAuthState(this);
        }

        this.initIdentity('template', this.mode);

        this.onIdentitySynced = () => {
            this.identitySynced = true;
            if (!this.isMultiplayer) {
                this._auditReady = true;
            } else if (this.isHost()) {
                this._seedHostBoardAuth();
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

    _commandChannel() {
        if (!this._cmd) {
            this._cmd = MpBoardAuth.createCommandChannel(this, { channel: 'template' });
        }
        return this._cmd;
    }

    isAuditReady() {
        if (typeof MpBoardAuth !== 'undefined' && this.hasCap?.('mpBoardAuthoritative')) {
            return MpBoardAuth.isAuditReady(this);
        }
        return this.identitySynced && (!this.isMultiplayer || !!this.roomData?.global?.board?.initialized);
    }

    _seedHostBoardAuth() {
        if (!this.isHost?.() || typeof MpBoardAuth === 'undefined') return;
        const body = this._buildBoardBody();
        body.initialized = true;
        const board = MpBoardAuth.hostPublishBoard(this, body, { bumpSeq: true, traceLabel: 'seed' });
        if (board) this._applyBoardLocal(board);
        this._auditReady = true;
    }

    _buildBoardBody() {
        return {
            initialized: true,
            ticks: this._ticks,
            turn: this.turn,
            isOver: this.isOver,
            winner: this.winner
        };
    }

    _applyBoardLocal(board) {
        if (!board) return;
        if (board.ticks != null) this._ticks = board.ticks;
        if (board.turn) this.turn = board.turn;
        if (board.isOver != null) this.isOver = !!board.isOver;
        if (board.winner != null) this.winner = board.winner;
        this._auditReady = board.initialized === true || (board.version >= 2 && (board.seq ?? 0) >= 1);
        if (board.commandAck) this._commandChannel().mirrorFromBoard(board);
        this.updateTurnIndicator?.();
        this.requestRender();
    }

    onNetworkUpdate(data) {
        if (!this.isMultiplayer || !this.hasCap?.('mpBoardAuthoritative')) return;

        const board = MpBoardAuth.readBoard(this, this.roomData);
        if (board?.version >= MpBoardAuth.BOARD_VERSION) {
            MpBoardAuth.applyIncomingBoard(this, board, (b) => this._applyBoardLocal(b), {
                _traceCaller: 'onNetworkUpdate'
            });
        }

        if (this.isHost()) {
            const handled = this._commandChannel().processHost(
                data?.interactions || this.roomData?.interactions,
                (uid, msg) => this._hostHandleCommand(uid, msg)
            );
            if (handled) {
                this._hostPublishAfterCommand();
            }
        }
    }

    _hostHandleCommand(uid, msg) {
        if (this.isOver) return 'ignore';
        if (msg.type !== 'tick') return 'ignore';

        this._ticks += 1;
        if (this._ticks >= this._maxTicks) {
            this.isOver = true;
            this.winner = this._roleForUid(uid) || this.turn;
            if (this.winner && this.scores[this.winner] != null) {
                this.scores[this.winner] += 1;
            }
        }
        return 'handled';
    }

    _roleForUid(uid) {
        const pd = this.roomData?.playerData || {};
        const hostUid = this.roomData?.host;
        if (uid && hostUid && uid === hostUid) return 'P1';
        const keys = Object.keys(pd).filter((id) => id && id !== hostUid);
        if (keys.includes(uid)) return keys.indexOf(uid) === 0 ? 'P2' : 'P2';
        return null;
    }

    _hostPublishAfterCommand() {
        if (!this.isHost?.()) return;
        const body = this._buildBoardBody();
        const board = MpBoardAuth.hostPublishBoard(this, body, { bumpSeq: true });
        if (board) this._applyBoardLocal(board);
    }

    getValidMoves() {
        if (this.isOver) return [];
        if (this.isMultiplayer && this.hasCap?.('mpBoardAuthoritative')) {
            return [{ type: 'tick' }];
        }
        if (!this.isMyTurn?.()) return [];
        return [{ type: 'tick' }];
    }

    submitMove(move) {
        if (!move || this.isOver) return false;

        if (this.isMultiplayer && this.hasCap?.('mpBoardAuthoritative')) {
            if (this.isHost()) {
                this._hostHandleCommand(this.uid, move);
                this._hostPublishAfterCommand();
            } else {
                this._commandChannel().send({ type: 'tick' });
            }
            return true;
        }

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
        return true;
    }

    serializeBoard() {
        const body = this._buildBoardBody();
        return {
            version: MpBoardAuth?.BOARD_VERSION ?? 2,
            seq: this._boardSeq ?? 0,
            ...body
        };
    }

    applyBoard(board, opts = {}) {
        if (this.isMultiplayer && this.hasCap?.('mpBoardAuthoritative') && !opts.force) {
            return;
        }
        this._applyBoardLocal(board);
    }

    onGameReset() {
        this._ticks = 0;
        this.turn = 'P1';
        this.isOver = false;
        this.winner = null;
        this._boardSeq = 0;
        this._commandAckLocal = {};
        this._commandAckHandled = {};
        if (typeof MpBoardAuth !== 'undefined') {
            MpBoardAuth.clearAllEphemeral(this);
        }
        if (this.isMultiplayer && this.isHost?.()) {
            this._seedHostBoardAuth();
        } else {
            this._auditReady = !this.isMultiplayer;
        }
        this.requestRender();
    }

    getExtraGlobalReset() {
        return { interactions: null, previews: null };
    }

    _render() {
        const el = document.querySelector('.sb-turn');
        if (el) {
            el.textContent = this.isOver
                ? `Game over — ${this.winner || '?'} wins`
                : `Ticks: ${this._ticks}/${this._maxTicks}`;
        }
    }
}

const game = new TemplateBoardAuthGame();
