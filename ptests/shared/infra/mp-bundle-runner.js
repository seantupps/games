/**
 * Run several MP audits in one browser session (shared contexts, hub warmup once).
 */
require('./bootstrap');

const { chromium } = require('playwright');
const { runMultiplayerAudit } = require('./multiplayer_base');
const { ensureTestStack } = require('./emulator-utils');
const { GLOBAL_MS } = require('./timeouts');
const {
    applyEnvProfiles,
    defaultBootstrapProfiles,
    shouldCloseBrowser,
    playwrightHeadless,
    registerKeepOpenBrowser
} = require('./env-defaults');
const { createAuditSession } = require('./audit-session');
const { resolveMpAuditTimeoutMs } = require('./mp-audit-timeout');
const { captureAuditFailure } = require('./test-logger');
const { captureAuditFailureWithMpSnapshot } = require('./mp-failure-snapshot');

/**
 * @param {object} options
 * @param {string} options.title
 * @param {{ name: string, gameId: string, gameMode: string, config: object }[]} options.tests
 * @param {import('playwright').Browser} [options.browser] Reuse caller's browser
 * @param {boolean} [options.mobile] Mobile viewport + isMobile audits
 * @param {number} [options.targetSeconds]
 * @param {string[]} [options.envProfiles]
 * @param {number} [options.auditTimeoutMs]
 * @param {boolean} [options.skipRefresh]
 * @param {boolean} [options.postVictoryOnLastOnly]
 * @param {boolean} [options.ensureStack]
 */
async function runMpAuditBundle(options) {
    const {
        title,
        tests,
        browser: providedBrowser = null,
        mobile = false,
        targetSeconds = null,
        envProfiles = null,
        skipRefresh: skipRefreshOpt,
        postVictoryOnLastOnly: postVictoryOpt,
        ensureStack = true,
        headless = playwrightHeadless(),
        scenario = null,
        slim = null,
        summarize = true
    } = options;

    const auditTimeoutMs = options.auditTimeoutMs ?? resolveMpAuditTimeoutMs({ scenario, slim });

    const slimDefault = (() => {
        try {
            const { isSlimAudit } = require('./run-config');
            return isSlimAudit();
        } catch (_) {
            return false;
        }
    })();
    const skipRefresh = skipRefreshOpt ?? slimDefault;
    const postVictoryOnLastOnly = postVictoryOpt ?? slimDefault;

    if (!tests?.length) {
        throw new Error('runMpAuditBundle: tests array is required');
    }

    if (envProfiles) {
        applyEnvProfiles(envProfiles);
    } else {
        applyEnvProfiles(defaultBootstrapProfiles(mobile ? ['viewportMobile'] : []));
    }

    const totalStart = Date.now();
    const { runnerLog, printSuiteHeader } = require('./runner-results');
    if (summarize) {
        const tag = mobile ? 'mobile' : 'desktop';
        printSuiteHeader(title, [
            `(${tag}, step timeout ${GLOBAL_MS}ms, audit cap ${(auditTimeoutMs / 1000).toFixed(0)}s)`
        ]);
    } else {
        runnerLog(`[RUNNER] ${title}...`);
    }

    if (ensureStack) await ensureTestStack();

    let ownsBrowser = !providedBrowser;
    let browser = providedBrowser;
    if (!browser) {
        if (mobile) {
            const { launchMobileBrowser } = require('../../platform/mobile/lib/mobile-utils');
            browser = await launchMobileBrowser();
        } else {
            browser = await chromium.launch({ headless });
        }
    }
    registerKeepOpenBrowser(browser);

    let context1;
    let context2;
    let page1;
    let page2;
    let closeMobilePair = null;

    const session = await createAuditSession(browser, {
        players: 2,
        topology: mobile ? 'mobile' : 'desktop'
    });
    context1 = session.context1;
    context2 = session.context2;
    page1 = session.page1;
    page2 = session.page2;
    closeMobilePair = () => session.cleanup();

    let hubWarmed = false;
    const results = [];

    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        const isLast = i === tests.length - 1;
        const start = Date.now();
        runnerLog(`[RUNNER] ${test.name}...`);
        let timeoutId;
        try {
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`Timeout: ${test.name} exceeded ${auditTimeoutMs / 1000}s`));
                }, auditTimeoutMs);
            });
            await Promise.race([
                runMultiplayerAudit(test.gameId, {
                    ...test.config,
                    mpOptimized: true,
                    browser,
                    context1,
                    context2,
                    page1,
                    page2,
                    skipStackCheck: true,
                    manageContexts: false,
                    skipHubWarmup: hubWarmed,
                    skipRefresh,
                    skipPostVictory: postVictoryOnLastOnly ? !isLast : false,
                    isMobile: mobile
                }),
                timeoutPromise
            ]);
            clearTimeout(timeoutId);
            hubWarmed = true;
            results.push({
                name: test.name,
                success: true,
                duration: ((Date.now() - start) / 1000).toFixed(2)
            });
        } catch (err) {
            clearTimeout(timeoutId);
            const failure = await captureAuditFailureWithMpSnapshot(err, {
                page1,
                page2,
                mobile,
                scenario,
                testName: test.name,
                gameId: test.gameId
            });
            results.push({
                name: test.name,
                success: false,
                duration: ((Date.now() - start) / 1000).toFixed(2),
                ...failure
            });
            break;
        }
    }

    if (shouldCloseBrowser()) {
        if (closeMobilePair) {
            await closeMobilePair();
        } else {
            await context1.close().catch(() => { });
            await context2.close().catch(() => { });
        }
        if (ownsBrowser) await browser.close().catch(() => { });
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    const allPassed = results.length === tests.length && results.every((r) => r.success);

    if (summarize) {
        const { printBenchmarkResults } = require('./runner-results');
        printBenchmarkResults({
            results,
            totalDuration,
            targetSeconds: targetSeconds ?? undefined,
            namePad: 24,
            title: title.toUpperCase()
        });
    }

    return { allPassed, totalDuration, results };
}

module.exports = { runMpAuditBundle };
