/**
 * Standalone MP 3p actions scenario — optimized AI playthrough only.
 */
const { applySpeedProfile } = require('../../../../shared/infra/speed-profiles');
const { runMpAiActionsOnly3p } = require('./mp-ai-playthrough-3p');

const ACTIONS_TIMEOUT_MS = Number(process.env.FIVE_MP_ACTIONS_TIMEOUT_MS || 600000);

function ensureActionsFastEnv() {
    applySpeedProfile('ci', { scenario: 'actions' });
}

async function withActionsTimeout(promise, label = 'MP 3p Actions') {
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

async function runBananagramsMpActionsAudit3p(browser, options = {}) {
    ensureActionsFastEnv();
    return withActionsTimeout(runMpAiActionsOnly3p(browser, options), 'MP 3p Actions');
}

module.exports = {
    runBananagramsMpActionsAudit3p,
    withActionsTimeout,
    ACTIONS_TIMEOUT_MS
};
