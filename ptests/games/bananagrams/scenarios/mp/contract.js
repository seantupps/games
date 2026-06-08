/**
 * MP scenario contract — flags select intentions, not files.
 *
 * @typedef {'real-gameplay'|'micro-fixture'} MpScenarioKind
 * @typedef {'desktop'|'mobile'} MpPlatform
 * @typedef {'2p'|'3p'|'4p'|string} MpTopology
 * @typedef {'invite'|'sequential'|'seed'} MpJoinMode
 *
 * @typedef {object} MpPlayerSlot
 * @property {string} uid
 * @property {string} name
 * @property {string} color
 * @property {string} role
 * @property {number} index
 * @property {import('playwright').Page} page
 * @property {import('playwright').Frame|null} [frame]
 *
 * @typedef {object} MpBagInfo
 * @property {number} total
 * @property {number} startingHand
 * @property {number} expectedPoolAfterDeal
 *
 * @typedef {object} MpCtx
 * @property {MpTopology} topology
 * @property {number} playerCount
 * @property {MpPlayerSlot} host
 * @property {MpPlayerSlot[]} players
 * @property {MpPlayerSlot[]} remotes — non-host clients
 * @property {import('playwright').Page[]} pages
 * @property {import('playwright').Frame[]} [frames]
 * @property {string|null} roomId
 * @property {boolean} mobile
 * @property {MpBagInfo} bag
 * @property {{ pages: import('playwright').Page[], page1?: import('playwright').Page, page2?: import('playwright').Page }} mp
 * @property {string[]} uids
 * @property {object} [options]
 *
 * @typedef {object} MpScenarioMeta
 * @property {string} id
 * @property {MpScenarioKind} kind
 * @property {string} description
 * @property {MpPlatform[]} platforms
 * @property {number[]} playerCounts — supported session sizes (e.g. [2], [2, 3])
 * @property {MpJoinMode} [joinMode] — how players enter the room
 * @property {boolean} requiresFreshRoom
 * @property {boolean} mutatesAuthority
 * @property {string[]} assertions
 *
 * @typedef {object} MpScenarioContext
 * @property {MpCtx} ctx
 * @property {import('playwright').Page} page1 — @deprecated use ctx.pages[0]
 * @property {import('playwright').Page} page2 — @deprecated use ctx.pages[1]
 * @property {boolean} mobile
 * @property {string} roomId
 * @property {object} mp
 * @property {boolean} skipSeed
 * @property {object} [options]
 *
 * @typedef {object} MpScenarioModule
 * @property {MpScenarioMeta} meta
 * @property {(ctx: MpScenarioContext) => Promise<unknown>} run
 */

/**
 * @param {MpScenarioMeta} meta
 * @param {(ctx: MpScenarioContext) => Promise<unknown>} run
 * @returns {MpScenarioModule}
 */
function defineMpScenario(meta, run) {
    if (!meta.id || !meta.kind || !meta.description) {
        throw new Error('MpScenarioMeta requires id, kind, description');
    }
    if (!Array.isArray(meta.platforms) || !meta.platforms.length) {
        throw new Error(`Scenario ${meta.id}: platforms required`);
    }
    const normalized = {
        playerCounts: [2],
        joinMode: 'invite',
        ...meta
    };
    if (!Array.isArray(normalized.playerCounts) || !normalized.playerCounts.length) {
        throw new Error(`Scenario ${meta.id}: playerCounts required`);
    }
    return { meta: normalized, run };
}

/**
 * Build scenario context from pages + room (runners call this).
 * @param {import('playwright').Page[]} pages
 * @param {object} opts
 * @returns {MpScenarioContext}
 */
function buildScenarioContext(pages, opts = {}) {
    const { buildMpCtxFromPages } = require('../../lib/mp-ctx');
    const ctx = buildMpCtxFromPages(pages, opts.playerDefs, {
        roomId: opts.roomId,
        mobile: opts.mobile,
        frames: opts.frames,
        options: opts.options
    });
    return {
        ctx,
        page1: pages[0],
        page2: pages[1] || pages[0],
        mobile: !!opts.mobile,
        roomId: opts.roomId,
        mp: ctx.mp,
        skipSeed: !!opts.skipSeed,
        options: opts.options || {}
    };
}

/**
 * @param {MpScenarioModule} scenario
 * @param {MpPlatform} platform
 */
function supportsPlatform(scenario, platform) {
    return scenario.meta.platforms.includes(platform);
}

/**
 * @param {MpScenarioModule} scenario
 * @param {number} playerCount
 */
function supportsPlayerCount(scenario, playerCount) {
    return scenario.meta.playerCounts.includes(playerCount);
}

/**
 * Validate scenario vs session before run.
 * @param {MpScenarioModule} scenario
 * @param {{ platform?: MpPlatform, playerCount: number }} session
 */
function assertScenarioForSession(scenario, session) {
    const { platform, playerCount } = session;
    if (platform && !supportsPlatform(scenario, platform)) {
        throw new Error(
            `Scenario "${scenario.meta.id}" does not support ${platform} `
            + `(platforms: ${scenario.meta.platforms.join(', ')})`
        );
    }
    if (!supportsPlayerCount(scenario, playerCount)) {
        throw new Error(
            `Scenario "${scenario.meta.id}" does not support ${playerCount} players `
            + `(playerCounts: ${scenario.meta.playerCounts.join(', ')})`
        );
    }
}

module.exports = {
    defineMpScenario,
    buildScenarioContext,
    supportsPlatform,
    supportsPlayerCount,
    assertScenarioForSession
};
