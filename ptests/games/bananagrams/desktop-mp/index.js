/**
 * Bananagrams MP audit config + direct debug entry (bypasses unified runner).
 *
 * Normal runs: npm run mp:banana:desktop | npm run mp:banana:mobile
 *   → run.js → run-mp.js / run-suite.js → mp-bundle-runner → beforeLoop → runBananagramsMpAudit
 *
 * Debug only: npm run mp:banana:debug  (or node this file — headed/local experiments)
 */
require('../../../shared/infra/bootstrap');

const { chromium } = require('playwright');
const { ensureTestStack } = require('../../../shared/infra/emulator-utils');
const { runBananagramsMpAudit } = require('./audit/run-audit');
const lib = require('../lib/mp-lib');
const { layoutMpHeadedWindows, mpHeadedContextOpts } = require('../../../shared/platform/mp-headed-view');
const { parseScenarioArgv, parseWinSideArgv, listScenarios } = require('../scenarios/registry');
const { playwrightHeadless } = require('../../../shared/infra/env-defaults');

const { log } = lib;

async function beforeLoop(page1, page2, ctx = {}) {
    const roomId = ctx.roomId
        || `MP_AUDIT_BANANA_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const scenario = parseScenarioArgv(process.argv, 'full');
    const winSide = parseWinSideArgv(process.argv);
    await runBananagramsMpAudit(page1, page2, {
        roomId,
        mp: { page1, page2 },
        mobile: !!ctx.isMobile,
        scenario,
        focusDumpPeel: scenario === 'focus',
        skipSeed: ctx.skipSeed,
        winSide
    });
}

async function runBananagramsMpTest(browser, options = {}) {
    const roomId = `MP_AUDIT_BANANA_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    log(`Bananagrams MP full audit in room ${roomId}...`);

    const contextOpts = options.headless === false
        ? mpHeadedContextOpts()
        : {
            viewport: { width: 1920, height: 1080 },
            screen: { width: 1920, height: 1080 },
            deviceScaleFactor: 1
        };
    const ctx1 = await browser.newContext(contextOpts);
    const ctx2 = await browser.newContext(contextOpts);
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    if (!options.headless) {
        await layoutMpHeadedWindows([page1, page2]);
    }

    const scenario = options.scenario || parseScenarioArgv(process.argv, 'full');
    const winSide = options.winSide ?? parseWinSideArgv(process.argv);

    try {
        await runBananagramsMpAudit(page1, page2, {
            roomId,
            mp: { page1, page2 },
            mobile: false,
            scenario,
            focusDumpPeel: scenario === 'focus',
            winSide
        });
    } finally {
        await page1.evaluate(({ rId }) => {
            const db = window.NetworkEngine?.db;
            if (db) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
        }, { rId: roomId }).catch(() => { });
        await ctx1.close();
        await ctx2.close();
    }
}

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        if (args.includes('--list-scenarios')) {
            console.log('MP scenarios:', listScenarios('mp').join(', '));
            process.exit(0);
        }
        await ensureTestStack();
        const headless = playwrightHeadless();
        const scenario = parseScenarioArgv(process.argv, 'full');
        const browser = await chromium.launch({
            headless,
            args: [
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        });
        try {
            await runBananagramsMpTest(browser, { focusDumpPeel: scenario === 'focus', headless, scenario });
        } catch (err) {
            console.error(err);
            process.exit(1);
        } finally {
            await browser.close();
        }
    })();
}

module.exports = {
    runBananagramsMpTest,
    runBananagramsMpAudit,
    dumpTile: lib.dumpTile,
    holdDump: lib.holdDump,
    dragTileByIndex: lib.dragTileByIndex,
    assertSpawnedAtViewportBottom: lib.assertSpawnedAtViewportBottom,
    waitForDiag: lib.waitForDiag,
    waitDumpResult: lib.waitDumpResult,
    splitViaDrag: lib.splitViaDrag,
    peelGridScript: lib.peelGridScript,
    peelGridScriptEval: lib.peelGridScriptEval,
    beforeLoop,
    skipBootstrap: true,
    deferBootstrapWait: true,
    skipGameLoop: true,
    skipScoreVerify: true,
    gameMode: 'multiplayer'
};
