/**
 * Outer timeout caps for bundled MP audits.
 * smoke/slim: ~45s | full: ~120s | actions: up to 600s
 */
const { getActiveRunConfig, isPaused, isSlimAudit, getScenario } = require('./run-config');

function resolveScenarioFromConfig() {
    return (getScenario() || 'full').toLowerCase();
}

/**
 * @param {{ scenario?: string, slim?: boolean, preferEnv?: boolean }} [options]
 * @returns {number}
 */
function resolveMpAuditTimeoutMs(options = {}) {
    const envExplicit = Number(process.env.FIVE_DESKTOP_MP_AUDIT_MS || process.env.FIVE_MOBILE_MP_GAME_MS || 0);
    if (envExplicit > 0 && options.preferEnv !== false) return envExplicit;

    const scenario = (options.scenario ?? resolveScenarioFromConfig()).toLowerCase();
    const slim = options.slim ?? isSlimAudit();

    if (isPaused()) {
        return Number(process.env.FIVE_PAUSE_TIMEOUT_MS || 3600000);
    }
    if (slim) return Number(process.env.FIVE_MP_SMOKE_MS || 45000);
    if (scenario === 'actions') return Number(process.env.FIVE_MP_ACTIONS_TIMEOUT_MS || 600000);
    if (scenario === 'focus') return Number(process.env.FIVE_MP_FOCUS_TIMEOUT_MS || 300000);
    if (scenario === 'all') return Number(process.env.FIVE_MP_ALL_SCENARIOS_MS || 2700000);
    return Number(process.env.FIVE_MP_FULL_AUDIT_MS || 120000);
}

/** Block wrapper timeout — audit cap plus cleanup buffer. */
function resolveMpAuditBlockMs(options = {}) {
    return resolveMpAuditTimeoutMs(options) + Number(process.env.FIVE_MP_BLOCK_BUFFER_MS || 60000);
}

module.exports = {
    resolveMpAuditTimeoutMs,
    resolveMpAuditBlockMs,
    resolveScenarioFromConfig,
    /** @deprecated use resolveScenarioFromConfig */
    resolveScenarioFromEnv: resolveScenarioFromConfig
};
