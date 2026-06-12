class BaseGame {
    constructor() {
        this.turn = 'P1';
        this.isOver = false;
        this.winner = null;
        this.zoom = 1.0;
        this.targetZoom = 1.0;
        this.zoomVelocity = 0.12;
        this._pointerDragging = false;
        this.lastResetCount = 0;

        this.devMode = localStorage.getItem('game_devMode') === 'true';

        // Identity for score isolation
        this.gameName = 'unknown';
        this.mode = 'default';

        this.username = localStorage.getItem('username') || "You";
        this.opponentName = "Opponent";

        const urlParams = new URLSearchParams(window.location.search);
        this.roomId = urlParams.get('room');
        this.playerRole = urlParams.get('role') || 'P1';
        this.isMultiplayer = !!this.roomId && this.roomId !== 'lobby';


        this.scoreVisible = localStorage.getItem('game_scoreVisible') !== 'false';
        this.scores = { P1: 0, P2: 0 };
        this._victoryRegistered = false;
        this._winBannerSent = false;
        this.autoResetTimer = null;

        // Multiplayer State
        this.piecePositions = {};
        this.remotelyDraggedPieces = {};
        this.selection = { pk: null, ids: [] };
        this.opponentSelection = null; // { pk, ids }

        // Color Management
        this.editingType = null;
        this.hoveredType = null;

        // Rendering Boilerplate
        this.renderPending = false;
        this.mousePos = { x: 0, y: 0 };
        this.uid = localStorage.getItem('game_uid') || sessionStorage.getItem('game_uid');
        this.localSize = 1000; // Default world-to-local scale (0-1000 world)

        this.gameEvents = [];
        this._eventsLoaded = false;
        this._lastTurnSyncedEventCount = -1;
        this.roomData = null;
        this._pinchActive = false;
        this._mobileBaseFit = 1;
        this._fitZoomInitialized = false;
        /** Freestyle piles: anchor cx/cy locked after first mobile layout (removals must not recenter). */
        this._mobileLayoutAnchorLocked = false;

        this.initKeybinds();
        this.setupEngineListeners();
        this.initNetworkListeners();
        this.initColorPicker();
        this.initGlobalEvents();
        this.initDevCommands();
        this.initZoom();
        if (typeof GameAdapter !== 'undefined') GameAdapter.attachGameAdapter(this);
        if (typeof GameSync !== 'undefined') GameSync.attachGameSync(this);
        setTimeout(() => this.updateTurnIndicator(), 0); // Init UI
        setTimeout(() => {
            window.parent.postMessage({ type: 'iframe-ready' }, '*');
        }, 50);
        if (typeof GameDevOverlay !== 'undefined') GameDevOverlay.sync(this);
    }

    requestRender() {
        if (this.renderPending) return;
        this.renderPending = true;
        requestAnimationFrame(() => {
            if (this._render) this._render();
            else if (this.render) this.render();
            this.renderPending = false;
        });
    }

    initDevCommands() {
        window.addEventListener('message', (e) => {
            if (!e.data || e.data.type !== 'dev-win') return;
            this.debugTriggerWin();
        });
    }

    /** Hub chat `/win` — games override for full victory flow (e.g. Bananagrams review). */
    debugTriggerWin() {
        if (this.isOver) return;
        const role = this.playerRole || 'P1';
        if (typeof this.setGameOver === 'function') {
            this.setGameOver(role);
            return;
        }
        console.warn('[DEV] /win: setGameOver not available for', this.gameName);
    }

    initGlobalEvents() {
        window.addEventListener('resize', () => {
            if (this._usesPanZoomBoard() && typeof GameViewport !== 'undefined') {
                GameViewport.reflowOnResize(this);
            }
            if (this.isMobileViewport?.() && !this._usesFitSquareMobileLayout()) {
                if (this._mobileLayoutAnchorLocked) this.refreshMobileLayoutViewportOnly();
                else this.refreshMobileLayout();
            }
            this.requestRender();
        });
        window.addEventListener('orientationchange', () => {
            if (this.isMobileViewport?.()) {
                if (this._mobileLayoutAnchorLocked) this.refreshMobileLayoutViewportOnly();
                else this.refreshMobileLayout();
            }
        });
        const trackPointer = (e) => {
            this.mousePos = { x: e.clientX, y: e.clientY };
        };
        window.addEventListener('mousemove', trackPointer);
        window.addEventListener('pointermove', trackPointer);
        window.addEventListener('message', (e) => {
            if (e.data.type === 'mousemove') {
                this.mousePos = { x: e.data.clientX, y: e.data.clientY };
            }
            if (e.data.type === 'five-viewport-mode' && e.data.mobile) {
                this._onMobileViewportModeEnabled();
            }
        });
        window.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this.isMyTurn()) return;
            const lastDrag = this.lastDragEnd || 0;
            if (Date.now() - lastDrag < 100) return;
            if (this.onEnter) this.onEnter();
        });

        this.initLongPressEndTurn();
    }

    /**
     * Same-origin iframe: touches on the right strip post to hub (overlay misses if gesture starts in frame).
     */
    initMobileSettingsEdgeSwipe() {
        if (!this.isMobileViewport() || window.parent === window) return;
        if (this.hasCap && !this.hasCap('supportsSettingsEdgeSwipe')) return;

        const EDGE_INSET_PX = 44;
        const MIN_SWIPE_PX = 52;
        const MAX_VERTICAL_DRIFT_PX = 90;
        const MAX_SWIPE_MS = 700;
        let start = null;

        const cancel = () => {
            start = null;
        };

        const onStart = (clientX, clientY) => {
            if (clientX > EDGE_INSET_PX) return;
            start = { x0: clientX, y0: clientY, t0: Date.now() };
        };

        const onMove = (clientX) => {
            if (!start) return;
            if (clientX < start.x0 - 28) cancel();
        };

        const onEnd = (clientX, clientY) => {
            if (!start) return;
            const dx = clientX - start.x0;
            const dy = Math.abs(clientY - start.y0);
            const dt = Date.now() - start.t0;
            cancel();
            if (dx < MIN_SWIPE_PX || dy > MAX_VERTICAL_DRIFT_PX || dt > MAX_SWIPE_MS) return;
            window.parent.postMessage({ type: 'open-settings-edge-swipe' }, '*');
        };

        const target = document.body;
        target.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            onStart(t.clientX, t.clientY);
        }, { passive: true });

        target.addEventListener('touchmove', (e) => {
            if (!start || e.touches.length !== 1) return;
            onMove(e.touches[0].clientX);
        }, { passive: true });

        target.addEventListener('touchend', (e) => {
            if (!start) return;
            const t = e.changedTouches[0];
            onEnd(t.clientX, t.clientY);
        }, { passive: true });

        target.addEventListener('touchcancel', cancel, { passive: true });

        target.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            onStart(e.clientX, e.clientY);
        });

        target.addEventListener('pointermove', (e) => {
            if (!start) return;
            onMove(e.clientX);
        });

        target.addEventListener('pointerup', (e) => {
            if (!start) return;
            onEnd(e.clientX, e.clientY);
        });

        target.addEventListener('pointercancel', cancel);
    }

    /** Mobile / touch: long-press ends turn (piles); replaces right-click on coarse pointers. */
    initLongPressEndTurn() {
        if (!this.onEnter) return;
        const container = document.getElementById('game-container') || document.body;

        const LONG_MS = 550;
        const MOVE_CANCEL_PX = 14;
        let timer = null;
        let start = null;

        const clear = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            start = null;
        };

        const onDown = (e) => {
            if (!this.isMobileViewport()) return;
            if (this._pinchActive) return;
            if (e.touches && e.touches.length >= 2) return;
            if (e.button !== undefined && e.button !== 0) return;
            if (!this.isMyTurn()) return;
            const pt = e.touches?.[0] || e;
            start = { x: pt.clientX, y: pt.clientY };
            timer = setTimeout(() => {
                timer = null;
                if (this._pinchActive) return;
                const lastDrag = this.lastDragEnd || 0;
                if (Date.now() - lastDrag < 150) return;
                if (this.onEnter) this.onEnter();
            }, LONG_MS);
        };

        const onMove = (e) => {
            if (!this.isMobileViewport()) return;
            if (this._pinchActive || (e.touches && e.touches.length >= 2)) {
                clear();
                return;
            }
            if (!start || !timer) return;
            const pt = e.touches?.[0] || e;
            if (Math.hypot(pt.clientX - start.x, pt.clientY - start.y) > MOVE_CANCEL_PX) clear();
        };

        container.addEventListener('pointerdown', onDown);
        container.addEventListener('pointermove', onMove);
        container.addEventListener('pointerup', clear);
        container.addEventListener('pointercancel', clear);
        container.addEventListener('touchstart', (e) => {
            if (e.touches.length >= 2) clear();
        }, { passive: true });
        container.addEventListener('touchmove', onMove, { passive: true });
    }

    enableDragging(el, onDragStart, onDragEnd) {
        BaseGame.setupDragging(el, (isDragging, draggedEl, e) => {
            this.isDragging = false;
            if (isDragging) {
                const lx = parseFloat(draggedEl.style.left);
                const ly = parseFloat(draggedEl.style.top);
                if (!isNaN(lx) && !isNaN(ly)) {
                    const world = this.toWorld(lx, ly);
                    this.piecePositions[draggedEl.id] = { nx: world.x, ny: world.y };
                    if (this.isMultiplayer) {
                        const uid = this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
                        this.broadcast(`interactions/drag/${uid}`, null);
                        this.broadcast(`global/piecePositions/${draggedEl.id}`, { nx: world.x, ny: world.y, uid: uid });
                    }
                }
                this.lastDragEnd = Date.now();
                if (onDragEnd) onDragEnd(draggedEl);
            }
            this.isDragging = false;
        }, this, (draggedEl) => {
            if (this.selection.ids.includes(draggedEl.id)) return false;
            this.isDragging = true;
            if (onDragStart) return onDragStart(draggedEl);
            return true;
        }, (lx, ly) => {
            if (!this.isMultiplayer) return;
            const now = Date.now();
            if (now - (this.lastDragSync || 0) < 30) return;
            this.lastDragSync = now;
            const world = this.toWorld(lx + 30, ly + 30);
            const uid = this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
            this.broadcast(`interactions/drag/${uid}/${el.id}`, { x: world.x - 500, y: world.y - 500, uid: uid });
        });
    }

    getPieceStyle(id, pk, defaultNx, defaultNy) {
        // COORDINATE PERSISTENCE: Only for freestyle
        let nx = defaultNx;
        let ny = defaultNy;

        if (this.mode === 'freestyle' && this.piecePositions && this.piecePositions[id]) {
            nx = this.piecePositions[id].nx !== undefined ? this.piecePositions[id].nx : defaultNx;
            ny = this.piecePositions[id].ny !== undefined ? this.piecePositions[id].ny : defaultNy;
        }

        const container = document.getElementById('game-container');
        const vis = this.isMobileViewport() ? this.getVisibleViewportSize() : null;
        const width = vis?.width || (container ? (container.offsetWidth || window.innerWidth) : 1000);
        const height = vis?.height || (container ? (container.offsetHeight || window.innerHeight) : 1000);

        const scale = this.isMobileViewport()
            ? 1.0
            : (parseFloat(container?.style.getPropertyValue('--board-scale')) || 1.0);

        const lx = this.isMobileViewport()
            ? nx
            : (width / 2) + (nx - 500) * scale;
        const ly = this.isMobileViewport()
            ? ny
            : (height / 2) + (ny - 500) * scale;

        let classes = [];
        if (this.selection.pk === pk && this.selection.ids.includes(id)) classes.push('selected');
        if (this.opponentSelection && this.opponentSelection.pk === pk && this.opponentSelection.ids && this.opponentSelection.ids.includes(id)) classes.push('selected-opponent');

        return {
            left: `${lx}px`,
            top: `${ly}px`,
            classList: classes
        };
    }

    isMyTurn() {
        if (this.isOver) return false;
        if (this.roomId === 'lobby') return this.turn === 'P1';
        if (this.isMultiplayer) return this.turn === this.playerRole;
        return this.turn === 'P1';
    }

    isHost() {
        if (!this.isMultiplayer || this.roomId === 'lobby') return true;
        return this.playerRole === 'P1';
    }

    _mobileLayoutPolicy() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.policy) return M.policy(this);
    }

    _usesFitSquareMobileLayout() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.usesFitSquare) return M.usesFitSquare(this);
    }

    _usesPanZoomBoard() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.usesPanZoomBoard) return M.usesPanZoomBoard(this);
    }

    _usesFixedSpiralMobileAnchor() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.usesFixedSpiralAnchor) return M.usesFixedSpiralAnchor(this);
    }

    _boardKind() {
        return this.capabilities?.boardKind || 'generic';
    }

    initViewportPan() {
        if (typeof GameViewport !== 'undefined') GameViewport.initPan(this);
    }

    /** Current rematch generation (defaults legacy events without field to round 1). */
    _currentResetRound() {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.currentResetRound) return M.currentResetRound(this);
        const roomRc = this.roomData?.global?.resetCount;
        const last = this.lastResetCount;
        const ack = this._resetAcknowledgedCount;
        const candidates = [roomRc, last, ack].filter((n) => typeof n === 'number' && n > 0);
        return candidates.length ? Math.max(...candidates) : 1;
    }

    _eventTimestamp(ev) {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.eventTimestamp) return M.eventTimestamp(this, ev);
    }

    _dropStaleFinishedBatch(events, round) {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.dropStaleFinishedBatch) return M.dropStaleFinishedBatch(this, events, round);
    }

    /** Only replay moves from the active game after host auto-reset. */
    _eventsForReplay(events) {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.eventsForReplay) return M.eventsForReplay(this, events);
    }

    initNetworkListeners() {
        if (typeof EngineNetwork !== 'undefined' && EngineNetwork.registerAll) {
            EngineNetwork.registerAll(this);
            return;
        }
        console.warn('[ENGINE] EngineNetwork not loaded; MP sync disabled');
    }

    rebuildState() {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.rebuildState) M.rebuildState(this);
    }

    applyState(state) {
        // Overridden by subclass (e.g. piles.js sets this.piles = state.piles)
    }

    _partyMemberCount() {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.partyMemberCount) return M.partyMemberCount(this);
    }

    /** Merge partial RTDB payloads; board uses resetCount epoch + board.seq (see RtdbSchema.mergeRoomBoard). */
    _mergeRoomSnapshot(prev, incoming) {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.mergeRoomSnapshot) return M.mergeRoomSnapshot(this, prev, incoming);
        return incoming || prev;
    }

    /** Shared transient cleanup when resetCount advances (host or guest). */
    _clearResetTransientState() {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.clearResetTransientState) M.clearResetTransientState(this);
    }

    /**
     * Host: regenerate via onGameReset (then pushes global/board).
     * Guest: apply global/board from the same RTDB payload — do not wipe locally first.
     */
    _applyRemoteResetSignal(data) {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.applyRemoteResetSignal) M.applyRemoteResetSignal(this, data);
    }

    /** Rebuild visible board from host reset payload (not from stale event log). */
    _applyFreshBoardFromRoom() {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.applyFreshBoardFromRoom) M.applyFreshBoardFromRoom(this);
    }

    notifyGameRendered() {
        if (this._gameRenderedNotified || window.parent === window) return;
        let visible = 0;
        if (this.hasCap('supportsPileColors') && this.piles) {
            visible = Object.values(this.piles).reduce((n, arr) => n + (arr?.length || 0), 0);
        } else if (this.nodes) {
            visible = this.nodes.length;
        }
        const container = document.getElementById('game-container');
        const cw = container?.offsetWidth || 0;
        const ch = container?.offsetHeight || 0;
        if (visible === 0 && (cw === 0 || ch === 0)) return;
        this._gameRenderedNotified = true;
        window.parent.postMessage({
            type: 'game-rendered',
            game: this.gameName,
            visible,
            containerW: cw,
            containerH: ch
        }, '*');
    }

    safeRender() {
        const container = document.getElementById('game-container');
        if (container) {
            const vis = this.getVisibleViewportSize?.() || null;
            const width = container.offsetWidth || vis?.width || window.innerWidth;
            const height = container.offsetHeight || vis?.height || window.innerHeight;
            const maxRetries = /iPhone|iPad|Android/i.test(navigator.userAgent || '') ? 60 : 10;
            if (width === 0 || height === 0) {
                if (!this._renderRetryCount || this._renderRetryCount < maxRetries) {
                    this._renderRetryCount = (this._renderRetryCount || 0) + 1;
                    requestAnimationFrame(() => this.safeRender());
                    return;
                }
                window.parent.postMessage({
                    type: 'game-render-failed',
                    reason: 'zero-size-container',
                    w: width,
                    h: height
                }, '*');
            }
            // Centralized Scale Factor (Unscaled layout values)
            const scaleX = width / 1000;
            const scaleY = height / 1000;
            if (!this.isMobileViewport()) {
                const boardScale = Math.min(scaleX, scaleY);
                container.style.setProperty('--board-scale', boardScale);
            } else {
                container.style.setProperty('--board-scale', '1');
            }
        }

        if (this.requestRender) this.requestRender();
        else if (this._render) this._render();
        else if (this.render) this.render();
        else if (typeof _render !== 'undefined') _render();

        this.notifyGameRendered();
    }

    broadcast(path, payload) {
        if (this.sync?.send) this.sync.send(path, payload);
        else window.parent.postMessage({ type: 'network-send', path, payload }, '*');
    }

    broadcastTurn(nextTurn) {
        this.broadcast('global/turn', nextTurn);
    }

    // Atomic room update
    updateMetadata(updates) {
        if (this.sync?.updateRoom) this.sync.updateRoom(updates);
        else window.parent.postMessage({ type: 'network-update-room', updates }, '*');
    }

    /**
     * Authoritative Move Submission
     * Handles turn swapping, board sync, and atomic cleanup
     */
    submitMove(movePayload) {
        if (this.isOver) return;

        // In multiplayer, we just send the event. Replay will update local state.
        if (this.isMultiplayer) {
            // Client local turn = visual prediction only (optimistic swap removed for server authority)
            const event = {
                type: 'move',
                payload: movePayload,
                resetCount: this._currentResetRound()
            };
            if (this.sync?.sendEvent) this.sync.sendEvent(event);
            else window.parent.postMessage({ type: 'network-send-event', event }, '*');

            // Optimistic Update (Optional, let's keep it robust for now)
            // Still clear selection immediately
            this.selection = { pk: null, ids: [] };
            this.broadcastSelection();
            return;
        }

        // Solo Mode Fallback (Direct logic calls)
        if (!window.GameLogic) return;
        const logic = GameLogic[this.gameName];
        if (!logic) return;

        // Current state for logic
        const currentState = {
            piles: this.piles,
            lines: this.lines,
            path: this.path,
            endpoints: this.endpoints,
            usedNodes: this.nodes ? this.nodes.map(n => n.used || false) : [],
            turn: this.turn,
            isOver: this.isOver
        };

        if (logic.isValidMove(currentState, movePayload)) {
            const newState = logic.applyMove(currentState, movePayload);
            this.applyState(newState);
            this.rebuildStateFromLocal(newState);

            if (this.turn === 'P2' && !this.isOver) {
                this.triggerAITurn();
            }
        } else {
            console.error(`[ENGINE] Invalid move attempt in mode ${this.mode}:`, movePayload);
        }
    }

    rebuildStateFromLocal(state) {
        this.turn = state.turn;
        this.isOver = state.isOver;
        this.winner = state.winner;
        if (this.applyState) this.applyState(state);
        this.updateTurnIndicator();
        this.safeRender();
        if (this.isOver) this.setGameOver(this.winner);
    }

    resetGame() {
        this.clearAutoReset();
        const wasOver = this.isOver;
        this._victoryRegistered = false;
        this._winBannerSent = false;
        this.isOver = false;
        this.winner = null;
        this.clearWinOverlay();
        this.gameEvents = [];
        this._lastTurnSyncedEventCount = -1;

        // 1. Reset local UI
        this.selection = { pk: null, ids: [] };
        this.opponentSelection = null;
        this.broadcastSelection();
        window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');

        let hostResetUpdates = null;
        if (this.isMultiplayer && this.playerRole === 'P1') {
            hostResetUpdates = this.sync?.buildHostResetUpdates
                ? this.sync.buildHostResetUpdates({ wasOver, includeBoard: false })
                : (() => {
                    if (wasOver) {
                        const prevFirstPlayer = this.firstPlayer || 'P1';
                        this.firstPlayer = prevFirstPlayer === 'P1' ? 'P2' : 'P1';
                        console.log(`HOST: Alternating first player for the next game. Prev: ${prevFirstPlayer}, Next: ${this.firstPlayer}`);
                    } else if (!this.firstPlayer) {
                        this.firstPlayer = 'P1';
                    }
                    const startTurn = this.firstPlayer;
                    this.turn = startTurn;
                    const resetCount = (this.roomData?.global?.resetCount || 0) + 1;
                    this.lastResetCount = resetCount;
                    this._resetAcknowledgedCount = resetCount;
                    this._resetAcknowledgedAt = Date.now();
                    return {
                        status: 'playing',
                        winner: null,
                        'global/firstPlayer': this.firstPlayer,
                        'global/turn': startTurn,
                        'global/resetCount': resetCount,
                        'global/board': null,
                        lastMove: null,
                        interactions: null
                    };
                })();
            if (typeof GameSync !== 'undefined' && GameSync.applyHostResetLocally) {
                GameSync.applyHostResetLocally(this, hostResetUpdates);
            }
        }

        // 2. Trigger local game logic reset (Host re-gens board locally at new resetCount)
        if (this.onGameReset) this.onGameReset();

        if (this.isHost() && this.hasCap('supportsPileColors')) {
            const varMap = { 'B': '--blue-color', 'R': '--red-color', 'G': '--green-color', 'Y': '--yellow-color' };
            this.currentColors = {};
            ['B', 'R', 'G', 'Y'].forEach(type => {
                this.currentColors[type] = getComputedStyle(document.documentElement).getPropertyValue(varMap[type]).trim();
            });
        }

        if (this.isMultiplayer && this.playerRole === 'P1') {
            const updates = hostResetUpdates || {};
            if (this.capabilities?.hasBoardState !== false && typeof this.serializeBoard === 'function') {
                updates['global/board'] = this.serializeBoard();
            }
            this.updateMetadata(updates);
            if (this.isHost()) this.rebuildState();
        } else if (!this.isMultiplayer) {
            this.turn = 'P1';
            this.piecePositions = {};
            localStorage.removeItem(`piecePositions_${this.gameName}_${this.mode}`);
        }

        // rebuildState (MP host) can override viewport set in onGameReset — re-apply default framing.
        if (typeof this._applyDefaultPlayingViewport === 'function') {
            this._applyDefaultPlayingViewport();
        }
        if (typeof this._syncViewportAfterLayout === 'function') {
            this._syncViewportAfterLayout();
        }

        this.safeRender();
        if (!this.isMultiplayer && this.turn === 'P2') this.triggerAITurn();
    }

    // --- Coordinate Normalization (Resolution Independence) ---
    // Maps screen pixels (centered) to a virtual 0-1000 world space
    toWorld(clientX, clientY) {
        const container = document.getElementById('game-container');
        if (!container) return { x: clientX, y: clientY };
        const rect = container.getBoundingClientRect();
        const baseSize = this.localSize || 1000;
        let lx = clientX - rect.left;
        let ly = clientY - rect.top;
        const tr = getComputedStyle(container).transform;
        if (tr && tr !== 'none') {
            try {
                const inv = new DOMMatrix(tr).inverse();
                const p = inv.transformPoint(new DOMPoint(lx, ly));
                lx = p.x;
                ly = p.y;
            } catch (_) { /* use untransformed */ }
        }
        const layoutW = container.offsetWidth || rect.width;
        const layoutH = container.offsetHeight || rect.height;
        return {
            x: Math.round((lx / layoutW) * baseSize),
            y: Math.round((ly / layoutH) * baseSize)
        };
    }

    isMobileViewport() {
        return typeof window.FiveViewport !== 'undefined' && window.FiveViewport.isMobile();
    }

    /** Visible iframe size (shrinks when parent hub reports keyboard / visual viewport). */
    getVisibleViewportSize() {
        const vv = window.visualViewport;
        if (this._hubVisibleViewport?.height) {
            return {
                width: this._hubVisibleViewport.width || window.innerWidth,
                height: this._hubVisibleViewport.height
            };
        }
        return {
            width: vv?.width || window.innerWidth,
            height: vv?.height || window.innerHeight
        };
    }

    getZoomStorageKey() {
        return `game_zoom_${this.gameName}_${this.mode}`;
    }

    /** Stable piles layout bounds in world units (nx/ny around 500) — does not move when pieces are picked. */
    _spiralCoords(n) {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.spiralCoords) return M.spiralCoords(this, n);
    }

    _classicPileWorldBounds(portrait) {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.classicPileWorldBounds) return M.classicPileWorldBounds(this, portrait);
    }

    _shouldLockFreestyleMobileLayout() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.shouldLockFreestyle) return M.shouldLockFreestyle(this);
    }

    /** Full freestyle spiral bbox — stable; does not shrink when pieces are removed. */
    getFreestyleInitialVisualBounds() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.getFreestyleInitialVisualBounds) return M.getFreestyleInitialVisualBounds(this);
    }

    getPilesStableVisualBounds() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.getPilesStableVisualBounds) return M.getPilesStableVisualBounds(this);
    }

    lockMobileLayoutAnchor() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.lockMobileLayoutAnchor) return M.lockMobileLayoutAnchor(this);
    }

    _applyMobilePilesContainerGeometry(bounds) {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.applyMobilePilesContainerGeometry) M.applyMobilePilesContainerGeometry(this, bounds);
    }

    /** Union of actual play pieces/nodes in local coordinates (not full board size). */
    getMobileVisualBounds() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.getMobileVisualBounds) return M.getMobileVisualBounds(this);
    }

    /** World-space bounds for pan-zoom-board games (tile rack / spread). */
    getPanZoomWorldVisualBounds() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.getPanZoomWorldVisualBounds) return M.getPanZoomWorldVisualBounds(this);
    }

    _fitPanZoomMobileViewport() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.fitPanZoomMobileViewport) return M.fitPanZoomMobileViewport(this);
    }

    /** Hub iframe: five-mobile class applied after initZoom — refit pan-zoom rack once mobile is known. */
    _onMobileViewportModeEnabled() {
        if (!this.isMobileViewport?.()) return;
        if (this._usesPanZoomBoard?.()) {
            this.refreshMobileLayout();
            if (typeof GameViewport !== 'undefined') {
                const c = typeof this.getViewportContentCenter === 'function'
                    ? this.getViewportContentCenter()
                    : null;
                const ox = this.ORIGIN ?? (this.localSize || 1000) / 2;
                const focal = c || { x: ox, y: ox };
                GameViewport.centerWorldPoint(this, focal.x, focal.y);
            }
            this.applyZoom();
        } else if (!this._usesFitSquareMobileLayout?.()) {
            this.refreshMobileLayout();
        }
        this.requestRender();
    }

    /** Recompute mobile zoom anchor once (not per render) — line fits board; piles use stable center. */
    refreshMobileLayout() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.refreshMobileLayout) return M.refreshMobileLayout(this);
    }

    /** Resize viewport shell without recomputing freestyle anchor (cx/cy stay fixed). */
    refreshMobileLayoutViewportOnly() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.refreshMobileLayoutViewportOnly) return M.refreshMobileLayoutViewportOnly(this);
    }

    getDefaultZoomForViewport() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.getDefaultZoomForViewport) return M.getDefaultZoomForViewport(this);
    }

    restorePersistedZoom() {
        if (!this.gameName || this.gameName === 'unknown') return;
        const raw = localStorage.getItem(this.getZoomStorageKey());
        const saved = raw != null ? parseFloat(raw) : NaN;
        const mobilePanZoom = this.isMobileViewport?.() && this._usesPanZoomBoard?.();
        if (Number.isFinite(saved)) {
            let zoom = Math.min(Math.max(saved, 0.2), 5);
            if (mobilePanZoom) {
                const fit = this.getDefaultZoomForViewport();
                if (Number.isFinite(fit)) {
                    if (zoom < fit) zoom = fit;
                    if (zoom > fit * 1.02) zoom = fit;
                }
            }
            this.targetZoom = zoom;
            this.zoom = zoom;
            this._fitZoomInitialized = true;
            return;
        }
        const def = this.getDefaultZoomForViewport();
        this.targetZoom = def;
        this.zoom = def;
        this._fitZoomInitialized = true;
    }

    savePersistedZoom() {
        if (!this.gameName || this.gameName === 'unknown') return;
        localStorage.setItem(this.getZoomStorageKey(), String(this.targetZoom));
    }

    scheduleSavePersistedZoom() {
        clearTimeout(this._saveZoomTimer);
        this._saveZoomTimer = setTimeout(() => this.savePersistedZoom(), 150);
    }

    /** Fit square boards (line only) inside the visible iframe — mobile viewport only. */
    fitBoardToViewport() {
        const M = typeof EngineMobileLayout !== 'undefined' ? EngineMobileLayout : null;
        if (M?.fitBoardToViewport) return M.fitBoardToViewport(this);
    }

    nodeSnapRadius() {
        return this.isMobileViewport() ? 80 : 60;
    }

    fromWorld(nx, ny) {
        const container = document.getElementById('game-container');
        const width = container ? (container.offsetWidth || window.innerWidth) : 1000;
        const height = container ? (container.offsetHeight || window.innerHeight) : 1000;
        const scale = parseFloat(container?.style.getPropertyValue('--board-scale')) || 1.0;

        return {
            lx: (width / 2) + (nx - 500) * scale,
            ly: (height / 2) + (ny - 500) * scale
        };
    }

    setupEngineListeners() {
        document.addEventListener('mousedown', (e) => {
            window.focus();
            if (e.target.closest('.piece, .node, .interactive, button, input')) return;
            window.parent.postMessage('close-settings', '*');
        }, true);
    }

    initIdentity(name, mode) {
        const identityChanged = this.gameName !== name || this.mode !== mode;
        this.gameName = name;
        this.mode = mode;
        if (typeof GameAdapter !== 'undefined') {
            GameAdapter.attachGameAdapter(this);
            GameAdapter.refreshCapabilities(this);
        }
        const urlParams = new URLSearchParams(window.location.search);
        this.roomId = urlParams.get('room');
        this.isMultiplayer = !!(this.roomId && this.roomId !== 'lobby');
        this.playerRole = urlParams.get('role') || 'P1';
        this.uid = this.uid || localStorage.getItem('game_uid') || sessionStorage.getItem('game_uid');
        this.username = localStorage.getItem('username') || sessionStorage.getItem('username') || 'Guest';
        this.opponentName = "Opponent";

        this.loadScores();
        this.renderScoreboard();
        if (identityChanged) {
            this._fitZoomInitialized = false;
            this._mobileContentBounds = null;
            this._mobileLayoutAnchorLocked = false;
        }
        this.restorePersistedZoom();
        this.applyZoom();
        requestAnimationFrame(() => this.refreshMobileLayout());

        // Notify parent hub
        window.parent.postMessage({ type: 'init-identity', game: this.gameName, mode: this.mode }, '*');

        // Solo/Lobby: Identity is intrinsic, no need to wait for message
        if (!this.isMultiplayer) {
            if (this.onIdentitySynced) this.onIdentitySynced();
        }
    }

    getScoreKey() {
        if (this.isMultiplayer) {
            return `scores_${this.gameName}_${this.mode}_room_${this.roomId}`;
        }
        const uid = this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid') || 'local';
        return `scores_${this.gameName}_${this.mode}_uid_${uid}`;
    }

    loadScores() {
        if (this.isMultiplayer) {
            const scoresObj = this.roomData?.global?.scores?.[this.gameName]?.[this.mode];
            this.scores = scoresObj ? { ...scoresObj } : { P1: 0, P2: 0 };
        } else {
            const key = this.getScoreKey();
            const saved = localStorage.getItem(key);
            this.scores = saved ? JSON.parse(saved) : { P1: 0, P2: 0 };
        }
    }

    saveScores() {
        if (this.isMultiplayer) {
            if (this.isHost()) {
                let updates = {};
                updates[`global/scores/${this.gameName}/${this.mode}`] = this.scores;
                this.updateMetadata(updates);
            }
        } else {
            localStorage.setItem(this.getScoreKey(), JSON.stringify(this.scores));
        }
    }

    initZoom() {
        const container = document.getElementById('game-container') || document.body;
        this.startZoomLoop();
        window.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (typeof GameZoom !== 'undefined' && !GameZoom.canZoom(this)) return;
            this.handleZoom(e.deltaY, e.clientX, e.clientY);
        }, { passive: false });

        window.addEventListener('message', (e) => {
            if (!e.data || typeof e.data.type !== 'string') return;
            if (e.data.type === 'hub-visible-viewport') {
                this._hubVisibleViewport = {
                    width: e.data.width,
                    height: e.data.height,
                    offsetTop: e.data.offsetTop
                };
                if (this._usesPanZoomBoard() && typeof GameViewport !== 'undefined') {
                    const preservePlayViewport = !!(this.gameStarted && this._fitZoomInitialized);
                    if (!preservePlayViewport) GameViewport.reflowOnResize(this);
                }
                if (this.isMobileViewport()) {
                    const startingHand = !!(this.started && !this.gameStarted);
                    const preservePlayViewport = !!(this.gameStarted && this._fitZoomInitialized);
                    if (startingHand && typeof this._applyDefaultPlayingViewport === 'function') {
                        this._applyDefaultPlayingViewport();
                    } else if (!preservePlayViewport) {
                        if (this._mobileLayoutAnchorLocked) this.refreshMobileLayoutViewportOnly();
                        else this.refreshMobileLayout();
                    }
                } else if (this.requestRender) {
                    this.requestRender();
                }
                return;
            }
            if (e.data.type === 'wheel') this.handleZoom(e.data.deltaY, e.data.clientX, e.data.clientY);
            if (e.data.type === 'pinch-zoom-get') {
                window.parent.postMessage({ type: 'pinch-zoom-current', zoom: this.targetZoom }, '*');
            }
            if (e.data.type === 'pinch-zoom-set' && typeof e.data.zoom === 'number') {
                this.targetZoom = Math.min(Math.max(e.data.zoom, 0.2), 5.0);
                this.scheduleSavePersistedZoom();
            }
            if (e.data.type === 'pinch-zoom' && typeof e.data.scale === 'number') {
                const next = this.targetZoom * e.data.scale;
                this.targetZoom = Math.min(Math.max(next, 0.2), 5.0);
                this.scheduleSavePersistedZoom();
            }
        });

        this.initPinchZoom(container);
        if (this._usesPanZoomBoard()) this.initViewportPan();

        this.renderScoreboard();
    }

    initPinchZoom(container) {
        const base = container || document.getElementById('game-container') || document.body;
        const target = (this.isMobileViewport() && this._usesFitSquareMobileLayout())
            ? (document.body || base)
            : base;
        let pinch = null;

        const dist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

        target.addEventListener('touchstart', (e) => {
            if (!this.isMobileViewport()) return;
            if (e.touches.length === 2) {
                this._pinchActive = true;
                this._mobileMarqueeActive = false;
                this._mobileMarqueeHoldPending = false;
                if (typeof this._cancelViewportPan === 'function') this._cancelViewportPan();
                pinch = { d0: dist(e.touches[0], e.touches[1]), zoom0: this.zoom };
                return;
            }
            if (typeof this.shouldBlockViewportPan === 'function' && this.shouldBlockViewportPan()) return;
        }, { passive: true });

        target.addEventListener('touchmove', (e) => {
            if (!this.isMobileViewport()) return;
            if (typeof this.shouldBlockViewportPan === 'function' && this.shouldBlockViewportPan()) return;
            if (!pinch || e.touches.length !== 2) return;
            this._pinchActive = true;
            e.preventDefault();
            const d = dist(e.touches[0], e.touches[1]);
            if (!pinch.d0) pinch.d0 = d;
            const scale = d / pinch.d0;
            const next = pinch.zoom0 * scale;
            this.targetZoom = Math.min(Math.max(next, 0.2), 5.0);
            this.scheduleSavePersistedZoom();
        }, { passive: false });

        const endPinch = (e) => {
            if (e.touches && e.touches.length >= 2) return;
            this._pinchActive = false;
            pinch = null;
            this.scheduleSavePersistedZoom();
        };
        target.addEventListener('touchend', endPinch, { passive: true });
        target.addEventListener('touchcancel', endPinch, { passive: true });
    }

    initKeybinds() {
        window.addEventListener('keydown', (e) => {
            const isText = e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && ['text', 'number', 'password', 'email'].includes(e.target.type));
            if (isText) return;
            this._handleKeyDown(e);
        });
    }

    _handleKeyDown(e) {
        const key = e.key.toLowerCase();
        if (key === 's') window.parent.postMessage('toggle-settings', '*');
        if (key === 'g' && this.isHost()) window.parent.postMessage('switch-game', '*');
        if (key === 'm' && this.isHost()) window.parent.postMessage('cycle-mode', '*');
        if (key === 't') window.parent.postMessage('toggle-chat', '*');
        if (key === '/') window.parent.postMessage('toggle-command', '*');
        if (key === 'p') this.toggleScore();

        if (key === '`') {
            if (!this.isHost()) return;
            if (this.onResetRequest) this.onResetRequest();
            else {
                this.resetGame();
                this.resetPositions();
            }
        }

        if (key === 'c') {
            if (this.onColorPickRequest) this.onColorPickRequest();
            else this.openColorPicker(this.hoveredType);
        }

        if (key === 'enter') {
            if (this.onEnter) this.onEnter();
        }

        if (e.key === 'F6') {
            e.preventDefault();
            this.toggleDevMode();
        }

        if (e.code === 'Comma' || e.key === '<') this.handleZoom(1);
        if (e.code === 'Period' || e.key === '>') this.handleZoom(-1);

        if (this.handleKeyDown) this.handleKeyDown(e);
    }

    broadcastSelection() {
        if (!this.isMultiplayer) return;
        const uid = this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
        if (!uid) return; // Cannot broadcast without identity
        this.broadcast(`interactions/select/${uid}`, this.selection);
    }

    broadcastInvalidMove(ids) {
        if (!this.isMultiplayer) return;
        const uid = this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
        this.broadcast(`interactions/invalid`, { ids, uid });
    }

    triggerInvalidFlash(ids) {
        if (!Array.isArray(ids)) return;
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.classList.add('flash-invalid');
                setTimeout(() => el.classList.remove('flash-invalid'), 600);
            }
        });
    }

    saveColors(type, color) {
        const colorKey = `pile_colors_${this.gameName}_${this.mode}`;
        const saved = JSON.parse(localStorage.getItem(colorKey) || '{}');
        saved[type] = color;
        localStorage.setItem(colorKey, JSON.stringify(saved));

        if (this.isMultiplayer) {
            this.broadcast(`global/pileColors/${type}`, color);
            // Also update metadata for persistence and late joiners
            let updates = {};
            updates[`global/pileColors/${type}`] = color;
            this.updateMetadata(updates);
        }
    }

    /** One Firebase write for all four freestyle pile colors (avoids room snapshot spam). */
    persistFreestylePileColors(colorMap) {
        if (!colorMap || typeof colorMap !== 'object') return;
        const colorKey = `pile_colors_${this.gameName}_${this.mode}`;
        localStorage.setItem(colorKey, JSON.stringify(colorMap));
        if (!this.isMultiplayer || !this.isHost()) return;
        const server = this.roomData?.global?.pileColors;
        if (server && JSON.stringify(server) === JSON.stringify(colorMap)) return;
        this.broadcast('global/pileColors', colorMap);
        this.updateMetadata({ 'global/pileColors': colorMap });
    }

    initColorPicker() {
        const picker = document.getElementById('pile-color-picker');
        if (!picker) return;

        picker.oninput = (e) => {
            const color = e.target.value;
            const target = this.editingType || this.hoveredType;
            if (target && this.colorVariableMap) {
                const varName = this.colorVariableMap[target];
                if (varName) {
                    document.documentElement.style.setProperty(varName, color);
                    this.saveColors(target, color);
                }
            }
        };

        picker.onchange = () => {
            picker.style.setProperty('opacity', '0', 'important');
            picker.style.setProperty('pointer-events', 'none', 'important');
            this.editingType = null;
        };
    }

    openColorPicker(type) {
        if (!type) return;
        this.editingType = type;
        const picker = document.getElementById('pile-color-picker');
        if (!picker || !this.colorVariableMap) return;

        const varName = this.colorVariableMap[type];
        const currentColor = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        const startHex = currentColor.startsWith('#') ? currentColor : '#ffffff';

        const applyColor = (color) => {
            picker.value = color;
            if (varName) {
                document.documentElement.style.setProperty(varName, color);
                this.saveColors(type, color);
            }
        };

        if (typeof ColorPicker !== 'undefined' && ColorPicker.shouldUseCustom(() => this.isMobileViewport())) {
            ColorPicker.open({
                color: startHex,
                onInput: applyColor,
                onClose: () => { this.editingType = null; }
            });
            return;
        }

        picker.style.position = 'fixed';
        picker.style.left = '50%';
        picker.style.top = '80%';
        picker.style.transform = 'translate(-50%, -50%)';
        picker.style.opacity = '0';
        picker.style.pointerEvents = 'auto';

        if (startHex.startsWith('#')) picker.value = startHex;
        if (typeof picker.showPicker === 'function') {
            try {
                const shown = picker.showPicker();
                if (shown && typeof shown.catch === 'function') {
                    shown.catch(() => picker.click());
                } else {
                    picker.click();
                }
            } catch (_) {
                picker.click();
            }
        } else {
            picker.click();
        }
    }

    resetPositions() {
        this.piecePositions = {};
        localStorage.removeItem(`piecePositions_${this.gameName}_${this.mode}`);
        if (this.isMultiplayer) {
            this.broadcast('global/piecePositions', null);
        }
        this.safeRender();
    }

    toggleDevMode() {
        this.devMode = !this.devMode;
        localStorage.setItem('game_devMode', this.devMode);

        if (typeof GameDevOverlay !== 'undefined') {
            GameDevOverlay.sync(this);
        } else {
            const dot = document.getElementById('center-dot');
            if (dot) {
                dot.style.display = this.devMode ? 'block' : 'none';
                dot.style.zIndex = '99999';
            }
            const debugInfo = document.getElementById('debug-info');
            if (debugInfo) debugInfo.style.display = this.devMode ? 'block' : 'none';
        }

        this.applyZoom();
    }

    handleZoom(deltaY, clientX, clientY) {
        if (typeof GameZoom !== 'undefined' && !GameZoom.canZoom(this)) return;
        if (this._usesPanZoomBoard() && typeof GameViewport !== 'undefined') {
            GameViewport.handleWheelZoom(this, deltaY, clientX, clientY);
            this.scheduleSavePersistedZoom();
            return;
        }
        if (typeof GameZoom !== 'undefined') {
            GameZoom.applyWheelDelta(this, deltaY);
        } else {
            const factor = deltaY > 0 ? 0.9 : 1.1;
            this.targetZoom = Math.min(Math.max(this.targetZoom * factor, 0.2), 5.0);
        }
        this.scheduleSavePersistedZoom();
    }

    startZoomLoop() {
        const loop = () => {
            if (typeof GameZoom !== 'undefined') {
                GameZoom.tick(this);
            } else if (Math.abs(this.zoom - this.targetZoom) > 0.001) {
                this.zoom += (this.targetZoom - this.zoom) * this.zoomVelocity;
                this.applyZoom();
            }
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }


    applyZoom() {
        const target = document.getElementById('game-container') || document.body;
        if (this._usesPanZoomBoard() && typeof GameViewport !== 'undefined' && GameViewport.applyPanZoom(this)) {
            return;
        }
        if (this.isMobileViewport() && this._usesFitSquareMobileLayout() && this._mobileContentBounds) {
            const { width: vw, height: vh } = this.getVisibleViewportSize();
            const b = this._mobileContentBounds;
            document.body.style.transform = '';
            document.body.style.transformOrigin = '';
            target.style.position = 'absolute';
            target.style.left = `${vw / 2 - b.cx}px`;
            target.style.top = `${vh / 2 - b.cy}px`;
            target.style.width = `${this.localSize}px`;
            target.style.height = `${this.localSize}px`;
            target.style.transformOrigin = `${b.cx}px ${b.cy}px`;
            target.style.transform = `scale(${this.zoom})`;
        } else if (this.isMobileViewport() && !this._usesFitSquareMobileLayout()) {
            if (this._shouldLockFreestyleMobileLayout()) {
                if (!this._mobileLayoutAnchorLocked) this.lockMobileLayoutAnchor();
            } else if (!this._mobileContentBounds) {
                this._mobileContentBounds = this.getPilesStableVisualBounds();
            }
            const b = this._mobileContentBounds;
            if (!b) return;
            this._applyMobilePilesContainerGeometry(b);
            target.style.transform = `scale(${this.zoom})`;
        } else {
            document.body.style.transform = '';
            document.body.style.transformOrigin = '';
            target.style.position = '';
            target.style.left = '';
            target.style.top = '';
            target.style.width = '';
            target.style.height = '';
            target.style.margin = '';
            target.style.transformOrigin = 'center center';
            target.style.transform = `scale(${this.zoom})`;
        }

        let debug = document.getElementById('debug-info');
        if (typeof GameDevOverlay !== 'undefined') {
            GameDevOverlay.sync(this);
        } else if (debug) {
            debug.innerText = `Click board to focus | Zoom: ${this.zoom.toFixed(2)} | Dev: ${this.devMode ? 'ON' : 'OFF'}`;
            debug.style.display = this.devMode ? 'block' : 'none';
        }

        if (this.onZoomChange) this.onZoomChange();
    }

    clearAutoReset() {
        if (this.autoResetTimer) {
            clearTimeout(this.autoResetTimer);
            this.autoResetTimer = null;
        }
    }

    /** Shared iframe → hub win banner (see shared/js/hub/win-banner-payload.js). */
    _postHubWinBanner(data) {
        if (!data || !this.hasCap('supportsWinBanner')) return;
        if (typeof HubWinBannerPayload !== 'undefined') {
            HubWinBannerPayload.postWinBanner(data);
        } else {
            window.parent.postMessage({ type: 'update-win-banner', ...data }, '*');
        }
    }

    /** Registry / test override for hub banner auto-fade (ms); null = stay until reset. */
    _resolveWinBannerAutoFadeMs(options = {}) {
        if (options.autoFadeMs != null) return options.autoFadeMs;
        if (typeof window !== 'undefined' && window.FIVE_WIN_BANNER_FADE_MS != null) {
            const t = Number(window.FIVE_WIN_BANNER_FADE_MS);
            if (!Number.isNaN(t) && t > 0) return t;
        }
        const caps = typeof GameRegistry !== 'undefined' && this.gameName
            ? GameRegistry.getCapabilities(this.gameName, this.mode)
            : {};
        if (typeof caps.winBannerAutoFadeMs === 'number' && caps.winBannerAutoFadeMs > 0) {
            return caps.winBannerAutoFadeMs;
        }
        return null;
    }

    /**
     * Core victory state — scores, MP metadata, hub banner. Games with post-game review
     * (Bananagrams) override setGameOver and call this without scheduling auto-reset.
     */
    _registerVictoryState(winner, options = {}) {
        if (this._victoryRegistered) return false;
        this._victoryRegistered = true;
        this.isOver = true;
        this.winner = winner;

        if (this.isMultiplayer && this.isHost()) {
            const updates = { winner };
            if (options.winnerUid) updates.winnerUid = options.winnerUid;
            if (this._partyMemberCount() >= 2) {
                updates.status = 'playing';
            }
            this.updateMetadata(updates);
        }

        if (this.scores && this.scores[winner] !== undefined) {
            this.scores[winner]++;
            this.saveScores();
            this.renderScoreboard();
        }

        const fadeMs = this._resolveWinBannerAutoFadeMs(options);
        const bannerPayload = {
            visible: true,
            winner,
            winnerUid: options.winnerUid || undefined
        };
        if (fadeMs != null) bannerPayload.autoFadeMs = fadeMs;
        if (options.bannerText != null) {
            bannerPayload.bannerText = options.bannerText;
            if (options.bannerColor) bannerPayload.bannerColor = options.bannerColor;
        }
        this._postHubWinBanner(bannerPayload);

        const overlay = document.querySelector('.win-overlay');
        if (overlay) {
            overlay.innerHTML = '<div style="font-size: 0.2em; opacity: 0.7; margin-top: 15vh;">PRESS \'R\' TO REMATCH</div>';
            overlay.classList.add('show');
        }

        this.updateTurnIndicator();
        return true;
    }

    setGameOver(winner, options = {}) {
        if (!this._registerVictoryState(winner, options)) return;

        // Auto-Restart Timer (host / P1 only — guest waits for resetCount from host)
        const victoryAutoReset = typeof this.hasCap === 'function'
            && this.hasCap('supportsVictoryAutoReset');
        if (!victoryAutoReset) {
            console.log('[ENGINE] Victory auto-reset disabled for this game');
        } else if (this.isMultiplayer && !this.isHost()) {
            console.log('[ENGINE] Guest waiting for host auto-reset');
        } else if (this.isHost()) {
            const isTest = this.roomId && this.roomId.startsWith('MP_AUDIT');
            const envDwell = (typeof window !== 'undefined' && window.FIVE_VICTORY_DWELL_MS != null)
                ? Number(window.FIVE_VICTORY_DWELL_MS)
                : NaN;
            const delay = isTest
                ? ((!Number.isNaN(envDwell) ? envDwell : 5000))
                : Number(
                    (!Number.isNaN(envDwell) ? envDwell : null)
                        || 2500
                );
            console.log(`[ENGINE] Host scheduling auto-reset in ${delay}ms`);
            this.clearAutoReset();
            this.autoResetTimer = setTimeout(() => {
                console.log('[ENGINE] Host auto-reset triggered');
                if (this.onResetRequest) this.onResetRequest();
                else this.resetGame();
            }, delay);
        }
    }

    clearWinOverlay() {
        const overlay = document.querySelector('.win-overlay');
        if (overlay) {
            overlay.classList.remove('show');
            overlay.innerHTML = '';
        }
    }

    triggerAITurn() {
        if (this.isMultiplayer || this.isOver || this.turn !== 'P2') return;
        if (this.onAITurn) {
            setTimeout(async () => {
                if (this.turn === 'P2' && !this.isOver) {
                    await this.onAITurn();
                }
            }, 1000);
        }
    }

    renderScoreboard() {
        this.updateTurnIndicator();
        if (typeof GameAdapter !== 'undefined' && !GameAdapter.cap(this, 'supportsScoreboard')) {
            const hidden = document.querySelector('.scoreboard');
            if (hidden) hidden.classList.remove('show');
            return;
        }
        let sb = document.querySelector('.scoreboard');
        if (!sb) {
            sb = document.createElement('div');
            sb.className = 'scoreboard';
            sb.style.pointerEvents = 'none';
            document.body.appendChild(sb);
        }
        sb.classList.toggle('show', this.scoreVisible);

        const myScore = this.playerRole === 'P1' ? this.scores.P1 : this.scores.P2;
        const oppScore = this.playerRole === 'P1' ? this.scores.P2 : this.scores.P1;

        sb.innerHTML = `<span class="score-user">${myScore}</span><span class="score-divider">-</span><span class="score-ai">${oppScore}</span>`;
    }

    updateTurnIndicator() {
        const turnMsg = typeof HubProtocol !== 'undefined' ? HubProtocol.MSG.UPDATE_TURN : 'update-turn';
        if (typeof GameAdapter !== 'undefined' && !GameAdapter.cap(this, 'supportsTurnIndicator')) {
            window.parent.postMessage({ type: turnMsg, text: '', color: 'white' }, '*');
            return;
        }
        let text = "";
        let color = "white";

        if (this.isOver) {
            text = ""; // Hide turns when game is over, handled by big banner
        } else if (this.isMultiplayer) {
            text = (this.turn === this.playerRole) ? "YOUR TURN" : "OPPONENT'S TURN";
            color = (this.turn === this.playerRole) ? 'var(--theme-color)' : 'var(--opponent-color)';
        } else if (this.roomId === 'lobby') {
            text = ""; // Hide in lobby
        } else {
            text = (this.turn === 'P1') ? "YOUR TURN" : "AI THINKING...";
            color = (this.turn === 'P1') ? 'var(--theme-color)' : 'var(--opponent-color)';
        }

        // Get actual hex value for CSS variables
        let actualColor = color;
        if (color.startsWith('var')) {
            const match = color.match(/\(([^)]+)\)/);
            if (match) actualColor = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
        }

        window.parent.postMessage({
            type: turnMsg,
            text: text,
            color: actualColor || color,
            isOver: this.isOver
        }, '*');
    }

    /** Shorthand for capability checks on this instance. */
    hasCap(name) {
        return typeof GameAdapter !== 'undefined' ? GameAdapter.cap(this, name) : true;
    }

    _mpBoardFromRoomData() {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.mpBoardFromRoomData) return M.mpBoardFromRoomData(this);
    }

    _mpBoardAuthoritative() {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.mpBoardAuthoritative) return M.mpBoardAuthoritative(this);
    }

    _boardInReviewPhase() {
        const M = typeof EngineRoomSync !== 'undefined' ? EngineRoomSync : null;
        if (M?.boardInReviewPhase) return M.boardInReviewPhase(this);
    }

    static setupDragging(el, onDragEnd, context, onDragStart, onDrag, options) {
        const drag = typeof GameDrag !== 'undefined' ? GameDrag : null;
        if (drag) return drag.setupDragging(el, onDragEnd, context, onDragStart, onDrag, options);
    }

    startRepairWatchdog() {
        if (this._repairInterval) clearInterval(this._repairInterval);
        
        this._repairInterval = setInterval(() => {
            if (!this.isMultiplayer || this.isOver || this.roomId === 'lobby') return;
            
            // If local state turn does not align with Firebase authority global/turn,
            // or if the turn value is not a valid player P1 or P2, Host repairs it
            const fbTurn = this.roomData?.global?.turn;
            if (fbTurn && fbTurn !== 'P1' && fbTurn !== 'P2') {
                console.warn(`[WATCHDOG] Host repairing invalid/stuck Firebase turn: "${fbTurn}". Resetting to firstPlayer: "${this.firstPlayer || 'P1'}"`);
                this.broadcastTurn(this.firstPlayer || 'P1');
            }
        }, 3000);
    }
}
window.addEventListener('dragstart', (e) => e.preventDefault());
window.BaseGame = BaseGame;
if (typeof EngineRoomSync !== 'undefined' && EngineRoomSync.install) {
    EngineRoomSync.install(BaseGame);
}
if (typeof EngineMobileLayout !== 'undefined' && EngineMobileLayout.install) {
    EngineMobileLayout.install(BaseGame);
}
