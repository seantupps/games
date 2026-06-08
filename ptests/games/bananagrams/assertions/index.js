/**
 * Bananagrams test assertions — public barrel for scenario imports.
 *
 * Pattern: capture → compare → assert (see core/ and mp/sync.js).
 *
 * Scenarios should import only from here — not individual mp/*.js paths.
 */
const coreCapture = require('./core/capture');
const coreCompare = require('./core/compare');
const coreAssert = require('./core/assert-ok');
const coreFormat = require('./core/format-failure');

const syncCore = require('./mp/sync');
const syncDisconnected = require('./mp/sync-disconnected');
const syncPeelSpawn = require('./mp/sync-peel-spawn');
const syncSplit = require('./mp/sync-split');
const syncWinBanner = require('./mp/sync-win-banner');
const syncGuestBanner = require('./mp/sync-guest-banner');
const syncVictory = require('./mp/victory');
const dealCore = require('./mp/deal');

const reviewCore = require('./mp/review');
const reviewActions = require('./mp/review-actions');
const reviewDoneSplit = require('./mp/review-done-split');
const reviewSolve2 = require('./mp/review-solve2');

module.exports = {
    core: {
        assertOk: coreAssert.assertOk,
        failWithSnapshot: coreFormat.failWithSnapshot,
        formatFailure: coreFormat.formatFailure,
        readBoardField: coreCapture.readBoardField,
        capture: coreCapture,
        compare: coreCompare
    },
    sync: {
        ...syncCore,
        ...syncDisconnected,
        ...syncPeelSpawn,
        ...syncSplit,
        ...syncWinBanner,
        ...syncGuestBanner,
        ...syncVictory
    },
    deal: dealCore,
    accounting: require('./mp/accounting'),
    authority: require('./mp/authority'),
    review: {
        ...reviewCore,
        ...reviewActions,
        ...reviewDoneSplit,
        ...reviewSolve2
    },
    audit: require('./mp/full-audit'),
    spawn: {
        dump: require('./spawn/dump'),
        peel: require('./spawn/peel'),
        visibility: require('./spawn/spawn-visibility')
    },
    distribution: require('./mp/distribution'),
    distributionSeed: require('./mp/distribution-seed'),
    scoreboard: require('./mp/scoreboard'),
    visibility: require('./mp/visibility'),
    joinReady: require('./mp/join-ready'),
    layout: {
        hub: require('./layout/hub'),
        mobileViewport: require('./layout/mobile-viewport'),
        tileStability: require('./layout/tile-stability')
    },
    reviewMobile: require('./mp/review-mobile'),
    sp: require('./sp/review')
};
