/**
 * Global Playwright wait/step timeout — 3s max unless env overrides.
 * Set FIVE_STEP_TIMEOUT_MS to change all step-level caps at once.
 *
 * Concepts (see ptests/SPEED.md):
 * - STEP_TIMEOUT_MS — max wait for waitFor* (fail if exceeded)
 * - POLL_INTERVAL_MS — how often to poll in custom loops
 * - SETTLE_MS — optional fixed post-action sleep (prefer condition-based waits)
 */
const GLOBAL_MS = Math.min(3000, Number(process.env.FIVE_STEP_TIMEOUT_MS || 3000));
const POLL_INTERVAL_MS = Number(process.env.FIVE_MP_ACTIONS_POLL_MS || 50);
const SETTLE_MS = Number(process.env.FIVE_MP_SETTLE_MS || 80);

module.exports = {
    GLOBAL_MS,
    STEP_MS: GLOBAL_MS,
    STEP_TIMEOUT_MS: GLOBAL_MS,
    POLL_INTERVAL_MS,
    SETTLE_MS,
    HUB_MS: GLOBAL_MS,
    DEFAULT_MS: GLOBAL_MS,
    NAV_MS: GLOBAL_MS,
    NETWORK_MS: GLOBAL_MS,
    HUB_INIT_MS: GLOBAL_MS,
    MP_TEST_MS: GLOBAL_MS,
    SP_GAME_MS: GLOBAL_MS,
    MP_GAME_MS: GLOBAL_MS,
    HUB_STEP_MS: GLOBAL_MS
};
