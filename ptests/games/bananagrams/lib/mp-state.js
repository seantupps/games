/**
 * Bananagrams MP lib — thin barrel. Re-exports focused modules + shared platform helpers.
 *
 * Prefer importing from submodules for new code:
 *   mp-join, mp-pool-waits, mp-input, mp-ctx, mp-session-boot
 */
const mpWaits = require('../../../shared/platform/mp-waits');
const mpBanners = require('../../../shared/platform/mp-banners');
const mpHostSync = require('../../../shared/adapters/mp-client');
const { mpPollMs, mpVictoryWaitMs, mpReviewWaitMs, peelStabilitySettleMs } = require('../../../shared/infra/speed-profiles');

const mpCtx = require('./mp-ctx');
const mpConstants = require('./mp-constants');
const { log, VERBOSE_FOCUS_DEBUG } = require('./mp-log');
const mpJoin = require('./mp-join');
const mpPoolWaits = require('./mp-pool-waits');
const mpInput = require('./mp-input');

const RESET_WAIT_MS = Math.min(8000, Number(process.env.FIVE_MP_BANANA_RESET_MS || 6000));
const HOST_PEEL_GUEST_STABILITY_MS = peelStabilitySettleMs();

module.exports = {
    ...mpWaits,
    ...mpBanners,
    ...mpHostSync,
    ...mpCtx,
    ...mpConstants,
    ...mpJoin,
    ...mpPoolWaits,
    ...mpInput,
    log,
    VERBOSE_FOCUS_DEBUG,
    mpPollMs,
    mpVictoryWaitMs,
    mpReviewWaitMs,
    RESET_WAIT_MS,
    HOST_PEEL_GUEST_STABILITY_MS
};
