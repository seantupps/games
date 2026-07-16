/**
 * GOPS hub — SP vs AI, N=13 full opening.
 * Both hands open; prize pile face-down; drag your card into the play slot.
 */
/* global BaseGame, GopsEngine */

const params = new URLSearchParams(window.location.search);
if (params.has("theme")) {
    document.documentElement.style.setProperty("--theme-color", params.get("theme"));
}
if (params.has("opp")) {
    document.documentElement.style.setProperty("--opponent-color", params.get("opp"));
}

const SUIT_YOU = "♠";
const SUIT_AI = "♥";
const SUIT_PRIZE = "♦";
/** Desktop default zoom when nothing is persisted for GOPS. */
const GOPS_DEFAULT_ZOOM = 1.15;

class GopsHubGame extends BaseGame {
    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get("mode") || "classic";
        this.localSize = 800;
        this.defaultZoom = GOPS_DEFAULT_ZOOM;
        this.turn = "P1";
        this.isOver = false;
        this.winner = null;
        this.scores = { P1: 0, P2: 0 };
        this._auditReady = false;
        this._busy = false;
        this._aiId = 0;
        this._phase = "idle"; // waiting_player | resolving | between
        this._stagedPlayerBid = null;
        this._stagedAiBid = null;
        this._drag = null;

        this.engine = new GopsEngine.Engine({ n: 13 });
        this._buildDom();
        this._initAiWorker();
        this._bindPointerDrag();

        this.initIdentity("gops", this.mode);

        this.onIdentitySynced = () => {
            this.identitySynced = true;
            if (!this.isMultiplayer) {
                this._auditReady = true;
                this._startMatch();
            }
            this.updateTurnIndicator?.();
            this.requestRender();
            this.fitBoardToViewport?.();
        };

        this._bindMobileLayoutRefresh();
        window.game = this;
        document.body.classList.add("gops-game");
        this.requestRender();
    }

    _startMatch() {
        this.engine = new GopsEngine.Engine({ n: 13 });
        this.engine.revealNextPrize();
        // Fixed seat order for the whole match — empty seats stay open after play.
        this._youSlots = this.engine.playerHand.slice();
        this._aiSlots = this.engine.aiHand.slice();
        this._phase = "waiting_player";
        this._stagedPlayerBid = null;
        this._stagedAiBid = null;
        this._busy = false;
        this._renderFp = null;
        this._syncMeta();
        this.requestRender();
        if (this._worker) {
            this._worker.postMessage({ type: "eval", state: this.engine.toJSON() });
        }
    }

    _buildDom() {
        const root = document.getElementById("game-container");
        root.innerHTML = "";
        this.boardEl = document.createElement("div");
        this.boardEl.id = "gops-board";
        root.appendChild(this.boardEl);

        this.boardEl.innerHTML = `
            <div class="gops-opp-hand" data-hand="ai"></div>
            <div class="gops-mid">
                <div class="gops-prize-col">
                    <div class="gops-prize-active"></div>
                </div>
                <div class="gops-table">
                    <div class="gops-play-slot ai" data-slot="ai"></div>
                    <div class="gops-play-slot you" data-slot="you"></div>
                </div>
                <div class="gops-scores">
                    <div class="gops-score opp"><span class="gops-score-dot"></span><span class="val">0</span></div>
                    <div class="gops-score you"><span class="gops-score-dot"></span><span class="val">0</span></div>
                </div>
            </div>
            <div class="gops-my-hand" data-hand="you"></div>
            <div class="gops-banner"></div>
        `;

        this.oppHandEl = this.boardEl.querySelector(".gops-opp-hand");
        this.myHandEl = this.boardEl.querySelector(".gops-my-hand");
        this.prizeActiveEl = this.boardEl.querySelector(".gops-prize-active");
        this.slotAiEl = this.boardEl.querySelector('.gops-play-slot.ai');
        this.slotYouEl = this.boardEl.querySelector('.gops-play-slot.you');
        this.scoreOppEl = this.boardEl.querySelector(".gops-score.opp .val");
        this.scoreYouEl = this.boardEl.querySelector(".gops-score.you .val");
        this.bannerEl = this.boardEl.querySelector(".gops-banner");
        this.scoreYouWrap = this.boardEl.querySelector(".gops-score.you");
        this.scoreOppWrap = this.boardEl.querySelector(".gops-score.opp");
    }

    _initAiWorker() {
        try {
            this._worker = new Worker("ai-worker.js");
            this._worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
            this._worker.postMessage({ type: "warmup" });
        } catch (err) {
            console.warn("[gops] AI worker unavailable", err);
            this._worker = null;
        }
    }

    _logNashMeta(meta, { bid = null, heading = null } = {}) {
        if (!meta) return;
        if (meta.source !== "nash") {
            if (meta.error) {
                console.warn("[gops-ai]", meta.error);
            }
            return;
        }
        if (heading) console.log(`[gops-ai] ${heading}`);
        if (meta.chances) console.log(meta.chances);
        for (const line of meta.mixes || []) {
            console.log(line);
        }
        if (bid != null) console.log(`AI:    ${bid}`);
        if (meta.turn_line) console.log(meta.turn_line);
        else if (meta.ms != null) {
            const bits = [
                meta.mode,
                `${meta.ms}ms solve`,
                meta.http_ms != null ? `${meta.http_ms}ms http` : null,
            ].filter(Boolean);
            console.log(`[gops-ai] (${bits.join(", ")})`);
        }
    }

    _onWorkerMessage(msg) {
        if (!msg) return;
        if (msg.type === "eval") {
            this._logNashMeta(msg.meta, { heading: "opening" });
            return;
        }
        if (msg.type === "ready") {
            if (msg.nash) console.log("[gops-ai] Nash bridge ready");
            else console.warn("[gops-ai] Nash bridge offline — heuristic AI");
            return;
        }
        if (msg.type !== "move" || msg.id !== this._aiId) return;
        if (msg.meta && msg.meta.source === "nash") {
            this._logNashMeta(msg.meta, { bid: msg.bid });
        } else {
            console.warn("[gops-ai] using heuristic (Nash bridge offline — run `games`)");
        }
        this._finishAiBid(msg.bid);
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
        return !this.isMultiplayer || this._auditReady;
    }

    _syncMeta() {
        this.turn = this._phase === "waiting_player" ? "P1" : "P2";
        this.isOver = this.engine.isFinished() && this._phase !== "resolving";
        if (this.isOver) {
            const w = this.engine.matchWinner();
            this.winner = w === "draw" ? null : w;
        } else {
            this.winner = null;
        }
    }

    getValidMoves() {
        if (this.isOver || this._busy || this._phase !== "waiting_player") return [];
        return this.engine.playerHand.map((rank) => ({ type: "bid", rank }));
    }

    submitMove(move) {
        if (!move || move.type !== "bid") return false;
        return this._playPlayerBid(move.rank);
    }

    _playPlayerBid(rank) {
        if (this._busy || this.isOver || this._phase !== "waiting_player") return false;
        if (!this.engine.playerHand.includes(rank)) return false;

        this._stagedPlayerBid = rank;
        this._busy = true;
        this._phase = "resolving";
        this._syncMeta();
        this.requestRender();

        const id = ++this._aiId;
        const state = this.engine.toJSON();
        if (this._worker) {
            this._worker.postMessage({ type: "choose", state, id });
        } else {
            const bid = this.engine.chooseAiBid();
            setTimeout(() => {
                if (id === this._aiId) this._finishAiBid(bid);
            }, 40);
        }
        return true;
    }

    getDefaultZoomForViewport() {
        if (this.isMobileViewport?.()) {
            const M = typeof EngineMobileLayout !== "undefined" ? EngineMobileLayout : null;
            if (M?.getDefaultZoomForViewport) return M.getDefaultZoomForViewport(this);
        }
        return this.defaultZoom ?? GOPS_DEFAULT_ZOOM;
    }

    async _finishAiBid(aiBid) {
        if (!this._stagedPlayerBid || this.isOver) {
            this._busy = false;
            return;
        }
        this._stagedAiBid = aiBid;
        this.requestRender();

        // Score updates immediately; keep both bid cards on the table for 1s.
        this.engine.resolveRound(this._stagedPlayerBid, aiBid);
        this._syncMeta();
        this.requestRender();

        await new Promise((r) => setTimeout(r, 1500));

        this._stagedPlayerBid = null;
        this._stagedAiBid = null;

        if (this.engine.isFinished()) {
            if (this.engine.pendingPrizes.length) this.engine.pendingPrizes = [];
            this._phase = "idle";
            this._busy = false;
            this._syncMeta();
            if (this.winner) {
                this.scores[this.winner] = (this.scores[this.winner] || 0) + 1;
            }
            this.updateTurnIndicator?.();
            this.requestRender();
            this.setGameOver?.(this.winner || "P1");
            return;
        }

        // Next prize immediately (no extra deal delay).
        this.engine.prepareNextPrize();
        this._phase = "waiting_player";
        this._busy = false;
        this._syncMeta();
        this.updateTurnIndicator?.();
        this.requestRender();
    }

    _flashBanner() {
        /* banner removed */
    }

    /* --- Card DOM --- */

    _cardEl({ rank, owner, faceDown = false, ghost = false }) {
        const el = document.createElement("div");
        el.className = `gops-card owner-${owner}${faceDown ? " back" : ""}${ghost ? " ghost" : ""}`;
        el.dataset.rank = rank || "";
        el.dataset.owner = owner;
        if (faceDown) {
            el.innerHTML = `<div class="gops-card-back"></div>`;
            return el;
        }
        const suit = owner === "you" ? SUIT_YOU : owner === "ai" ? SUIT_AI : SUIT_PRIZE;
        const suitTone = suit === "♥" || suit === "♦" ? "red" : "black";
        el.classList.add(`suit-${suitTone}`);
        el.innerHTML = `
            <span class="corner tl"><b>${rank}</b><i>${suit}</i></span>
            <span class="pip">${suit}</span>
            <span class="corner br"><b>${rank}</b><i>${suit}</i></span>
        `;
        return el;
    }

    _fillHand(container, slots, liveHand, owner, interactive, stagedRank) {
        container.innerHTML = "";
        const live = new Set(liveHand);
        for (const rank of slots) {
            const present = live.has(rank) && rank !== stagedRank;
            if (present) {
                const card = this._cardEl({ rank, owner });
                if (interactive) {
                    card.classList.add("draggable");
                    card.dataset.interactive = "1";
                }
                container.appendChild(card);
            } else {
                const spacer = document.createElement("div");
                spacer.className = "gops-card-slot";
                spacer.setAttribute("aria-hidden", "true");
                container.appendChild(spacer);
            }
        }
    }

    /* --- Hold / drag into play slot --- */

    _bindPointerDrag() {
        const onDown = (e) => {
            const card = e.target.closest?.(".gops-card.draggable");
            if (!card || this._phase !== "waiting_player" || this._busy) return;
            if (e.button != null && e.button !== 0) return;
            e.preventDefault();
            const rank = card.dataset.rank;
            const rect = card.getBoundingClientRect();
            this._drag = {
                rank,
                card,
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                ox: e.clientX - rect.left,
                oy: e.clientY - rect.top,
                moved: false,
                ghost: null,
            };
            card.setPointerCapture?.(e.pointerId);
        };

        const onMove = (e) => {
            const d = this._drag;
            if (!d || e.pointerId !== d.pointerId) return;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            if (!d.moved && Math.hypot(dx, dy) < 6) return;
            if (!d.moved) {
                d.moved = true;
                d.card.classList.add("is-source");
                // Keep layout size (--card-w/--card-h) so fonts match; mirror board zoom.
                const r = d.card.getBoundingClientRect();
                const zoom = this.zoom || 1;
                d.ox = e.clientX - r.left;
                d.oy = e.clientY - r.top;
                d.w = d.card.offsetWidth;
                d.h = d.card.offsetHeight;
                d.ghost = d.card.cloneNode(true);
                d.ghost.classList.add("gops-drag-ghost");
                d.ghost.classList.remove("is-source", "draggable");
                d.ghost.style.width = `${d.w}px`;
                d.ghost.style.height = `${d.h}px`;
                d.ghost.style.boxSizing = "border-box";
                d.ghost.style.transformOrigin = "0 0";
                d.ghost.style.transform = `scale(${zoom})`;
                document.body.appendChild(d.ghost);
            }
            const zoom = this.zoom || 1;
            d.ghost.style.transform = `scale(${zoom})`;
            d.ghost.style.left = `${e.clientX - d.ox}px`;
            d.ghost.style.top = `${e.clientY - d.oy}px`;

            const over = this._hitPlaySlot(e.clientX, e.clientY);
            this.slotYouEl.classList.toggle("drop-hot", !!over);
        };

        const onUp = (e) => {
            const d = this._drag;
            if (!d || e.pointerId !== d.pointerId) return;
            const over = d.moved && this._hitPlaySlot(e.clientX, e.clientY);
            if (d.ghost) d.ghost.remove();
            d.card.classList.remove("is-source");
            this.slotYouEl.classList.remove("drop-hot");
            this._drag = null;
            if (over) this._playPlayerBid(d.rank);
        };

        this.boardEl.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    }

    _hitPlaySlot(clientX, clientY) {
        const r = this.slotYouEl.getBoundingClientRect();
        const pad = 12;
        return (
            clientX >= r.left - pad &&
            clientX <= r.right + pad &&
            clientY >= r.top - pad &&
            clientY <= r.bottom + pad
        );
    }

    serializeBoard() {
        return {
            initialized: true,
            engine: this.engine.toJSON(),
            phase: this._phase,
            stagedPlayerBid: this._stagedPlayerBid,
            stagedAiBid: this._stagedAiBid,
            turn: this.turn,
            isOver: this.isOver,
            winner: this.winner,
            scores: { ...this.scores },
        };
    }

    applyBoard(board) {
        if (!board) return;
        if (board.engine) this.engine = GopsEngine.Engine.fromJSON(board.engine);
        if (board.phase) this._phase = board.phase;
        this._stagedPlayerBid = board.stagedPlayerBid || null;
        this._stagedAiBid = board.stagedAiBid || null;
        if (board.turn) this.turn = board.turn;
        if (board.isOver != null) this.isOver = !!board.isOver;
        if (board.winner != null) this.winner = board.winner;
        if (board.scores) this.scores = { ...board.scores };
        this._auditReady = !!board.initialized;
        this.requestRender();
    }

    applyState(state) {
        this.applyBoard(state);
    }

    onGameReset() {
        this._aiId++;
        this._busy = false;
        this._stagedPlayerBid = null;
        this._stagedAiBid = null;
        if (!this.isMultiplayer) this._startMatch();
        this._auditReady = !this.isMultiplayer;
        this.requestRender();
    }

    _render() {
        const eng = this.engine;
        const youSlots = this._youSlots || eng.playerHand.slice();
        const aiSlots = this._aiSlots || eng.aiHand.slice();

        const interactive = this._phase === "waiting_player" && !this._busy;
        const fp = [
            eng.playerHand.join(","),
            eng.aiHand.join(","),
            eng.pendingPrizes.join(","),
            this._stagedPlayerBid || "",
            this._stagedAiBid || "",
            eng.playerScore,
            eng.aiScore,
            this._phase,
            interactive ? "1" : "0",
        ].join("|");
        if (fp === this._renderFp) return;
        this._renderFp = fp;

        this._fillHand(
            this.oppHandEl,
            aiSlots,
            eng.aiHand,
            "ai",
            false,
            this._stagedAiBid
        );
        this._fillHand(
            this.myHandEl,
            youSlots,
            eng.playerHand,
            "you",
            interactive,
            this._stagedPlayerBid
        );

        // Current prize only (no face-down draw pile)
        this.prizeActiveEl.innerHTML = "";
        for (const rank of eng.pendingPrizes) {
            this.prizeActiveEl.appendChild(this._cardEl({ rank, owner: "prize" }));
        }

        this.slotAiEl.innerHTML = "";
        this.slotYouEl.innerHTML = "";
        if (this._stagedAiBid) {
            this.slotAiEl.appendChild(this._cardEl({ rank: this._stagedAiBid, owner: "ai" }));
        }
        if (this._stagedPlayerBid) {
            this.slotYouEl.appendChild(this._cardEl({ rank: this._stagedPlayerBid, owner: "you" }));
        }

        this.scoreOppEl.textContent = String(eng.aiScore);
        this.scoreYouEl.textContent = String(eng.playerScore);
        this.scoreYouWrap.classList.toggle("active", this._phase === "waiting_player");
        this.scoreOppWrap.classList.toggle("active", this._phase === "resolving");
    }
}

const game = new GopsHubGame();
