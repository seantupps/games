(function (global) {
    function attach(ctx, hubGames) {
        let dissolvingParty = false;
        let lastPartyMemberCount = null;
        /** Room prepared from lobby while host waits for first accept — reuse for later invites. */
        let pendingInviteRoomId = null;

        function partyDbg(tag, detail = {}) {
            try {
                if (localStorage.getItem('five_party_dbg') !== '1'
                    && !new URLSearchParams(window.location.search).has('partyDbg')) {
                    return;
                }
            } catch (_) { return; }
            const ne = global.NetworkEngine;
            console.log('[PARTY-DBG]', tag, {
                ctxRoom: ctx.roomId,
                neRoom: ne?.roomId,
                uid: ne?.uid,
                role: ne?.playerRole,
                dissolving: dissolvingParty,
                status: ne?.roomData?.status ?? null,
                host: ne?.roomData?.host ?? null,
                ...detail
            });
        }

        function returnToLobbyCore(systemMessage) {
            partyDbg('returnToLobbyCore', { message: systemMessage });
            ctx._lastHubWinBannerUid = null;
            if (typeof ctx.showWinBanner === 'function') {
                ctx.showWinBanner({ visible: false });
            }
            const leaveBtn = document.getElementById('btn-leave-party');
            if (leaveBtn) leaveBtn.style.display = 'none';
            ctx.roomId = 'lobby';
            pendingInviteRoomId = null;
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

        function dissolvePartyAndReturnToLobby(message, options = {}) {
            if (dissolvingParty || !ctx.roomId || ctx.roomId === 'lobby') {
                partyDbg('dissolveParty skipped', {
                    message,
                    reason: dissolvingParty ? 'dissolving' : (!ctx.roomId ? 'no-ctx-room' : 'already-lobby')
                });
                return;
            }
            dissolvingParty = true;
            const roomId = ctx.roomId;
            partyDbg('dissolveParty start', { message, roomId, skipTerminate: !!options.skipTerminate });
            if (!options.skipTerminate) {
                global.NetworkEngine.terminatePartyRoom(roomId);
            }
            returnToLobbyCore(message);
            dissolvingParty = false;
            lastPartyMemberCount = null;
            partyDbg('dissolveParty done', { neRoom: global.NetworkEngine?.roomId });
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
        function partyGameMode(gameId, mode) {
            const reg = global.GameRegistry;
            if (reg?.usesHubModeSwitch?.(gameId)) return reg.hubModeFor(gameId, true);
            return mode || ctx.gameMode;
        }

        async function enterPartyRoom(roomId, options = {}) {
            const { role = 'P1', game, mode, skipJoin = false } = options;
            pendingInviteRoomId = null;
            ctx.roomId = roomId;
            if (game) ctx.currentGame = game;
            const resolvedMode = partyGameMode(ctx.currentGame, mode);
            ctx.gameMode = resolvedMode;
            localStorage.setItem(`${ctx.currentGame}_mode`, ctx.gameMode);
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
            if (memberCount >= 2) {
                await global.NetworkEngine.db.ref(`${S.paths.room(roomId)}/status`).set('playing');
            }
            if (typeof ctx.setPartyMemberCount === 'function') ctx.setPartyMemberCount(memberCount);

            hubGames.updateFrame(document.getElementById('game-frame'), ctx.lastFrameGameRef);
            ctx.startRoomHeartbeat();
            ctx.updateUI();
            if (hubGames.syncLeavePartyButton) hubGames.syncLeavePartyButton();
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
            const max = global.NetworkEngine.ROOM_MAX_PLAYERS;
            const msg = (check && check.reason) || `This room is full (${max} players max).`;
            console.warn('[HUB]', msg);
            alert(msg);
            ctx.roomId = 'lobby';
            pendingInviteRoomId = null;
            const url = new URL(window.location);
            url.searchParams.set('room', 'lobby');
            url.searchParams.delete('role');
            window.history.replaceState({}, '', url);
            global.NetworkEngine.joinRoom('lobby');
            global.NetworkEngine.playerRole = 'P1';
            ctx.applySoloOpponentColor();
            hubGames.updateFrame(document.getElementById('game-frame'), ctx.lastFrameGameRef);
            ctx.updateUI();
            if (hubGames.syncLeavePartyButton) hubGames.syncLeavePartyButton();
            startRoomHeartbeat();
        }

        async function leaveParty() {
            if (!ctx.roomId || ctx.roomId === 'lobby') {
                global.ChatEngine.append({ sender: 'System', content: 'You are already in the lobby.' });
                return;
            }
            const leavingRoom = ctx.roomId;
            const uid = global.NetworkEngine.uid;
            const hostUid = global.NetworkEngine.roomData?.host || '';
            const isHost = uid && (uid === hostUid || global.NetworkEngine.playerRole === 'P1');
            partyDbg('leaveParty', { leavingRoom, uid, hostUid, isHost, role: global.NetworkEngine.playerRole });

            if (isHost) {
                const S = global.RtdbSchema;
                const updates = {
                    [`${S.paths.room(leavingRoom)}/status`]: 'dissolved'
                };
                if (uid) {
                    updates[S.paths.playerData(leavingRoom, uid)] = null;
                    updates[S.paths.users(leavingRoom, uid)] = null;
                }
                partyDbg('host leave RTDB update', { updates: Object.keys(updates) });
                try {
                    await global.NetworkEngine.db.ref().update(updates);
                } catch (err) {
                    console.warn('[HUB] host leave dissolve update failed', err);
                    partyDbg('host leave RTDB update failed', { err: String(err) });
                }
                dissolvePartyAndReturnToLobby('The host left the party.', { skipTerminate: true });
                return;
            }

            const S = global.RtdbSchema;
            if (global.NetworkEngine.isInitialized && uid) {
                await Promise.all([
                    global.NetworkEngine.db.ref(S.paths.playerData(leavingRoom, uid)).remove(),
                    global.NetworkEngine.db.ref(S.paths.users(leavingRoom, uid)).remove()
                ]);
            }
            await global.NetworkEngine.evaluateRoomLifecycleAfterLeave(leavingRoom);
            returnToLobbyCore('You left the party and returned to the lobby.');
        }

        function sendInvite(uid, name) {
            const launch = async () => {
                let partyRoomId = ctx.roomId;
                const creatingFromLobby = !partyRoomId || partyRoomId === 'lobby';
                const inviteMode = partyGameMode(ctx.currentGame, ctx.gameMode);

                if (creatingFromLobby) {
                    // Host can invite multiple people before anyone accepts — one room only.
                    if (pendingInviteRoomId) {
                        partyRoomId = pendingInviteRoomId;
                    } else {
                        partyRoomId = Math.random().toString(36).substring(2, 7).toUpperCase();
                        // Reserve immediately so a second invite while prepare is in-flight reuses this room.
                        pendingInviteRoomId = partyRoomId;
                        const prepared = await global.NetworkEngine.prepareInviteRoom(
                            partyRoomId, ctx.currentGame, inviteMode
                        );
                        if (!prepared) {
                            pendingInviteRoomId = null;
                            return;
                        }
                    }
                    // Stay in lobby until the first invitee accepts — no URL change or join yet.
                }

                global.NetworkEngine.sendInvite(
                    uid,
                    { game: ctx.currentGame, mode: inviteMode, roomId: partyRoomId },
                    async (acceptedRoomId) => {
                        pendingInviteRoomId = null;
                        await enterPartyRoom(acceptedRoomId, {
                            role: 'P1',
                            game: ctx.currentGame,
                            mode: inviteMode,
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
                    alert(`Your party is full (${global.NetworkEngine.ROOM_MAX_PLAYERS} players max).`);
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
                if (hubGames.syncLeavePartyButton) hubGames.syncLeavePartyButton();
                return;
            }

            if (hubGames.syncLeavePartyButton) hubGames.syncLeavePartyButton();

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
                const S = global.RtdbSchema;
                const room = data && S ? S.normalizeRoomSnapshot(data) : data;
                if (room) global.NetworkEngine.roomData = room;
                const count = room ? global.NetworkEngine.countRoomMembers(room) : 0;
                const hostUid = room?.host || '';
                const hostPresent = hostUid && room?.playerData?.[hostUid];
                if (ctx.roomId && ctx.roomId !== 'lobby' && !dissolvingParty) {
                    if (room?.status === 'dissolved') {
                        partyDbg('room listener: dissolved status');
                        dissolvePartyAndReturnToLobby('Party room closed.');
                        return;
                    }
                    if (!room || count === 0) {
                        if (lastPartyMemberCount == null) {
                            partyDbg('room listener: empty room during bootstrap', { count, hasRoom: !!room });
                            return;
                        }
                        partyDbg('room listener: empty room', { count, hasRoom: !!room });
                        dissolvePartyAndReturnToLobby('Party room closed.');
                        return;
                    }
                    if (hostUid && !hostPresent) {
                        partyDbg('room listener: host absent', { hostUid, hostPresent: !!hostPresent });
                        dissolvePartyAndReturnToLobby('The host left the party.');
                        return;
                    }
                }
                if (
                    room
                    && ctx.roomId
                    && ctx.roomId !== 'lobby'
                    && lastPartyMemberCount != null
                    && lastPartyMemberCount >= 2
                    && count === 1
                ) {
                    onPartnerLeftParty();
                }
                if (room) lastPartyMemberCount = count;
                if (typeof ctx.setPartyMemberCount === 'function') ctx.setPartyMemberCount(count);
                const frame = document.getElementById('game-frame');
                if (frame?.contentWindow) {
                    frame.contentWindow.postMessage({
                        type: H.NETWORK_UPDATE || 'network-update',
                        payload: room
                    }, '*');
                }
                ctx.syncOpponentFromRoom(room);
            });
        }

        async function joinBootstrap() {
            window.onPartyRoomClosed = (closedId) => {
                partyDbg('onPartyRoomClosed', { closedId });
                if (dissolvingParty || !ctx.roomId || ctx.roomId === 'lobby') {
                    partyDbg('onPartyRoomClosed ignored', {
                        dissolvingParty,
                        ctxRoom: ctx.roomId,
                        reason: dissolvingParty ? 'dissolving' : (!ctx.roomId ? 'no-ctx' : 'lobby')
                    });
                    return;
                }
                if (closedId === ctx.roomId) {
                    partyDbg('onPartyRoomClosed -> dissolve');
                    dissolvePartyAndReturnToLobby('Party room closed.');
                } else {
                    partyDbg('onPartyRoomClosed id mismatch', { closedId, ctxRoom: ctx.roomId });
                }
            };

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
                ctx.gameMode = partyGameMode(ctx.currentGame, g.mode);
                localStorage.setItem(`${ctx.currentGame}_mode`, ctx.gameMode);
                if (room) {
                    global.NetworkEngine.roomData = room;
                    ctx.syncOpponentFromRoom(room);
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
            if (hubGames.syncLeavePartyButton) hubGames.syncLeavePartyButton();

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
