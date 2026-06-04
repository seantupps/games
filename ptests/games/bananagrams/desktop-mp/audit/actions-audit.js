/**
 * Standalone MP actions scenario — AI playthrough only.
 * Full audit calls runMpAiPlaythrough directly from run-audit.js.
 */
const { applySpeedProfile } = require('../../../../shared/infra/speed-profiles');
const {
    runMpAiActionsOnly
} = require('./mp-ai-playthrough');

const ACTIONS_TIMEOUT_MS = Number(process.env.FIVE_MP_ACTIONS_TIMEOUT_MS || 600000);

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

async function runBananagramsMpActionsAudit(page1, page2, options = {}) {
    ensureActionsFastEnv();
    return runMpAiActionsOnly(page1, page2, options);
}

module.exports = {
    runBananagramsMpActionsAudit,
    withActionsTimeout,
    ACTIONS_TIMEOUT_MS
};