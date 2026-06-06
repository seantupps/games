/** MP sync invariants — board, peel spawn, split, banners. */
module.exports = {
    ...require('./mp-sync-board'),
    ...require('./mp-sync-peel-spawn'),
    ...require('./mp-sync-disconnected'),
    ...require('./mp-sync-split'),
    ...require('./mp-sync-win-banner'),
    ...require('./mp-sync-guest-banner')
};
