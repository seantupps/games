/**
 * Bananagrams MP audit router — delegates to scenarios/mp/* modules.
 * Accepts pages[] (N-player) or legacy (page1, page2, options).
 */
const lib = require('../../lib/mp-state');
const { buildScenarioContext, assertScenarioForSession } = require('../../scenarios/mp/contract');
const { getMpScenario, normalizeScenarioId } = require('../../scenarios/mp/index');
const { parseScenarioArgv } = require('../../scenarios/registry');

/**
 * Normalize runner args to { pages, options }.
 * @param {import('playwright').Page[]|import('playwright').Page} pagesOrP1
 * @param {import('playwright').Page|object} [page2OrOpts]
 * @param {object} [legacyOpts]
 */
function resolveAuditArgs(pagesOrP1, page2OrOpts, legacyOpts = {}) {
    if (Array.isArray(pagesOrP1)) {
        return { pages: pagesOrP1, options: page2OrOpts || {} };
    }
    return {
        pages: [pagesOrP1, page2OrOpts],
        options: legacyOpts
    };
}

/**
 * @param {import('playwright').Page[]|import('playwright').Page} pagesOrP1
 * @param {import('playwright').Page|object} [page2OrOpts]
 * @param {object} [legacyOpts]
 */
async function runBananagramsMpAudit(pagesOrP1, page2OrOpts, legacyOpts = {}) {
    const { pages, options } = resolveAuditArgs(pagesOrP1, page2OrOpts, legacyOpts);
    if (!pages.length || pages.length < 2) {
        throw new Error(`runBananagramsMpAudit requires at least 2 pages (got ${pages.length})`);
    }

    const scenarioId = normalizeScenarioId(options.scenario ?? parseScenarioArgv(process.argv, 'full'));
    const scenario = getMpScenario(scenarioId);
    const mobile = !!options.mobile;
    const roomId = options.roomId
        || `MP_AUDIT_BANANA_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const skipSeed = !!options.skipSeed;
    const platform = mobile ? 'mobile' : 'desktop';
    const playerCount = pages.length;

    assertScenarioForSession(scenario, { platform, playerCount });

    lib.log(
        `MP scenario "${scenarioId}" (${scenario.meta.kind}, ${platform}, ${playerCount}p)`
    );

    const scenarioCtx = buildScenarioContext(pages, {
        roomId,
        mobile,
        skipSeed,
        options,
        playerDefs: options.playerDefs
    });
    return scenario.run(scenarioCtx);
}

module.exports = { runBananagramsMpAudit, resolveAuditArgs };
