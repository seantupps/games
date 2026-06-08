/**
 * MP session CLI/config — rounds, pause, play-to-win flags.
 * Scenarios and runners import from here, not mp-ai-playthrough.
 */

function resolveSessionRounds(opts = {}) {
    const raw = opts.rounds ?? (() => {
        try {
            const { getRounds } = require('../../../shared/infra/run-config');
            return getRounds();
        } catch (_) {
            return 1;
        }
    })();
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
}

function resolveSessionPause(opts = {}) {
    if (opts.pause != null) return !!opts.pause;
    try {
        const { isPaused } = require('../../../shared/infra/run-config');
        return isPaused();
    } catch (_) {
        return false;
    }
}

function pauseTimeoutMs() {
    return Number(process.env.FIVE_PAUSE_TIMEOUT_MS || 3600000);
}

module.exports = {
    resolveSessionRounds,
    resolveSessionPause,
    pauseTimeoutMs
};
