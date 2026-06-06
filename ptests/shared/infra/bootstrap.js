/**
 * Apply default ptests env on load. Import first in runners and audit modules.
 *
 * FIVE_PROFILE=fast   (default) — 3s steps, 150ms victory dwell, optimized MP polls
 * FIVE_PROFILE=full   — slow timeouts for debugging
 * FIVE_PROFILE=prod   — production runners (no auto stack)
 * FIVE_SKIP_BOOTSTRAP=1 — opt out (rare)
 */
const { applyEnvProfiles, defaultBootstrapProfiles } = require('./env-defaults');
const { resetRunEnv } = require('./run-config');

function applyBootstrap(extraProfiles = []) {
    resetRunEnv();
    applyEnvProfiles(defaultBootstrapProfiles(extraProfiles));
}

if (process.env.FIVE_SKIP_BOOTSTRAP !== '1') {
    applyBootstrap();
}

module.exports = { applyBootstrap };
