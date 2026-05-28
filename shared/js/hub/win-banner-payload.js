/**
 * Shared hub win-banner message shape (iframe → hub parent).
 */
(function (global) {
    const MSG = 'update-win-banner';

    /**
     * @param {object} data
     * @param {boolean} data.visible
     * @param {'P1'|'P2'} [data.winner]
     * @param {string} [data.winnerUid]
     * @param {string} [data.bannerText] — solo timer-style text (no "WINS!")
     * @param {string} [data.bannerColor]
     * @param {number} [data.autoFadeMs]
     */
    function buildWinBannerMessage(data) {
        return { type: MSG, ...data };
    }

    function postWinBanner(data) {
        if (typeof window === 'undefined' || !window.parent) return;
        window.parent.postMessage(buildWinBannerMessage(data), '*');
    }

    global.HubWinBannerPayload = {
        MSG,
        buildWinBannerMessage,
        postWinBanner
    };
})(typeof window !== 'undefined' ? window : global);
