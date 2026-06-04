/**
 * In-game action banner hooks from registry (Peel/Dump/etc.) — iframe banner, not hub win banner.
 */
const GameRegistry = require('../../../shared/games/registry');

const DEFAULT_BANNER = {
    elementId: 'action-banner',
    visibleClass: 'is-visible',
    actorUidField: '_bannerActorUid',
    colorFn: '_bannerColorForUid'
};

/**
 * @param {string} gameId
 * @param {string} [gameMode]
 */
function resolveActionBannerHooks(gameId, gameMode) {
    const caps = GameRegistry.getCapabilities(gameId, gameMode);
    const id = caps.inGameActionBannerId || DEFAULT_BANNER.elementId;
    return {
        elementId: id,
        visibleClass: caps.inGameActionBannerVisibleClass || DEFAULT_BANNER.visibleClass,
        actorUidField: caps.inGameActionBannerActorField || DEFAULT_BANNER.actorUidField,
        colorFn: caps.inGameActionBannerColorFn || DEFAULT_BANNER.colorFn
    };
}

module.exports = { resolveActionBannerHooks, DEFAULT_BANNER };
