/**
 * Desktop MP suite: party limit + default-tier bundled games + extended tier per-game.
 * Prefer: node ptests/run.js mp  |  slim: node ptests/run.js mp piles-line
 */
require('../../shared/infra/bootstrap');

const { chromium } = require('playwright');
const { runMultiplayerAudit } = require('../../shared/infra/multiplayer_base');
const { runMpAuditBundle } = require('../../shared/infra/mp-bundle-runner');
const { ensureTestStack } = require('../../shared/infra/emulator-utils');
const { buildMultiplayerAudits, partitionMpBySuite } = require('../../shared/infra/test-manifest');
const { filterAuditsByGame } = require('../../shared/infra/run-spec');
const { runPartyLimitTest } = require('./mp/mp_party_limit');
const { playwrightHeadless, shouldCloseBrowser, playwrightSlowMo } = require('../../shared/infra/env-defaults');
const { resolveMpAuditTimeoutMs } = require('../../shared/infra/mp-audit-timeout');
const { runnerLog, printSuiteHeader, printBenchmarkResults } = require('../../shared/infra/runner-results');
const { captureAuditFailure } = require('../../shared/infra/test-logger');

function canUseMpBundle(tests) {
    return tests.length > 0
        && Number(process.env.FIVE_PLAYERS || 2) === 2
        && !tests.some((t) => t.customRunner);
}

async function runFreshContextAudit(browser, test) {
    const auditMs = resolveMpAuditTimeoutMs({ slim: false });
    const start = Date.now();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Timeout: ${test.name} exceeded ${auditMs / 1000}s`));
        }, auditMs);
    });

    let context1;
    let context2;
    try {
        context1 = await browser.newContext();
        context2 = await browser.newContext();
        const page1 = await context1.newPage();
        const page2 = await context2.newPage();

        await Promise.race([
            runMultiplayerAudit(test.gameId, {
                ...test.config,
                browser,
                context1,
                context2,
                page1,
                page2,
                skipStackCheck: true,
                manageContexts: false
            }),
            timeoutPromise
        ]);
        clearTimeout(timeoutId);
        return {
            name: test.name,
            success: true,
            duration: ((Date.now() - start) / 1000).toFixed(2)
        };
    } catch (err) {
        clearTimeout(timeoutId);
        return {
            name: test.name,
            success: false,
            duration: ((Date.now() - start) / 1000).toFixed(2),
            ...captureAuditFailure(err)
        };
    } finally {
        if (context1 && shouldCloseBrowser()) await context1.close().catch(() => { });
        if (context2 && shouldCloseBrowser()) await context2.close().catch(() => { });
    }
}

async function runMpSuite(options = {}) {
    const { summarize = true } = options;
    const totalStart = Date.now();
    if (summarize) {
        printSuiteHeader('DESKTOP MULTIPLAYER SUITE');
    }

    if (process.env.FIVE_FIREBASE_TARGET === 'production') {
        console.error('\x1b[31m[RUNNER] Refusing MP suite on production RTDB.\x1b[0m');
        process.exit(1);
    }

    await ensureTestStack();
    const browser = await chromium.launch({
        headless: playwrightHeadless(),
        slowMo: playwrightSlowMo()
    });

    const gameFilter = process.env.FIVE_GAME || null;
    let allTests = buildMultiplayerAudits({ players: 2, topology: 'desktop' });
    allTests = filterAuditsByGame(allTests, gameFilter);
    if (!allTests.length) {
        if (shouldCloseBrowser()) await browser.close().catch(() => { });
        const err = new Error(`No MP audits match --game=${gameFilter || '(all)'}.`);
        if (summarize) {
            console.error(`[RUNNER] ${err.message}`);
            process.exit(1);
        }
        throw err;
    }

    const skipPlatform = process.env.FIVE_MP_SKIP_PLATFORM === '1';
    const slim = process.env.FIVE_MP_SLIM === '1';
    const scenario = process.env.FIVE_SCENARIO || null;
    const useMpBundle = skipPlatform && canUseMpBundle(allTests);

    const results = [];
    let suiteFailed = false;
    let suiteFailMessage = '';

    const failSuite = (msg) => {
        suiteFailed = true;
        suiteFailMessage = msg;
    };

    try {
        if (useMpBundle) {
            runnerLog('[RUNNER] Filtered MP (shared session bundle, skip platform)...');
            const bundle = await runMpAuditBundle({
                title: slim ? 'DESKTOP MP (bundled slim)' : 'DESKTOP MP (bundled full)',
                tests: allTests,
                browser,
                ensureStack: false,
                skipRefresh: slim,
                postVictoryOnLastOnly: slim,
                scenario,
                slim,
                summarize: false,
                auditTimeoutMs: resolveMpAuditTimeoutMs({ scenario, slim })
            });
            results.push(...bundle.results);
            if (!bundle.allPassed) failSuite('Desktop MP bundle had failures');
        } else {
            const { defaultTier, extendedTier } = partitionMpBySuite(allTests);
            const freshContext = process.env.FIVE_MP_FRESH_CONTEXT === '1';
            const suite = require('../../shared/infra/test-manifest').resolveMpSuiteFilter();
            runnerLog(`[RUNNER] suite=${suite} | default=${defaultTier.length} bundled=${!freshContext} | extended=${extendedTier.length}`);

            const partyStart = Date.now();
            try {
                await runPartyLimitTest(browser);
                results.push({
                    name: 'Party Limit',
                    success: true,
                    duration: ((Date.now() - partyStart) / 1000).toFixed(2)
                });
            } catch (err) {
                results.push({
                    name: 'Party Limit',
                    success: false,
                    ...captureAuditFailure(err)
                });
                suiteFailed = true;
            }

            if (defaultTier.length && !suiteFailed) {
                if (freshContext) {
                    runnerLog('[RUNNER] Default tier (fresh context per game)...');
                    for (const test of defaultTier) {
                        const res = await runFreshContextAudit(browser, test);
                        results.push(res);
                        if (!res.success) {
                            suiteFailed = true;
                            break;
                        }
                    }
                } else {
                    runnerLog('[RUNNER] Default tier (shared session bundle)...');
                    const bundle = await runMpAuditBundle({
                        title: 'MP DEFAULT TIER (full)',
                        tests: defaultTier,
                        browser,
                        ensureStack: false,
                        skipRefresh: false,
                        postVictoryOnLastOnly: false,
                        summarize: false,
                        auditTimeoutMs: resolveMpAuditTimeoutMs({ slim: false })
                    });
                    results.push(...bundle.results);
                    if (!bundle.allPassed) failSuite('Desktop MP default tier bundle had failures');
                }
            }

            if (extendedTier.length && !suiteFailed) {
                runnerLog('[RUNNER] Extended tier (fresh context per game)...');
                for (const test of extendedTier) {
                    const res = await runFreshContextAudit(browser, test);
                    results.push(res);
                    if (!res.success) {
                        suiteFailed = true;
                        break;
                    }
                }
            }
        }
    } finally {
        if (shouldCloseBrowser()) {
            await browser.close().catch(() => { });
        }
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    const allPassed = !suiteFailed && results.length > 0 && results.every((r) => r.success);

    if (summarize) {
        printBenchmarkResults({
            results,
            totalDuration,
            namePad: 24,
            title: 'BENCHMARK RESULTS'
        });
        if (!allPassed) {
            throw new Error(suiteFailMessage || 'Desktop MP suite had failures');
        }
    }

    return { results, allPassed, totalDuration };
}

async function main() {
    await runMpSuite({ summarize: true });
}

module.exports = { main, runMpSuite };

if (require.main === module) {
    const { awaitBrowserDismissal } = require('../../shared/infra/env-defaults');
    main()
        .catch((err) => {
            console.error(err.message || err);
            process.exitCode = 1;
        })
        .finally(() => awaitBrowserDismissal());
}
