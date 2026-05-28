/**
 * Player identity model for hub + iframe.
 *
 * Current production model: roles-p1-p2 (host = P1, one guest = P2).
 * Future: party-uids (P1…Pn mapped from join order) — use flexiblePlayerRoles cap.
 */
(function (global) {
    /** @typedef {'roles-p1-p2'|'party-uids'} PlayerModelKind */

    const ROLE_HOST = 'P1';
    const ROLE_GUEST = 'P2';

    function modelForGame(gameId, mode) {
        const Registry = global.GameRegistry;
        if (Registry?.hasCapability?.(gameId, 'flexiblePlayerRoles', mode)) {
            return 'party-uids';
        }
        return 'roles-p1-p2';
    }

    function isHostRole(role) {
        return (role || ROLE_HOST).toUpperCase() === ROLE_HOST;
    }

    function defaultScores() {
        return { P1: 0, P2: 0 };
    }

    /**
     * Legacy 2P: first non-self uid in playerData (previews, opponent theme).
     * Not valid for 3+; games with party-uids should override via game hooks.
     */
    function firstOtherUid(roomData, myUid) {
        if (!roomData?.playerData || !myUid) return null;
        return Object.keys(roomData.playerData).find((uid) => uid && uid !== myUid) || null;
    }

    const PlayerModel = {
        ROLE_HOST,
        ROLE_GUEST,
        modelForGame,
        isHostRole,
        defaultScores,
        firstOtherUid
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PlayerModel;
    } else {
        global.PlayerModel = PlayerModel;
    }
})(typeof window !== 'undefined' ? window : global);
