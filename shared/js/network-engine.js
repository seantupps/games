window.NetworkEngine = {
    config: {
        apiKey: "AIzaSyCt0DtKHmp8JVQegsTgmxJwfiie_BBobe8",
        authDomain: "games-fad3a.firebaseapp.com",
        projectId: "games-fad3a",
        storageBucket: "games-fad3a.firebasestorage.app",
        messagingSenderId: "526013940943",
        appId: "1:526013940943:web:f5ba2e59ead8465b8423ba",
        measurementId: "G-JG4Q476RJQ",
        databaseURL: "https://games-fad3a-default-rtdb.firebaseio.com"
    },

    roomId: null,
    db: null,
    isInitialized: false,

    init() {
        // Skip if keys aren't set yet
        if (this.config.apiKey.includes("YOUR_API_KEY")) {
            console.warn("Multiplayer: Firebase keys not set. Running in local mode.");
            return false;
        }

        // Initialize Firebase
        if (!window.firebase) {
            console.error("Firebase library not detected.");
            return false;
        }

        if (!this.isInitialized) {
            firebase.initializeApp(this.config);
            this.db = firebase.database();
            this.isInitialized = true;
            console.log("Multiplayer: Network Engine Initialized.");
        }
        return true;
    },

    joinRoom(id) {
        this.init();
        this.roomId = id;
        console.log(`Multiplayer: Joined Room ${id}`);
    },

    send(path, data) {
        if (!this.isInitialized || !this.roomId) return;
        this.db.ref(`rooms/${this.roomId}/${path}`).set(data);
    },

    on(path, callback) {
        if (!this.isInitialized || !this.roomId) return;
        this.db.ref(`rooms/${this.roomId}/${path}`).on('value', (snapshot) => {
            callback(snapshot.val());
        });
    }
};
