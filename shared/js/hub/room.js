(function (global) {
    function attach(ctx, hubGames) {
        let dissolvingParty = false;
        let lastPartyMemberCount = null;

        function returnToLobbyCore(systemMessage) {
            const leaveBtn = document.getElementById('btn-leave-party');
            if (leaveBtn) leaveBtn.style.display = 'none';
            ctx.roomId = 'lobby';
            const url = new URL(window.location);
            url.searchParams.set('room', 'lobby');
            url.searchParams.delete('role');
            window.history.replaceState({}, '', url);
            global.NetworkEngine.joinRoom('lobby');
            global.NetworkEngine.playerRole = 'P1';
            ctx.lastPartyResetCount = null;
            partnerLeftHandled = false;
            ctx.applySoloOpponentColor();
            hubGames.updateFrame(document.getElementById('game-frame'), ctx.lastFrameGameRef);
            ctx.updateUI();
            startRoomHeartbeat();
            if (systemMessage) {
                global.ChatEngine.append({ sender: 'System', content: systemMessage });
            }
        }

        function dissolvePartyAndReturnToLobby(message) {
            if (dissolvingParty || !ctx.roomId || ctx.roomId === 'lobby') return;
            dissolvingParty = true;
            const roomId = ctx.roomId;
            global.NetworkEngine.terminatePartyRoom(roomId).finally(() => {
                returnToLobbyCore(message);
                dissolvingParty = false;
                lastPartyMemberCount = null;
            });
        }

        let partnerLeftHandled = false;

        function onPartnerLeftParty() {
            if (!ctx.roomId || ctx.roomId === 'lobby' || dissolvingParty || partnerLeftHandled) return;
            partnerLeftHandled = true;
            global.ChatEngine.append({
                sender: 'System',
                content: 'The other player left. Invite someone new or tap Leave Party.'
            });

            if (global.NetworkEngine.playerRole === 'P1' && global.NetworkEngine.isInitialized) {
                const rid = ctx.roomId;
                const S = global.RtdbSchema;
                global.NetworkEngine.db.ref().update({
                    [`${S.paths.room(rid)}/status`]: 'waiting',
                    [`${S.paths.room(rid)}/winner`]: null
                }).catch((err) => console.warn('[HUB] partner-left room patch failed', err));
            }
        }

        function syncRoomStateOnGameOrModeChange(gameId, mode) {
            if (!ctx.roomId || ctx.roomId === 'lobby' || global.NetworkEngine.playerRole !== 'P1') return;
            const prev = global.NetworkEngine.roomData?.global?.resetCount || 0;
            const updates = global.GameRegistry.buildHostGameSwitchUpdates(
                ctx.roomId, gameId, mode, prev + 1
            );
            console.log(`[HUB] Host changing game/mode atomically: game=${gameId}, mode=${mode}`);
            global.NetworkEngine.db.ref().update(updates);
        }

        ctx.syncRoomStateOnGameOrModeChange = syncRoomStateOnGameOrModeChange;

        /** Join party room in RTDB + hub UI (after invite accepted). */
        async function enterPartyRoom(roomId, options = {}) {
            const { role = 'P1', game, mode, skipJoin = false } = options;
            ctx.roomId = roomId;
            if (game) ctx.currentGame = game;
            if (mode) {
                ctx.gameMode = mode;
                localStorage.setItem(`${ctx.currentGame}_mode`, ctx.gameMode);
            }
            global.NetworkEngine.playerRole = role;

            const url = new URL(window.location);
            url.searchParams.set('room', roomId);
            url.searchParams.delete('role');
            window.history.pushState({}, '', url);

            if (!skipJoin) {
                const joinResult = await global.NetworkEngine.tryJoinRoom(roomId);
                if (!joinResult.ok) {
                    rejectRoomJoin(joinResult);
                    return false;
                }
            } else {
                global.NetworkEngine.joinRoom(roomId);
            }

            await global.NetworkEngine.registerPlayerInRoom(ctx.username, ctx.userColor);

            const S = global.RtdbSchema;
            const snap = await global.NetworkEngine.db.ref(S.paths.room(roomId)).once('value');
            const room = S.normalizeRoomSnapshot(snap.val());
            if (room) {
                global.NetworkEngine.roomData = room;
                ctx.syncOpponentFromRoom(room);
                const g = room.global || room.meta || {};
                ctx.lastPartyResetCount = g.resetCount || 0;
            }

            const memberCount = await global.NetworkEngine.fetchRoomMemberCount(roomId);
            lastPartyMemberCount = memberCount;
            if (memberCount >= global.NetworkEngine.ROOM_MAX_PLAYERS) {
                await global.NetworkEngine.db.ref(`${S.paths.room(roomId)}/status`).set('playing');
            }

            hubGames.updateFrame(document.getElementById('game-frame'), ctx.lastFrameGameRef);
            ctx.startRoomHeartbeat();
            ctx.updateUI();
            const leaveBtn = document.getElementById('btn-leave-party');
            if (leaveBtn) leaveBtn.style.display = 'block';
            ctx.setUserColor(ctx.userColor);
            return true;
        }
        ctx.enterPartyRoom = enterPartyRoom;

        function renderPlayers(otherPlayers = []) {
            const list = document.getElementById('player-list');
            if (!list) return;
            list.innerHTML = '';
            if (otherPlayers.length === 0) {
                list.innerHTML = '<div style="font-size: 0.7rem; color: rgba(255,255,255,0.2); text-align: center; padding: 10px;">No other players online</div>';
                return;
            }
            otherPlayers.forEach((p) => {
                const div = document.createElement('div');
                div.className = 'player-item';
                const label = p.sameNameAsMe ? `${p.name} (other tab)` : p.name;
                div.onclick = () => sendInvite(p.uid, p.name);
                div.innerHTML = `
                    <div class="player-status" style="background: ${p.color}; box-shadow: 0 0 8px ${p.color};"></div>
                    <span class="player-name">${label}</span>
                    ${p.active ? '<span class="player-badge">In Game</span>' : ''}
                `;
                list.appendChild(div);
            });
        }

        function rejectRoomJoin(check) {
            const msg = (check && check.reason) || 'This room is full (2 players max).';
            console.warn('[HUB]', msg);
            alert(msg);
            ctx.roomId = 'lobby';
            const url = new URL(window.location);
            url.searchParams.set('room', 'lobby');
            url.searchParams.delete('role');
            window.history.replaceState({}, '', url);
            global.NetworkEngine.joinRoom('lobby');
            global.NetworkEngine.playerRole = 'P1';
            ctx.applySoloOpponentColor();
            hubGames.updateFrame(document.getElementById('game-frame'), ctx.lastFrameGameRef);
            ctx.updateUI();
            startRoomHeartbeat();
        }

        function leaveParty() {
            if (!ctx.roomId || ctx.roomId === 'lobby') {
                global.ChatEngine.append({ sender: 'System', content: 'You are already in the lobby.' });
                return;
            }
            const leavingRoom = ctx.roomId;
            const uid = global.NetworkEngine.uid;
            const S = global.RtdbSchema;
            if (global.NetworkEngine.isInitialized && uid) {
                global.NetworkEngine.db.ref(S.paths.playerData(leavingRoom, uid)).remove();
                global.NetworkEngine.db.ref(S.paths.users(leavingRoom, uid)).remove();
            }
            global.NetworkEngine.evaluateRoomLifecycleAfterLeave(leavingRoom);
            returnToLobbyCore('You left the party and returned to the lobby.');
        }

        function sendInvite(uid, name) {
            const launch = async () => {
                let partyRoomId = ctx.roomId;
                const creatingFromLobby = !partyRoomId || partyRoomId === 'lobby';

                if (creatingFromLobby) {
                    partyRoomId = Math.random().toString(36).substring(2, 7).toUpperCase();
                    const prepared = await global.NetworkEngine.prepareInviteRoom(
                        partyRoomId, ctx.currentGame, ctx.gameMode
                    );
                    if (!prepared) return;
                    // Stay in lobby until the invitee accepts — no URL change or join yet.
                }

                global.NetworkEngine.sendInvite(
                    uid,
                    { game: ctx.currentGame, mode: ctx.gameMode, roomId: partyRoomId },
                    async (acceptedRoomId) => {
                        await enterPartyRoom(acceptedRoomId, {
                            role: 'P1',
                            game: ctx.currentGame,
                            mode: ctx.gameMode,
                            skipJoin: true
                        });
                    }
                );
            };

            if (!ctx.roomId || ctx.roomId === 'lobby') {
                launch();
                return;
            }

            global.NetworkEngine.fetchRoomMemberCount(ctx.roomId).then((count) => {
                if (count >= global.NetworkEngine.ROOM_MAX_PLAYERS) {
                    alert('Your party is full (2 players max).');
                    return;
                }
                launch();
            });
        }

        function startRoomHeartbeat() {
            global.ChatEngine.clear();
            global.NetworkEngine.listenForChat(ctx.appendChatMessage, ctx.roomId || 'lobby');

            if (!ctx.roomId || ctx.roomId === 'lobby') {
                ctx.applySoloOpponentColor();
                ctx.updateUI();
                return;
            }

            const H = global.HubProtocol?.MSG || {};
            global.NetworkEngine.on('global', (data) => {
                if (!data || global.NetworkEngine.playerRole === 'P1') return;
                const reset = data.resetCount;
                const prevGame = ctx.currentGame;
                const prevMode = ctx.gameMode;
                let reload = false;
                if (reset != null && reset !== ctx.lastPartyResetCount) {
                    ctx.lastPartyResetCount = reset;
                    if (data.game) ctx.currentGame = data.game;
                    if (data.mode) ctx.gameMode = data.mode;
                    // Rematch only bumps resetCount — engine clears the board in-place; do not reload iframe.
                    reload =
                        (data.game && data.game !== prevGame)
                        || (data.mode && data.mode !== prevMode);
                } else {
                    if (data.game && data.game !== ctx.currentGame) {
                        ctx.currentGame = data.game;
                        reload = true;
                    }
                    if (data.mode && data.mode !== ctx.gameMode) {
                        ctx.gameMode = data.mode;
                        reload = true;
                    }
                }
                if (reload) {
                    localStorage.setItem(`${ctx.currentGame}_mode`, ctx.gameMode);
                    ctx.lastFrameGameRef.current = null;
                    ctx.lastFrameGameRef.mode = null;
                    hubGames.updateFrame(document.getElementById('game-frame'), ctx.lastFrameGameRef);
                    ctx.updateUI();
                }
            });

            global.NetworkEngine.on('interactions', (data) => {
                const frame = document.getElementById('game-frame');
                if (frame?.contentWindow) {
                    frame.contentWindow.postMessage({
                        type: H.NETWORK_UPDATE || 'network-update',
                        payload: { interactions: data }
                    }, '*');
                }
            });

            global.NetworkEngine.on('previews', (data) => {
                const frame = document.getElementById('game-frame');
                if (frame?.contentWindow) {
                    frame.contentWindow.postMessage({
                        type: H.NETWORK_UPDATE || 'network-update',
                        payload: { previews: data }
                    }, '*');
                }
            });

            global.NetworkEngine.on('', (data) => {
                if (data) global.NetworkEngine.roomData = data;
                const count = data ? global.NetworkEngine.countRoomMembers(data) : 0;
                if (data && count === 0 && ctx.roomId && ctx.roomId !== 'lobby') {
                    dissolvePartyAndReturnToLobby('Party room closed.');
                    return;
                }
                if (
                    data
                    && ctx.roomId
                    && ctx.roomId !== 'lobby'
                    && lastPartyMemberCount != null
                    && lastPartyMemberCount >= 2
                    && count === 1
                ) {
                    onPartnerLeftParty();
                }
                if (data) lastPartyMemberCount = count;
                const frame = document.getElementById('game-frame');
                if (frame?.contentWindow) {
                    frame.contentWindow.postMessage({
                        type: H.NETWORK_UPDATE || 'network-update',
                        payload: data
                    }, '*');
                }
                ctx.syncOpponentFromRoom(data);
            });
        }

        async function joinBootstrap() {
            if (ctx.roomId && ctx.roomId !== 'lobby') {
                const result = await global.NetworkEngine.tryJoinRoom(ctx.roomId);
                if (!result.ok) {
                    rejectRoomJoin(result);
                    return;
                }
                const S = global.RtdbSchema;
                const snap = await global.NetworkEngine.db.ref(S.paths.room(ctx.roomId)).once('value');
                const room = S.normalizeRoomSnapshot(snap.val());
                const g = room?.global || room?.meta || {};
                if (g.game) ctx.currentGame = g.game;
                if (g.mode) {
                    ctx.gameMode = g.mode;
                    localStorage.setItem(`${ctx.currentGame}_mode`, ctx.gameMode);
                }
                if (room) {
                    global.NetworkEngine.roomData = room;
                    ctx.syncOpponentFromRoom(room);
                    const g = room.global || room.meta || {};
                    ctx.lastPartyResetCount = g.resetCount || 0;
                }
            } else {
                global.NetworkEngine.joinRoom(ctx.roomId);
            }

            if (ctx.roomId === 'lobby') {
                global.NetworkEngine.playerRole = 'P1';
                global.NetworkEngine.updatePresence();
                ctx.applySoloOpponentColor();
                const banner = document.getElementById('global-win-banner');
                if (banner) banner.classList.remove('visible');
            }

            global.window.onNetworkUpdate = () => ctx.updateUI();
            startRoomHeartbeat();
            ctx.setUserColor(ctx.userColor);
            hubGames.updateFrame(document.getElementById('game-frame'), ctx.lastFrameGameRef);
            ctx.updateUI();

            if (localStorage.getItem('settingsOpen') === 'true') {
                ctx.toggleSidebar(true);
            }
        }

        global.onRoomJoinRejected = rejectRoomJoin;
        ctx.renderPlayers = renderPlayers;
        ctx.sendInvite = sendInvite;
        ctx.leaveParty = leaveParty;
        ctx.startRoomHeartbeat = startRoomHeartbeat;
        ctx.joinBootstrap = joinBootstrap;
    }

    global.HubRoom = { attach };
})(typeof window !== 'undefined' ? window : global);
