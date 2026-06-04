/**
 * Template — copy to games/<id>/desktop-sp.js
 * Thin tier: registry caps + optional extra hooks only.
 */
const { runGameAudit } = require('../../shared/infra/audit_base');
const { spConfig } = require('../../shared/platform/capability-audit');

const config = spConfig('YOUR_GAME_ID', {
    gameMode: 'classic'
    // extra: [(page, ctx) => myOneRegressionCheck(page, ctx)],
});

if (require.main === module) {
    runGameAudit('YOUR_GAME_ID', config);
}

module.exports = config;
