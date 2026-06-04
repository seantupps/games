#!/usr/bin/env node
/**
 * Unified ptests runner — mode, players, topology, --game, --scenario.
 */
require('./shared/infra/bootstrap');

const path = require('path');
const { spawn } = require('child_process');
const {
    parseRunSpec,
    applyRunSpecEnv,
    formatAuditLabel,
    printRunHelp,
    matchesGameFilter,
    includesPlayerCount,
    isOnlyPlayerCount
} = require('./shared/infra/run-spec');
const { awaitBrowserDismissal } = require('./shared/infra/env-defaults');

const ROOT = __dirname;

function forwardEnv(spec) {
    applyRunSpecEnv(spec);
}

function runNodeScript(relScript, extraArgv = []) {
    const script = path.join(ROOT, relScript);
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...extraArgv], {
            stdio: 'inherit',
            env: process.env,
            cwd: path.join(ROOT, '..')
        });
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${relScript} exited with code ${code}`));
        });
        child.on('error', reject);
    });
}

async function runHub() {
    const { main } = require('./hub/runner');
    return main();
}

async function runSp() {
    const { runSpSuite } = require('./platform/desktop/run-sp');
    return runSpSuite({ summarize: true });
}

function useFullMpSuite(spec) {
    return spec.mode === 'mp' && !spec.game && !spec.slimAudit;
}

function applyMpSuiteEnv(spec) {
    if (spec.suite !== 'default') {
        process.env.FIVE_MP_SUITE = spec.suite;
        return;
    }
    if (useFullMpSuite(spec)) {
        spec.suite = 'all';
        process.env.FIVE_MP_SUITE = 'all';
        return;
    }
    if (matchesGameFilter(spec.game, 'bananagrams')) {
        spec.suite = 'extended';
        process.env.FIVE_MP_SUITE = 'extended';
        spec.skipPlatform = true;
        process.env.FIVE_MP_SKIP_PLATFORM = '1';
    }
}

async function runMp3p(spec, opts = {}) {
    const summarize = opts.summarize !== false && spec.summarize !== false;
    const { runMp3pSuite } = require('./games/bananagrams/desktop-mp/mp_bananagrams_3p');
    const result = await runMp3pSuite({
        topology: spec.topology,
        scenario: spec.scenario,
        mobileAll: spec.topology === 'mobile',
        mixed: spec.topology === 'mixed',
        summarize,
        skipStackCheck: spec.skipStackCheck
    });
    if (summarize && !result.allPassed) {
        throw new Error(result.error || '3p MP suite failed');
    }
    return result;
}

async function runCombinedMpSuite(spec) {
    const { printSuiteHeader, printBenchmarkResults } = require('./shared/infra/runner-results');
    const summarize = spec.summarize !== false;
    const wants2 = includesPlayerCount(spec, 2);
    const wants3 = includesPlayerCount(spec, 3);
    const totalStart = Date.now();
    const isMobile = spec.topology === 'mobile';
    if (summarize) {
        printSuiteHeader(isMobile ? 'MOBILE MULTIPLAYER SUITE' : 'DESKTOP MULTIPLAYER SUITE');
    }

    const allResults = [];
    let priorPassed = true;

    if (wants2) {
        if (isMobile) {
            const { mainInner } = require('./platform/mobile/run-suite');
            const mobileOut = await mainInner({ ...spec, summarize: false, skipStackCheck: true });
            allResults.push(...mobileOut.results);
            priorPassed = mobileOut.allPassed;
        } else {
            const { runMpSuite } = require('./platform/desktop/run-mp');
            const mpOut = await runMpSuite({ summarize: false });
            allResults.push(...mpOut.results);
            priorPassed = mpOut.allPassed;
        }
    }

    if (wants3 && priorPassed) {
        const mp3Out = await runMp3p(
            { ...spec, game: spec.game || 'bananagrams', skipStackCheck: true },
            { summarize: false }
        );
        allResults.push(...mp3Out.results);
        priorPassed = priorPassed && mp3Out.allPassed;
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    const allPassed = allResults.length > 0 && allResults.every((r) => r.success) && priorPassed;

    if (summarize) {
        printBenchmarkResults({
            results: allResults,
            totalDuration,
            namePad: 28,
            title: 'BENCHMARK RESULTS'
        });
        if (!allPassed) {
            throw new Error('MP suite had failures');
        }
    }

    return { results: allResults, allPassed, totalDuration };
}

async function runMp(spec) {
    applyMpSuiteEnv(spec);
    const summarize = spec.summarize !== false;

    if (spec.slimAudit && spec.game?.includes('piles') && spec.topology !== 'mobile') {
        const { main } = require('./platform/desktop/run-mp-piles-line');
        const out = await main({ summarize });
        if (!summarize) return out;
        if (!out.allPassed) {
            throw new Error('MP piles-line smoke failed');
        }
        return out;
    }

    if (isOnlyPlayerCount(spec, 3)) {
        if (spec.game && !matchesGameFilter(spec.game, 'bananagrams')) {
            throw new Error(
                `3-player MP only supports bananagrams (got --game=${spec.game}). `
                + 'Use --game=bananagrams or omit --game.'
            );
        }
        return runMp3p(spec, { summarize });
    }

    const wantsBoth = includesPlayerCount(spec, 2) && includesPlayerCount(spec, 3);
    if (useFullMpSuite(spec) || wantsBoth) {
        return runCombinedMpSuite(spec);
    }

    if (includesPlayerCount(spec, 2)) {
        const { runMpSuite } = require('./platform/desktop/run-mp');
        const out = await runMpSuite({ summarize });
        if (!summarize) return out;
        if (!out.allPassed) {
            throw new Error('Desktop MP suite had failures');
        }
        return out;
    }

    return { allPassed: true, results: [] };
}

async function runMobile(spec) {
    applyMpSuiteEnv(spec);
    const wantsBoth = includesPlayerCount(spec, 2) && includesPlayerCount(spec, 3);
    if (spec.mode === 'mp' && (useFullMpSuite(spec) || wantsBoth)) {
        return runCombinedMpSuite({ ...spec, topology: 'mobile' });
    }
    const { mainInner } = require('./platform/mobile/run-suite');
    return mainInner(spec);
}

/**
 * Run one topology (desktop | mobile | mixed). When summarize is false, returns { allPassed, results }.
 * @param {import('./shared/infra/run-spec').RunSpec} spec
 */
async function runSingleTopology(spec) {
    const summarize = spec.summarize !== false;
    const { prefixResults } = require('./shared/infra/runner-results');

    if (spec.topology === 'mobile') {
        if (spec.mode === 'mp' && isOnlyPlayerCount(spec, 3)) {
            const out = await runMp3p(spec, { summarize });
            if (!summarize) return out;
            return;
        }
        const out = await runMobile({ ...spec, summarize: false });
        if (!summarize) return out;
        if (!out.allPassed) {
            throw new Error('Mobile test suite had failures');
        }
        return;
    }

    if (spec.mode === 'hub') {
        await runHub();
        return summarize ? undefined : { allPassed: true, results: [] };
    }

    if (spec.mode === 'all') {
        const { runSpSuite } = require('./platform/desktop/run-sp');
        const { printSuiteHeader, printBenchmarkResults } = require('./shared/infra/runner-results');
        const totalStart = Date.now();
        if (summarize) {
            printSuiteHeader('FULL RUN — SP + MP');
        }
        const spOut = await runSpSuite({ summarize: false });
        const mpOut = await runCombinedMpSuite({ ...spec, summarize: false });
        const results = [
            ...prefixResults(spOut.results, 'SP'),
            ...prefixResults(mpOut.results, 'MP')
        ];
        const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
        const allPassed = spOut.allPassed && mpOut.allPassed;
        if (summarize) {
            printBenchmarkResults({
                results,
                totalDuration,
                namePad: 32,
                title: 'ALL RESULTS'
            });
            if (!allPassed) {
                throw new Error('Combined SP+MP run had failures');
            }
            return;
        }
        return { allPassed, results, totalDuration };
    }

    if (spec.mode === 'sp') {
        if (summarize) {
            await runSp();
            return;
        }
        const { runSpSuite } = require('./platform/desktop/run-sp');
        return runSpSuite({ summarize: false });
    }

    if (spec.mode === 'mp') {
        if (summarize) {
            await runMp(spec);
            return;
        }
        return runMp({ ...spec, summarize: false });
    }

    throw new Error(`Unhandled run spec: ${JSON.stringify(spec)}`);
}

/**
 * Run desktop then mobile (hub runs once on desktop only).
 * @param {import('./shared/infra/run-spec').RunSpec} spec
 */
async function runAllTopologies(spec) {
    const { printSuiteHeader, printBenchmarkResults, prefixResults } = require('./shared/infra/runner-results');
    const summarize = spec.summarize !== false;
    const topologies = spec.mode === 'hub' ? ['desktop'] : ['desktop', 'mobile'];
    const totalStart = Date.now();
    const combined = [];
    let allPassed = true;

    for (const topology of topologies) {
        if (!allPassed) break;
        const child = { ...spec, topology, summarize: false };
        forwardEnv(child);
        applyMpSuiteEnv(child);

        if (summarize) {
            printSuiteHeader(`${topology.toUpperCase()} — ${spec.mode.toUpperCase()}${spec.game ? ` game=${spec.game}` : ''}`);
        }

        try {
            const out = await runSingleTopology(child);
            if (out?.results?.length) {
                combined.push(...prefixResults(out.results, topology));
            }
            if (out && out.allPassed === false) {
                allPassed = false;
            }
        } catch (err) {
            allPassed = false;
            combined.push({
                name: `${topology} ${spec.mode}`,
                success: false,
                duration: '0.00',
                error: err.message
            });
            break;
        }
    }

    if (summarize) {
        const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
        printBenchmarkResults({
            results: combined,
            totalDuration,
            namePad: 32,
            title: 'BENCHMARK RESULTS (desktop + mobile)'
        });
        if (!allPassed) {
            throw new Error('Dual-topology suite had failures');
        }
    }

    return { allPassed, results: combined };
}

async function main() {
    const spec = parseRunSpec(process.argv.slice(2));
    if (spec.help) {
        printRunHelp();
        return;
    }

    let failed = false;
    try {
        if (spec.topology === 'all') {
            await runAllTopologies(spec);
        } else {
            forwardEnv(spec);
            await runSingleTopology(spec);
        }
    } catch (err) {
        failed = true;
        throw err;
    } finally {
        await awaitBrowserDismissal();
        if (failed) process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err.message || err);
        process.exit(process.exitCode || 1);
    });
}

module.exports = {
    runCombinedMpSuite,
    runMp3p,
    runMp,
    runSp,
    runMobile,
    runSingleTopology,
    runAllTopologies,
    runHub
};
