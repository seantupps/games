/**
 * Unified RunConfig — parsed once from argv only.
 * Run flags are not read from env; use getActiveRunConfig() downstream.
 */
const MODES = new Set(['all', 'hub', 'sp', 'mp']);
const TOPOLOGIES = new Set(['desktop', 'mobile', 'mixed', 'all']);
const SUPPORTED_MP_PLAYER_COUNTS = [2, 3];

/**
 * @typedef {object} RunConfig
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
 * @property {boolean} manualTest — --test: boot session only, skip all audits
 * @property {number|null} slowMo
 * @property {'host'|'guest'|null} winSide — MP AI play-to-win; null = random
 * @property {number} rounds — full games per party session (default 1)
 * @property {boolean} pause — wait in post-game review for manual Done between rounds
 * @property {boolean} [headedLayout] — tile headed MP windows (default true when headed)
 * @property {boolean} [headedCenter] — center game viewport in headed mode
 * @property {boolean} [headedChat] — enable headed hub chat helper
 * @property {boolean} [headedMobileViewportProbe] — assert emulated mobile viewport in headed runs
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
 * @returns {RunConfig}
 */
function parseRunSpec(argv = process.argv.slice(2)) {
    let mode = 'all';
    let game = null;
    let scenario = null;
    let skipPlatform = false;
    let playerCounts = null;
    let topology = null;
    let mixedLayout = [];
    let suite = 'default';
    let slimAudit = false;
    let bundle = true;
    let freshContext = false;
    let headed = false;
    let keepBrowserOpen = false;
    let manualTest = false;
    let slowMo = null;
    let winSide = null;
    let rounds = 1;
    let pause = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
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
        if (arg === '--test') {
            manualTest = true;
            headed = true;
            keepBrowserOpen = true;
            scenario = null;
            skipPlatform = true;
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
            const n = Number(arg.slice('--slow='.length));
            if (!Number.isFinite(n) || n < 0) {
                throw new Error(`Invalid --slow=${arg.slice('--slow='.length)}. Use a non-negative number of ms.`);
            }
            slowMo = n;
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
        if (arg.startsWith('--rounds=')) {
            const n = parseInt(arg.slice('--rounds='.length), 10);
            if (!Number.isFinite(n) || n < 1) {
                throw new Error(`Invalid --rounds=${arg.slice('--rounds='.length)}. Use a positive integer.`);
            }
            rounds = n;
            continue;
        }
        if (arg === '--rounds') {
            const next = argv[i + 1];
            if (!next || next.startsWith('-')) {
                throw new Error('Missing value for --rounds (use --rounds=2 or --rounds 2)');
            }
            const n = parseInt(next, 10);
            if (!Number.isFinite(n) || n < 1) {
                throw new Error(`Invalid --rounds ${next}. Use a positive integer.`);
            }
            rounds = n;
            i += 1;
            continue;
        }
        if (arg === '--pause') {
            pause = true;
            continue;
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
    if (!playerCounts) {
        if (mode === 'sp') playerCounts = [1];
        else if (mode === 'mp') playerCounts = [2];
        else playerCounts = [1];
    }

    if (topology === 'mixed' && mixedLayout.length === 0 && isOnlyPlayerCount({ playerCounts }, 3)) {
        mixedLayout = ['desktop', 'desktop', 'mobile'];
    }

    if (game) {
        game = normalizeGameFilterString(game) || null;
    }

    ({ headed, keepBrowserOpen, manualTest } = finalizeDisplayFlags({ headed, keepBrowserOpen, manualTest }));
    if (manualTest) {
        scenario = null;
        skipPlatform = true;
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
        manualTest,
        slowMo,
        winSide,
        rounds,
        pause,
        headedLayout: true,
        headedCenter: true,
        headedChat: true,
        headedMobileViewportProbe: false
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
    const rounds = spec.rounds > 1 ? ` rounds=${spec.rounds}` : '';
    const pause = spec.pause ? ' pause' : '';
    const players = formatPlayerCountsLabel(spec.playerCounts || [spec.players || 2]);
    return `${players} ${topo}${game}${scenario}${win}${rounds}${pause}`;
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
  --test            Manual test — boot party/solo only; skip scenarios, hub, and audits (implies --headed --open)
  --slow[=MS]       Delay MS between test actions + Playwright slowMo (default 50)
  --win=host|guest  MP AI play-to-win: force winner (default: random)
  --rounds=N        Play N full games in the same session (default: 1; also --rounds N)
                    Bananagrams MP: N>1 implies --scenario=actions (AI playthrough only)
  --pause           Pause in post-game review; press Done on host to continue (--rounds)
  --slim / --smoke  Shorter audits (smoke)
  --help

Examples:
  node ptests/run.js sp --game=bananagrams --scenario=actions
  node ptests/run.js mp --game=bananagrams --players=2 --scenario=actions
  node ptests/run.js mp --game=bananagrams --scenario=actions --win=host
  node ptests/run.js mp --game=bananagrams --scenario=actions --rounds=2 --pause --headed --open
  node ptests/run.js hub

Blessed npm scripts (flags baked into package.json — use these with npm):
  npm run mp:banana:actions
  npm run mp:banana:desktop:actions
  npm run mp:banana:mobile:actions
  npm run mp:headed          (add --headed via script; combine with :banana:* scripts)

Note: npm run mp --game=foo does NOT pass flags on Windows — use node ... or a :banana:* script.`);
}

/**
 * Display rules (dead simple):
 *   default → headless, close
 *   --headed → visible, still close
 *   --open → visible, keep open
 *   --test → visible, keep open, manual boot
 * @param {{ headed: boolean, keepBrowserOpen: boolean, manualTest: boolean }} flags
 */
function finalizeDisplayFlags(flags) {
    if (flags.manualTest) {
        return { headed: true, keepBrowserOpen: true, manualTest: true };
    }
    if (flags.keepBrowserOpen) {
        return { headed: true, keepBrowserOpen: true, manualTest: false };
    }
    if (flags.headed) {
        return { headed: true, keepBrowserOpen: false, manualTest: false };
    }
    return { headed: false, keepBrowserOpen: false, manualTest: false };
}

/** Infer scenario side effects on spec (no env writes). */
function finalizeRunConfig(spec) {
    if (spec.manualTest) {
        spec.scenario = null;
        spec.skipPlatform = true;
        return spec;
    }
    if (!spec.scenario) {
        try {
            const { inferBananagramsMpScenario } = require('../../games/bananagrams/scenarios/registry');
            const inferred = inferBananagramsMpScenario(spec);
            if (inferred) spec.scenario = inferred;
        } catch (_) { /* registry optional */ }
    }
    return spec;
}

/** @deprecated use finalizeRunConfig + setActiveRunConfig — does not touch process.env */
function applyRunConfigEnv(spec) {
    return finalizeRunConfig(spec);
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
    finalizeDisplayFlags,
    finalizeRunConfig,
    applyRunConfigEnv,
    /** @deprecated use finalizeRunConfig */
    applyRunSpecEnv: applyRunConfigEnv
};
