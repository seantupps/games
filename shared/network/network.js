window.NetworkEngine = {
    config: null,
    firebaseTarget: 'production',
    roomId: null,
    db: null,
    uid: null,
    playerRole: 'P1', // Default
    isInitialized: false,
    ROOM_MAX_PLAYERS: 8,
    PRESENCE_HEARTBEAT_MS: 30000,

    _schema() {
        return typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
    },

    _roomPath(roomId) {
        const S = this._schema();
        return S ? S.paths.room(roomId) : `games/${roomId}`;
    },

    _normalizeRoom(raw) {
        const S = this._schema();
        return S ? S.normalizeRoomSnapshot(raw) : raw;
    },

    _partyRoleForUid(room, uid) {
        if (!room || !uid) return 'P1';
        if (room.host === uid) return 'P1';

        const gameId = room?.global?.game || room?.meta?.game || '';
        const Registry = typeof GameRegistry !== 'undefined' ? GameRegistry : null;
        const partyMode = Registry?.hubModeFor(gameId, true) || 'classic';
        if (!Registry?.hasCapability(gameId, 'flexiblePlayerRoles', partyMode)) return 'P2';

        const pd = room.playerData || {};
        const users = room.users || {};
        const others = Object.keys(pd).filter((id) => id && id !== room.host);
        others.sort((a, b) => {
            const ta = typeof users[a] === 'number' ? users[a] : Number.MAX_SAFE_INTEGER;
            const tb = typeof users[b] === 'number' ? users[b] : Number.MAX_SAFE_INTEGER;
            if (ta !== tb) return ta - tb;
            return a.localeCompare(b);
        });
        const idx = others.indexOf(uid);
        return idx >= 0 ? `P${idx + 2}` : 'P2';
    },

    _presenceTiming() {
        const url = this.config?.databaseURL || '';
        const emulator = this.firebaseTarget === 'emulator'
            || url.includes('127.0.0.1') || url.includes('localhost');
        return emulator
            ? { activeMs: 45000, pruneMs: 90000 }
            : { activeMs: 90000, pruneMs: 600000 };
    },

    resolveLastSeen(entry) {
        const ls = entry?.lastSeen;
        return typeof ls === 'number' && Number.isFinite(ls) ? ls : null;
    },

    /** Lobby list: only tabs that heartbeated recently (not dead Playwright/emulator rows). */
    isPresenceActive(entry, now = Date.now()) {
        const ls = this.resolveLastSeen(entry);
        if (ls == null) return false;
        return now - ls <= this._presenceTiming().activeMs;
    },

    isPresenceStale(entry, now = Date.now()) {
        const ls = this.resolveLastSeen(entry);
        if (ls == null) return true;
        return now - ls > this._presenceTiming().pruneMs;
    },

    /**
     * True when the party room row should be deleted entirely (no members left).
     * One player remaining after a partner leaves is NOT a dissolve — they can re-invite.
     */
    shouldDissolveSoloParty(room) {
        if (!room) return false;
        return this.countRoomMembers(room) === 0;
    },

    terminatePartyRoom(roomId) {
        if (!this.init() || !roomId || roomId === 'lobby') return Promise.resolve();
        return this.db.ref(`games/${roomId}/status`).set('dissolved');
    },

    async evaluateRoomLifecycleAfterLeave(roomId) {
        if (!this.init() || !roomId || roomId === 'lobby') return;
        const snap = await this.db.ref(this._roomPath(roomId)).once('value');
        const room = snap.val();
        if (!room || this.countRoomMembers(room) === 0 || this.shouldDissolveSoloParty(room)) {
            await this.terminatePartyRoom(roomId);
        }
    },

    /** Active party size — playerData is authoritative; users/host only during bootstrap. */
    countRoomMembers(room) {
        if (!room) return 0;
        const pd = room.playerData || {};
        const fromPlayerData = Object.keys(pd).filter(
            (id) => pd[id] != null && typeof pd[id] === 'object'
        );
        if (fromPlayerData.length > 0) return fromPlayerData.length;

        const ids = new Set();
        if (room.host) ids.add(room.host);
        Object.keys(room.users || {}).forEach((id) => ids.add(id));
        return ids.size;
    },

    isRoomMember(room, uid) {
        if (!room || !uid) return false;
        if (room.playerData && room.playerData[uid]) return true;
        if (room.host === uid) return true;
        if (room.users && room.users[uid]) return true;
        return false;
    },

    async fetchRoomMemberCount(roomId) {
        if (!roomId || roomId === 'lobby' || !this.init()) return 0;
        const snap = await this.db.ref(this._roomPath(roomId)).once('value');
        return this.countRoomMembers(snap.val());
    },

    async assertCanJoinRoom(roomId) {
        if (!this.init()) return { ok: false, reason: 'Network not initialized' };
        if (!roomId || roomId === 'lobby') return { ok: true };

        const snap = await this.db.ref(this._roomPath(roomId)).once('value');
        const room = snap.val();
        if (!room) return { ok: true }; // New room — first writers create it

        if (this.isRoomMember(room, this.uid)) return { ok: true };

        if (this.countRoomMembers(room) >= this.ROOM_MAX_PLAYERS) {
            return { ok: false, reason: `This room is full (${this.ROOM_MAX_PLAYERS} players max).` };
        }
        return { ok: true };
    },

    async tryJoinRoom(id) {
        if (id === 'lobby') {
            this.joinRoom(id);
            return { ok: true };
        }
        const check = await this.assertCanJoinRoom(id);
        if (!check.ok) return check;
        this.joinRoom(id);
        return { ok: true };
    },

    registerPlayerInRoom(name, color) {
        if (!this.isInitialized || !this.roomId || this.roomId === 'lobby') return Promise.resolve(true);
        return this.assertCanJoinRoom(this.roomId).then((check) => {
            if (!check.ok) {
                console.warn('[Network] Player registration blocked:', check.reason);
                return false;
            }
            const S = this._schema();
            const pd = S ? S.paths.playerData(this.roomId, this.uid) : `games/${this.roomId}/playerData/${this.uid}`;
            return this.db.ref(pd).update({ name, color }).then(() => true);
        });
    },

    init() {
        if (this.isInitialized) return true;
        if (!window.firebase) { console.error("Firebase missing"); return false; }
        if (!window.FiveFirebaseEnv) {
            console.error("FiveFirebaseEnv missing — load shared/network/firebase-env.js before network.js");
            return false;
        }

        const runtime = window.FiveFirebaseEnv.getFirebaseRuntime();
        this.firebaseTarget = runtime.target;
        this.config = runtime.config;

        if (!firebase.apps.length) {
            firebase.initializeApp(this.config);
        }
        this.db = firebase.database();
        if (runtime.useEmulator) {
            this.db.useEmulator(runtime.emulatorHost, runtime.emulatorDatabasePort);
            console.log(`[Network] Firebase RTDB emulator: ${runtime.emulatorHost}:${runtime.emulatorDatabasePort} (${this.firebaseTarget})`);
        } else {
            console.log(`[Network] Firebase RTDB: ${this.firebaseTarget} (${this.config.databaseURL})`);
        }

        if (typeof DeviceStorage !== 'undefined') {
            this.uid = DeviceStorage.getOrCreateUid();
        } else {
            this.uid = localStorage.getItem('game_uid') || sessionStorage.getItem('game_uid');
            if (!this.uid) {
                this.uid = 'u' + Math.random().toString(36).substring(2, 9);
                try { localStorage.setItem('game_uid', this.uid); } catch (_) { /* ignore */ }
                sessionStorage.setItem('game_uid', this.uid);
            } else {
                try { localStorage.setItem('game_uid', this.uid); } catch (_) { /* ignore */ }
                sessionStorage.setItem('game_uid', this.uid);
            }
        }

        this.isInitialized = true;
        this.initPresence();
        return true;
    },

    getUid() {
        return this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
    },

    _usesRtdbTunnel() {
        return !!(window.FiveFirebaseEnv?.getFirebaseRuntime?.().rtdbTunnelUrl);
    },

    _restParts() {
        const base = this.config?.databaseURL || '';
        const q = base.includes('?') ? base.slice(base.indexOf('?')) : '';
        const root = base.split('?')[0].replace(/\/$/, '');
        return { root, q };
    },

    async _restGet(path) {
        const { root, q } = this._restParts();
        const r = await fetch(`${root}/${path}.json${q}`);
        if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
        const text = await r.text();
        if (!text || text === 'null') return null;
        return JSON.parse(text);
    },

    async _restSet(path, data) {
        const { root, q } = this._restParts();
        const r = await fetch(`${root}/${path}.json${q}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!r.ok) throw new Error(`PUT ${path} ${r.status}`);
    },

    async _restRemove(path) {
        const { root, q } = this._restParts();
        const r = await fetch(`${root}/${path}.json${q}`, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error(`DELETE ${path} ${r.status}`);
    },

    clearPresence() {
        return this._removePresenceRow();
    },

    _removePresenceRow() {
        if (!this.isInitialized || !this.uid) return Promise.resolve();
        if (this._presenceHeartbeat) {
            clearInterval(this._presenceHeartbeat);
            this._presenceHeartbeat = null;
        }
        if (this._usesRtdbTunnel()) {
            return this._restRemove(`presence/${this.uid}`).catch((err) => {
                console.warn('[Network] Presence remove failed (tunnel):', err?.message || err);
            });
        }
        return this.db.ref(`presence/${this.uid}`).remove().catch((err) => {
            console.warn('[Network] Presence remove failed:', err?.message || err);
        });
    },

    async _restPost(path, data) {
        const { root, q } = this._restParts();
        const r = await fetch(`${root}/${path}.json${q}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!r.ok) throw new Error(`POST ${path} ${r.status}`);
    },

    _clearPresencePoll() {
        if (this._presencePoll) {
            clearInterval(this._presencePoll);
            this._presencePoll = null;
        }
    },

    _otherPlayersFromMap(players) {
        const myName = sessionStorage.getItem('username') || localStorage.getItem('username') || '';
        const now = Date.now();
        return Object.keys(players || {})
            .filter((id) => {
                if (id === this.uid) return false;
                const entry = players[id];
                if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) return false;
                return this.isPresenceActive(entry, now);
            })
            .map((id) => {
                const entry = players[id];
                return {
                    uid: id,
                    ...entry,
                    sameNameAsMe: !!(myName && entry.name === myName)
                };
            });
    },

    initPresence() {
        const presenceRef = this.db.ref(`.info/connected`);
        const userRef = this.db.ref(`presence/${this.uid}`);

        if (this._presenceHeartbeat) clearInterval(this._presenceHeartbeat);
        this._presenceHeartbeat = setInterval(() => this.updatePresence(), this.PRESENCE_HEARTBEAT_MS);

        if (!this._presenceVisibilityBound && typeof document !== 'undefined') {
            this._presenceVisibilityBound = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    this.updatePresence();
                    this.pruneStalePresence();
                }
            });
        }

        if (!this._presenceUnloadBound && typeof window !== 'undefined') {
            this._presenceUnloadBound = true;
            const leave = () => { this._removePresenceRow(); };
            window.addEventListener('pagehide', leave);
            window.addEventListener('beforeunload', leave);
        }

        if (this._presencePruneTimer) clearInterval(this._presencePruneTimer);
        this._presencePruneTimer = setInterval(() => this.pruneStalePresence(), 30000);

        presenceRef.on('value', (snap) => {
            if (snap.val() === true) {
                if (!this._usesRtdbTunnel()) {
                    userRef.onDisconnect().remove();
                }
                this.updatePresence();
                this.pruneStalePresence();
            }
        });
    },

    pruneStalePresence() {
        if (!this.isInitialized) return;
        const now = Date.now();
        this.db.ref('presence').once('value').then((snap) => {
            const players = snap.val() || {};
            const updates = {};
            Object.keys(players).forEach((id) => {
                if (id === this.uid) return;
                if (this.isPresenceStale(players[id], now)) {
                    updates[id] = null;
                }
            });
            if (Object.keys(updates).length > 0) {
                return this.db.ref('presence').update(updates);
            }
        }).catch((err) => {
            console.warn('[Network] Stale presence cleanup failed:', err?.message || err);
        });
    },

    updatePresence() {
        if (!this.isInitialized) return;
        const name = sessionStorage.getItem('username') || localStorage.getItem('username') || 'Guest';
        const color = sessionStorage.getItem('userColor') || localStorage.getItem('userColor') || '#3b82f6';
        const payload = { name, color, lastSeen: Date.now() };
        if (this._usesRtdbTunnel()) {
            this._restSet(`presence/${this.uid}`, payload).catch((err) => {
                console.warn('[Network] Presence update failed (tunnel):', err.message);
            });
            return;
        }
        this.db.ref(`presence/${this.uid}`).set({
            name, color,
            lastSeen: firebase.database.ServerValue.TIMESTAMP
        }).catch((err) => {
            console.warn('[Network] Presence update failed:', err.message);
        });
    },

    listenForPlayers(callback) {
        if (!this.init()) return;
        this._clearPresencePoll();
        if (this._usesRtdbTunnel()) {
            const poll = () => {
                this._restGet('presence')
                    .then((players) => callback(this._otherPlayersFromMap(players)))
                    .catch((err) => {
                        console.warn('[Network] Presence poll failed (tunnel):', err?.message || err);
                    });
            };
            poll();
            this._presencePoll = setInterval(poll, 1200);
            return;
        }
        this.db.ref('presence').on('value', (snap) => {
            callback(this._otherPlayersFromMap(snap.val()));
        }, (err) => {
            console.warn('[Network] Presence listen failed (check database rules):', err?.message || err);
        });
    },

    prepareInviteRoom(roomId, game, mode) {
        if (!this.init()) return Promise.resolve(false);
        const name = sessionStorage.getItem('username')
            || localStorage.getItem('username')
            || 'Guest';
        const color = sessionStorage.getItem('userColor')
            || localStorage.getItem('userColor')
            || '#3b82f6';
        const S = this._schema();
        const base = this._roomPath(roomId);
        const updates = {
            [`${base}/host`]: this.uid,
            [`${base}/status`]: 'waiting',
            [`${base}/winner`]: null,
            [`${base}/users/${this.uid}`]: firebase.database.ServerValue.TIMESTAMP,
            [`${base}/playerData/${this.uid}`]: { name, color },
            [`${base}/lastMove`]: null,
            [`${base}/interactions`]: null,
            [`${base}/previews`]: null
        };
        if (S) {
            updates[S.paths.metaKey(roomId, 'game')] = game;
            updates[S.paths.metaKey(roomId, 'mode')] = mode;
            updates[S.paths.metaKey(roomId, 'resetCount')] = 1;
            updates[S.paths.metaKey(roomId, 'turn')] = 'P1';
            updates[S.paths.metaKey(roomId, 'firstPlayer')] = 'P1';
            updates[S.paths.legacyGlobalKey(roomId, 'game')] = game;
            updates[S.paths.legacyGlobalKey(roomId, 'mode')] = mode;
            updates[S.paths.legacyGlobalKey(roomId, 'resetCount')] = 1;
            updates[S.paths.legacyGlobalKey(roomId, 'turn')] = 'P1';
            updates[S.paths.legacyGlobalKey(roomId, 'firstPlayer')] = 'P1';
            updates[S.paths.legacyGlobalKey(roomId, 'board')] = null;
            updates[S.paths.state(roomId)] = null;
            updates[S.paths.events(roomId)] = null;
            updates[S.paths.legacyGameData(roomId)] = null;
        } else {
            updates[`${base}/global`] = { game, mode, resetCount: 1, turn: 'P1', firstPlayer: 'P1', board: null };
        }
        return this.db.ref().update(updates).then(() => true).catch((err) => {
            console.error('[Network] prepareInviteRoom failed', err);
            return false;
        });
    },

    sendInvite(targetUid, gameData, onAccept) {
        if (!this.init()) return;
        const inviteRef = this.db.ref(`invites/${targetUid}/${this.uid}`);
        const fromName = sessionStorage.getItem('username')
            || localStorage.getItem('username')
            || 'Guest';
        const payload = {
            fromName,
            fromUid: this.uid,
            game: gameData.game,
            mode: gameData.mode,
            status: 'pending',
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };
        if (gameData.roomId) payload.roomId = gameData.roomId;
        inviteRef.set(payload);

        // Listen for internal acceptance
        inviteRef.on('value', (snap) => {
            const data = snap.val();
            if (data && data.status === 'accepted') {
                this.tryJoinRoom(data.roomId).then((result) => {
                    if (!result.ok) {
                        if (window.onRoomJoinRejected) window.onRoomJoinRejected(result);
                        return;
                    }
                    if (onAccept) onAccept(data.roomId);
                    inviteRef.remove();
                });
            }
        });
    },

    listenForInvites(callback) {
        if (!this.init()) return;
        const handler = (snap) => {
            const invite = snap.val();
            if (invite && invite.status === 'pending') {
                callback(invite);
            }
        };
        this.db.ref(`invites/${this.uid}`).on('child_added', handler);
        this.db.ref(`invites/${this.uid}`).on('child_changed', handler);
    },

    acceptInvite(senderUid, roomId) {
        if (!this.init()) return Promise.resolve({ ok: false, reason: 'Network not initialized' });
        return this.assertCanJoinRoom(roomId).then((check) => {
            if (!check.ok) {
                console.warn('[Network] Invite accept blocked:', check.reason);
                if (window.onRoomJoinRejected) window.onRoomJoinRejected(check);
                return check;
            }
            const name = sessionStorage.getItem('username')
                || localStorage.getItem('username')
                || 'Guest';
            const color = sessionStorage.getItem('userColor')
                || localStorage.getItem('userColor')
                || '#ef4444';
            return this.db.ref(`games/${roomId}`).once('value').then((snap) => {
                const room = snap.val();
                const updates = {};
                updates[`games/${roomId}/host`] = senderUid;
                updates[`games/${roomId}/winner`] = null;
                // Do not downgrade an in-progress party when a late guest accepts.
                const keepPlaying = room?.status === 'playing'
                    && this.countRoomMembers(room) >= 1;
                if (!keepPlaying) {
                    updates[`games/${roomId}/status`] = 'waiting';
                }
                updates[`games/${roomId}/users/${this.uid}`] = firebase.database.ServerValue.TIMESTAMP;
                updates[`games/${roomId}/playerData/${this.uid}`] = { name, color };
                updates[`invites/${this.uid}/${senderUid}/status`] = 'accepted';
                updates[`invites/${this.uid}/${senderUid}/roomId`] = roomId;

                return this.db.ref().update(updates).then(() => {
                    this.joinRoom(roomId);
                    return { ok: true };
                });
            });
        });
    },

    declineInvite(senderUid) {
        if (!this.init()) return;
        this.db.ref(`invites/${this.uid}/${senderUid}`).remove();
    },

    _trackRoomSubscription(ref, eventType, callback) {
        if (!this._roomSubscriptions) this._roomSubscriptions = [];
        this._roomSubscriptions.push({ ref, eventType, callback });
        ref.on(eventType, callback);
    },

    _clearRoomSubscriptions() {
        if (this._roomSubscriptions) {
            this._roomSubscriptions.forEach(({ ref, eventType, callback }) => {
                try {
                    ref.off(eventType, callback);
                } catch (e) {
                    console.error("Error tearing down listener", e);
                }
            });
            this._roomSubscriptions = [];
        }
    },

    joinRoom(id) {
        if (!this.init()) return;
        
        // Clear all previous room-specific subscriptions cleanly
        this._clearRoomSubscriptions();
        this._clearChatListener();
        this._clearPresencePoll();

        const S = this._schema();
        if (this.roomId) {
            try {
                this.db.ref(this._roomPath(this.roomId)).off();
                if (S) {
                    this.db.ref(S.paths.events(this.roomId)).off();
                    this.db.ref(S.paths.legacyEvents(this.roomId)).off();
                } else {
                    this.db.ref(`gameData/${this.roomId}/events`).off();
                }
            } catch (e) {}
        }
        this.roomId = id;

        if (id === 'lobby') {
            this.playerRole = 'P1';
            this.roomData = null;
            console.log(`Network: Solo/Lobby mode active (Local play only)`);
            return;
        }

        const roomMetaRef = this.db.ref(this._roomPath(id));
        let lastInitIdentityDigest = null;
        let hadRoomSnapshot = false;
        const metaCallback = (snap) => {
            const raw = snap.val();
            const game = this._normalizeRoom(raw);
            if (game) {
                hadRoomSnapshot = true;
                this.playerRole = this._partyRoleForUid(game, this.uid);
                window.NetworkEngine.roomData = game;

                const g = game.global || {};
                const digest = `${game.host || ''}|${g.game || ''}|${g.mode || ''}`;

                const frame = document.getElementById('game-frame');
                if (frame && frame.contentWindow && digest !== lastInitIdentityDigest) {
                    lastInitIdentityDigest = digest;
                    frame.contentWindow.postMessage({
                        type: 'init-identity',
                        role: this.playerRole,
                        uid: this.uid,
                        roomId: id,
                        game: game
                    }, '*');
                }

                if (window.onNetworkUpdate) window.onNetworkUpdate(game);
                const dissolved = raw?.status === 'dissolved' || game.status === 'dissolved';
                if (dissolved) {
                    try {
                        if (localStorage.getItem('five_party_dbg') === '1'
                            || new URLSearchParams(window.location.search).has('partyDbg')) {
                            console.log('[PARTY-DBG] metaCallback dissolved', {
                                id,
                                neRoom: this.roomId,
                                rawStatus: raw?.status,
                                gameStatus: game.status,
                                hasHandler: typeof window.onPartyRoomClosed === 'function'
                            });
                        }
                    } catch (_) { /* ignore */ }
                    if (typeof window.onPartyRoomClosed === 'function') {
                        window.onPartyRoomClosed(id);
                    }
                }
            } else if (id !== 'lobby') {
                this.roomData = null;
                if (hadRoomSnapshot && typeof window.onPartyRoomClosed === 'function') {
                    try {
                        if (localStorage.getItem('five_party_dbg') === '1') {
                            console.log('[PARTY-DBG] metaCallback room deleted', { id, neRoom: this.roomId });
                        }
                    } catch (_) { /* ignore */ }
                    window.onPartyRoomClosed(id);
                }
                hadRoomSnapshot = false;
                if (window.onNetworkUpdate) window.onNetworkUpdate(null);
            }
        };
        this._trackRoomSubscription(roomMetaRef, 'value', metaCallback);

        if (id !== 'lobby') {
            const statusRef = this.db.ref(`${this._roomPath(id)}/status`);
            const statusCallback = (snap) => {
                const val = snap.val();
                if (val === 'dissolved') {
                    try {
                        if (localStorage.getItem('five_party_dbg') === '1'
                            || new URLSearchParams(window.location.search).has('partyDbg')) {
                            console.log('[PARTY-DBG] status listener dissolved', {
                                id,
                                neRoom: this.roomId,
                                hasHandler: typeof window.onPartyRoomClosed === 'function'
                            });
                        }
                    } catch (_) { /* ignore */ }
                    if (typeof window.onPartyRoomClosed === 'function') {
                        window.onPartyRoomClosed(id);
                    }
                }
            };
            this._trackRoomSubscription(statusRef, 'value', statusCallback);
        }

        const pushEventsToFrame = (val) => {
            const events = val ? Object.values(val) : [];
            const frame = document.getElementById('game-frame');
            if (frame && frame.contentWindow) {
                frame.contentWindow.postMessage({ type: 'network-events', events }, '*');
            }
        };

        if (S) {
            const primaryEventsRef = this.db.ref(S.paths.events(id));
            this._trackRoomSubscription(primaryEventsRef, 'value', (snap) => pushEventsToFrame(snap.val()));
            const legacyEventsRef = this.db.ref(S.paths.legacyEvents(id));
            this._trackRoomSubscription(legacyEventsRef, 'value', (snap) => pushEventsToFrame(snap.val()));
        } else {
            const eventsRef = this.db.ref(`gameData/${id}/events`);
            this._trackRoomSubscription(eventsRef, 'value', (snap) => pushEventsToFrame(snap.val()));
        }

        // Re-register saved listeners under the new room ID
        if (this.listeners) {
            this.listeners.forEach(({ path, callback }) => {
                const pRef = this.db.ref(`games/${id}/${path}`);
                const pCallback = (snapshot) => {
                    callback(snapshot.val());
                };
                this._trackRoomSubscription(pRef, 'value', pCallback);
            });
        }

        console.log(`Network: Monitoring Room ${id}`);
    },

    sendEvent(event) {
        if (!this.isInitialized || !this.roomId) {
            console.warn(`[NETWORK] sendEvent aborted! Not initialized or no room.`);
            return;
        }
        const round =
            event?.resetCount
            ?? this.roomData?.global?.resetCount
            ?? 1;
        const payload = {
            ...event,
            uid: this.uid,
            resetCount: round,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };
        const S = this._schema();
        const primary = S ? S.paths.eventPush(this.roomId) : `gameData/${this.roomId}/events`;
        this.db.ref(primary).push(payload).catch((err) => {
            console.error(`[NETWORK] sendEvent push FAILED:`, err);
        });
        if (S) {
            this.db.ref(S.paths.legacyEvents(this.roomId)).push(payload).catch(() => {});
        }
    },

    send(path, data) {
        if (!this.isInitialized || !this.roomId) return;
        const S = this._schema();
        if (S && (path.startsWith('global/') || path.startsWith('meta/') || path.startsWith('state/'))) {
            this.db.ref().update(S.expandRelativeWrites(this.roomId, path, data));
            return;
        }
        this.db.ref(`${this._roomPath(this.roomId)}/${path}`).set(data);
    },

    on(path, callback) {
        if (!this.listeners) this.listeners = [];
        this.listeners.push({ path, callback });
        if (!this.isInitialized || !this.roomId) return;
        const pRef = this.db.ref(`games/${this.roomId}/${path}`);
        const pCallback = (snapshot) => {
            callback(snapshot.val());
        };
        this._trackRoomSubscription(pRef, 'value', pCallback);
    },

    getChatPath(forRoomId) {
        const id = forRoomId || this.roomId;
        if (!id || id === 'lobby') return 'lobby/chat';
        return `games/${id}/chat`;
    },

    _clearChatListener() {
        if (this._chatPoll) {
            clearInterval(this._chatPoll);
            this._chatPoll = null;
        }
        this._chatSeen = null;
        if (this._chatSubscription?.ref) {
            try {
                this._chatSubscription.ref.off(this._chatSubscription.eventType, this._chatSubscription.callback);
            } catch (e) {}
            this._chatSubscription = null;
        }
    },

    sendChatMessage(msg, forRoomId) {
        if (!this.init()) return;
        const payload = {
            sender: sessionStorage.getItem('username') || localStorage.getItem('username') || 'Guest',
            color: sessionStorage.getItem('userColor') || localStorage.getItem('userColor') || '#3b82f6',
            uid: this.uid,
            content: msg,
            timestamp: Date.now()
        };
        if (this._usesRtdbTunnel()) {
            this._restPost(this.getChatPath(forRoomId), payload).catch((err) => {
                console.warn('[Network] Chat send failed (tunnel):', err.message);
            });
            return;
        }
        const chatRef = this.db.ref(this.getChatPath(forRoomId)).push();
        chatRef.set({
            ...payload,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    },

    _normalizeChatTimestamp(ts) {
        if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
        return ts < 1e12 ? ts * 1000 : ts;
    },

    listenForChat(callback, forRoomId) {
        if (!this.init()) return;
        this._clearChatListener();
        const chatPath = this.getChatPath(forRoomId);
        const attachedAt = Date.now();
        if (this._usesRtdbTunnel()) {
            this._chatSeen = new Set();
            const poll = () => {
                this._restGet(chatPath)
                    .then((msgs) => {
                        if (!msgs || typeof msgs !== 'object') return;
                        Object.entries(msgs).forEach(([key, data]) => {
                            if (!data || this._chatSeen.has(key)) return;
                            this._chatSeen.add(key);
                            const ts = this._normalizeChatTimestamp(data.timestamp);
                            if (ts != null && ts < attachedAt - 1500) return;
                            callback({ ...data, timestamp: ts != null ? ts : Date.now() });
                        });
                    })
                    .catch((err) => {
                        console.warn('[Network] Chat poll failed (tunnel):', err?.message || err);
                    });
            };
            poll();
            this._chatPoll = setInterval(poll, 1200);
            this._chatSubscription = { tunnel: true };
            return;
        }
        const chatRef = this.db.ref(chatPath).limitToLast(50);
        const chatCallback = (snap) => {
            const data = snap.val();
            if (!data) return;
            const ts = this._normalizeChatTimestamp(data.timestamp);
            if (ts != null && ts < attachedAt - 1500) return;
            callback({ ...data, timestamp: ts != null ? ts : Date.now() });
        };
        chatRef.on('child_added', chatCallback);
        this._chatSubscription = { ref: chatRef, eventType: 'child_added', callback: chatCallback };
    },

    findUserByName(name, callback) {
        if (!this.isInitialized) return;
        const pick = (players) => {
            const now = Date.now();
            const found = Object.keys(players || {}).find((id) => {
                const p = players[id];
                return p && this.isPresenceActive(p, now)
                    && p.name.toLowerCase() === name.toLowerCase();
            });
            callback(found ? { uid: found, ...players[found] } : null);
        };
        if (this._usesRtdbTunnel()) {
            this._restGet('presence').then(pick).catch(() => callback(null));
            return;
        }
        this.db.ref('presence').once('value', (snap) => pick(snap.val()));
    },

    // --- High-Level GameSync Helpers ---

    normalize(val, limit) {
        return Math.round((val / limit) * 1000);
    },

    denormalize(norm, limit) {
        return (norm / 1000) * limit;
    },

    broadcast(path, payload) {
        if (!this.isInitialized || !this.roomId) return;
        const S = this._schema();
        if (S && (path.startsWith('global/') || path.startsWith('meta/') || path.startsWith('state/'))) {
            this.db.ref().update(S.expandRelativeWrites(this.roomId, path, payload));
            return;
        }
        this.db.ref(`${this._roomPath(this.roomId)}/${path}`).set(payload);
    },

    // --- Cloud Functions API ---
    async createGame(gameData) {
        if (!this.init()) return;
        // In this architecture, we would call a Cloud Function
        // For local development, we'll simulate it for now but structure it to push to /games
        const gameId = 'g' + Math.random().toString(36).substring(2, 7).toUpperCase();
        const updates = {};
        updates[`games/${gameId}`] = {
            host: this.uid,
            status: 'waiting',
            game: gameData.game,
            mode: gameData.mode,
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            users: { [this.uid]: firebase.database.ServerValue.TIMESTAMP }
        };
        updates[`gameData/${gameId}`] = {
            populatedAt: firebase.database.ServerValue.TIMESTAMP
        };
        await this.db.ref().update(updates);
        return gameId;
    }
};

