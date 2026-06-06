/**
 * Registry-driven test matrix for SP and MP runners.
 */
require('./bootstrap');

const path = require('path');
const { formatAuditLabel } = require('./run-spec');
const GameRegistry = require('../../../shared/games/registry');

const ROOT = path.resolve(__dirname, '../../..');

function resolveAuditConfig(rel) {
    if (!rel) return null;
    const base = path.join(ROOT, rel);
    try {
        return require(base);
    } catch (e) {
        throw new Error(`Failed to load audit config: ${rel} (${e.message})`);
    }
}

function auditPathFor(game, mode, { mobile = false } = {}) {
    if (mobile) {
        const mobilePath = GameRegistry.mobileAuditPathFor(game.id, mode);
        if (mobilePath) return mobilePath;
    }
    return GameRegistry.auditPathFor(game.id, mode);
}

function mpAuditPathFor(game, mode, { mobile = false } = {}) {
    if (mobile) {
        const mobilePath = GameRegistry.mobileMpAuditPathFor(game.id, mode);
        if (mobilePath) return mobilePath;
    }
    return GameRegistry.mpAuditPathFor(game.id, mode);
}

/**
 * MP suite tiers (registry `mpSuite` on each game, default 'default'):
 * - default: piles, line — included in `npm run test:mp`
 * - extended: bananagrams full MP — `node ptests/run.js mp` (full suite) or `--game=bananagrams`
 * - all: same as extended
 */
function resolveMpSuiteFilter(opts = {}) {
    if (opts.suite) return String(opts.suite).toLowerCase();
    try {
        const { getActiveRunConfig } = require('./run-config');
        return String(getActiveRunConfig().suite || 'default').toLowerCase();
    } catch (_) {
        return 'default';
    }
}

function includeGameInMpSuite(game, suiteFilter) {
    const tier = game.mpSuite || 'default';
    if (suiteFilter === 'all' || suiteFilter === 'extended') return true;
    if (suiteFilter === 'default') return tier === 'default';
    return tier === suiteFilter;
}

/**
 * @returns {{ name: string, gameId: string, gameMode: string, config: object }[]}
 */
function buildSingleplayerAudits(opts = {}) {
    const rows = [];
    const topology = opts.topology || 'desktop';
    const topoTag = topology === 'desktop' ? '' : ` [${topology}]`;
    for (const game of GameRegistry.list()) {
        for (const mode of game.modes) {
            const rel = auditPathFor(game, mode, opts);
            const config = resolveAuditConfig(rel);
            if (!config) continue;
            const modeLabel = game.modes.length > 1 ? ` (${mode})` : '';
            rows.push({
                name: `SP ${game.label}${modeLabel}${topoTag}`,
                gameId: game.id,
                gameMode: mode,
                players: 1,
                topology,
                config: { ...config, gameMode: mode }
            });
        }
    }
    return rows;
}

/**
 * @returns {{ name: string, gameId: string, gameMode: string, config: object }[]}
 */
function buildMultiplayerAudits(opts = {}) {
    const rows = [];
    const suiteFilter = resolveMpSuiteFilter(opts);
    const players = opts.players ?? 2;
    const topology = opts.topology || (opts.mobile ? 'mobile' : 'desktop');
    const topoSuffix = ` [${formatAuditLabel({ players, topology, mixedLayout: opts.mixedLayout || [] })}]`;

    for (const game of GameRegistry.list()) {
        if (!includeGameInMpSuite(game, suiteFilter)) continue;
        if (!GameRegistry.supportsMpPlayerCount(game.id, players)) continue;

        if (players === 3 && game.mpAudit3p) {
            rows.push({
                name: `MP ${game.label} (3p)${topoSuffix}`,
                gameId: game.id,
                gameMode: game.hubModeInParty || game.defaultMode,
                players: 3,
                topology,
                customRunner: game.mpAudit3p,
                config: {}
            });
            continue;
        }

        for (const mode of game.modes) {
            const rel = GameRegistry.mpAuditPathForPlayerCount(game.id, mode, players, opts)
                || mpAuditPathFor(game, mode, opts);
            const config = resolveAuditConfig(rel);
            if (!config) continue;
            const modeLabel = game.modes.length > 1 ? ` (${mode})` : '';
            rows.push({
                name: `MP ${game.label}${modeLabel}${topoSuffix}`,
                gameId: game.id,
                gameMode: mode,
                players,
                topology,
                config: { ...config, gameMode: mode }
            });
        }
    }
    return rows;
}

/**
 * Filter manifest rows by display name (for bundle runners).
 * @param {{ name: string }[]} rows
 * @param {Set<string>|string[]} names
 */
function filterAuditsByName(rows, names) {
    const set = names instanceof Set ? names : new Set(names);
    return rows.filter((r) => set.has(r.name));
}

/** @param {ReturnType<typeof buildMultiplayerAudits>} rows */
function partitionMpBySuite(rows) {
    const defaultTier = [];
    const extendedTier = [];
    for (const row of rows) {
        const tier = GameRegistry.get(row.gameId)?.mpSuite || 'default';
        if (tier === 'extended') extendedTier.push(row);
        else defaultTier.push(row);
    }
    return { defaultTier, extendedTier };
}

module.exports = {
    buildSingleplayerAudits,
    buildMultiplayerAudits,
    filterAuditsByName,
    partitionMpBySuite,
    resolveMpSuiteFilter,
    includeGameInMpSuite,
    GameRegistry
};
