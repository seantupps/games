/**
 * Bananagrams MP full audit — thin entry (ctx-native).
 */
const { buildMpCtx2p } = require('../../lib/mp-ctx');
const {
    runFocusAuditFromCtx,
    runFullAuditFromCtx
} = require('./full-audit-orchestration');

/** @param {import('./contract').MpScenarioContext} scenarioCtx */
async function runFullScenario(scenarioCtx) {
    const options = scenarioCtx.options || {};
    const page1 = scenarioCtx.page1 ?? scenarioCtx.ctx?.pages?.[0];
    const page2 = scenarioCtx.page2 ?? scenarioCtx.ctx?.pages?.[1];
    const mobile = scenarioCtx.mobile ?? !!options.mobile;
    const roomId = scenarioCtx.roomId || options.roomId
        || `MP_AUDIT_BANANA_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const focusDumpPeel = options.focusDumpPeel ?? !!scenarioCtx.focusDumpPeel;

    const ctx = scenarioCtx.ctx || buildMpCtx2p(page1, page2, { roomId, mobile, options });
    ctx.roomId = ctx.roomId || roomId;
    const normalized = { ...scenarioCtx, ctx, mobile, roomId, options };

    if (focusDumpPeel && ctx.playerCount === 2) {
        return runFocusAuditFromCtx(normalized);
    }
    return runFullAuditFromCtx(normalized);
}

module.exports = { runFullScenario };
