require('../../shared/infra/bootstrap');

const { chromium } = require('playwright');
const { runGameAudit } = require('../../shared/infra/audit_base');

const { buildSingleplayerAudits } = require('../../shared/infra/test-manifest');
const { runAllComponents } = require('../../hub/runner');
const { filterAuditsByGame } = require('../../shared/infra/run-spec');
const { ensureTestStack } = require('../../shared/infra/emulator-utils');
const { playwrightHeadless, shouldCloseBrowser, playwrightSlowMo } = require('../../shared/infra/env-defaults');
const { runnerLog, printSuiteHeader, printBenchmarkResults, hubSubResultsToBenchmark, isRunnerQuiet } = require('../../shared/infra/runner-results');

async function runSpSuite(options = {}) {
    const { summarize = true } = options;
    const totalStart = Date.now();
    if (summarize) {
        printSuiteHeader('SINGLE-LAUNCH CONCURRENT BENCHMARK RUNNER');
    }

    await ensureTestStack();

    const gameFilter = process.env.FIVE_GAME || null;
    const skipGlobalHub = !!gameFilter;

    const browser = await chromium.launch({
        headless: playwrightHeadless(),
        slowMo: playwrightSlowMo()
    });

    let hubResult;
    if (!skipGlobalHub) {
        const hubStart = Date.now();
        runnerLog('[RUNNER] Hub (desktop, by component)...');
        let hubSubResults;
        try {
            hubSubResults = await runAllComponents({ browser, log: !isRunnerQuiet() });
        } catch (err) {
            hubSubResults = [{ id: 'hub', name: 'Hub suite', ok: false, ms: 0, error: err.message }];
        }
        const hubOk = hubSubResults.every((r) => r.ok);
        hubResult = {
            name: 'Hub',
            success: hubOk,
            duration: ((Date.now() - hubStart) / 1000).toFixed(2),
            subResults: hubSubResultsToBenchmark(hubSubResults),
            error: hubOk ? undefined : hubSubResults.filter((r) => !r.ok).map((r) => `[${r.id}] ${r.error}`).join('; ')
        };
    } else {
        runnerLog(`[RUNNER] Skipping global hub (game filter: ${gameFilter})`);
    }

    const tests = filterAuditsByGame(buildSingleplayerAudits(), gameFilter);
    if (!tests.length) {
        if (shouldCloseBrowser()) await browser.close();
        const err = new Error(`No SP audits match --game=${gameFilter || '(none)'}`);
        if (summarize) throw err;
        return { results: hubResult ? [hubResult] : [], allPassed: false, totalDuration: '0.00', error: err.message };
    }

    const runWithSingleBrowser = async (test) => {
        const start = Date.now();
        runnerLog(`[RUNNER] Starting test page: ${test.name}...`);
        try {
            const context = await browser.newContext();
            const page = await context.newPage();

            await runGameAudit(test.gameId, {
                ...test.config,
                page,
                context,
                browser,
                skipStackCheck: true
            });

            const duration = (Date.now() - start) / 1000;
            return {
                name: test.name,
                success: true,
                duration: duration.toFixed(2)
            };
        } catch (err) {
            const duration = (Date.now() - start) / 1000;
            return {
                name: test.name,
                success: false,
                duration: duration.toFixed(2),
                error: err.message
            };
        }
    };

    const gameResults = await Promise.all(tests.map((test) => runWithSingleBrowser(test)));
    const results = hubResult ? [hubResult, ...gameResults] : gameResults;

    runnerLog('[RUNNER] Closing Chromium Browser...');
    if (shouldCloseBrowser()) {
        await browser.close();
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    const allPassed = results.length > 0 && results.every((r) => r.success);

    if (summarize) {
        printBenchmarkResults({
            results,
            totalDuration,
            targetSeconds: 3.0
        });
        if (!allPassed) {
            throw new Error('SP benchmark suite had failures');
        }
    }

    return { results, allPassed, totalDuration };
}

async function main() {
    await runSpSuite({ summarize: true });
}

module.exports = { main, runSpSuite };

if (require.main === module) {
    const { awaitBrowserDismissal } = require('../../shared/infra/env-defaults');
    main()
        .catch((err) => {
            console.error(err.message || err);
            process.exitCode = 1;
        })
        .finally(() => awaitBrowserDismissal());
}
