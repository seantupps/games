/**
 * Device-local prefs (localStorage with sessionStorage mirror).
 * Survives tab close; unavailable in private browsing (falls back to session only).
 */
(function (global) {
    function canUseLocal() {
        try {
            const probe = '__five_ls__';
            global.localStorage.setItem(probe, '1');
            global.localStorage.removeItem(probe);
            return true;
        } catch (_) {
            return false;
        }
    }

    function read(key) {
        if (canUseLocal()) {
            const v = global.localStorage.getItem(key);
            if (v != null && v !== '') return v;
        }
        return global.sessionStorage.getItem(key);
    }

    function write(key, value) {
        global.sessionStorage.setItem(key, value);
        if (canUseLocal()) {
            try {
                global.localStorage.setItem(key, value);
            } catch (_) { /* quota / private mode */ }
        }
    }

    function getOrCreate(key, factory) {
        let value = read(key);
        if (!value) {
            value = factory();
            write(key, value);
        } else {
            write(key, value);
        }
        return value;
    }

    function getOrCreateUid() {
        // Multiplayer identity must be tab-scoped: two desktop tabs should be two players.
        // Keep UID in sessionStorage only so reload preserves identity, but new tabs get new UIDs.
        let uid = global.sessionStorage.getItem('game_uid');
        if (!uid) {
            uid = 'u' + Math.random().toString(36).substring(2, 9);
            global.sessionStorage.setItem('game_uid', uid);
        }
        return uid;
    }

    const DeviceStorage = { read, write, getOrCreate, getOrCreateUid, canUseLocal };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = DeviceStorage;
    } else {
        global.DeviceStorage = DeviceStorage;
    }
})(typeof window !== 'undefined' ? window : global);
