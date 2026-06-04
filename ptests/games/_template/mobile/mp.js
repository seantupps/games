/**
 * Template mobile MP — re-export desktop; add touch suite when drag/pinch differs on phone.
 * Register as mobileMpAuditConfig only when needed; otherwise desktop-mp runs on mobile topology.
 */
const desktop = require('../desktop-mp');

async function beforeLoop(page1, page2, ctx = {}) {
    if (ctx.isMobile && typeof desktop.runMobileMpSuite === 'function') {
        await desktop.runMobileMpSuite(page1, page2, ctx);
        return;
    }
    return desktop.beforeLoop(page1, page2, ctx);
}

module.exports = {
    ...desktop,
    beforeLoop
};
