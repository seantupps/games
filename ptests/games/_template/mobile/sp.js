/**
 * Template mobile SP — re-export desktop hooks; add a mobile suite when needed.
 * Omit mobileAuditConfig from registry to use desktop-sp on mobile topology (default).
 */
const desktop = require('../runners/sp');
// const { runTouchSmoke } = require('./touch-example');

module.exports = {
    ...desktop,
    async beforeLoop(page, ctx = {}) {
        if (ctx.isMobile && typeof desktop.runMobileSuite === 'function') {
            await desktop.runMobileSuite(page, ctx);
            return;
        }
        // if (ctx.isMobile) await runTouchSmoke(page, ctx);
        return desktop.beforeLoop(page, ctx);
    }
};
