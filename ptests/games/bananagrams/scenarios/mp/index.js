/**
 * MP scenario registry — flags select intentions via metadata, not file paths.
 */
const { supportsPlatform, supportsPlayerCount, assertScenarioForSession } = require('./contract');
const full = require('./full');
const sync = require('./sync');
const actions = require('./actions');
const solve = require('./solve');
const review = require('./review');
const focus = require('./focus');
const join = require('./join');
const ctxProof = require('./ctx-proof');
const template = require('./template');
const peelRegisterRepro = require('./peel-register-repro-3p');
const dumpRemoveTile = require('./dump-remove-tile');
const dumpLanVisible = require('./dump-lan-visible');
const guestDoubleDump = require('./guest-double-dump');
const guestDumpBannerRepro = require('./guest-dump-banner-repro');

/** @type {Record<string, import('./contract').MpScenarioModule>} */
const MP_SCENARIOS = {
    full,
    sync,
    actions,
    solve,
    review,
    focus,
    join,
    'ctx-proof': ctxProof,
    template,
    'peel-register-repro': peelRegisterRepro,
    'dump-remove-tile': dumpRemoveTile,
    'dump-lan-visible': dumpLanVisible,
    'guest-double-dump': guestDoubleDump,
    'guest-dump-banner-repro': guestDumpBannerRepro
};

const ALIASES = {
    'last-bunch': 'review'
};

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeScenarioId(raw) {
    const id = String(raw || 'full').trim().toLowerCase();
    return ALIASES[id] || id;
}

/**
 * @param {string} id
 * @returns {import('./contract').MpScenarioModule}
 */
function getMpScenario(id) {
    const key = normalizeScenarioId(id);
    const scenario = MP_SCENARIOS[key];
    if (!scenario) {
        throw new Error(
            `Unknown MP scenario "${id}". `
            + `Use: ${Object.keys(MP_SCENARIOS).join(', ')}`
        );
    }
    return scenario;
}

function listMpScenarioMeta() {
    return Object.values(MP_SCENARIOS).map((s) => s.meta);
}

/**
 * @param {string} id
 * @param {'desktop'|'mobile'} platform
 */
function scenarioSupportsPlatform(id, platform) {
    return supportsPlatform(getMpScenario(id), platform);
}

/**
 * @param {string} id
 * @param {number} playerCount
 */
function scenarioSupportsPlayerCount(id, playerCount) {
    return supportsPlayerCount(getMpScenario(id), playerCount);
}

/**
 * Scenarios compatible with a session (platform + player count).
 * @param {{ platform?: 'desktop'|'mobile', playerCount: number }} session
 */
function listScenariosForSession(session) {
    return Object.values(MP_SCENARIOS).filter((s) => {
        if (session.platform && !supportsPlatform(s, session.platform)) return false;
        return supportsPlayerCount(s, session.playerCount);
    });
}

module.exports = {
    MP_SCENARIOS,
    ALIASES,
    normalizeScenarioId,
    getMpScenario,
    listMpScenarioMeta,
    scenarioSupportsPlatform,
    scenarioSupportsPlayerCount,
    listScenariosForSession,
    assertScenarioForSession
};
