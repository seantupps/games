/**
 * Named speed tiers for ptests — scenarios opt in via applySpeedProfile().
 * See ptests/SPEED.md for env var reference.
 */
const { setEnvIfUnset } = require('./env-defaults');
const { STEP_MS } = require('./timeouts');

/** @type {Record<string, Record<string, string>>} */
const PROFILES = {
    ci: {
        FIVE_BANANA_BANNER_INSTANT_MS: '50',
        FIVE_MP_VICTORY_MS: '500',
        FIVE_MP_REVIEW_SYNC_MS: '350',
        FIVE_MP_ACTIONS_POLL_MS: '20',
        FIVE_MP_ACTIONS_DEBUG: '0',
        FIVE_MP_PEEL_STABILITY_SETTLE_MS: '40',
        FIVE_VICTORY_DWELL_MS: '50'
    },
    dev: {
        FIVE_STEP_TIMEOUT_MS: '3000',
        FIVE_VICTORY_DWELL_MS: '150',
        FIVE_MP_ACTIONS_POLL_MS: '50'
    },
    debug: {
        FIVE_STEP_TIMEOUT_MS: '15000',
        FIVE_VICTORY_DWELL_MS: '5000',
        FIVE_MP_ACTIONS_POLL_MS: '120',
        FIVE_MP_VICTORY_MS: '8000',
        FIVE_MP_REVIEW_SYNC_MS: '12000'
    }
};

const SCENARIO_PROFILES = {
    actions: 'ci',
    smoke: 'ci',
    focus: 'dev',
    'guest-double-dump': 'ci'
};

function applySpeedProfile(tier, options = {}) {
    const name = tier || SCENARIO_PROFILES[options.scenario] || process.env.FIVE_SPEED_PROFILE || 'dev';
    const block = PROFILES[name];
    if (!block) {
        throw new Error(`Unknown speed profile "${name}". Known: ${Object.keys(PROFILES).join(', ')}`);
    }
    Object.entries(block).forEach(([k, v]) => setEnvIfUnset(k, v));
    return name;
}

function resolveSpeedProfile(options = {}) {
    if (options.scenario && SCENARIO_PROFILES[options.scenario]) {
        return SCENARIO_PROFILES[options.scenario];
    }
    return process.env.FIVE_SPEED_PROFILE || 'dev';
}

function readEnvMs(key, fallback) {
    const env = process.env[key];
    if (env != null && env !== '') return Number(env);
    return fallback;
}

function mpPollMs() {
    return readEnvMs('FIVE_MP_ACTIONS_POLL_MS', 50);
}

function mpVictoryWaitMs() {
    return readEnvMs('FIVE_MP_VICTORY_MS', 800);
}

function mpReviewWaitMs() {
    return readEnvMs('FIVE_MP_REVIEW_SYNC_MS', 1200);
}

function peelStabilitySettleMs() {
    return readEnvMs('FIVE_MP_PEEL_STABILITY_SETTLE_MS', 620);
}

function bannerInstantMs() {
    return readEnvMs('FIVE_BANANA_BANNER_INSTANT_MS', 100);
}

/** Off by default — set FIVE_MP_AI_ROUND_TRIP_CAP=1 to enforce max round-trip limits. */
function mpAiRoundTripCapEnabled() {
    const v = process.env.FIVE_MP_AI_ROUND_TRIP_CAP;
    if (v == null || v === '') return false;
    const s = String(v).toLowerCase();
    return s !== '0' && s !== 'false' && s !== 'off' && s !== 'no';
}

/**
 * @param {boolean} playToWin
 * @param {{ playFallback?: number, auditFallback?: number }} [opts]
 */
function resolveMpAiMaxRoundTrips(playToWin, opts = {}) {
    if (!mpAiRoundTripCapEnabled()) {
        return Number.POSITIVE_INFINITY;
    }
    if (playToWin) {
        return Number(
            process.env.FIVE_BANANA_MAX_TURNS
            || process.env.FIVE_MP_AI_MAX_ROUNDS
            || opts.playFallback
            || 30
        );
    }
    return Number(process.env.FIVE_MP_AI_MAX_ROUNDS || opts.auditFallback || 120);
}

module.exports = {
    PROFILES,
    SCENARIO_PROFILES,
    applySpeedProfile,
    resolveSpeedProfile,
    mpPollMs,
    mpVictoryWaitMs,
    mpReviewWaitMs,
    peelStabilitySettleMs,
    bannerInstantMs,
    mpAiRoundTripCapEnabled,
    resolveMpAiMaxRoundTrips,
    WAIT_MS: STEP_MS
};
