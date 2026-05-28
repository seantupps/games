(function (global) {
    function install(ctx, hubGames) {
        const H = global.HubProtocol.MSG;
        const L = global.HubProtocol.LEGACY_STRING;
        const S = global.RtdbSchema;

        function pushIframeIdentity(frame, role, game) {
            if (!frame?.contentWindow) return;
            frame.contentWindow.postMessage({
                type: H.INIT_IDENTITY || 'init-identity',
                role,
                uid: global.NetworkEngine.uid,
                username: ctx.username,
                roomId: ctx.roomId,
                game
            }, '*');
        }

        function resolvePartyRole(game) {
            if (!game) return 'P1';
            const myUid = global.NetworkEngine.uid;
            if (!myUid || game.host === myUid || ctx.roomId === 'lobby') return 'P1';
            const gameId = game?.global?.game || game?.meta?.game || '';
            if (gameId !== 'bananagrams') return 'P2';
            const pd = game.playerData || {};
            const users = game.users || {};
            const others = Object.keys(pd).filter((id) => id && id !== game.host);
            others.sort((a, b) => {
                const ta = typeof users[a] === 'number' ? users[a] : Number.MAX_SAFE_INTEGER;
                const tb = typeof users[b] === 'number' ? users[b] : Number.MAX_SAFE_INTEGER;
                if (ta !== tb) return ta - tb;
                return a.localeCompare(b);
            });
            const idx = others.indexOf(myUid);
            return idx >= 0 ? `P${idx + 2}` : 'P2';
        }

        function loadRoomIntoIframe(frame) {
            if (!frame?.contentWindow || !ctx.roomId || ctx.roomId === 'lobby') {
                pushIframeIdentity(frame, 'P1', null);
                return;
            }

            Promise.all([
                global.NetworkEngine.db.ref(S.paths.room(ctx.roomId)).once('value'),
                global.NetworkEngine.db.ref(S.paths.legacyEvents(ctx.roomId)).once('value'),
                global.NetworkEngine.db.ref(S.paths.events(ctx.roomId)).once('value')
            ]).then(([gameSnap, legacyEvSnap, targetEvSnap]) => {
                const raw = gameSnap.val();
                const game = S.normalizeRoomSnapshot(raw);
                const legacyEv = legacyEvSnap.val();
                const targetEv = targetEvSnap.val();
                const evObj = targetEv || legacyEv;
                const events = evObj ? Object.values(evObj) : [];

                if (!game || !frame.contentWindow) return;

                const calculatedRole = resolvePartyRole(game);
                global.NetworkEngine.playerRole = calculatedRole;

                frame.contentWindow.postMessage({
                    type: H.NETWORK_EVENTS || 'network-events',
                    events
                }, '*');

                pushIframeIdentity(frame, calculatedRole, game);

                frame.contentWindow.postMessage({
                    type: H.NETWORK_UPDATE || 'network-update',
                    payload: game
                }, '*');
            });
        }

        global.HubMessageBridge.install({
            [L.TOGGLE_SETTINGS]: () => ctx.toggleSidebar(),
            [H.OPEN_SETTINGS_EDGE_SWIPE]: () => {
                ctx.toggleSidebar(true);
                global.muteHubOverlayDismiss(80);
            },
            [L.CLOSE_SETTINGS]: () => {
                ctx.toggleSidebar(false);
                global.ChatEngine.toggle(false);
            },
            [L.SWITCH_GAME]: () => {
                hubGames.cycleGame();
            },
            [L.CYCLE_MODE]: () => {
                hubGames.cycleMode();
            },
            [L.TOGGLE_CHAT]: () => global.ChatEngine.toggle(),
            [L.TOGGLE_COMMAND]: () => global.ChatEngine.toggle(true, '/'),
            [H.NETWORK_SEND]: (e) => global.NetworkEngine.send(e.data.path, e.data.payload),
            [H.NETWORK_SEND_EVENT]: (e) => {
                if (ctx.roomId && ctx.roomId !== 'lobby') {
                    const path = S.paths.legacyGlobalKey(ctx.roomId, 'stateVersion');
                    global.NetworkEngine.db.ref(path).transaction((current) => (current || 0) + 1);
                }
                global.NetworkEngine.sendEvent(e.data.event);
            },
            [H.NETWORK_UPDATE_ROOM]: (e) => {
                if (!ctx.roomId || !e.data?.updates) return;
                const multiUpdates = {};
                Object.entries(e.data.updates).forEach(([key, val]) => {
                    Object.assign(multiUpdates, S.expandRelativeWrites(ctx.roomId, key, val));
                });
                if (e.data.updates['global/resetCount'] !== undefined) {
                    // Wipe legacy gameData subtree (includes gameData/{id}/events).
                    multiUpdates[S.paths.legacyGameData(ctx.roomId)] = null;
                    multiUpdates[S.paths.events(ctx.roomId)] = null;
                }
                global.NetworkEngine.db.ref().update(multiUpdates);
            },
            [H.INIT_IDENTITY]: (e) => {
                const game = e.data?.game || ctx.currentGame;
                const mode = e.data?.mode || ctx.gameMode;
                const caps = global.GameRegistry?.getCapabilities(game, mode);
                if (!caps?.supportsTurnIndicator && hubGames.clearGlobalTurnIndicator) {
                    hubGames.clearGlobalTurnIndicator();
                }
            },
            [H.GAME_RENDERED]: () => {
                global.hideHubLoading();
                if (global.FivePhoneDebug) global.FivePhoneDebug.flush('game-rendered');
            },
            [H.GAME_RENDER_FAILED]: () => {
                global.setBootStatus('Game area has no size on phone — reload', false);
                const el = document.getElementById('hub-loading');
                if (el) {
                    el.classList.remove('hidden');
                    const title = el.querySelector('.hub-loading-title');
                    const hint = el.querySelector('.hub-loading-hint');
                    if (title) title.textContent = 'Display issue (0-size game area)';
                    if (hint) {
                        hint.textContent =
                            'iOS Safari iframe bug. Force-quit browser tab and reopen phone-check.html first.';
                    }
                }
                if (global.FivePhoneDebug) global.FivePhoneDebug.flush('game-render-failed');
            },
            [H.IFRAME_READY]: () => {
                global.setBootStatus('Game loading…');
                const frame = document.getElementById('game-frame');
                if (frame?.contentWindow) {
                    frame.contentWindow.postMessage({
                        type: H.UPDATE_THEME || 'update-theme',
                        color: ctx.userColor
                    }, '*');
                    if (ctx.roomId && ctx.roomId !== 'lobby') {
                        ctx.syncOpponentFromRoom(global.NetworkEngine?.roomData);
                    } else {
                        ctx.applySoloOpponentColor();
                    }
                    loadRoomIntoIframe(frame);
                }
                setTimeout(() => {
                    const loading = document.getElementById('hub-loading');
                    if (loading && !loading.classList.contains('hidden')) {
                        global.setBootStatus('Still waiting for game board…', false);
                        if (global.FivePhoneDebug) global.FivePhoneDebug.flush('hub-slow');
                    }
                }, 8000);
            },
            [H.TOGGLE_TURN_ALTERNATION]: () => ctx.toggleFirstPlayer(),
            [H.UPDATE_TURN]: (e) => {
                const indicator = document.getElementById('global-turn-indicator');
                const text = document.getElementById('turn-text');
                if (indicator && text) {
                    text.innerText = e.data.text;
                    indicator.style.color = e.data.color || 'white';
                    indicator.classList.toggle('visible', !!e.data.text);
                }
            },
            [H.UPDATE_WIN_BANNER]: (e) => ctx.showWinBanner(e.data),
            'post-game-blocking': (e) => {
                if (!e.data?.active || ctx.currentGame !== 'bananagrams') return;
                const banner = document.getElementById('global-win-banner');
                if (!banner?.classList.contains('visible')) return;
                ctx.adjustBananagramsWinBannerClearance?.(banner);
            }
        });
    }

    global.HubBridgeHandlers = { install };
})(typeof window !== 'undefined' ? window : global);
