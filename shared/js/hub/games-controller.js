/**
 * Hub game picker + iframe URL — driven by GameRegistry.
 * index.html passes a mutable state bag and callbacks.
 */
(function (global) {
    const Registry = global.GameRegistry;

    /**
     * @typedef {Object} HubGamesState
     * @property {string} currentGame
     * @property {string} gameMode
     * @property {string|null} roomId
     * @property {string} userColor
     * @property {function(string): string} getOpponentColor
     * @property {string} [initialRole]
     */

    /**
     * @param {HubGamesState} state
     * @param {{ updateFrame: Function, updateUI: Function, onHostSync?: Function }} hooks
     */
    function create(state, hooks) {
        function ensureValidGame() {
            if (!Registry.has(state.currentGame)) {
                state.currentGame = Registry.defaultId();
            }
            state.gameMode = Registry.normalizeMode(state.currentGame, state.gameMode);
        }

        function iframePath(gameId) {
            return `games/${gameId}/index.html`;
        }

        function buildFrameParams(cacheBust) {
            const params = new URLSearchParams();
            params.set('theme', state.userColor);
            const inParty = state.roomId && state.roomId !== 'lobby';
            const opp = inParty && typeof state.resolveOpponentColorForIframe === 'function'
                ? state.resolveOpponentColorForIframe()
                : state.getOpponentColor(state.userColor);
            if (opp) params.set('opp', opp);
            params.set('mode', state.gameMode);
            if (cacheBust) params.set('v', String(Date.now()));
            if (state.roomId && state.roomId !== 'lobby') {
                params.set('room', state.roomId);
                const role = global.NetworkEngine?.playerRole || state.initialRole || 'P1';
                params.set('role', role);
            }
            return params;
        }

        function primeFrame(frame) {
            if (!frame) return;
            ensureValidGame();
            frame.src = `${iframePath(state.currentGame)}?${buildFrameParams(false).toString()}`;
        }

        function updateFrame(frame, lastFrameGameRef) {
            if (!frame) return;
            ensureValidGame();
            if (lastFrameGameRef.mode == null) lastFrameGameRef.mode = state.gameMode;
            const gameChanged = lastFrameGameRef.current !== state.currentGame;
            const modeChanged = lastFrameGameRef.mode !== state.gameMode;
            if (gameChanged) lastFrameGameRef.current = state.currentGame;
            if (modeChanged) lastFrameGameRef.mode = state.gameMode;
            frame.src = `${iframePath(state.currentGame)}?${buildFrameParams(gameChanged || modeChanged).toString()}`;
            localStorage.setItem('lastGame', state.currentGame);
        }

        function setGame(gameId, sync = true) {
            if (!Registry.has(gameId)) return;
            state.currentGame = gameId;
            state.gameMode = Registry.normalizeMode(
                gameId,
                localStorage.getItem(`${gameId}_mode`) || Registry.defaultModeFor(gameId)
            );
            hooks.updateFrame();
            hooks.updateUI();
            if (sync && hooks.onHostSync) hooks.onHostSync(state.currentGame, state.gameMode);
        }

        function setGameMode(mode, sync = true) {
            state.gameMode = Registry.normalizeMode(state.currentGame, mode);
            localStorage.setItem(`${state.currentGame}_mode`, state.gameMode);
            hooks.updateFrame();
            hooks.updateUI();
            if (sync && hooks.onHostSync) hooks.onHostSync(state.currentGame, state.gameMode);
        }

        function cycleGame() {
            setGame(Registry.nextGameId(state.currentGame), true);
        }

        function cycleMode() {
            const def = Registry.get(state.currentGame);
            if (!def || def.modes.length < 2) return;
            setGameMode(Registry.nextMode(state.currentGame, state.gameMode), true);
        }

        function updateGamePickerUI() {
            const isLobby = !state.roomId || state.roomId === 'lobby';
            const isHost = global.NetworkEngine?.playerRole === 'P1' || isLobby;
            const def = Registry.get(state.currentGame);

            document.querySelectorAll('.game-btn:not(#btn-leave-party)').forEach((btn) => {
                btn.style.display = isHost ? 'block' : 'none';
            });

            const modeGroup = document.getElementById('mode-settings-group');
            if (modeGroup) {
                modeGroup.style.display = (isHost && def && def.modes.length > 1) ? 'block' : 'none';
            }

            const keybindModeTag = document.getElementById('keybind-mode-tag');
            const keybindModeDesc = document.getElementById('keybind-mode-desc');
            if (keybindModeTag && keybindModeDesc) {
                const show = !!(def && def.modes.length > 1);
                keybindModeTag.style.display = show ? 'block' : 'none';
                keybindModeDesc.style.display = show ? 'block' : 'none';
            }

            Registry.listIds().forEach((id) => {
                const btn = document.getElementById(`btn-${id}`);
                if (btn) btn.classList.toggle('active', state.currentGame === id);
            });

            if (global.HubGamePickerUI?.syncModePicker) {
                global.HubGamePickerUI.syncModePicker(state.currentGame, state.gameMode);
            }

            const leaveBtn = document.getElementById('btn-leave-party');
            if (leaveBtn) leaveBtn.style.display = isLobby ? 'none' : 'block';
        }

        function initFromUrl(urlParams) {
            state.currentGame = urlParams.get('game')
                || localStorage.getItem('lastGame')
                || Registry.defaultId();
            ensureValidGame();
            state.gameMode = Registry.normalizeMode(
                state.currentGame,
                urlParams.get('mode') || localStorage.getItem(`${state.currentGame}_mode`) || Registry.defaultModeFor(state.currentGame)
            );
        }

        return {
            ensureValidGame,
            primeFrame,
            updateFrame,
            setGame,
            setGameMode,
            cycleGame,
            cycleMode,
            updateGamePickerUI,
            initFromUrl
        };
    }

    const HubGames = { create };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HubGames;
    } else {
        global.HubGames = HubGames;
    }
})(typeof window !== 'undefined' ? window : global);
