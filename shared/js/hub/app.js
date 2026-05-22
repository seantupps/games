(function (global) {
    const VIBRANT_COLORS = [
        '#f43f5e', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#6366f1', '#3b82f6',
        '#0ea5e9', '#06b6d4', '#14b8a6', '#10b981', '#22c55e', '#84cc16', '#eab308',
        '#f59e0b', '#f97316', '#ef4444'
    ];

    function bootstrap() {
        if (global.HubBoot) global.HubBoot.init();

        let username = sessionStorage.getItem('username');
        if (!username) {
            username = `Guest${Math.floor(Math.random() * 9000 + 1000)}`;
            sessionStorage.setItem('username', username);
        }

        try {
            const piecePositions = JSON.parse(localStorage.getItem('piecePositions') || '{}');
            const firstPiece = Object.values(piecePositions)[0];
            if (firstPiece && (firstPiece.left !== undefined || firstPiece.top !== undefined)) {
                console.log('Hub: Cleaning up legacy absolute positions...');
                localStorage.removeItem('piecePositions');
            }
        } catch (_) { /* ignore */ }

        const urlParams = new URLSearchParams(window.location.search);
        let roomId = urlParams.get('room');
        const initialRole = urlParams.get('role');
        if (initialRole) global.NetworkEngine.playerRole = initialRole;

        let currentGame =
            urlParams.get('game') || localStorage.getItem('lastGame') || global.GameRegistry.defaultId();
        let gameMode = urlParams.get('mode') || 'classic';

        let userColor = sessionStorage.getItem('userColor');
        if (!userColor) {
            userColor = VIBRANT_COLORS[Math.floor(Math.random() * VIBRANT_COLORS.length)];
            sessionStorage.setItem('userColor', userColor);
        }

        const lastFrameGameRef = { current: null };

        const ctx = {
            username,
            userColor,
            initialRole,
            lastFrameGameRef,
            hubGames: null,
            get currentGame() { return currentGame; },
            set currentGame(v) { currentGame = v; },
            get gameMode() { return gameMode; },
            set gameMode(v) { gameMode = v; },
            get roomId() { return roomId; },
            set roomId(v) { roomId = v; }
        };

        global.HubApp = { ctx };

        global.HubTheme.attach(ctx);
        global.HubUI.attach(ctx);

        const hubGames = global.HubGames.create(ctx, {
            updateFrame() {
                const frame = document.getElementById('game-frame');
                hubGames.updateFrame(frame, lastFrameGameRef);
                frame.onload = () => {
                    if (global.FiveViewport) {
                        global.FiveViewport.notifyGameFrame(global.FiveViewport.isMobile());
                    }
                    ctx.setUserColor(ctx.userColor);
                    setTimeout(() => frame.focus(), 100);
                };
            },
            updateUI: () => ctx.updateUI(),
            onHostSync: (gameId, mode) => {
                if (ctx.syncRoomStateOnGameOrModeChange) {
                    ctx.syncRoomStateOnGameOrModeChange(gameId, mode);
                }
            }
        });
        ctx.hubGames = hubGames;

        hubGames.initFromUrl(urlParams);
        currentGame = ctx.currentGame;
        gameMode = ctx.gameMode;
        hubGames.primeFrame(document.getElementById('game-frame'));

        ctx.setUserColor(userColor);

        global.HubRoom.attach(ctx, hubGames);
        global.HubChat.attach(ctx);
        global.HubInvites.attach(ctx, hubGames);
        global.HubBridgeHandlers.install(ctx, hubGames);

        ctx.toggleFirstPlayer = function toggleFirstPlayer() {
            if (global.NetworkEngine.playerRole !== 'P1' || !ctx.roomId) return;
            const rel = global.RtdbSchema.relativeGlobal('firstPlayer');
            global.NetworkEngine.db.ref(`games/${ctx.roomId}/global/firstPlayer`).once('value', (snap) => {
                const current = snap.val() || 'P1';
                const next = current === 'P1' ? 'P2' : 'P1';
                global.NetworkEngine.send(rel, next);
                console.log(`[Turn] Next game first player: ${next}`);
            });
        };

        global.setGame = (id, sync) => {
            hubGames.setGame(id, sync);
            currentGame = ctx.currentGame;
            gameMode = ctx.gameMode;
        };
        global.setGameMode = (mode, sync) => {
            hubGames.setGameMode(mode, sync);
            gameMode = ctx.gameMode;
        };
        global.cycleGame = () => hubGames.cycleGame();
        global.cycleMode = () => hubGames.cycleMode();
        global.leaveParty = () => ctx.leaveParty();

        global.NetworkEngine.init();
        global.NetworkEngine.listenForPlayers(ctx.renderPlayers);
        if (global.HubGamePickerUI) global.HubGamePickerUI.mountGamePickerButtons();
        ctx.updateUI();

        const usernameInput = document.getElementById('username-input');
        if (usernameInput) {
            usernameInput.addEventListener('input', (e) => {
                ctx.username = e.target.value.trim().substring(0, 16) || ctx.username;
                sessionStorage.setItem('username', ctx.username);
                global.NetworkEngine.updatePresence();
            });
        }

        installKeyboard(ctx, hubGames);

        if (!roomId) {
            roomId = 'lobby';
            const url = new URL(window.location);
            url.searchParams.set('room', roomId);
            window.history.replaceState({}, '', url);
        }
        ctx.roomId = roomId;

        ctx.joinBootstrap();
    }

    function installKeyboard(ctx, hubGames) {
        window.addEventListener('keydown', (e) => {
            const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
            if (isInput && e.key !== 'Escape') return;

            const key = e.key.toLowerCase();
            if (key === 't') {
                e.preventDefault();
                global.ChatEngine.toggle();
                return;
            }
            if (key === '/') {
                e.preventDefault();
                global.ChatEngine.toggle(true, '/');
                return;
            }

            const isHost = global.NetworkEngine.playerRole === 'P1';
            if (key === 's') {
                e.preventDefault();
                ctx.toggleSidebar();
                return;
            }
            if (key === 'm' && isHost) {
                e.preventDefault();
                hubGames.cycleMode();
                return;
            }
            if (key === 'g' && isHost) {
                e.preventDefault();
                hubGames.cycleGame();
                return;
            }

            const frame = document.getElementById('game-frame');
            if (frame?.contentWindow) {
                frame.contentWindow.postMessage({
                    type: 'keydown',
                    key: e.key,
                    code: e.code,
                    ctrlKey: e.ctrlKey,
                    shiftKey: e.shiftKey,
                    altKey: e.altKey,
                    metaKey: e.metaKey
                }, '*');
            }
        });

        window.addEventListener(
            'wheel',
            (e) => {
                const frame = document.getElementById('game-frame');
                if (frame?.contentWindow) {
                    frame.contentWindow.postMessage({ type: 'wheel', deltaY: e.deltaY }, '*');
                }
            },
            { passive: false }
        );
    }

    global.HubApp = { bootstrap, ctx: global.HubApp?.ctx };
})(typeof window !== 'undefined' ? window : global);
