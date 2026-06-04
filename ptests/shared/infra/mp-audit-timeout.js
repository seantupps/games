/**
 * Outer timeout caps for bundled MP audits.
 * smoke/slim: ~45s | full: ~120s | actions: up to 600s
 */

function resolveScenarioFromEnv() {
    const raw = process.env.FIVE_SCENARIO || process.env.npm_config_scenario || 'full';
    return String(raw).trim().toLowerCase();
}

/**
 * @param {{ scenario?: string, slim?: boolean, preferEnv?: boolean }} [options]
 * @returns {number}
 */
function resolveMpAuditTimeoutMs(options = {}) {
    const envExplicit = Number(process.env.FIVE_DESKTOP_MP_AUDIT_MS || process.env.FIVE_MOBILE_MP_GAME_MS || 0);
    if (envExplicit > 0 && options.preferEnv !== false) return envExplicit;

    const scenario = (options.scenario ?? resolveScenarioFromEnv()).toLowerCase();
    const slim = options.slim ?? process.env.FIVE_MP_SLIM === '1';

    if (slim) return Number(process.env.FIVE_MP_SMOKE_MS || 45000);
    if (scenario === 'actions') return Number(process.env.FIVE_MP_ACTIONS_TIMEOUT_MS || 600000);
    if (scenario === 'focus') return Number(process.env.FIVE_MP_FOCUS_TIMEOUT_MS || 300000);
    return Number(process.env.FIVE_MP_FULL_AUDIT_MS || 120000);
}

/** Block wrapper timeout — audit cap plus cleanup buffer. */
function resolveMpAuditBlockMs(options = {}) {
    return resolveMpAuditTimeoutMs(options) + Number(process.env.FIVE_MP_BLOCK_BUFFER_MS || 60000);
}

module.exports = {
    resolveMpAuditTimeoutMs,
    resolveMpAuditBlockMs,
    resolveScenarioFromEnv
};
