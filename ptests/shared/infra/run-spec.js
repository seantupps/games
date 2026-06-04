/**
 * Unified RunSpec — mode, players, topology, game filter, scenario.
 * Env fallbacks: FIVE_RUN_MODE, FIVE_GAME, FIVE_SCENARIO, FIVE_PLAYERS, etc.
 */
const MODES = new Set(['all', 'hub', 'sp', 'mp']);
const TOPOLOGIES = new Set(['desktop', 'mobile', 'mixed', 'all']);
const SUPPORTED_MP_PLAYER_COUNTS = [2, 3];

/**
 * @typedef {object} RunSpec
 * @property {'all'|'hub'|'sp'|'mp'} mode
 * @property {number[]} playerCounts — MP counts to run (default [2] for mp)
 * @property {number} players — primary count (first entry; backward compat)
 * @property {'desktop'|'mobile'|'mixed'|'all'} topology — `all` runs desktop then mobile
 * @property {('desktop'|'mobile')[]} mixedLayout
 * @property {'default'|'extended'|'all'} suite
 * @property {string|null} game — comma-separated game id filters (e.g. bananagrams)
 * @property {string|null} scenario — forwarded to game audits (e.g. ui, hub, focus)
 * @property {boolean} skipPlatform
 * @property {boolean} slimAudit
 * @property {boolean} bundle
 * @property {boolean} freshContext
 * @property {boolean} headed
 * @property {boolean} keepBrowserOpen
 * @property {number|null} slowMo
 * @property {'host'|'guest'|null} winSide — MP AI play-to-win; null = random
 */

/**
 * @param {string|number|null|undefined} raw
 * @returns {number[]|null}
 */
function parsePlayerCounts(raw) {
    if (raw == null || raw === '') return null;
    const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    const counts = parts.map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
    if (!counts.length) {
        throw new Error(`Invalid --players=${raw}. Use 2, 3, or 2,3`);
    }
    const invalid = counts.filter((n) => !SUPPORTED_MP_PLAYER_COUNTS.includes(n));
    if (invalid.length) {
        throw new Error(`Unsupported player count(s): ${invalid.join(', ')}. Supported: ${SUPPORTED_MP_PLAYER_COUNTS.join(', ')}`);
    }
    return [...new Set(counts)].sort((a, b) => a - b);
}

/**
 * @param {RunSpec|{ playerCounts?: number[] }} spec
 * @param {number} n
 */
function includesPlayerCount(spec, n) {
    return (spec.playerCounts || []).includes(n);
}

/**
 * @param {RunSpec|{ playerCounts?: number[] }} spec
 * @param {number} n
 */
function isOnlyPlayerCount(spec, n) {
    const counts = spec.playerCounts || [];
    return counts.length === 1 && counts[0] === n;
}

/**
 * @param {number[]} playerCounts
 */
function formatPlayerCountsLabel(playerCounts) {
    if (!playerCounts?.length) return '2p';
    return playerCounts.length > 1 ? `${playerCounts.join('+')}p` : `${playerCounts[0]}p`;
}

/**
 * @param {string[]} [argv]
 * @returns {RunSpec}
 */
function parseRunSpec(argv = process.argv.slice(2)) {
    let mode = process.env.FIVE_RUN_MODE || 'all';
    let game = process.env.FIVE_GAME || process.env.npm_config_game || null;
    let scenario = process.env.FIVE_SCENARIO || process.env.npm_config_scenario || null;
    let skipPlatform = process.env.FIVE_MP_SKIP_PLATFORM === '1';
    let playerCounts = parsePlayerCounts(process.env.FIVE_PLAYER_COUNTS
        || process.env.FIVE_PLAYERS
        || process.env.npm_config_players
        || null);
    let topology = process.env.FIVE_TOPOLOGY || process.env.npm_config_topology || null;
    let mixedLayout = [];
    let suite = process.env.FIVE_MP_SUITE || process.env.npm_config_suite || 'default';
    let slimAudit = process.env.FIVE_MP_SLIM === '1' || process.env.npm_config_slim === 'true';
    let bundle = process.env.FIVE_MP_BUNDLE !== '0';
    let freshContext = process.env.FIVE_MP_FRESH_CONTEXT === '1';
    let headed = isHeadedRequested(argv);
    let keepBrowserOpen = process.env.FIVE_KEEP_BROWSER_OPEN === '1';
    let slowMo = Number(process.env.FIVE_SLOW_MO || process.env.npm_config_slow || 0) || null;
    let winSide = null;

    for (const arg of argv) {
        if (MODES.has(arg)) {
            mode = arg;
            continue;
        }
        if (arg === 'piles-line') {
            game = 'piles,line';
            skipPlatform = true;
            slimAudit = true;
            bundle = true;
            continue;
        }
        if (arg.startsWith('--game=')) {
            game = arg.slice('--game='.length);
            continue;
        }
        if (arg.startsWith('--scenario=')) {
            scenario = arg.slice('--scenario='.length);
            continue;
        }
        if (arg === '--skip-platform') {
            skipPlatform = true;
            continue;
        }
        if (arg === '--slim' || arg === '--smoke') {
            slimAudit = true;
            continue;
        }
        if (arg === '--full-audit') {
            slimAudit = false;
            continue;
        }
        if (arg === '--bundle') {
            bundle = true;
            continue;
        }
        if (arg === '--no-bundle') {
            bundle = false;
            continue;
        }
        if (arg === '--fresh-context') {
            freshContext = true;
            continue;
        }
        if (arg.startsWith('--players=')) {
            playerCounts = parsePlayerCounts(arg.slice('--players='.length));
            continue;
        }
        if (arg.startsWith('--topology=')) {
            topology = arg.slice('--topology='.length).toLowerCase();
            continue;
        }
        if (arg.startsWith('--layout=')) {
            mixedLayout = arg.slice('--layout='.length)
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter((s) => s === 'desktop' || s === 'mobile');
            topology = 'mixed';
            continue;
        }
        if (arg.startsWith('--suite=')) {
            suite = arg.slice('--suite='.length).toLowerCase();
            continue;
        }
        if (arg === '-h' || arg === '--h' || arg === '--headed') {
            headed = true;
            continue;
        }
        if (arg === '--open') {
            keepBrowserOpen = true;
            headed = true;
            continue;
        }
        if (arg === '--keep-open' || arg === '--keep-browser') {
            keepBrowserOpen = true;
            continue;
        }
        if (arg === '--help' || arg === '-?') {
            return { help: true };
        }
        if (arg === '--slow') {
            slowMo = 50;
            continue;
        }
        if (arg.startsWith('--slow=')) {
            slowMo = Number(arg.slice('--slow='.length));
            continue;
        }
        if (arg.startsWith('--win=')) {
            const { parseWinSideValue } = require('../../games/bananagrams/scenarios/registry');
            winSide = parseWinSideValue(arg.slice('--win='.length));
            continue;
        }
        if (arg === '--win') {
            throw new Error('Missing value for --win (use --win=host or --win=guest)');
        }

        if (arg.startsWith('-')) {
            throw new Error(`Unknown flag: ${arg} (try --help)`);
        }
        throw new Error(`Unexpected argument: ${arg} (use --game=name, not bare words)`);
    }

    if (!topology) {
        topology = 'desktop';
    }
    if (!TOPOLOGIES.has(topology)) {
        throw new Error(`Invalid --topology=${topology}. Use: ${[...TOPOLOGIES].join(', ')}`);
    }
    if (topology !== 'all' && process.env.FIVE_MOBILE === '1') topology = 'mobile';

    if (!playerCounts) {
        if (mode === 'sp') playerCounts = [1];
        else if (mode === 'mp') playerCounts = [2];
        else playerCounts = [1];
    }

    if (topology === 'mixed' && mixedLayout.length === 0 && isOnlyPlayerCount({ playerCounts }, 3)) {
        mixedLayout = ['desktop', 'desktop', 'mobile'];
    }

    if (!winSide && process.env.npm_config_win) {
        const { parseWinSideValue } = require('../../games/bananagrams/scenarios/registry');
        winSide = parseWinSideValue(process.env.npm_config_win);
    }

    if (game) {
        game = normalizeGameFilterString(game) || null;
    }

    return {
        mode,
        playerCounts,
        players: playerCounts[0],
        topology,
        mixedLayout,
        suite,
        game,
        scenario,
        skipPlatform,
        slimAudit,
        bundle,
        freshContext,
        headed,
        keepBrowserOpen,
        slowMo,
        winSide
    };
}

/**
 * @param {{ name: string, gameId: string }[]} rows
 * @param {string|null} game
 */
function filterAuditsByGame(rows, game) {
    if (!game) return rows;
    const keys = gameFilterKeys(game);
    if (!keys.length) return rows;
    return rows.filter((r) => {
        const id = r.gameId.toLowerCase();
        const name = r.name.toLowerCase();
        return keys.some((k) => id.includes(k) || name.includes(k));
    });
}

/** Short aliases → canonical game id substring used by filterAuditsByGame. */
const GAME_FILTER_ALIASES = {
    pile: 'piles',
    piles: 'piles',
    line: 'line',
    banana: 'bananagrams',
    bananagrams: 'bananagrams',
    ng: 'bananagrams'
};

function normalizeGameFilterToken(raw) {
    const k = String(raw || '').trim().toLowerCase();
    if (!k) return '';
    return GAME_FILTER_ALIASES[k] || k;
}

function gameFilterKeys(game) {
    if (!game) return [];
    return String(game).split(/[,\s]+/)
        .map((s) => normalizeGameFilterToken(s))
        .filter(Boolean);
}

function normalizeGameFilterString(game) {
    const keys = gameFilterKeys(game);
    return keys.length ? keys.join(',') : '';
}

function matchesGameFilter(game, gameId) {
    const keys = gameFilterKeys(game);
    if (!keys.length) return true;
    const id = gameId.toLowerCase();
    return keys.some((k) => id.includes(k));
}

function formatAuditLabel(spec) {
    const topo = spec.topology === 'all'
        ? 'desktop+mobile'
        : spec.topology === 'mixed'
            ? `mixed(${spec.mixedLayout.join('+') || '?'})`
            : spec.topology;
    const game = spec.game ? ` game=${spec.game}` : '';
    const scenario = spec.scenario ? ` scenario=${spec.scenario}` : '';
    const win = spec.winSide ? ` win=${spec.winSide}` : '';
    const players = formatPlayerCountsLabel(spec.playerCounts || [spec.players || 2]);
    return `${players} ${topo}${game}${scenario}${win}`;
}

function printRunHelp() {
    console.log(`Usage: node ptests/run.js <mode> [options]

Modes:
  sp          Solo / SP game audits (+ global hub when no --game)
  mp          Multiplayer audits
  hub         Lobby hub component suite only
  all         sp then mp (desktop)

Options:
  --game=ID         Filter to game(s): line, pile(s), bananagrams (comma-separated)
                    Aliases: pile→piles, banana→bananagrams
                    Examples: --game=line  --game=pile  --game=line,pile
  --scenario=NAME   Standard: smoke | default | full | focus
                    Bananagrams SP also: actions | placement | dump | peel | ui | hub
  --players=2|3|2,3  MP player counts (default: 2). Comma-separated runs each tier.
  --topology=desktop|mobile|mixed|all   all = run desktop then mobile
  --headed / -h     Show browser
  --open            Headed run; leave browser tabs open after tests (implies --headed)
  --keep-open       Same as --open (alias)
  --slow[=MS]       Slow down browser actions (default 50ms)
  --win=host|guest  MP AI play-to-win: force winner (default: random)
  --slim / --smoke  Shorter audits (smoke)
  --help

Examples:
  node ptests/run.js sp --game=bananagrams --scenario=actions
  node ptests/run.js sp --game=bananagrams --scenario=actions --headed --slow=100
  node ptests/run.js sp --game=bananagrams --scenario=placement,peel
  node ptests/run.js mp --players=2,3
  node ptests/run.js mp --game=bananagrams --players=3
  node ptests/run.js mp --game=bananagrams --scenario=actions --win=host
  node ptests/run.js hub
  node ptests/run.js mp piles-line

Mobile (same audits, emulated phone — no separate suite required for simple games):
  node ptests/run.js sp --game=line --topology=mobile
  node ptests/run.js sp --game=line --topology=all
  npm run sp:mobile --game=line
  npm run phone:path          real-device smoke (stack must be running)`);
}

const { applyPlaywrightHeadedMode, isHeadedRequested } = require('./env-defaults');

function applyRunSpecEnv(spec) {
    applyPlaywrightHeadedMode(!!spec.headed);
    if (spec.keepBrowserOpen) process.env.FIVE_KEEP_BROWSER_OPEN = '1';
    else delete process.env.FIVE_KEEP_BROWSER_OPEN;
    process.env.FIVE_RUN_MODE = spec.mode;
    if (spec.game) {
        process.env.FIVE_GAME = spec.game;
        delete process.env.FIVE_MP_ONLY;
        delete process.env.FIVE_AUDIT_ONLY;
    } else {
        delete process.env.FIVE_GAME;
    }
    if (spec.scenario) process.env.FIVE_SCENARIO = spec.scenario;
    else delete process.env.FIVE_SCENARIO;
    if (spec.skipPlatform) process.env.FIVE_MP_SKIP_PLATFORM = '1';
    else delete process.env.FIVE_MP_SKIP_PLATFORM;
    process.env.FIVE_PLAYER_COUNTS = spec.playerCounts.join(',');
    process.env.FIVE_PLAYERS = String(spec.playerCounts[0]);
    process.env.FIVE_TOPOLOGY = spec.topology;
    process.env.FIVE_MP_SUITE = spec.suite;
    if (spec.topology === 'mobile') process.env.FIVE_MOBILE = '1';
    else delete process.env.FIVE_MOBILE;
    if (spec.slimAudit) process.env.FIVE_MP_SLIM = '1';
    else delete process.env.FIVE_MP_SLIM;
    if (spec.freshContext) process.env.FIVE_MP_FRESH_CONTEXT = '1';
    else delete process.env.FIVE_MP_FRESH_CONTEXT;

    if (spec.slowMo) process.env.FIVE_SLOW_MO = String(spec.slowMo);
    else delete process.env.FIVE_SLOW_MO;
    if (spec.winSide) process.env.FIVE_MP_WIN_SIDE = spec.winSide;
    else delete process.env.FIVE_MP_WIN_SIDE;
}

module.exports = {
    MODES,
    TOPOLOGIES,
    SUPPORTED_MP_PLAYER_COUNTS,
    parseRunSpec,
    parsePlayerCounts,
    includesPlayerCount,
    isOnlyPlayerCount,
    formatPlayerCountsLabel,
    filterAuditsByGame,
    normalizeGameFilterToken,
    normalizeGameFilterString,
    gameFilterKeys,
    matchesGameFilter,
    formatAuditLabel,
    printRunHelp,
    applyRunSpecEnv
};
