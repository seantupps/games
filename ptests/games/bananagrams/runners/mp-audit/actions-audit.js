/**
 * Standalone MP actions scenario — solver mid-game + real drag win + natural RTDB sync.
 * Full audit calls runMpAiPlaythrough directly from run-audit.js.
 */
const { applySpeedProfile } = require('../../../../shared/infra/speed-profiles');

const ACTIONS_TIMEOUT_MS = Number(process.env.FIVE_MP_ACTIONS_TIMEOUT_MS || 120000);

/** Stress dump sync between players — flip on to hunt MP dump bugs. */
const AGGRESSIVE_DUMPING = false;
const AGGRESSIVE_DUMPS_PER_PLAYER = 10;

/** Real pointer drag for the last winning tile — off uses bulk apply + peel/win API. */
const WIN_DRAG = false;

/** Headless actions — ci speed tier. Override any var via env. */
function ensureActionsFastEnv() {
    applySpeedProfile('ci', { scenario: 'actions' });
}

async function withActionsTimeout(promise, label = 'MP Actions') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${ACTIONS_TIMEOUT_MS}ms`)),
            ACTIONS_TIMEOUT_MS
        );
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    withActionsTimeout,
    ACTIONS_TIMEOUT_MS,
    AGGRESSIVE_DUMPING,
    AGGRESSIVE_DUMPS_PER_PLAYER,
    WIN_DRAG,
    ensureActionsFastEnv
};
