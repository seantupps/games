#!/usr/bin/env node
/**
 * Unified ptests runner — mode, players, topology, --game, --scenario.
 */
require('./shared/infra/bootstrap');

const path = require('path');
const { spawn } = require('child_process');
const {
    formatAuditLabel,
    printRunHelp,
    matchesGameFilter,
    includesPlayerCount,
    isOnlyPlayerCount
} = require('./shared/infra/run-spec');
const { initRunConfig, setActiveRunConfig } = require('./shared/infra/run-config');
const { endPlaywrightRun } = require('./shared/infra/env-defaults');

const ROOT = __dirname;

function forwardConfig(spec) {
    setActiveRunConfig(spec);
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

async function runSp(spec) {
    const { runSpSuite } = require('./platform/desktop/run-sp');
    return runSpSuite({ summarize: false, spec });
}

function useFullMpSuite(spec) {
    return spec.mode === 'mp' && !spec.game && !spec.slimAudit;
}

function applyMpSuiteDefaults(spec) {
    if (spec.suite !== 'default') return;
    if (useFullMpSuite(spec)) {
        spec.suite = 'all';
        return;
    }
    if (matchesGameFilter(spec.game, 'bananagrams')) {
        spec.suite = 'extended';
        spec.skipPlatform = true;
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
    const { printSuiteHeader, emitBenchmarkSummary } = require('./shared/infra/runner-results');
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
            const mpOut = await runMpSuite({ summarize: false, spec });
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

    const out = { results: allResults, allPassed, totalDuration };

    if (summarize) {
        emitBenchmarkSummary(out, {
            namePad: 28,
            failMessage: 'MP suite had failures'
        });
    }

    return out;
}

async function runMp(spec) {
    applyMpSuiteDefaults(spec);
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
        const out = await runMpSuite({ summarize, spec });
        if (!summarize) return out;
        if (!out.allPassed) {
            throw new Error('Desktop MP suite had failures');
        }
        return out;
    }

    return { allPassed: true, results: [] };
}

async function runMobile(spec) {
    applyMpSuiteDefaults(spec);
    const wantsBoth = includesPlayerCount(spec, 2) && includesPlayerCount(spec, 3);
    if (spec.mode === 'mp' && (useFullMpSuite(spec) || wantsBoth)) {
        return runCombinedMpSuite({ ...spec, topology: 'mobile' });
    }
    const { mainInner } = require('./platform/mobile/run-suite');
    return mainInner(spec);
}

function printRunSuiteHeader(spec) {
    const { printSuiteHeader } = require('./shared/infra/runner-results');
    if (spec.mode === 'mp' && isOnlyPlayerCount(spec, 3)) {
        printSuiteHeader('BANANAGRAMS MP 3P', [
            `${spec.topology || 'desktop'}${spec.topology === 'mobile' ? ', all mobile' : ''}`,
            spec.scenario ? `scenario=${spec.scenario}` : 'full audit'
        ]);
        return;
    }
    if (spec.topology === 'mobile') {
        const { resolveDeviceName } = require('./platform/mobile/lib/mobile-utils');
        const device = resolveDeviceName();
        printSuiteHeader('MOBILE PLAYWRIGHT SUITE (EMULATED)', [
            `Device: ${device}  |  ${process.env.FIVE_BASE_URL}`,
            `mode=${spec.mode}${spec.game ? ` game=${spec.game}` : ''}${spec.scenario ? ` scenario=${spec.scenario}` : ''}${spec.skipPlatform ? ' (no platform)' : ''}`
        ]);
        return;
    }
    if (spec.mode === 'all') {
        printSuiteHeader('FULL RUN — SP + MP');
    } else if (spec.mode === 'sp') {
        printSuiteHeader('SINGLE-LAUNCH CONCURRENT BENCHMARK RUNNER');
    } else if (spec.mode === 'mp') {
        printSuiteHeader('DESKTOP MULTIPLAYER SUITE');
    }
}

function resolveBenchmarkTarget(spec) {
    if (spec.mode === 'sp' && !spec.game) return 3.0;
    if (spec.topology === 'mobile' && spec.mode === 'mp' && spec.scenario === 'actions') {
        return Number(process.env.FIVE_MOBILE_MP_TARGET_S || 10);
    }
    return null;
}

function benchmarkNamePad(spec) {
    if (spec.mode === 'all') return 32;
    if (spec.topology === 'mobile' || spec.mode === 'mp') return 28;
    return 16;
}

function benchmarkTitle(spec) {
    return spec.mode === 'all' ? 'ALL RESULTS' : 'BENCHMARK RESULTS';
}

function benchmarkFailMessage(spec) {
    if (spec.topology === 'mobile') return 'Mobile test suite had failures';
    if (spec.mode === 'sp') return 'SP suite had failures';
    if (spec.mode === 'mp') return 'Desktop MP suite had failures';
    if (spec.mode === 'all') return 'Combined SP+MP run had failures';
    return 'Suite had failures';
}

/**
 * Run one topology (desktop | mobile | mixed). When summarize is false, returns { allPassed, results }.
 * @param {import('./shared/infra/run-spec').RunSpec} spec
 */
async function runSingleTopology(spec) {
    const summarize = spec.summarize !== false;
    const { emitBenchmarkSummary, prefixResults } = require('./shared/infra/runner-results');

    if (summarize && spec.mode !== 'hub') {
        printRunSuiteHeader(spec);
    }

    let out = null;

    if (spec.topology === 'mobile') {
        if (spec.mode === 'mp' && isOnlyPlayerCount(spec, 3)) {
            out = await runMp3p({ ...spec, summarize: false }, { summarize: false });
        } else {
            out = await runMobile({ ...spec, summarize: false });
        }
    } else if (spec.mode === 'hub') {
        await runHub();
        return summarize ? undefined : { allPassed: true, results: [] };
    } else if (spec.mode === 'all') {
        const totalStart = Date.now();
        const spOut = await runSp({ ...spec, summarize: false });
        const mpOut = await runCombinedMpSuite({ ...spec, summarize: false });
        out = {
            results: [
                ...prefixResults(spOut.results, 'SP'),
                ...prefixResults(mpOut.results, 'MP')
            ],
            allPassed: spOut.allPassed && mpOut.allPassed,
            totalDuration: ((Date.now() - totalStart) / 1000).toFixed(2)
        };
    } else if (spec.mode === 'sp') {
        out = await runSp({ ...spec, summarize: false });
    } else if (spec.mode === 'mp') {
        out = await runMp({ ...spec, summarize: false });
    } else {
        throw new Error(`Unhandled run spec: ${JSON.stringify(spec)}`);
    }

    if (summarize && out) {
        emitBenchmarkSummary(out, {
            namePad: benchmarkNamePad(spec),
            targetSeconds: resolveBenchmarkTarget(spec),
            title: benchmarkTitle(spec),
            failMessage: benchmarkFailMessage(spec)
        });
    }
    return out;
}

/**
 * Run desktop then mobile (hub runs once on desktop only).
 * @param {import('./shared/infra/run-spec').RunSpec} spec
 */
async function runAllTopologies(spec) {
    const { printSuiteHeader, emitBenchmarkSummary, prefixResults } = require('./shared/infra/runner-results');
    const summarize = spec.summarize !== false;
    const topologies = spec.mode === 'hub' ? ['desktop'] : ['desktop', 'mobile'];
    const totalStart = Date.now();
    const combined = [];
    let allPassed = true;

    for (const topology of topologies) {
        if (!allPassed) break;
        const child = { ...spec, topology, summarize: false };
        forwardConfig(child);
        applyMpSuiteDefaults(child);

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
        emitBenchmarkSummary(
            { results: combined, allPassed, totalDuration },
            {
                namePad: 32,
                title: 'BENCHMARK RESULTS (desktop + mobile)',
                failMessage: 'Dual-topology suite had failures'
            }
        );
    }

    return { allPassed, results: combined };
}

async function main() {
    const spec = initRunConfig(process.argv.slice(2));
    if (spec.help) {
        printRunHelp();
        return;
    }

    let failed = false;
    try {
        if (spec.manualTest) {
            const { runManualTest } = require('./shared/infra/manual-test');
            await runManualTest(spec);
            return;
        }
        if (spec.topology === 'all') {
            await runAllTopologies(spec);
        } else {
            await runSingleTopology(spec);
        }
    } catch (err) {
        failed = true;
        throw err;
    } finally {
        await endPlaywrightRun();
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
