/**
 * N-player Bananagrams MP audit — creates session + delegates to scenario router.
 */
require('../../../shared/infra/bootstrap');

const { chromium } = require('playwright');
const { ensureTestStack } = require('../../../shared/infra/emulator-utils');
const { playwrightHeadless, shouldCloseBrowser, registerKeepOpenBrowser } = require('../../../shared/infra/env-defaults');
const { printSuiteHeader, printBenchmarkResults, runnerLog } = require('../../../shared/infra/runner-results');
const { createBanana3pSession, BANANA_3P_PLAYERS } = require('../../../shared/infra/scenarios/mp-3p-banana-party');
const { runBananagramsMpAudit } = require('./mp-audit/run-audit');
const { normalizeScenarioId, scenarioSupportsPlayerCount } = require('../scenarios/mp/index');
const { DEFAULT_3P_SCENARIO } = require('../scenarios/mp/routing');
const { parseScenarioArgv } = require('../scenarios/registry');

/**
 * @param {import('../../../shared/infra/run-spec').RunSpec} spec
 * @param {{ summarize?: boolean }} [opts]
 */
async function runBananagramsMpNAudit(spec = {}, opts = {}) {
    const summarize = opts.summarize !== false && spec.summarize !== false;
    const topology = spec.topology || 'desktop';
    const mobileAll = topology === 'mobile' || !!spec.mobileAll;
    const playerCount = spec.players || spec.playerCount || 3;
    const scenarioId = normalizeScenarioId(spec.scenario || parseScenarioArgv(process.argv, DEFAULT_3P_SCENARIO));

    if (playerCount !== 3) {
        throw new Error(`runBananagramsMpNAudit: only 3p wired today (got ${playerCount}p)`);
    }
    if (!scenarioSupportsPlayerCount(scenarioId, playerCount)) {
        throw new Error(`Scenario "${scenarioId}" does not support ${playerCount} players`);
    }

    if (summarize) {
        printSuiteHeader('BANANAGRAMS MP 3P', [
            `${topology}${mobileAll ? ', mobile' : ''}`,
            `scenario=${scenarioId}`
        ]);
    }

    if (summarize || !spec.skipStackCheck) {
        await ensureTestStack();
    }

    let browser = spec.browser;
    let ownsBrowser = !browser;
    if (!browser) {
        if (mobileAll) {
            const { applyBootstrap } = require('../../../shared/infra/bootstrap');
            applyBootstrap(['viewportMobile']);
            const { launchMobileBrowser } = require('../../../platform/mobile/lib/mobile-utils');
            browser = await launchMobileBrowser();
        } else {
            browser = await chromium.launch({ headless: playwrightHeadless() });
        }
        registerKeepOpenBrowser(browser);
    }

    const roomId = spec.roomId
        || `MP_BANANA_3P_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const testName = `MP Bananagrams 3p [${scenarioId}]`;
    const t0 = Date.now();
    let result;

    const { contexts, pages, mobilePageIndices } = await createBanana3pSession(browser, { mobileAll });
    const hostPage = pages[0];

    try {
        runnerLog(`[RUNNER] ${testName}...`);
        await runBananagramsMpAudit(pages, {
            scenario: scenarioId,
            roomId,
            mobile: mobileAll,
            playerDefs: BANANA_3P_PLAYERS,
            guestOrders: spec.guestOrders,
            mobilePageIndices
        });
        if (!shouldCloseBrowser()) {
            const { centerMpViewerOnPages } = require('../../../shared/platform/mp-headed-view');
            await centerMpViewerOnPages(pages, { mobile: mobileAll });
            await pages[0].bringToFront().catch(() => {});
        }
        result = {
            name: testName,
            success: true,
            duration: ((Date.now() - t0) / 1000).toFixed(2)
        };
    } catch (err) {
        result = {
            name: testName,
            success: false,
            duration: ((Date.now() - t0) / 1000).toFixed(2),
            error: err.message
        };
    } finally {
        if (shouldCloseBrowser()) {
            await hostPage.evaluate(({ rId }) => {
                const db = window.NetworkEngine?.db;
                if (db && rId) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
            }, { rId: roomId }).catch(() => {});
            await Promise.all(contexts.map((ctx) => ctx.close()));
            if (ownsBrowser) await browser.close().catch(() => {});
        }
    }

    const out = { results: [result], allPassed: result.success, totalDuration: result.duration };

    if (summarize) {
        printBenchmarkResults(out);
        if (!out.allPassed) throw new Error(result.error || `${testName} failed`);
    }

    return out;
}

module.exports = { runBananagramsMpNAudit };
