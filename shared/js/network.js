window.NetworkEngine = {
    config: null,
    firebaseTarget: 'production',
    roomId: null,
    db: null,
    uid: null,
    playerRole: 'P1', // Default
    isInitialized: false,

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

        // Identity
        this.uid = localStorage.getItem('game_uid');
        if (!this.uid) {
            this.uid = 'u' + Math.random().toString(36).substring(2, 9);
            localStorage.setItem('game_uid', this.uid);
        }

        this.isInitialized = true;
        this.initPresence();
        return true;
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
        const name = localStorage.getItem('username') || 'Guest';
        const color = localStorage.getItem('userColor') || '#3b82f6';
        this.db.ref(`presence/${this.uid}`).set({
            name, color,
            lastSeen: firebase.database.ServerValue.TIMESTAMP
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
                this.joinRoom(data.roomId);
                if (onAccept) onAccept(data.roomId);
                inviteRef.remove(); // Cleanup
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
        if (!this.init()) return;
        // Host is the sender, Guest is the receiver
        // We now use update for atomic setup
        const updates = {};
        updates[`games/${roomId}/host`] = senderUid;
        updates[`games/${roomId}/status`] = 'waiting';
        updates[`games/${roomId}/users/${this.uid}`] = firebase.database.ServerValue.TIMESTAMP;
        updates[`invites/${this.uid}/${senderUid}/status`] = 'accepted';
        updates[`invites/${this.uid}/${senderUid}/roomId`] = roomId;

        this.db.ref().update(updates);
        this.joinRoom(roomId);
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

    sendChatMessage(msg) {
        if (!this.isInitialized || !this.roomId) return;
        const chatRef = this.db.ref(`games/${this.roomId}/chat`).push();
        chatRef.set({
            sender: localStorage.getItem('username'),
            color: localStorage.getItem('userColor') || '#3b82f6',
            uid: this.uid,
            content: msg,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    },

    listenForChat(callback) {
        if (!this.isInitialized || !this.roomId) return;
        const chatRef = this.db.ref(`games/${this.roomId}/chat`).limitToLast(50);
        const chatCallback = (snap) => {
            callback(snap.val());
        };
        this._trackRoomSubscription(chatRef, 'child_added', chatCallback);
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

