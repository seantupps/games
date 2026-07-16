/**
 * Quoridor — SP human (P1) vs greedy AI (P2), same pattern as line/piles.
 * Fit-square board, site theme CSS vars, Worker AI bridge.
 */
/* global BaseGame, QuoridorEngine */

const params = new URLSearchParams(window.location.search);
if (params.has("theme")) {
    document.documentElement.style.setProperty("--theme-color", params.get("theme"));
}
if (params.has("opp")) {
    document.documentElement.style.setProperty("--opponent-color", params.get("opp"));
}

class QuoridorGame extends BaseGame {
    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get("mode") || "classic";
        this.localSize = 800;
        this.turn = "P1";
        this.isOver = false;
        this.winner = null;
        this.scores = { P1: 0, P2: 0 };
        this._auditReady = false;
        this._busy = false;
        this._aiId = 0;
        this._history = [];

        this.engine = new QuoridorEngine.Engine();
        this._buildDom();
        this._initAiWorker();

        this.initIdentity("quoridor", this.mode);

        this.onIdentitySynced = () => {
            this.identitySynced = true;
            if (!this.isMultiplayer) {
                this._auditReady = true;
                this.engine = new QuoridorEngine.Engine();
                this._history = [];
                this._syncFromEngine();
            }
            this.updateTurnIndicator?.();
            this.requestRender();
            this.fitBoardToViewport?.();
            if (!this.isMultiplayer && this.turn === "P2") this.triggerAITurn();
        };

        this._bindMobileLayoutRefresh();
        window.game = this;
        document.body.classList.add("quoridor-game");
        this.requestRender();
    }

    _buildDom() {
        const root = document.getElementById("game-container");
        root.innerHTML = "";
        this.boardEl = document.createElement("div");
        this.boardEl.id = "quoridor-board";
        this.thinkingEl = document.createElement("div");
        this.thinkingEl.className = "q-thinking";
        this.thinkingEl.textContent = "AI thinking…";
        this.hudEl = document.createElement("div");
        this.hudEl.className = "q-hud";
        root.appendChild(this.thinkingEl);
        root.appendChild(this.boardEl);
        root.appendChild(this.hudEl);

        this.cellEls = [];
        this.hFenceEls = [];
        this.vFenceEls = [];

        const { SIZE, WALL_N } = QuoridorEngine;
        for (let r = 0; r < SIZE; r++) {
            this.cellEls[r] = [];
            for (let c = 0; c < SIZE; c++) {
                const el = document.createElement("div");
                el.className = "q-cell";
                el.dataset.r = String(r);
                el.dataset.c = String(c);
                el.style.left = `calc(${c} * (var(--cell) + var(--gap)))`;
                el.style.top = `calc(${r} * (var(--cell) + var(--gap)))`;
                el.addEventListener("click", () => this._onCellClick(r, c));
                const pawn = document.createElement("div");
                pawn.className = "q-pawn";
                pawn.hidden = true;
                el.appendChild(pawn);
                this.boardEl.appendChild(el);
                this.cellEls[r][c] = el;
            }
        }

        for (let r = 0; r < WALL_N; r++) {
            this.hFenceEls[r] = [];
            for (let c = 0; c < WALL_N; c++) {
                const el = document.createElement("div");
                el.className = "q-hfence";
                el.dataset.r = String(r);
                el.dataset.c = String(c);
                el.style.left = `calc(${c} * (var(--cell) + var(--gap)))`;
                el.style.top = `calc(${r + 1} * var(--cell) + ${r} * var(--gap))`;
                el.addEventListener("click", () => this._onFenceClick("H", r, c));
                this.boardEl.appendChild(el);
                this.hFenceEls[r][c] = el;
            }
        }

        for (let r = 0; r < WALL_N; r++) {
            this.vFenceEls[r] = [];
            for (let c = 0; c < WALL_N; c++) {
                const el = document.createElement("div");
                el.className = "q-vfence";
                el.dataset.r = String(r);
                el.dataset.c = String(c);
                el.style.left = `calc(${c + 1} * var(--cell) + ${c} * var(--gap))`;
                el.style.top = `calc(${r} * (var(--cell) + var(--gap)))`;
                el.addEventListener("click", () => this._onFenceClick("V", r, c));
                this.boardEl.appendChild(el);
                this.vFenceEls[r][c] = el;
            }
        }
    }

    _initAiWorker() {
        try {
            this._worker = new Worker("ai-worker.js");
            this._workerReady = false;
            this._worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
            this._worker.postMessage({ type: "warmup" });
        } catch (err) {
            console.warn("[quoridor] AI worker unavailable, using main thread", err);
            this._worker = null;
        }
    }

    _onWorkerMessage(msg) {
        if (!msg) return;
        if (msg.type === "ready") {
            this._workerReady = true;
            return;
        }
        if (msg.type === "move" && msg.id === this._aiId) {
            this._finishAiMove(msg.move);
        }
    }

    _bindMobileLayoutRefresh() {
        const refit = () => {
            if (typeof this.refreshMobileLayout === "function") this.refreshMobileLayout();
            else if (typeof this.fitBoardToViewport === "function") this.fitBoardToViewport();
        };
        window.addEventListener("resize", refit);
        window.addEventListener("orientationchange", refit);
        requestAnimationFrame(refit);
    }

    isAuditReady() {
        if (!this.identitySynced) return false;
        if (!this.isMultiplayer) return true;
        return this._auditReady;
    }

    _syncFromEngine() {
        this.turn = this.engine.turn % 2 === 0 ? "P1" : "P2";
        this.isOver = !!this.engine.winner;
        this.winner = this.engine.winner
            ? this.engine.winner.index === 0
                ? "P1"
                : "P2"
            : null;
    }

    getValidMoves() {
        if (this.isOver || this._busy) return [];
        if (this.isMultiplayer) return [];
        if (this.turn !== "P1") return [];
        return this.engine.listLegalMoves();
    }

    /**
     * Local SP path — engine is authoritative; then triggerAITurn like line/piles.
     * (BaseGame.submitMove is piles/line-shaped; override keeps Quoridor out of that.)
     */
    submitMove(move) {
        if (!move || this.isOver || this._busy) return false;
        if (this.isMultiplayer) return false;
        if (this.turn !== "P1") return false;
        // Snapshot before P1 move — undo restores this (drops P1 + AI reply).
        const snap = this.engine.clone();
        if (!this.engine.applyMove(move)) return false;
        this._history.push(snap);
        this._syncFromEngine();
        if (this.winner) {
            this.scores[this.winner] = (this.scores[this.winner] || 0) + 1;
        }
        this.updateTurnIndicator?.();
        this.requestRender();
        if (this.isOver) {
            this.setGameOver?.(this.winner);
            return true;
        }
        if (this.turn === "P2") this.triggerAITurn();
        return true;
    }

    /**
     * SP undo via hub `/undo`: roll back last player move and AI reply.
     * Same semantics as terminal Quoridor `u` / `undo`.
     */
    undoLastTurn() {
        if (this.isMultiplayer) return false;
        if (!this._history.length) return false;

        const prevWinner = this.winner;
        this._aiId++;
        this._busy = false;
        document.body.classList.remove("quoridor-busy");
        this.thinkingEl.classList.remove("show");

        this.engine = this._history.pop();
        this._syncFromEngine();

        if (prevWinner && !this.winner) {
            this.scores[prevWinner] = Math.max(0, (this.scores[prevWinner] || 0) - 1);
        }
        this.clearWinOverlay?.();
        this.updateTurnIndicator?.();
        this.requestRender();
        return true;
    }

    _onCellClick(r, c) {
        if (this._busy || this.isOver || this.turn !== "P1") return;
        this.submitMove({ type: "move", row: r, col: c });
    }

    _onFenceClick(orient, r, c) {
        if (this._busy || this.isOver || this.turn !== "P1") return;
        this.submitMove({ type: orient, row: r, col: c });
    }

    /** Engine SP hook — same as line/piles onAITurn. */
    async onAITurn() {
        if (this.isMultiplayer || this.isOver) return;
        if (this.turn !== "P2") return;

        this._busy = true;
        document.body.classList.add("quoridor-busy");
        this.thinkingEl.classList.add("show");
        this.requestRender();

        const id = ++this._aiId;
        const state = this.engine.toJSON();

        if (this._worker) {
            this._worker.postMessage({ type: "choose", state, id });
            return;
        }
        await new Promise((r) => setTimeout(r, 20));
        const move = QuoridorEngine.chooseGreedy(this.engine);
        if (id === this._aiId) this._finishAiMove(move);
    }

    _finishAiMove(move) {
        this.thinkingEl.classList.remove("show");
        this._busy = false;
        document.body.classList.remove("quoridor-busy");
        if (!move || this.isOver) {
            this.requestRender();
            return;
        }
        if (!this.engine.applyMove(move)) {
            this.requestRender();
            return;
        }
        this._syncFromEngine();
        if (this.winner) {
            this.scores[this.winner] = (this.scores[this.winner] || 0) + 1;
        }
        this.updateTurnIndicator?.();
        this.requestRender();
        if (this.isOver) this.setGameOver?.(this.winner);
    }

    serializeBoard() {
        return {
            initialized: true,
            engine: this.engine.toJSON(),
            turn: this.turn,
            isOver: this.isOver,
            winner: this.winner,
            scores: { ...this.scores },
        };
    }

    applyBoard(board) {
        if (!board) return;
        if (board.engine) {
            this.engine = QuoridorEngine.Engine.fromJSON(board.engine);
        }
        if (board.turn) this.turn = board.turn;
        if (board.isOver != null) this.isOver = !!board.isOver;
        if (board.winner != null) this.winner = board.winner;
        if (board.scores) this.scores = { ...board.scores };
        this._auditReady = !!board.initialized;
        this._syncFromEngine();
        this.requestRender();
    }

    applyState(state) {
        this.applyBoard(state);
    }

    onGameReset() {
        this.engine = new QuoridorEngine.Engine();
        this._history = [];
        this._syncFromEngine();
        this._busy = false;
        this._aiId++;
        document.body.classList.remove("quoridor-busy");
        this.thinkingEl.classList.remove("show");
        this._auditReady = !this.isMultiplayer;
        this.requestRender();
        if (!this.isMultiplayer && this.turn === "P2") this.triggerAITurn();
    }

    _render() {
        const { SIZE, WALL_N } = QuoridorEngine;
        const eng = this.engine;
        const legal = this.getValidMoves();
        const legalPawn = new Set();
        const legalH = new Set();
        const legalV = new Set();
        for (const m of legal) {
            if (m.type === "move") legalPawn.add(`${m.row},${m.col}`);
            else if (m.type === "H") legalH.add(`${m.row},${m.col}`);
            else if (m.type === "V") legalV.add(`${m.row},${m.col}`);
        }

        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const el = this.cellEls[r][c];
                const isLegal = legalPawn.has(`${r},${c}`);
                el.classList.toggle("legal", isLegal);
                const pawnEl = el.querySelector(".q-pawn");
                const p0 = eng.pawns[0];
                const p1 = eng.pawns[1];
                if (p0.row === r && p0.col === c) {
                    pawnEl.hidden = false;
                    pawnEl.className = "q-pawn p1";
                } else if (p1.row === r && p1.col === c) {
                    pawnEl.hidden = false;
                    pawnEl.className = "q-pawn p2";
                } else if (isLegal) {
                    // Dimmed ghost disc (same shape as pawn)
                    pawnEl.hidden = false;
                    pawnEl.className = "q-pawn ghost";
                } else {
                    pawnEl.hidden = true;
                }
            }
        }

        for (let r = 0; r < WALL_N; r++) {
            for (let c = 0; c < WALL_N; c++) {
                const hOwner = eng.wallsH[r][c];
                const vOwner = eng.wallsV[r][c];
                const h = this.hFenceEls[r][c];
                h.classList.toggle("placed", hOwner != null);
                h.classList.toggle("p1", hOwner === 0);
                h.classList.toggle("p2", hOwner === 1);
                h.classList.toggle("legal", hOwner == null && legalH.has(`${r},${c}`));
                const v = this.vFenceEls[r][c];
                v.classList.toggle("placed", vOwner != null);
                v.classList.toggle("p1", vOwner === 0);
                v.classList.toggle("p2", vOwner === 1);
                v.classList.toggle("legal", vOwner == null && legalV.has(`${r},${c}`));
            }
        }

        const p0 = eng.pawns[0];
        const p1 = eng.pawns[1];
        this.hudEl.innerHTML =
            `<span class="wall-p1">You · ${p0.wallsLeft} walls</span>` +
            `<span class="wall-p2">AI · ${p1.wallsLeft} walls</span>`;
    }
}

const game = new QuoridorGame();
