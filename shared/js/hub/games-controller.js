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
        function isLobby() {
            return !state.roomId || state.roomId === 'lobby';
        }

        /** Bananagrams uses solo in lobby and multiplayer in any party room. */
        function effectiveGameMode() {
            if (state.currentGame === 'bananagrams') {
                return isLobby() ? 'solo' : 'multiplayer';
            }
            return Registry.normalizeMode(state.currentGame, state.gameMode);
        }

        function ensureValidGame() {
            if (!Registry.has(state.currentGame)) {
                state.currentGame = Registry.defaultId();
            }
            if (state.currentGame === 'bananagrams') {
                state.gameMode = effectiveGameMode();
                try {
                    localStorage.setItem('bananagrams_mode', state.gameMode);
                } catch (_) { /* ignore */ }
            } else {
                state.gameMode = Registry.normalizeMode(state.currentGame, state.gameMode);
            }
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
            params.set('mode', effectiveGameMode());
            if (cacheBust) params.set('v', String(Date.now()));
            if (state.roomId && state.roomId !== 'lobby') {
                params.set('room', state.roomId);
                const role = global.NetworkEngine?.playerRole || state.initialRole || 'P1';
                params.set('role', role);
            }
            return params;
        }

        function syncHubGameAttribute() {
            if (typeof document !== 'undefined' && document.body) {
                document.body.dataset.hubGame = state.currentGame || '';
            }
        }

        function primeFrame(frame) {
            if (!frame) return;
            ensureValidGame();
            syncHubGameAttribute();
            frame.src = `${iframePath(state.currentGame)}?${buildFrameParams(false).toString()}`;
        }

        function updateFrame(frame, lastFrameGameRef) {
            if (!frame) return;
            ensureValidGame();
            state.gameMode = effectiveGameMode();
            if (lastFrameGameRef.mode == null) lastFrameGameRef.mode = state.gameMode;
            const gameChanged = lastFrameGameRef.current !== state.currentGame;
            const modeChanged = lastFrameGameRef.mode !== state.gameMode;
            if (gameChanged) lastFrameGameRef.current = state.currentGame;
            if (modeChanged) lastFrameGameRef.mode = state.gameMode;
            if (gameChanged || modeChanged) {
                const caps = Registry.getCapabilities(state.currentGame, state.gameMode);
                if (!caps?.supportsTurnIndicator) clearGlobalTurnIndicator();
            }
            syncHubGameAttribute();
            frame.src = `${iframePath(state.currentGame)}?${buildFrameParams(gameChanged || modeChanged).toString()}`;
            localStorage.setItem('lastGame', state.currentGame);
            notifySettingsEdgeSync();
        }

        function resetCurrentGame() {
            const frame = document.getElementById('game-frame');
            if (!frame) return;
            const win = frame.contentWindow;
            const g = win?.game;
            const canResetInFrame = g && typeof g.resetGame === 'function'
                && (isLobby() || global.NetworkEngine?.playerRole === 'P1');
            if (canResetInFrame) {
                g.resetGame();
                hooks.updateUI();
                return;
            }
            ensureValidGame();
            frame.src = `${iframePath(state.currentGame)}?${buildFrameParams(true).toString()}`;
            hooks.updateUI();
        }

        function postGameBlocksSwitch() {
            const frame = document.getElementById('game-frame');
            const g = frame?.contentWindow?.game;
            return typeof g?.isPostGameBlocking === 'function' && g.isPostGameBlocking();
        }

        function notifySettingsEdgeSync() {
            try {
                window.dispatchEvent(new CustomEvent('five-settings-edge-sync'));
            } catch (_) { /* ignore */ }
        }

        function setGame(gameId, sync = true) {
            if (!Registry.has(gameId)) return;
            if (postGameBlocksSwitch()) return;
            if (gameId === state.currentGame) {
                resetCurrentGame();
                return;
            }
            state.currentGame = gameId;
            syncHubGameAttribute();
            let mode = localStorage.getItem(`${gameId}_mode`) || Registry.defaultModeFor(gameId);
            if (Registry.usesHubModeSwitch(gameId)) {
                mode = Registry.hubModeFor(gameId, !isLobby());
                try {
                    localStorage.setItem(`${gameId}_mode`, mode);
                } catch (_) { /* ignore */ }
            }
            state.gameMode = Registry.normalizeMode(gameId, mode);
            hooks.updateFrame();
            hooks.updateUI();
            if (sync && hooks.onHostSync) hooks.onHostSync(state.currentGame, state.gameMode);
        }

        function setGameMode(mode, sync = true) {
            if (postGameBlocksSwitch()) return;
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

        function partyMemberCount() {
            if (typeof state.getPartyMemberCount === 'function') {
                return state.getPartyMemberCount();
            }
            const room = global.NetworkEngine?.roomData;
            if (room && global.NetworkEngine?.countRoomMembers) {
                return global.NetworkEngine.countRoomMembers(room);
            }
            return isLobby() ? 1 : 2;
        }

        function syncLeavePartyButton() {
            const leaveBtn = document.getElementById('btn-leave-party');
            if (!leaveBtn) return;
            leaveBtn.style.display = isLobby() ? 'none' : 'block';
        }

        function clearGlobalTurnIndicator() {
            const indicator = document.getElementById('global-turn-indicator');
            const text = document.getElementById('turn-text');
            if (!indicator || !text) return;
            text.innerText = '';
            indicator.classList.remove('visible');
        }

        function updateGamePickerUI() {
            syncLeavePartyButton();
            const lobby = isLobby();
            const isHost = global.NetworkEngine?.playerRole === 'P1' || lobby;
            const def = Registry.get(state.currentGame);
            const partySize = partyMemberCount();

            if (!lobby && !Registry.isAvailableForPartySize(state.currentGame, partySize)) {
                const fallback = Registry.defaultPartyGameId(partySize);
                if (Registry.has(fallback) && isHost) {
                    state.gameMode = fallback === 'bananagrams' ? 'multiplayer' : Registry.defaultModeFor(fallback);
                    setGame(fallback, true);
                    syncLeavePartyButton();
                    return;
                }
            }

            document.querySelectorAll('.game-btn:not(#btn-leave-party)').forEach((btn) => {
                const id = btn.id?.replace(/^btn-/, '');
                const available = lobby || Registry.isAvailableForPartySize(id, partySize);
                btn.style.display = (isHost && available) ? 'block' : 'none';
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

            syncLeavePartyButton();
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
            syncHubGameAttribute();
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
            syncLeavePartyButton,
            clearGlobalTurnIndicator,
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
