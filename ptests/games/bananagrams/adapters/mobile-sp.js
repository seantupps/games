/**
 * Bananagrams solo — mobile Playwright audit config.
 * Default: touch/UI mobile suite. --scenario=actions|placement|dump|peel|hub|ui → shared desktop-sp routing.
 */
const desktop = require('../runners/sp');
const { runBananagramsSpMobile } = require('./mobile-suite');
const {
    parseSpScenarioSlices,
    isSpActionsPlaythrough,
    isSpActionScenario
} = require('../scenarios/registry');

/** Full mobile touch suite unless a named scenario slice was requested. */
function useMobileTouchSuite(slices) {
    if (isSpActionsPlaythrough(slices)) return false;
    if (isSpActionScenario(slices)) return false;
    if (slices.length === 1 && slices[0] === 'hub') return false;
    if (slices.includes('ui')) return false;
    return true;
}

async function beforeLoop(page, ctx = {}) {
    const slices = parseSpScenarioSlices(process.argv, 'all');

    if (ctx.isMobile && useMobileTouchSuite(slices)) {
        await runBananagramsSpMobile(page);
        return;
    }

    return desktop.beforeLoop(page, ctx);
}

module.exports = {
    beforeLoop,
    skipGameLoop: true,
    gameMode: 'solo'
};
