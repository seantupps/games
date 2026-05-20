window.NetworkEngine = {
    config: null,
    firebaseTarget: 'production',
    roomId: null,
    db: null,
    uid: null,
    playerRole: 'P1', // Default
    isInitialized: false,
    ROOM_MAX_PLAYERS: 2,

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
        const snap = await this.db.ref(`games/${roomId}`).once('value');
        return this.countRoomMembers(snap.val());
    },

    async assertCanJoinRoom(roomId) {
        if (!this.init()) return { ok: false, reason: 'Network not initialized' };
        if (!roomId || roomId === 'lobby') return { ok: true };

        const snap = await this.db.ref(`games/${roomId}`).once('value');
        const room = snap.val();
        if (!room) return { ok: true }; // New room — first writers create it

        if (this.isRoomMember(room, this.uid)) return { ok: true };

        if (this.countRoomMembers(room) >= this.ROOM_MAX_PLAYERS) {
            return { ok: false, reason: 'This room is full (2 players max).' };
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
            return this.db.ref(`games/${this.roomId}/playerData/${this.uid}`).update({ name, color }).then(() => true);
        });
    },

    init() {
        if (this.isInitialized) return true;
        if (!window.firebase) { console.error("Firebase missing"); return false; }
        if (!window.FiveFirebaseEnv) {
            console.error("FiveFirebaseEnv missing — load shared/js/firebase-env.js before network.js");
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

        // Per-tab uid so multiple tabs on one machine show up as separate players in the lobby
        this.uid = sessionStorage.getItem('game_uid');
        if (!this.uid) {
            this.uid = 'u' + Math.random().toString(36).substring(2, 9);
            sessionStorage.setItem('game_uid', this.uid);
        }

        this.isInitialized = true;
        this.initPresence();
        return true;
    },

    getUid() {
        return this.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
    },

    initPresence() {
        const presenceRef = this.db.ref(`.info/connected`);
        const userRef = this.db.ref(`presence/${this.uid}`);

        presenceRef.on('value', (snap) => {
            if (snap.val() === true) {
                userRef.onDisconnect().remove();
                this.updatePresence();
            }
        });
    },

    updatePresence() {
        if (!this.isInitialized) return;
        const name = sessionStorage.getItem('username') || localStorage.getItem('username') || 'Guest';
        const color = sessionStorage.getItem('userColor') || localStorage.getItem('userColor') || '#3b82f6';
        this.db.ref(`presence/${this.uid}`).set({
            name, color,
            lastSeen: firebase.database.ServerValue.TIMESTAMP
        }).catch((err) => {
            console.warn('[Network] Presence update failed:', err.message);
        });
    },

    listenForPlayers(callback) {
        if (!this.init()) return;
        this.db.ref('presence').on('value', (snap) => {
            const players = snap.val() || {};
            // Filter out self
            const otherPlayers = Object.keys(players)
                .filter(id => id !== this.uid)
                .map(id => ({ uid: id, ...players[id] }));
            callback(otherPlayers);
        });
    },

    sendInvite(targetUid, gameData, onAccept) {
        if (!this.init()) return;
        const inviteRef = this.db.ref(`invites/${targetUid}/${this.uid}`);
        inviteRef.set({
            fromName: localStorage.getItem('username'),
            fromUid: this.uid,
            game: gameData.game,
            mode: gameData.mode,
            status: 'pending',
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });

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
            const updates = {};
            updates[`games/${roomId}/host`] = senderUid;
            updates[`games/${roomId}/status`] = 'waiting';
            updates[`games/${roomId}/users/${this.uid}`] = firebase.database.ServerValue.TIMESTAMP;
            updates[`invites/${this.uid}/${senderUid}/status`] = 'accepted';
            updates[`invites/${this.uid}/${senderUid}/roomId`] = roomId;

            return this.db.ref().update(updates).then(() => {
                this.joinRoom(roomId);
                return { ok: true };
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

        if (this.roomId) {
            try {
                this.db.ref(`games/${this.roomId}`).off();
                this.db.ref(`gameData/${this.roomId}/events`).off();
            } catch (e) {}
        }
        this.roomId = id;

        // Lobby/Solo Mode: 100% local, do not monitor Firebase room or events
        if (id === 'lobby') {
            this.playerRole = 'P1';
            this.roomData = null;
            console.log(`Network: Solo/Lobby mode active (Local play only)`);
            return;
        }

        // 1. Meta Data (Host, Status, Players)
        const roomMetaRef = this.db.ref(`games/${id}`);
        // Only re-send init-identity when room *identity* changes (host / game / mode).
        // Sending it on every Firebase tick (e.g. each global/pileColors write) caused piles
        // freestyle to re-run initPiles -> initFreestyle -> randomizeColors in a feedback loop.
        let lastInitIdentityDigest = null;
        const metaCallback = (snap) => {
            const game = snap.val();
            if (game) {
                this.playerRole = (game.host === this.uid || id === 'lobby') ? 'P1' : 'P2';
                window.NetworkEngine.roomData = game; // Cache the latest room metadata

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
            }
        };
        this._trackRoomSubscription(roomMetaRef, 'value', metaCallback);

        // 2. Event Stream (Authoritative Play)
        const eventsRef = this.db.ref(`gameData/${id}/events`);
        const eventsCallback = (snap) => {
            const events = snap.val() ? Object.values(snap.val()) : [];
            const frame = document.getElementById('game-frame');
            if (frame && frame.contentWindow) {
                frame.contentWindow.postMessage({
                    type: 'network-events',
                    events: events
                }, '*');
            }
        };
        this._trackRoomSubscription(eventsRef, 'value', eventsCallback);

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
        this.db.ref(`gameData/${this.roomId}/events`).push({
            ...event,
            uid: this.uid,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        }).catch(err => {
            console.error(`[NETWORK] sendEvent push FAILED:`, err);
        });
    },

    send(path, data) {
        if (!this.isInitialized || !this.roomId) return;
        this.db.ref(`games/${this.roomId}/${path}`).set(data);
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
        if (this._chatSubscription) {
            try {
                this._chatSubscription.ref.off(this._chatSubscription.eventType, this._chatSubscription.callback);
            } catch (e) {}
            this._chatSubscription = null;
        }
    },

    sendChatMessage(msg, forRoomId) {
        if (!this.init()) return;
        const chatRef = this.db.ref(this.getChatPath(forRoomId)).push();
        chatRef.set({
            sender: sessionStorage.getItem('username') || localStorage.getItem('username') || 'Guest',
            color: sessionStorage.getItem('userColor') || localStorage.getItem('userColor') || '#3b82f6',
            uid: this.uid,
            content: msg,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    },

    listenForChat(callback, forRoomId) {
        if (!this.init()) return;
        this._clearChatListener();
        const chatRef = this.db.ref(this.getChatPath(forRoomId)).limitToLast(50);
        const chatCallback = (snap) => {
            callback(snap.val());
        };
        chatRef.on('child_added', chatCallback);
        this._chatSubscription = { ref: chatRef, eventType: 'child_added', callback: chatCallback };
    },

    findUserByName(name, callback) {
        if (!this.isInitialized) return;
        this.db.ref('presence').once('value', (snap) => {
            const players = snap.val() || {};
            const found = Object.keys(players).find(id => players[id].name.toLowerCase() === name.toLowerCase());
            callback(found ? { uid: found, ...players[found] } : null);
        });
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
        this.db.ref(`games/${this.roomId}/${path}`).set(payload);
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

