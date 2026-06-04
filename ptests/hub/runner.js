/**
 * Hub audit runner — runs each component separately and reports pass/fail per id.
 *
 * Usage:
 *   node runner.js              # all components
 *   node runner.js invite       # one component (id or alias)
 *   HUB_ONLY=turn-layout node runner.js
 */
const { ensureStackQuick, runComponent } = require('./shared');
const { playwrightHeadless, playwrightSlowMo, shouldCloseBrowser } = require('../shared/infra/env-defaults');
const { runnerLog, printSuiteHeader, printBenchmarkResults, hubSubResultsToBenchmark } = require('../shared/infra/runner-results');

const COMPONENTS = [
    require('./desktop-shell'),
    require('./settings-toggle'),
    require('./solo-color'),
    require('./turn-layout'),
    require('./leave-party'),
    require('./invite'),
    require('./host-mode-sync')
];

const ALIASES = {
    shell: 'desktop-shell',
    settings: 'settings-toggle',
    solo: 'solo-color',
    turn: 'turn-layout',
    layout: 'turn-layout',
    invite: 'invite',
    party: 'invite',
    leave: 'leave-party',
    mode: 'host-mode-sync',
    sync: 'host-mode-sync'
};

const RUN_MODES = new Set(['hub', 'sp', 'mp', 'all']);

function resolveFilter(argv) {
    const fromEnv = process.env.HUB_COMPONENT;
    const positional = argv.slice(2).filter((a) => !a.startsWith('-') && !RUN_MODES.has(a));
    const fromArg = positional[0];
    const raw = (fromArg || fromEnv || '').trim().toLowerCase();
    if (!raw || raw === 'all') return null;
    const id = ALIASES[raw] || raw;
    const spec = COMPONENTS.find((c) => c.id === id);
    if (!spec) {
        const ids = COMPONENTS.map((c) => c.id).join(', ');
        const aliases = Object.keys(ALIASES).join(', ');
        throw new Error(`Unknown hub component "${raw}". ids: ${ids}. aliases: ${aliases}`);
    }
    return spec;
}

/**
 * @param {{ browser?: import('playwright').Browser, components?: typeof COMPONENTS, log?: boolean }} [opts]
 * @returns {Promise<Array<{ id: string, name: string, ok: boolean, ms: number, error?: string }>>}
 */
async function runAllComponents(opts = {}) {
    const list = opts.components || COMPONENTS;
    const log = opts.log !== false;
    const { chromium } = require('playwright');
    const ownsBrowser = !opts.browser;
    if (!opts.browser) await ensureStackQuick();
    const browser = opts.browser || await chromium.launch({
        headless: playwrightHeadless(),
        slowMo: playwrightSlowMo()
    });
    const results = [];
    try {
        for (const spec of list) {
            if (log) runnerLog(`--- hub/${spec.id}: ${spec.name} ---`);
            const result = await runComponent(spec, { browser, quiet: true });
            results.push(result);
        }
        return results;
    } finally {
        if (ownsBrowser && shouldCloseBrowser()) await browser.close().catch(() => { });
    }
}

async function main() {
    const totalStart = Date.now();
    const only = resolveFilter(process.argv);
    const list = only ? [only] : COMPONENTS;

    printSuiteHeader('HUB AUDIT (by component)');

    const hubSubResults = await runAllComponents({ components: list, log: true });
    const hubOk = hubSubResults.every((r) => r.ok);
    const results = [{
        name: only ? `Hub (${only.id})` : 'Hub',
        success: hubOk,
        duration: ((Date.now() - totalStart) / 1000).toFixed(2),
        subResults: hubSubResultsToBenchmark(hubSubResults),
        error: hubOk ? undefined : hubSubResults.filter((r) => !r.ok).map((r) => `[${r.id}] ${r.error}`).join('; ')
    }];

    const allPassed = printBenchmarkResults({
        results,
        totalDuration: results[0].duration,
        namePad: 16,
        title: 'BENCHMARK RESULTS'
    });

    if (!allPassed) process.exit(1);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('FAILURE:', err.message);
        process.exit(1);
    });
}

module.exports = { COMPONENTS, main, resolveFilter, runAllComponents };
