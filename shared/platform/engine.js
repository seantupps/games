class BaseGame {
    constructor() {
        this.turn = 'P1';
        this.isOver = false;
        this.winner = null;
        this.zoom = 1.0;
        this.targetZoom = 1.0;
        this.zoomVelocity = 0.4;
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
        this.uid = sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid'); // Fallback
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
        this.initZoom();
        if (typeof GameAdapter !== 'undefined') GameAdapter.attachGameAdapter(this);
        setTimeout(() => this.updateTurnIndicator(), 0); // Init UI
        setTimeout(() => {
            window.parent.postMessage({ type: 'iframe-ready' }, '*');
        }, 50);
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

    initGlobalEvents() {
        window.addEventListener('resize', () => {
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
        });
        window.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this.isMyTurn()) return;
            const lastDrag = this.lastDragEnd || 0;
            if (Date.now() - lastDrag < 100) return;
            if (this.onEnter) this.onEnter();
        });

        this.initLongPressEndTurn();
        this.initMobileSettingsEdgeSwipe();
    }

    /**
     * Same-origin iframe: touches on the right strip post to hub (overlay misses if gesture starts in frame).
     */
    initMobileSettingsEdgeSwipe() {
        if (!this.isMobileViewport() || window.parent === window) return;

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
        return this.capabilities?.mobileLayoutPolicy || 'none';
    }

    _usesFitSquareMobileLayout() {
        return this._mobileLayoutPolicy() === 'fit-square';
    }

    _usesFixedSpiralMobileAnchor() {
        return this._mobileLayoutPolicy() === 'fixed-spiral-anchor';
    }

    _isPilesBoard() {
        return (this.capabilities?.boardKind || 'generic') === 'piles';
    }

    /** Current rematch generation (defaults legacy events without field to round 1). */
    _currentResetRound() {
        return this.roomData?.global?.resetCount ?? this.lastResetCount ?? 1;
    }

    _eventTimestamp(ev) {
        const ts = ev?.timestamp;
        if (typeof ts === 'number' && Number.isFinite(ts)) {
            return ts < 1e12 ? ts * 1000 : ts;
        }
        return 0;
    }

    _dropStaleFinishedBatch(events, round) {
        if (events.length === 0) return [];

        const newestTs = events.reduce((max, ev) => Math.max(max, this._eventTimestamp(ev)), 0);
        const preReset =
            (newestTs > 0 && newestTs < this._resetAcknowledgedAt)
            || (
                newestTs === 0
                && this._resetAcknowledgedCount != null
                && round <= this._resetAcknowledgedCount
            );
        if (preReset) return [];

        const cfg = {
            mode: this.mode,
            createdAt: this.roomData?.createdAt || Date.now(),
            board: this.roomData?.global?.board || null,
            firstPlayer: this.roomData?.global?.firstPlayer || 'P1'
        };
        const probe = GameLogic.computeState(this.gameName, events, cfg);
        return probe?.isOver ? [] : events;
    }

    /** Only replay moves from the active game after host auto-reset. */
    _eventsForReplay(events) {
        if (!this.isMultiplayer || !Array.isArray(events)) return events || [];
        const round = Number(this._currentResetRound());
        const tagged = events.filter((ev) => Number(ev.resetCount ?? 1) === round);
        if (tagged.length > 0) return tagged;

        // Mid-game (no rematch yet): legacy events without resetCount stay in the log.
        if (!this._resetAcknowledgedAt) return events;

        return this._dropStaleFinishedBatch(events, round);
    }

    initNetworkListeners() {
        window.addEventListener('message', (e) => {
            if (!e.data) return;

            // 1. Identity & Theme Updates
            if (e.data.type === 'init-identity') {
                this.uid = e.data.uid || this.uid;
                this.playerRole = (e.data.role || 'P1').toUpperCase();
                this.roomId = e.data.roomId || 'lobby';
                if (e.data.username) this.username = e.data.username;
                this.isMultiplayer = !!this.roomId && this.roomId !== 'lobby';
                if (!this.isMultiplayer) {
                    this.opponentName = "AI";
                    this.loadScores();
                }

                if (e.data.game) {
                    this.roomData = e.data.game;
                    this.lastResetCount = this.roomData.global?.resetCount || 0;
                    this.firstPlayer = this.roomData.global?.firstPlayer || 'P1';
                    if (this.roomData.global?.mode) {
                        this.mode = this.roomData.global.mode;
                    }
                }

                if (this.hasCap('supportsPileColors') && this.mode === 'freestyle' && this.applyServerPileColors) {
                    this.applyServerPileColors();
                }
                this.rebuildState();

                if (this.onIdentitySynced) this.onIdentitySynced();
                this.renderScoreboard();
                if (this.safeRender) this.safeRender();

                // Warmup check directly in message handler - guarantees it is ALWAYS executed and never overridden!
                const hasBoard = this.roomData?.global?.board && (
                    !this._isPilesBoard()
                        ? true
                        : Object.values(this.roomData.global.board).flat().filter(Boolean).length > 0
                );
                
                // Inspect board to detect classic vs freestyle mismatches
                let boardModeMismatch = false;
                if (this.roomData?.global?.board) {
                    if (this._isPilesBoard()) {
                        const board = this.roomData.global.board;
                        const allPieces = Object.values(board).flat().filter(Boolean);
                        if (allPieces.length > 0) {
                            const hasGridIdx = allPieces.some(p => typeof p.gridIdx === 'number');
                            if (this.mode === 'freestyle' && !hasGridIdx) {
                                boardModeMismatch = true;
                            } else if (this.mode === 'classic' && hasGridIdx) {
                                boardModeMismatch = true;
                            }
                        }
                    }
                }

                // Warm up when board missing or mode/board mismatch. Skip on refresh or mid-game (events already replayed).
                const needsWarmup = !this.roomData || !this.roomData.global || !hasBoard || boardModeMismatch;
                const gameInProgress = this._eventsLoaded && this.gameEvents.length > 0;
                const skipWarmupOnRefresh = gameInProgress
                    || (hasBoard && !boardModeMismatch && (this.roomData?.global?.resetCount || 0) >= 1);
                if (this.isMultiplayer && this.isHost() && !this._hasWarmedUp && needsWarmup && !skipWarmupOnRefresh) {
                    this._hasWarmedUp = true;
                    console.log(`[ENGINE] Host warming up uninitialized or mismatched room: ${this.roomId} (boardModeMismatch=${boardModeMismatch})`);
                    this.resetGame();
                } else if (this.isMultiplayer && this.isHost() && !this._hasWarmedUp) {
                    this._hasWarmedUp = true;
                }

                // Start Host-led impossible/stuck state repair watchdog
                if (this.isHost() && this.isMultiplayer) {
                    this.startRepairWatchdog();
                }
            }
            if (e.data.type === 'update-role') {
                this.playerRole = e.data.role;
                console.log(`Piles Identity: Role updated to ${this.playerRole}`);
                this.updateTurnIndicator();
                this.renderScoreboard();
            }
            if (e.data.type === 'update-theme') {
                this.uid = e.data.uid || this.uid;
                document.documentElement.style.setProperty('--theme-color', e.data.color);
                if (e.data.opponentColor) document.documentElement.style.setProperty('--opponent-color', e.data.opponentColor);
                if (e.data.username) this.username = e.data.username;
                this.updateTurnIndicator();
                this.safeRender();
            }
            if (e.data.type === 'update-opponent-theme') {
                document.documentElement.style.setProperty('--opponent-color', e.data.color);
                if (e.data.name) this.opponentName = e.data.name;
                this.updateTurnIndicator();
                this.safeRender();
            }
            if (e.data.type === 'test-force-move') {
                this.submitMove(e.data.move);
            }

            // 2. Authoritative Network Updates (Events)
            if (e.data.type === 'network-events') {
                if (this.roomId === 'lobby' || !this.isMultiplayer) return;
                this._eventsLoaded = true;
                const events = Array.isArray(e.data.events) ? e.data.events : [];
                const roomRc = this._currentResetRound();
                const replay = this._eventsForReplay(events);

                if (events.length > 0 && replay.length === 0 && this._resetAcknowledgedAt) {
                    console.warn('[ENGINE] Dropping pre-reset / wrong-round event batch');
                    this.gameEvents = [];
                    this._eventsSyncedAtResetCount = roomRc;
                    this.rebuildState();
                    return;
                }

                this.gameEvents = events;
                this._eventsSyncedAtResetCount = roomRc;
                this.rebuildState();
            }

            if (e.data.type === 'network-update' && e.data.payload) {
                if (this.roomId === 'lobby' || !this.isMultiplayer) return;
                const data = e.data.payload;
                this.roomData = data; // Cache for reset counts etc
                if (data.global && data.global.firstPlayer) {
                    this.firstPlayer = data.global.firstPlayer;
                }

                // Detect Reset Signal (resetCount increased)
                const currentResetCount = data.global?.resetCount || 0;
                if (currentResetCount > this.lastResetCount) {
                    const who = this.isHost() ? 'Host' : 'Guest';
                    console.log(`[ENGINE] ${who} received reset signal (resetCount: ${currentResetCount})`);
                    this.lastResetCount = currentResetCount;
                    this._resetAcknowledgedCount = currentResetCount;
                    this._resetAcknowledgedAt = Date.now();

                    this.clearAutoReset();
                    this._victoryRegistered = false;
                    this._winBannerSent = false;
                    this.isOver = false;
                    this.winner = null;
                    this.clearWinOverlay();
                    this.selection = { pk: null, ids: [] };
                    this.opponentSelection = null;
                    this.gameEvents = [];
                    this._eventsSyncedAtResetCount = currentResetCount;
                    this._lastTurnSyncedEventCount = -1;
                    window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');

                    if (data.global?.firstPlayer) this.firstPlayer = data.global.firstPlayer;
                    if (data.global?.turn) this.turn = data.global.turn;
                    if (data.global?.mode) {
                        this.mode = data.global.mode;
                    }
                    if (this.onGameReset) this.onGameReset();
                }

                this.rebuildState();

                // Handle Global Reset Signal (Legacy, but keeping metadata sync)
                if (data.global && data.global.colors) {
                    const varMap = { 'B': '--blue-color', 'R': '--red-color', 'G': '--green-color', 'Y': '--yellow-color' };
                    Object.keys(data.global.colors).forEach(type => {
                        const val = data.global.colors[type];
                        const current = document.documentElement.style.getPropertyValue(varMap[type]) || getComputedStyle(document.documentElement).getPropertyValue(varMap[type]);
                        if (current.trim() !== val.trim()) {
                            document.documentElement.style.setProperty(varMap[type], val);
                        }
                    });
                }

                const myUid = this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');

                // Auto-handle Interaction Sync (Dragging, Selection) - Still real-time outside event stream

                // Auto-handle Real-time Dragging
                if (data.interactions && data.interactions.drag) {
                    Object.entries(data.interactions.drag).forEach(([uid, pieces]) => {
                        if (uid !== myUid && pieces) {
                            Object.entries(pieces).forEach(([pid, dragData]) => {
                                if (!dragData) return;
                                const el = document.getElementById(pid);
                                if (el && !this.isDragging) {
                                    const worldPos = this.fromWorld(dragData.x + 500, dragData.y + 500);
                                    el.style.transition = 'none';
                                    el.style.left = `${worldPos.lx}px`;
                                    el.style.top = `${worldPos.ly}px`;
                                    el.style.zIndex = '1000';

                                    this.piecePositions[pid] = { nx: dragData.x + 500, ny: dragData.y + 500 };
                                    this.remotelyDraggedPieces[pid] = Date.now();
                                }
                            });
                        }
                    });
                }

                if (data.global && (data.global.piecePositions || data.global.piecePositions === null)) {
                    if (data.global.piecePositions === null) {
                        this.piecePositions = {};
                    } else {
                        Object.entries(data.global.piecePositions).forEach(([id, pos]) => {
                            if (pos && pos.uid !== myUid) {
                                // Drag Protection
                                if (this.remotelyDraggedPieces[id] && (Date.now() - this.remotelyDraggedPieces[id] < 500)) return;

                                this.piecePositions[id] = pos;
                                const el = document.getElementById(id);
                                if (el && !this.isDragging) {
                                    const worldPos = this.fromWorld(pos.nx, pos.ny);
                                    el.style.left = `${worldPos.lx}px`;
                                    el.style.top = `${worldPos.ly}px`;
                                }
                            } else if (pos === null) {
                                delete this.piecePositions[id];
                            }
                        });
                    }
                }

                if (data.interactions) {
                    if (data.interactions.select) {
                        const opponentUid = Object.keys(data.interactions.select).find(uid => uid !== myUid);
                        if (opponentUid) {
                            const selectData = data.interactions.select[opponentUid];
                            if (selectData && typeof selectData === 'object' && selectData.ids) {
                                this.opponentSelection = selectData;
                            } else {
                                this.opponentSelection = null;
                            }
                        } else {
                            this.opponentSelection = null;
                        }
                    } else {
                        this.opponentSelection = null;
                    }
                } else {
                    this.opponentSelection = null;
                }
                this.safeRender();

                // Real-time drag previews for line game
                if (data.previews) {
                    const opponentUid = Object.keys(data.previews).find(uid => uid !== myUid);
                    if (opponentUid) {
                        const previewVal = data.previews[opponentUid];
                        if (previewVal) {
                            this.opponentPreview = {
                                start: previewVal.start,
                                nx: previewVal.nx,
                                ny: previewVal.ny
                            };
                        } else {
                            this.opponentPreview = null;
                        }
                    } else {
                        this.opponentPreview = null;
                    }
                    this.safeRender();
                } else if ('previews' in data && !data.previews) {
                    this.opponentPreview = null;
                    this.safeRender();
                }

                // Auto-handle Invalid Move Feedback
                if (data.interactions && data.interactions.invalid && data.interactions.invalid.uid !== myUid) {
                    this.triggerInvalidFlash(data.interactions.invalid.ids);
                }

                // Auto-handle Color Sync
                if (data.global) {
                    if (data.global.pileColors && typeof data.global.pileColors === 'object') {
                        const varMap = this.colorVariableMap;
                        Object.entries(data.global.pileColors).forEach(([type, color]) => {
                            if (typeof color !== 'string') return;
                            const varName = varMap ? varMap[type] : null;
                            if (varName) document.documentElement.style.setProperty(varName, color);
                        });
                        this.safeRender();
                    } else if (this._isPilesBoard() && this.mode === 'classic') {
                        // Restore classic defaults if pileColors is null/missing
                        const defaults = { '--blue-color': '#3b82f6', '--red-color': '#ef4444', '--green-color': '#22c55e', '--yellow-color': '#eab308' };
                        Object.entries(defaults).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
                        this.safeRender();
                    }
                }

                // Sync Opponent Name & Color
                if (data.playerData) {
                    const oppUid = Object.keys(data.playerData).find(uid => uid !== myUid);
                    if (oppUid) {
                        if (data.playerData[oppUid].name) {
                            this.opponentName = data.playerData[oppUid].name;
                        }
                        if (data.playerData[oppUid].color) {
                            document.documentElement.style.setProperty('--opponent-color', data.playerData[oppUid].color);
                        }
                        this.updateTurnIndicator();
                        this.safeRender();
                    }
                }

                // Hook for game-specific logic
                if (this.onNetworkUpdate) {
                    this.onNetworkUpdate(data);
                }
            }

            if (e.data.type === 'keydown') {
                this._handleKeyDown(e.data);
            }
        });
    }

    rebuildState() {
        if (!window.GameLogic) return;
        if (this.isMultiplayer) {
            if (!this.roomData || !this.roomData.global) {
                return; // Wait for room metadata sync from Firebase
            }
            // Authority: Sync scores from Firebase
            const scoresObj = this.roomData.global.scores?.[this.gameName]?.[this.mode];
            this.scores = scoresObj ? { ...scoresObj } : { P1: 0, P2: 0 };
        }
        const config = {
            mode: this.mode,
            createdAt: this.roomData?.createdAt || Date.now(),
            board: this.roomData?.global?.board || null,
            firstPlayer: this.roomData?.global?.firstPlayer || 'P1'
        };
        const replayEvents = this._eventsForReplay(this.gameEvents);
        try {
            const state = GameLogic.computeState(this.gameName, replayEvents, config);
            if (state) {
                // Multiplayer turn: replayed event log is source of truth (emulator has no cloud functions).
                // Host writes global/turn only when a new event arrives to avoid repair races on refresh.
                if (this.isMultiplayer && this._eventsLoaded && replayEvents.length > 0) {
                    this.turn = state.turn;
                    if (this.isHost()) {
                        const eventCount = replayEvents.length;
                        if (eventCount !== this._lastTurnSyncedEventCount) {
                            this._lastTurnSyncedEventCount = eventCount;
                            if (this.roomData?.global?.turn !== state.turn) {
                                this.broadcastTurn(state.turn);
                            }
                        }
                    }
                } else if (this.isMultiplayer) {
                    const g = this.roomData.global;
                    this.turn = g.turn || g.firstPlayer || state.turn;
                } else {
                    this.turn = state.turn;
                }

                if (this.isMultiplayer && replayEvents.length === 0) {
                    this.isOver = false;
                    this.winner = null;
                } else {
                    this.isOver = state.isOver;
                    this.winner = state.winner;
                }

                // After host reset, RTDB may still replay the previous game's finished log.
                const staleVictory =
                    this.isMultiplayer
                    && state.isOver
                    && (
                        replayEvents.length < this.gameEvents.length
                        || (this.roomData?.global?.resetCount || 0) > (this._eventsSyncedAtResetCount ?? 0)
                    );

                if (staleVictory) {
                    console.warn('[ENGINE] Ignoring stale game-over from event log after host reset');
                    this.isOver = false;
                    this.winner = null;
                    this._victoryRegistered = false;
                    this.clearWinOverlay();
                    window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
                    this._applyFreshBoardFromRoom();
                } else {
                    if (this.applyState) this.applyState(state);
                    if (this.isOver) {
                        this.setGameOver(this.winner);
                    } else if (!this._victoryRegistered) {
                        // Do not hide the victory banner on a later rebuild after setGameOver already ran.
                        this._victoryRegistered = false;
                        this.clearWinOverlay();
                        window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
                    }
                }

                this.updateTurnIndicator();
                this.renderScoreboard();
                this.safeRender();
            } else if (!this.isMultiplayer && this.gameName !== 'unknown') {
                // Rebuild local state for solo mode if GameLogic exists but events stream is empty
                const logic = GameLogic[this.gameName];
                if (logic) {
                    const config = { mode: this.mode, createdAt: Date.now(), board: null };
                    const state = logic.initialState(this.mode);
                    if (this.applyState) this.applyState(state);
                    this.safeRender();
                }
            }
        } catch (e) {
            console.error(`[ENGINE] State compute failed for ${this.gameName}:`, e);
        }
    }

    applyState(state) {
        // Overridden by subclass (e.g. piles.js sets this.piles = state.piles)
    }

    _partyMemberCount() {
        const pd = this.roomData?.playerData || {};
        return Object.keys(pd).filter((id) => pd[id] != null && typeof pd[id] === 'object').length;
    }

    /** Rebuild visible board from host reset payload (not from stale event log). */
    _applyFreshBoardFromRoom() {
        if (this.onGameReset) this.onGameReset();
        if (!window.GameLogic || !this.roomData?.global) return;
        const g = this.roomData.global;
        const fresh = GameLogic.computeState(this.gameName, [], {
            mode: this.mode,
            createdAt: this.roomData.createdAt || Date.now(),
            board: g.board || null,
            firstPlayer: g.firstPlayer || 'P1'
        });
        if (fresh && this.applyState) this.applyState(fresh);
        if (g.turn) this.turn = g.turn;
    }

    notifyGameRendered() {
        if (this._gameRenderedNotified || window.parent === window) return;
        let visible = 0;
        if (this._isPilesBoard() && this.piles) {
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
        window.parent.postMessage({ type: 'network-send', path, payload }, '*');
    }

    broadcastTurn(nextTurn) {
        this.broadcast('global/turn', nextTurn);
    }

    // Atomic room update
    updateMetadata(updates) {
        window.parent.postMessage({ type: 'network-update-room', updates }, '*');
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
            window.parent.postMessage({
                type: 'network-send-event',
                event: {
                    type: 'move',
                    payload: movePayload,
                    resetCount: this._currentResetRound()
                }
            }, '*');

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

        // 2. Trigger local game logic reset (Host re-gens board locally)
        if (this.onGameReset) this.onGameReset();

        if (this.isHost() && this.hasCap('supportsPileColors')) {
            const varMap = { 'B': '--blue-color', 'R': '--red-color', 'G': '--green-color', 'Y': '--yellow-color' };
            this.currentColors = {};
            ['B', 'R', 'G', 'Y'].forEach(type => {
                this.currentColors[type] = getComputedStyle(document.documentElement).getPropertyValue(varMap[type]).trim();
            });
        }

        if (this.isMultiplayer && this.playerRole === 'P1') {
            if (wasOver) {
                const prevFirstPlayer = this.firstPlayer || 'P1';
                this.firstPlayer = prevFirstPlayer === 'P1' ? 'P2' : 'P1';
                console.log(`HOST: Alternating first player for the next game. Prev: ${prevFirstPlayer}, Next: ${this.firstPlayer}`);
            } else {
                if (!this.firstPlayer) this.firstPlayer = 'P1';
            }

            const startTurn = this.firstPlayer;
            this.turn = startTurn;
            const updates = {};
            updates['status'] = 'playing';
            updates['winner'] = null;
            updates['global/firstPlayer'] = this.firstPlayer;
            updates['global/turn'] = startTurn;
            updates['global/resetCount'] = (this.roomData?.global?.resetCount || 0) + 1;
            this.lastResetCount = updates['global/resetCount'];
            this._resetAcknowledgedCount = updates['global/resetCount'];
            this._resetAcknowledgedAt = Date.now();

            const board = typeof this.serializeBoard === 'function' ? this.serializeBoard() : null;
            updates['global/board'] = this.capabilities?.hasBoardState !== false ? board : null;

            const reg = typeof GameRegistry !== 'undefined' ? GameRegistry.get(this.gameName) : null;
            (reg?.globalResetKeys || ['piecePositions', 'colors', 'pileColors']).forEach((key) => {
                if (key === 'board') return;
                updates[`global/${key}`] = null;
            });

            const extra = typeof this.getExtraGlobalReset === 'function' ? this.getExtraGlobalReset() : {};
            Object.assign(updates, extra);

            updates['lastMove'] = null;
            updates['interactions'] = null;
            this.updateMetadata(updates);
        } else if (!this.isMultiplayer) {
            this.turn = 'P1';
            this.piecePositions = {};
            localStorage.removeItem(`piecePositions_${this.gameName}_${this.mode}`);
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
        if (n === 0) return { x: 0, y: 0 };
        let x = 0;
        let y = 0;
        let step = 1;
        let count = 0;
        while (count < n) {
            for (let i = 0; i < step && count < n; i++) { x++; count++; }
            if (count === n) break;
            for (let i = 0; i < step && count < n; i++) { y--; count++; }
            if (count === n) break;
            step++;
            for (let i = 0; i < step && count < n; i++) { x--; count++; }
            if (count === n) break;
            for (let i = 0; i < step && count < n; i++) { y++; count++; }
            if (count === n) break;
            step++;
        }
        return { x, y };
    }

    _classicPileWorldBounds(portrait) {
        const piece = 44;
        const pad = piece / 2;
        const gap = 70;
        const vgap = 70;
        const spacing = portrait ? 200 : 250;
        const centers = { B: -spacing, R: 0, G: spacing };
        let minNx = Infinity;
        let maxNx = -Infinity;
        let minNy = Infinity;
        let maxNy = -Infinity;

        for (const pk of ['B', 'R', 'G']) {
            for (let idx = 0; idx < 5; idx++) {
                let offsetX;
                let offsetY;
                if (portrait) {
                    const centerYOffset = centers[pk];
                    if (idx < 3) {
                        offsetX = (idx - 1) * gap;
                        offsetY = centerYOffset;
                    } else {
                        offsetX = idx === 3 ? -gap / 2 : gap / 2;
                        offsetY = centerYOffset - vgap;
                    }
                } else {
                    const centerXOffset = centers[pk];
                    if (idx < 3) {
                        offsetX = centerXOffset + (idx - 1) * gap;
                        offsetY = 0;
                    } else {
                        offsetX = centerXOffset + (idx === 3 ? -gap / 2 : gap / 2);
                        offsetY = -vgap;
                    }
                }
                const nx = 500 + offsetX;
                const ny = 500 + offsetY;
                minNx = Math.min(minNx, nx - pad);
                maxNx = Math.max(maxNx, nx + pad);
                minNy = Math.min(minNy, ny - pad);
                maxNy = Math.max(maxNy, ny + pad);
            }
        }

        return {
            w: maxNx - minNx,
            h: maxNy - minNy,
            cx: (minNx + maxNx) / 2,
            cy: (minNy + maxNy) / 2
        };
    }

    _shouldLockFreestyleMobileLayout() {
        return this.isMobileViewport() && this._usesFixedSpiralMobileAnchor();
    }

    /** Full freestyle spiral bbox — stable; does not shrink when pieces are removed. */
    getFreestyleInitialVisualBounds() {
        const piece = 44;
        const pad = piece / 2;
        let minNx = Infinity;
        let maxNx = -Infinity;
        let minNy = Infinity;
        let maxNy = -Infinity;
        for (let i = 0; i < 12; i++) {
            const spiral = this._spiralCoords(i);
            const nx = 500 + spiral.x * 75;
            const ny = 500 + spiral.y * 75;
            minNx = Math.min(minNx, nx - pad);
            maxNx = Math.max(maxNx, nx + pad);
            minNy = Math.min(minNy, ny - pad);
            maxNy = Math.max(maxNy, ny + pad);
        }
        if (!Number.isFinite(minNx)) {
            return { w: 400, h: 400, cx: 500, cy: 500 };
        }
        return {
            w: maxNx - minNx,
            h: maxNy - minNy,
            cx: (minNx + maxNx) / 2,
            cy: (minNy + maxNy) / 2
        };
    }

    getPilesStableVisualBounds() {
        const piece = 44;
        const { width: vw, height: vh } = this.getVisibleViewportSize();
        const portrait = vh > vw;

        if (this.mode === 'classic') {
            return this._classicPileWorldBounds(portrait);
        }

        if (this._mobileLayoutAnchorLocked && this._mobileContentBounds) {
            return this._mobileContentBounds;
        }

        const pad = piece / 2;
        let minNx = Infinity;
        let maxNx = -Infinity;
        let minNy = Infinity;
        let maxNy = -Infinity;
        const items = this.piles
            ? Object.values(this.piles).flat().filter(Boolean)
            : [];
        const walk = (idx) => {
            const spiral = this._spiralCoords(idx);
            let nx = 500 + spiral.x * 75;
            let ny = 500 + spiral.y * 75;
            return { nx, ny };
        };
        if (items.length) {
            items.forEach((piece) => {
                let { nx, ny } = walk(piece.gridIdx ?? 0);
                const saved = this.piecePositions?.[piece.id];
                if (saved) {
                    if (saved.nx !== undefined) nx = saved.nx;
                    if (saved.ny !== undefined) ny = saved.ny;
                }
                minNx = Math.min(minNx, nx - pad);
                maxNx = Math.max(maxNx, nx + pad);
                minNy = Math.min(minNy, ny - pad);
                maxNy = Math.max(maxNy, ny + pad);
            });
        } else {
            for (let i = 0; i < 12; i++) {
                const { nx, ny } = walk(i);
                minNx = Math.min(minNx, nx - pad);
                maxNx = Math.max(maxNx, nx + pad);
                minNy = Math.min(minNy, ny - pad);
                maxNy = Math.max(maxNy, ny + pad);
            }
        }
        if (!Number.isFinite(minNx)) {
            return { w: 400, h: 400, cx: 500, cy: 500 };
        }
        return {
            w: maxNx - minNx,
            h: maxNy - minNy,
            cx: (minNx + maxNx) / 2,
            cy: (minNy + maxNy) / 2
        };
    }

    lockMobileLayoutAnchor() {
        if (this._mobileLayoutAnchorLocked) return;
        this._mobileContentBounds = this.getFreestyleInitialVisualBounds();
        this._mobileLayoutAnchorLocked = true;
    }

    _applyMobilePilesContainerGeometry(bounds) {
        const { width: vw, height: vh } = this.getVisibleViewportSize();
        if (!vw || !vh || !bounds) return;
        const board = this.localSize || 1000;
        const docEl = document.documentElement;
        docEl.style.height = '100%';
        docEl.style.width = '100%';
        docEl.style.maxHeight = '';
        docEl.style.overflow = 'hidden';
        document.body.style.display = 'block';
        document.body.style.position = 'relative';
        document.body.style.width = `${vw}px`;
        document.body.style.height = `${vh}px`;
        document.body.style.maxHeight = `${vh}px`;
        document.body.style.minHeight = '0';
        document.body.style.overflow = 'hidden';
        document.body.style.margin = '0';
        document.body.style.transform = '';
        document.body.style.transformOrigin = '';
        const container = document.getElementById('game-container');
        if (container) {
            container.style.position = 'absolute';
            container.style.left = `${vw / 2 - bounds.cx}px`;
            container.style.top = `${vh / 2 - bounds.cy}px`;
            container.style.width = `${board}px`;
            container.style.height = `${board}px`;
            container.style.margin = '0';
            container.style.transformOrigin = `${bounds.cx}px ${bounds.cy}px`;
        }
    }

    /** Union of actual play pieces/nodes in local coordinates (not full board size). */
    getMobileVisualBounds() {
        const pad = this.isMobileViewport() ? 32 : 12;
        const ls = this.localSize || 800;
        const fallback = { w: ls, h: ls, cx: ls / 2, cy: ls / 2 };

        if (this._isPilesBoard() || this._usesFixedSpiralMobileAnchor() || this._mobileLayoutPolicy() === 'piles-dynamic') {
            return this.getPilesStableVisualBounds();
        }

        if (this.nodes?.length && this._usesFitSquareMobileLayout()) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const n of this.nodes) {
                const x = parseFloat(n.el?.style?.left) || 0;
                const y = parseFloat(n.el?.style?.top) || 0;
                minX = Math.min(minX, x - pad);
                maxX = Math.max(maxX, x + pad);
                minY = Math.min(minY, y - pad);
                maxY = Math.max(maxY, y + pad);
            }
            if (!Number.isFinite(minX)) return fallback;
            return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
        }

        const container = document.getElementById('game-container');
        const pieces = container?.querySelectorAll('.piece') || [];
        if (pieces.length) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            pieces.forEach((p) => {
                const x = parseFloat(p.style.left) || 0;
                const y = parseFloat(p.style.top) || 0;
                const w = p.offsetWidth || 36;
                const h = p.offsetHeight || 36;
                minX = Math.min(minX, x - pad);
                maxX = Math.max(maxX, x + w + pad);
                minY = Math.min(minY, y - pad);
                maxY = Math.max(maxY, y + h + pad);
            });
            if (!Number.isFinite(minX)) return fallback;
            return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
        }

        return fallback;
    }

    /** Recompute mobile zoom anchor once (not per render) — line fits board; piles use stable center. */
    refreshMobileLayout() {
        if (!this.isMobileViewport()) return;
        if (this._usesFitSquareMobileLayout() && this.fitBoardToViewport) {
            this.fitBoardToViewport();
            return;
        }
        if (this._shouldLockFreestyleMobileLayout()) {
            this.lockMobileLayoutAnchor();
            this._applyMobilePilesContainerGeometry(this._mobileContentBounds);
            this.applyZoom();
            return;
        }
        this._mobileContentBounds = this.getPilesStableVisualBounds();
        this._applyMobilePilesContainerGeometry(this._mobileContentBounds);
        this.applyZoom();
    }

    /** Resize viewport shell without recomputing freestyle anchor (cx/cy stay fixed). */
    refreshMobileLayoutViewportOnly() {
        if (!this.isMobileViewport()) return;
        if (this._usesFitSquareMobileLayout() && this.fitBoardToViewport) {
            this.fitBoardToViewport();
            return;
        }
        if (!this._mobileLayoutAnchorLocked || !this._mobileContentBounds) {
            this.refreshMobileLayout();
            return;
        }
        this._applyMobilePilesContainerGeometry(this._mobileContentBounds);
        this.applyZoom();
    }

    getDefaultZoomForViewport() {
        if (this.isMobileViewport()) {
            const { width: vw, height: vh } = this.getVisibleViewportSize();
            const margin = 20;
            const bounds = this._shouldLockFreestyleMobileLayout()
                ? (this._mobileContentBounds || this.getFreestyleInitialVisualBounds())
                : this.getMobileVisualBounds();
            const scaleX = (vw - margin * 2) / Math.max(bounds.w, 1);
            const scaleY = (vh - margin * 2) / Math.max(bounds.h, 1);
            const base = Math.min(Math.max(Math.min(scaleX, scaleY), 0.25), 5);
            this._mobileBaseFit = base;
            this._mobileContentBounds = bounds;
            return base;
        }
        return 1;
    }

    restorePersistedZoom() {
        if (!this.gameName || this.gameName === 'unknown') return;
        const raw = localStorage.getItem(this.getZoomStorageKey());
        const saved = raw != null ? parseFloat(raw) : NaN;
        if (Number.isFinite(saved)) {
            this.targetZoom = Math.min(Math.max(saved, 0.2), 5);
            this.zoom = this.targetZoom;
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
        if (!this.isMobileViewport()) return;
        if (!this.localSize || !this._usesFitSquareMobileLayout()) return;
        const container = document.getElementById('game-container');
        if (!container) return;
        const { width: vw, height: vh } = this.getVisibleViewportSize();
        if (!vw || !vh) return;
        this._mobileContentBounds = this.getMobileVisualBounds();

        container.style.width = `${this.localSize}px`;
        container.style.height = `${this.localSize}px`;
        container.style.margin = '0';
        container.style.flexShrink = '0';

        const docEl = document.documentElement;
        docEl.style.height = `${vh}px`;
        docEl.style.width = `${vw}px`;
        docEl.style.maxHeight = `${vh}px`;
        docEl.style.overflow = 'hidden';
        document.body.style.display = 'block';
        document.body.style.position = 'relative';
        document.body.style.width = `${vw}px`;
        document.body.style.height = `${vh}px`;
        document.body.style.maxHeight = `${vh}px`;
        document.body.style.minHeight = '0';
        document.body.style.overflow = 'hidden';
        document.body.style.margin = '0';

        if (!this._fitZoomInitialized) {
            this.restorePersistedZoom();
        }
        this.applyZoom();
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
        this.uid = this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
        this.username = sessionStorage.getItem('username') || localStorage.getItem('username') || 'Guest';
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
            this.handleZoom(e.deltaY);
        }, { passive: false });

        window.addEventListener('message', (e) => {
            if (!e.data || typeof e.data.type !== 'string') return;
            if (e.data.type === 'hub-visible-viewport') {
                this._hubVisibleViewport = {
                    width: e.data.width,
                    height: e.data.height,
                    offsetTop: e.data.offsetTop
                };
                if (this.isMobileViewport()) {
                    if (this._mobileLayoutAnchorLocked) this.refreshMobileLayoutViewportOnly();
                    else this.refreshMobileLayout();
                } else if (this.requestRender) {
                    this.requestRender();
                }
                return;
            }
            if (e.data.type === 'wheel') this.handleZoom(e.data.deltaY);
            if (e.data.type === 'pinch-zoom-get') {
                window.parent.postMessage({ type: 'pinch-zoom-current', zoom: this.targetZoom }, '*');
            }
            if (e.data.type === 'pinch-zoom-set' && typeof e.data.zoom === 'number') {
                this.targetZoom = Math.min(Math.max(e.data.zoom, 0.2), 5.0);
                this.zoom = this.targetZoom;
                this.applyZoom();
                this.scheduleSavePersistedZoom();
            }
            if (e.data.type === 'pinch-zoom' && typeof e.data.scale === 'number') {
                const next = this.targetZoom * e.data.scale;
                this.targetZoom = Math.min(Math.max(next, 0.2), 5.0);
                this.scheduleSavePersistedZoom();
            }
        });

        this.initPinchZoom(container);

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
                pinch = { d0: dist(e.touches[0], e.touches[1]), zoom0: this.zoom };
            }
        }, { passive: true });

        target.addEventListener('touchmove', (e) => {
            if (!this.isMobileViewport()) return;
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

        if (key === 'r') {
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
        if (picker && this.colorVariableMap) {
            const varName = this.colorVariableMap[type];
            const currentColor = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();

            picker.style.position = 'fixed';
            picker.style.left = '50%';
            picker.style.top = '80%';
            picker.style.transform = 'translate(-50%, -50%)';
            if (this.isMobileViewport()) {
                picker.style.setProperty('opacity', '1', 'important');
                picker.style.setProperty('pointer-events', 'auto', 'important');
                picker.style.width = '56px';
                picker.style.height = '56px';
                picker.style.zIndex = '100000';
            } else {
                picker.style.opacity = '0';
                picker.style.pointerEvents = 'auto';
            }

            if (currentColor.startsWith('#')) picker.value = currentColor;
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

        const dot = document.getElementById('center-dot');
        if (dot) {
            dot.style.display = this.devMode ? 'block' : 'none';
            dot.style.zIndex = '99999';
        }

        const debugInfo = document.getElementById('debug-info');
        if (debugInfo) debugInfo.style.display = this.devMode ? 'block' : 'none';

        this.applyZoom();
    }

    handleZoom(deltaY) {
        const factor = deltaY > 0 ? 0.9 : 1.1;
        this.targetZoom = Math.min(Math.max(this.targetZoom * factor, 0.2), 5.0);
        if (!this.isMobileViewport()) {
            this.zoom = this.targetZoom;
            this.applyZoom();
        }
        this.scheduleSavePersistedZoom();
    }

    startZoomLoop() {
        const loop = () => {
            if (Math.abs(this.zoom - this.targetZoom) > 0.001) {
                this.zoom += (this.targetZoom - this.zoom) * this.zoomVelocity;
                this.applyZoom();
            }
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }


    applyZoom() {
        const target = document.getElementById('game-container') || document.body;
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
        if (!debug && this.devMode) {
            debug = document.createElement('div');
            debug.id = 'debug-info';
            debug.style.cssText = `position: fixed; top: 20px; right: 20px; background: rgba(0,0,0,0.8); padding: 10px; border-radius: 5px; font-family: monospace; z-index: 9999; pointer-events: none; color: #22c55e; font-size: 12px; border: 1px solid #22c55e;`;
            document.body.appendChild(debug);
        }

        if (debug) {
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

    setGameOver(winner) {
        if (this._victoryRegistered) return;
        this._victoryRegistered = true;

        this.isOver = true;
        this.winner = winner;

        if (this.isMultiplayer && this.isHost()) {
            const updates = { winner };
            if (this._partyMemberCount() >= 2) {
                updates.status = 'playing';
            }
            this.updateMetadata(updates);
        }
        this.updateTurnIndicator();

        // Increment and Save Scores
        if (this.scores && this.scores[winner] !== undefined) {
            this.scores[winner]++;
            this.saveScores();
            this.renderScoreboard();
        }

        // Win Banner Trigger
        window.parent.postMessage({
            type: 'update-win-banner',
            winner: winner,
            visible: true
        }, '*');

        // Update turn indicator (BaseGame will handle "Game Over" text)
        this.updateTurnIndicator();

        // Legacy Overlay (Keep for R key prompt but simplify)
        const overlay = document.querySelector('.win-overlay');
        if (overlay) {
            overlay.innerHTML = `<div style="font-size: 0.2em; opacity: 0.7; margin-top: 15vh;">PRESS 'R' TO REMATCH</div>`;
            overlay.classList.add('show');
        }

        // Auto-Restart Timer (host / P1 only — guest waits for resetCount from host)
        if (this.isMultiplayer && !this.isHost()) {
            console.log('[ENGINE] Guest waiting for host auto-reset');
        } else if (this.isHost()) {
            const isTest = this.roomId && this.roomId.startsWith('MP_AUDIT');
            const dwell = Number(
                (typeof window !== 'undefined' && window.FIVE_VICTORY_DWELL_MS)
                    || (isTest ? 5000 : 2500)
            );
            const delay = isTest ? Math.max(dwell, 5000) : dwell;
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
        if (typeof GameAdapter !== 'undefined' && !GameAdapter.cap(this, 'supportsTurnIndicator')) {
            return;
        }
        const turnMsg = typeof HubProtocol !== 'undefined' ? HubProtocol.MSG.UPDATE_TURN : 'update-turn';
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

    static setupDragging(el, onDragEnd, context, onDragStart, onDrag) {
        let startX, startY, isDragging = false;
        const threshold = 5;
        el.style.touchAction = 'none';

        const onPointerDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (context && context.isMultiplayer && context.turn !== context.playerRole) return;
            if (context && !context.isMultiplayer && (context.turn !== 'P1' || context.isOver)) return;
            if (onDragStart && onDragStart(el) === false) return;

            startX = e.clientX;
            startY = e.clientY;
            const zoom = (context && context.zoom) || 1.0;
            const rect = el.getBoundingClientRect();
            const parentRect = el.parentElement.getBoundingClientRect();
            const initialLeft = (rect.left - parentRect.left) / zoom;
            const initialTop = (rect.top - parentRect.top) / zoom;

            el.style.transition = 'none';
            let movePending = false;
            let latestMe = null;

            try {
                if (e.pointerId != null) el.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }

            const onPointerMove = (me) => {
                latestMe = me;
                if (!isDragging && (Math.abs(me.clientX - startX) > threshold || Math.abs(me.clientY - startY) > threshold)) {
                    isDragging = true;
                }
                if (isDragging && !movePending) {
                    movePending = true;
                    requestAnimationFrame(() => {
                        if (!isDragging || !latestMe) { movePending = false; return; }
                        const dx = (latestMe.clientX - startX) / zoom;
                        const dy = (latestMe.clientY - startY) / zoom;
                        const nextLeft = Math.max(0, Math.min(initialLeft + dx, (parentRect.width - rect.width) / zoom));
                        const nextTop = Math.max(0, Math.min(initialTop + dy, (parentRect.height - rect.height) / zoom));
                        el.style.left = `${nextLeft}px`;
                        el.style.top = `${nextTop}px`;
                        if (onDrag) onDrag(nextLeft, nextTop);
                        movePending = false;
                    });
                }
            };

            const onPointerUp = (ue) => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.removeEventListener('pointercancel', onPointerUp);
                try {
                    if (ue.pointerId != null) el.releasePointerCapture(ue.pointerId);
                } catch (_) { /* ignore */ }
                if (onDragEnd) onDragEnd(isDragging, el, ue);
                isDragging = false;
                el.style.transition = '';
            };

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
        };

        el.addEventListener('pointerdown', onPointerDown);
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
