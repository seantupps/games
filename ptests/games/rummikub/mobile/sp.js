/**
 * Rummikub solo mobile — capability + UI audit with touch pan/drag/pinch.
 */
const desktop = require('../runners/sp');

module.exports = {
    ...desktop,
    beforeLoop(page, ctx = {}) {
        return desktop.beforeLoop(page, { ...ctx, isMobile: true });
    }
};
