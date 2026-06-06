#!/usr/bin/env node
/**
 * Full local audit — one pass per topology, no duplicate platform checks.
 *
 *   Desktop: hub+SP, 2p MP (party + all games), 3p Bananagrams
 *   Mobile:  mobile hub shell, SP games, 2p MP games only (party/invite run on desktop)
 *   Optional: phone-path (--cross-client)
 *
 * Prereq: npm run stack
 *
 * Usage:
 *   npm run all
 *   npm run all -- --cross-client
 */
require('./shared/infra/bootstrap');
const { ensureRunConfig, setActiveRunConfig, createDefaultRunConfig } = require('./shared/infra/run-config');
ensureRunConfig(process.argv.slice(2));

const { ensureTestStack } = require('./shared/infra/emulator-utils');
const { printSuiteHeader, printBenchmarkResults, prefixResults, runnerLog } = require('./shared/infra/runner-results');
const { endPlaywrightRun } = require('./shared/infra/env-defaults');

function parseAllFlags(argv = process.argv.slice(2)) {
    const crossClient = argv.includes('--cross-client') || argv.includes('--phone-path');
    return { crossClient };
}

/** Minimal spec for embedded phases — avoid parseRunSpec([]) defaulting mode=all, players=1. */
function fullSuiteSpec(overrides = {}) {
    return {
        ...createDefaultRunConfig(),
        mode: 'mp',
        topology: 'desktop',
        playerCounts: [2],
        players: 2,
        suite: 'all',
        skipPlatform: false,
        summarize: false,
        skipStackCheck: true,
        ...overrides
    };
}

function activateSpec(spec) {
    setActiveRunConfig(spec);
    return spec;
}

/**
 * @param {string} phaseName
 * @param {() => Promise<{ results: import('./shared/infra/runner-results').BenchmarkResult[], allPassed?: boolean }>} fn
 */
async function runPhase(phaseName, fn) {
    const t0 = Date.now();
    try {
        const out = await fn();
        const results = prefixResults(out.results || [], phaseName);
        const allPassed = out.allPassed !== false && results.every((r) => r.success);
        runnerLog(`[phase] ${phaseName}: ${allPassed ? 'ok' : 'FAIL'} (${results.length} checks)`);
        return { results, allPassed };
    } catch (err) {
        runnerLog(`[phase] ${phaseName}: FAIL — ${err.message}`);
        return {
            results: [{
                name: phaseName,
                success: false,
                duration: ((Date.now() - t0) / 1000).toFixed(2),
                error: err.message
            }],
            allPassed: false
        };
    }
}

async function main(argv = process.argv.slice(2)) {
    const { crossClient } = parseAllFlags(argv);
    const totalStart = Date.now();
    printSuiteHeader('FULL SUITE — desktop + mobile', [
        crossClient ? '+ cross-client (phone-path)' : '(use --cross-client for phone-path)',
        'Platform checks (party/invite) on desktop only; per-topology game audits',
        'Full benchmark at the end'
    ]);

    await ensureTestStack();

    const allResults = [];

    const phases = [
        {
            name: 'Desktop SP',
            run: async () => {
                const spec = activateSpec(fullSuiteSpec({ mode: 'sp' }));
                const { runSpSuite } = require('./platform/desktop/run-sp');
                return runSpSuite({ summarize: false, spec });
            }
        },
        {
            name: 'Desktop MP 2p',
            run: async () => {
                const spec = activateSpec(fullSuiteSpec({
                    topology: 'desktop',
                    playerCounts: [2],
                    players: 2
                }));
                const { runCombinedMpSuite } = require('./run');
                return runCombinedMpSuite(spec);
            }
        },
        {
            name: 'Desktop MP 3p',
            run: async () => {
                const spec = activateSpec(fullSuiteSpec({
                    topology: 'desktop',
                    game: 'bananagrams',
                    playerCounts: [3],
                    players: 3
                }));
                const { runMp3p } = require('./run');
                return runMp3p(spec, { summarize: false });
            }
        },
        {
            name: 'Mobile hub',
            run: async () => {
                const { launchMobileBrowser } = require('./platform/mobile/lib/mobile-utils');
                const { runHubSuite } = require('./platform/mobile/hub/hub_suite');
                const browser = await launchMobileBrowser();
                try {
                    const hub = await runHubSuite(browser);
                    if (hub.failed) {
                        return { results: hub.results, allPassed: false };
                    }
                    return { results: hub.results, allPassed: true };
                } finally {
                    await browser.close().catch(() => { });
                }
            }
        },
        {
            name: 'Mobile SP',
            run: async () => {
                const spec = activateSpec(fullSuiteSpec({
                    mode: 'sp',
                    topology: 'mobile'
                }));
                const { mainInner } = require('./platform/mobile/run-suite');
                return mainInner(spec);
            }
        },
        {
            name: 'Mobile MP 2p',
            run: async () => {
                const spec = activateSpec(fullSuiteSpec({
                    mode: 'mp',
                    topology: 'mobile',
                    playerCounts: [2],
                    players: 2,
                    skipPlatform: true
                }));
                const { runCombinedMpSuite } = require('./run');
                return runCombinedMpSuite(spec);
            }
        },
        {
            name: 'Mobile MP 3p',
            run: async () => {
                const spec = activateSpec(fullSuiteSpec({
                    topology: 'mobile',
                    game: 'bananagrams',
                    playerCounts: [3],
                    players: 3
                }));
                const { runMp3p } = require('./run');
                return runMp3p(spec, { summarize: false });
            }
        }
    ];

    if (crossClient) {
        phases.push({
            name: 'Phone path',
            run: async () => {
                const { runPhonePathSuite } = require('./platform/cross-client/run_phone_path');
                return runPhonePathSuite({ summarize: false });
            }
        });
    }

    for (const phase of phases) {
        const out = await runPhase(phase.name, phase.run);
        allResults.push(...out.results);
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    const allPassed = allResults.length > 0 && allResults.every((r) => r.success);

    printBenchmarkResults({
        results: allResults,
        totalDuration,
        namePad: 40,
        title: 'FULL SUITE — ALL RESULTS'
    });

    if (!allPassed) {
        process.exit(1);
    }
}

module.exports = { main, parseAllFlags, runPhase, fullSuiteSpec };

if (require.main === module) {
    main()
        .catch((err) => {
            console.error(err.message || err);
            process.exit(1);
        })
        .finally(() => endPlaywrightRun());
}
