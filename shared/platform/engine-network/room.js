/**
 * Room snapshot + identity messages (init-identity, network-update shell).
 */
(function (global) {
    const PM = () => global.PlayerModel;

    function hostWarmupBoardPopulated(game) {
        if (typeof game.hostWarmupBoardPopulated === 'function') {
            return game.hostWarmupBoardPopulated();
        }
        const board = game.roomData?.global?.board;
        if (!board) return false;
        if (game.hasCap?.('supportsPileColors')) {
            return Object.values(board).flat().filter(Boolean).length > 0;
        }
        return true;
    }

    function hostWarmupBoardModeMismatch(game) {
        if (typeof game.hostWarmupBoardModeMismatch === 'function') {
            return game.hostWarmupBoardModeMismatch();
        }
        if (!game.hasCap?.('supportsPileColors')) return false;
        const board = game.roomData?.global?.board;
        if (!board) return false;
        const allPieces = Object.values(board).flat().filter(Boolean);
        if (!allPieces.length) return false;
        const hasGridIdx = allPieces.some((p) => typeof p.gridIdx === 'number');
        if (game.mode === 'freestyle' && !hasGridIdx) return true;
        if (game.mode === 'classic' && hasGridIdx) return true;
        return false;
    }

    function handleInitIdentity(game, e) {
        if (e.data.type !== 'init-identity') return false;

        game.uid = e.data.uid || game.uid;
        game.playerRole = (e.data.role || PM()?.ROLE_HOST || 'P1').toUpperCase();
        game.roomId = e.data.roomId || 'lobby';
        if (e.data.username) game.username = e.data.username;
        game.isMultiplayer = !!game.roomId && game.roomId !== 'lobby';
        if (!game.isMultiplayer) {
            game.opponentName = 'AI';
            game.loadScores();
        }

        if (e.data.game) {
            game.roomData = e.data.game;
            game.lastResetCount = game.roomData.global?.resetCount || 0;
            game.firstPlayer = game.roomData.global?.firstPlayer || PM()?.ROLE_HOST || 'P1';
            if (game.roomData.global?.mode) {
                game.mode = game.roomData.global.mode;
            }
        }
        const reg = typeof GameRegistry !== 'undefined' ? GameRegistry : null;
        if (reg?.usesHubModeSwitch?.(game.gameName) && game.isMultiplayer && game.roomId !== 'lobby') {
            game.mode = reg.hubModeFor(game.gameName, true);
            if (typeof GameAdapter !== 'undefined') GameAdapter.refreshCapabilities(game);
        }

        if (game.hasCap('supportsPileColors') && game.mode === 'freestyle' && game.applyServerPileColors) {
            game.applyServerPileColors();
        }
        game.rebuildState();

        if (game.onIdentitySynced) game.onIdentitySynced();
        game.renderScoreboard();
        if (game.safeRender) game.safeRender();

        const hasBoard = game.roomData?.global?.board && hostWarmupBoardPopulated(game);
        const boardModeMismatch = hostWarmupBoardModeMismatch(game);
        const needsWarmup = !game.roomData || !game.roomData.global || !hasBoard || boardModeMismatch;
        const gameInProgress = game._eventsLoaded && game.gameEvents.length > 0;
        const skipWarmupOnRefresh = gameInProgress
            || (hasBoard && !boardModeMismatch && (game.roomData?.global?.resetCount || 0) >= 1);

        if (game.isMultiplayer && game.isHost() && !game._hasWarmedUp && needsWarmup && !skipWarmupOnRefresh) {
            game._hasWarmedUp = true;
            console.log(`[ENGINE] Host warming up uninitialized or mismatched room: ${game.roomId} (boardModeMismatch=${boardModeMismatch})`);
            game.resetGame();
        } else if (game.isMultiplayer && game.isHost() && !game._hasWarmedUp) {
            game._hasWarmedUp = true;
        }

        if (game.isHost() && game.isMultiplayer && game.hasCap?.('supportsTurnIndicator')) {
            game.startRepairWatchdog();
        }
        return true;
    }

    function handleNetworkUpdateShell(game, e) {
        if (e.data.type !== 'network-update' || !e.data.payload) return false;
        if (game.roomId === 'lobby' || !game.isMultiplayer) return true;

        const data = e.data.payload;
        game.roomData = game._mergeRoomSnapshot(game.roomData, data);
        if (typeof game._traceDoneNetwork === 'function') {
            game._traceDoneNetwork(data, 'engine-network-update');
        }
        if (data.global && data.global.firstPlayer) {
            game.firstPlayer = data.global.firstPlayer;
        }

        const currentResetCount = typeof RtdbSchema !== 'undefined'
            ? RtdbSchema.readResetCount(game.roomData)
            : (game.roomData?.global?.resetCount ?? game.roomData?.meta?.resetCount ?? 0);
        if (currentResetCount > game.lastResetCount) {
            if (game.lastResetCount > 0) {
                const who = game.isHost() ? 'Host' : 'Guest';
                console.log(`[ENGINE] ${who} received reset signal (resetCount: ${currentResetCount})`);
                if (typeof game._traceDoneFlags === 'function') {
                    game._traceDoneFlags('before-remote-reset');
                }
                game._applyRemoteResetSignal(data);
            }
            game.lastResetCount = currentResetCount;
        }

        if (game.onNetworkUpdate) {
            game.onNetworkUpdate(data);
        }

        if (typeof game._traceDoneFlags === 'function') {
            game._traceDoneFlags('before-rebuildState');
        }
        game.rebuildState();
        if (typeof game._traceDoneFlags === 'function') {
            game._traceDoneFlags('after-rebuildState');
        }

        if (data.global && data.global.colors) {
            const varMap = {
                B: '--blue-color',
                R: '--red-color',
                G: '--green-color',
                Y: '--yellow-color'
            };
            Object.keys(data.global.colors).forEach((type) => {
                const val = data.global.colors[type];
                const cssVar = varMap[type];
                const current = document.documentElement.style.getPropertyValue(cssVar)
                    || getComputedStyle(document.documentElement).getPropertyValue(cssVar);
                if (current.trim() !== val.trim()) {
                    document.documentElement.style.setProperty(cssVar, val);
                }
            });
        }

        syncPlayerDataTheme(game, data);
        return true;
    }

    function syncPlayerDataTheme(game, data) {
        if (!data.playerData) return;
        const myUid = game.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
        const otherUid = PM()?.firstOtherUid(data, myUid)
            || Object.keys(data.playerData).find((uid) => uid !== myUid);
        if (!otherUid) return;
        if (data.playerData[otherUid].name) {
            game.opponentName = data.playerData[otherUid].name;
        }
        if (data.playerData[otherUid].color) {
            document.documentElement.style.setProperty('--opponent-color', data.playerData[otherUid].color);
        }
        game.updateTurnIndicator();
        game.safeRender();
    }

    const EngineNetworkRoom = {
        handleInitIdentity,
        handleNetworkUpdateShell,
        hostWarmupBoardPopulated,
        hostWarmupBoardModeMismatch
    };

    global.EngineNetwork = global.EngineNetwork || {};
    global.EngineNetwork.room = EngineNetworkRoom;
})(typeof window !== 'undefined' ? window : global);
