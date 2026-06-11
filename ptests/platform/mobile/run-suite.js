/**
 * Mobile Playwright suite implementation (hub | sp | mp | all).
 */
const { applyBootstrap } = require('../../shared/infra/bootstrap');
applyBootstrap(['viewportMobile']);

const { runGameAudit } = require('../../shared/infra/audit_base');
const { runMultiplayerAudit } = require('../../shared/infra/multiplayer_base');
const { runMpAuditBundle } = require('../../shared/infra/mp-bundle-runner');
const { parseRunSpec, filterAuditsByGame, includesPlayerCount } = require('../../shared/infra/run-spec');
const { buildSingleplayerAudits, buildMultiplayerAudits } = require('../../shared/infra/test-manifest');
const { launchMobileBrowser, createMobileContext, createMobilePair, closeMobilePair, resolveDeviceName } = require('./lib/mobile-utils');
const { runStep, withTimeout, ensureStackBounded } = require('./lib/mobile-timeouts');
const {
    WORKERS,
    MP_PARALLEL,
    MP_GAME_MS,
    SP_GAME_MS,
    SUITE_MS,
    MP_INVITE_MS,
    MP_PARTY_MS,
    MP_BLOCK_MS
} = require('./lib/mobile-constants');
const { runPool } = require('./lib/mobile-pool');
const { runHubSuite } = require('./hub/hub_suite');
const { runMobileInviteParty } = require('./mp/mp_mobile_extras');
const { runPartyLimitMobile } = require('./mp/mp_party_mobile');
const { resolveMpAuditTimeoutMs, resolveMpAuditBlockMs } = require('../../shared/infra/mp-audit-timeout');
const { shouldCloseBrowser, registerKeepOpenBrowser } = require('../../shared/infra/env-defaults');
const { printSuiteHeader, printBenchmarkResults } = require('../../shared/infra/runner-results');
const { captureAuditFailure } = require('../../shared/infra/test-logger');
const { captureAuditFailureWithMpSnapshot } = require('../../shared/infra/failure-snapshot');

/** MP manifest player count — prefer explicit 2p/3p in playerCounts over stale spec.players. */
function mpPlayersForSpec(spec) {
    const counts = spec.playerCounts || [];
    if (counts.includes(2)) return 2;
    if (counts.includes(3)) return 3;
    return spec.players ?? 2;
}

/**
 * @param {import('../../shared/infra/run-spec').RunSpec} [specIn]
 */
async function mainInner(specIn) {
    const spec = specIn || parseRunSpec(process.argv.slice(2));
    const summarize = spec.summarize !== false;
    const MODE = spec.mode;

    const totalStart = Date.now();
    const device = resolveDeviceName();

    if (summarize) {
        printSuiteHeader('MOBILE PLAYWRIGHT SUITE (EMULATED)', [
            `Device: ${device}  |  ${process.env.FIVE_BASE_URL}`,
            `mode=${MODE}${spec.game ? ` game=${spec.game}` : ''}${spec.scenario ? ` scenario=${spec.scenario}` : ''}${spec.skipPlatform ? ' (no platform)' : ''}`
        ]);
    }

    if (process.env.FIVE_FIREBASE_TARGET === 'production') {
        console.error('\x1b[31m[MOBILE] Refusing full suite on production. Use emulator stack.\x1b[0m');
        process.exit(1);
    }

    await runStep('ensure stack', () => ensureStackBounded(), 15000);

    const browser = await launchMobileBrowser();
    registerKeepOpenBrowser(browser);
    const results = [];

    try {
        if (MODE === 'all' || MODE === 'hub') {
            const hub = await runHubSuite(browser);
            results.push(...hub.results);
            if (hub.failed) throw hub.failed;
        }

        let spTests = buildSingleplayerAudits({ mobile: true, topology: 'mobile' });
        spTests = filterAuditsByGame(spTests, spec.game);

        let mpTests = buildMultiplayerAudits({
            mobile: true,
            topology: 'mobile',
            players: mpPlayersForSpec(spec),
            suite: spec.suite
        });
        mpTests = filterAuditsByGame(mpTests, spec.game);

        const useMpBundle = spec.skipPlatform && mpTests.length > 0
            && includesPlayerCount(spec, 2)
            && !mpTests.some((t) => t.customRunner)
            && (MODE === 'mp' || MODE === 'all');

        if ((MODE === 'all' || MODE === 'sp') && !spTests.length && MODE !== 'mp') {
            throw new Error('No SP audits match filter.');
        }
        if ((MODE === 'all' || MODE === 'mp') && !mpTests.length) {
            throw new Error('No MP audits match filter.');
        }

        const runMpSection = async () => {
            if (useMpBundle) {
                const auditMs = resolveMpAuditTimeoutMs({ scenario: spec.scenario, slim: spec.slimAudit });
                const bundle = await runMpAuditBundle({
                    title: spec.slimAudit ? 'MOBILE MP (bundled slim)' : 'MOBILE MP (bundled full)',
                    tests: mpTests,
                    mobile: true,
                    ensureStack: false,
                    skipRefresh: spec.slimAudit,
                    postVictoryOnLastOnly: spec.slimAudit,
                    scenario: spec.scenario,
                    slim: spec.slimAudit,
                    summarize: false,
                    auditTimeoutMs: auditMs,
                    targetSeconds: Number(process.env.FIVE_MOBILE_MP_TARGET_S || 10)
                });
                return bundle.results;
            }
            return runMpBlockFull(browser, mpTests, spec);
        };

        const mpBlockMs = useMpBundle
            ? resolveMpAuditBlockMs({ scenario: spec.scenario, slim: spec.slimAudit })
            : MP_BLOCK_MS;

        const spGameMs = (spec.scenario === 'actions')
            ? resolveMpAuditTimeoutMs({ scenario: spec.scenario, slim: spec.slimAudit })
            : (spec.game?.includes('bananagrams')
                ? Math.max(SP_GAME_MS, Number(process.env.FIVE_MOBILE_SP_FULL_MS || 120000))
                : SP_GAME_MS);

        if (MODE === 'all') {
            const [spResults, mpResults] = await Promise.all([
                runStep('SP (parallel)', () => runPool(
                    spTests.map((t) => () => runMobileSP(browser, t)),
                    Math.min(WORKERS, spTests.length || 1)
                ), spGameMs),
                runStep('MP block', runMpSection, mpBlockMs)
            ]);
            results.push(...spResults, ...mpResults);
        } else {
            if (MODE === 'sp') {
                results.push(...await runStep('SP (parallel)', () => runPool(
                    spTests.map((t) => () => runMobileSP(browser, t)),
                    Math.min(WORKERS, spTests.length)
                ), spGameMs));
            }
            if (MODE === 'mp') {
                results.push(...await runStep('MP block', runMpSection, mpBlockMs));
            }
        }
    } finally {
        if (shouldCloseBrowser()) await browser.close().catch(() => {});
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    const targetSeconds = spec.mode === 'mp' && spec.scenario === 'actions'
        ? Number(process.env.FIVE_MOBILE_MP_TARGET_S || 10)
        : null;
    const allPassed = results.length > 0 && results.every((r) => r.success);

    if (summarize) {
        printBenchmarkResults({
            results,
            totalDuration,
            targetSeconds,
            namePad: 28,
            title: 'BENCHMARK RESULTS'
        });
        if (!allPassed) {
            throw new Error('Mobile test suite had failures');
        }
    }

    return { results, allPassed, totalDuration };
}

async function runMobileSP(browser, test) {
    const start = Date.now();
    const { context, page } = await createMobileContext(browser);
    try {
        await runGameAudit(test.gameId, {
            ...test.config,
            page,
            context,
            browser,
            skipStackCheck: true,
            manageContext: false,
            isMobile: true
        });
        if (!shouldCloseBrowser()) {
            const { syncMpHeadedMobileViewport } = require('../../shared/platform/mp-headed-view');
            await syncMpHeadedMobileViewport(page);
            await page.bringToFront();
        }
        return { name: test.name, success: true, duration: ((Date.now() - start) / 1000).toFixed(2) };
    } catch (err) {
        return {
            name: test.name,
            success: false,
            duration: ((Date.now() - start) / 1000).toFixed(2),
            ...captureAuditFailure(err)
        };
    } finally {
        if (shouldCloseBrowser()) await context.close().catch(() => {});
    }
}

async function runMobileMP(browser, test, pair = null) {
    const start = Date.now();
    const ownPair = !pair;
    if (!pair) pair = await createMobilePair(browser);
    const mpMs = Number(process.env.FIVE_MP_READY_MS || 15000);
    pair.page1.setDefaultTimeout(mpMs);
    pair.page2.setDefaultTimeout(mpMs);
    try {
        await runMultiplayerAudit(test.gameId, {
            ...test.config,
            browser,
            context1: pair.context1,
            context2: pair.context2,
            page1: pair.page1,
            page2: pair.page2,
            skipStackCheck: true,
            manageContexts: false,
            isMobile: true
        });
        return { name: test.name, success: true, duration: ((Date.now() - start) / 1000).toFixed(2) };
    } catch (err) {
        return {
            name: test.name,
            success: false,
            duration: ((Date.now() - start) / 1000).toFixed(2),
            ...(await captureAuditFailureWithMpSnapshot(err, {
                page1: pair.page1,
                page2: pair.page2,
                mobile: true,
                testName: test.name,
                gameId: test.gameId
            }))
        };
    } finally {
        if (ownPair && shouldCloseBrowser()) await closeMobilePair(pair);
    }
}

async function runMpBlockFull(browser, mpTests, spec) {
    const mpResults = [];
    if (MP_PARALLEL) {
        if (!spec.skipPlatform) {
            try {
                await runStep('MP Invite & Party', () => runMobileInviteParty(browser), MP_INVITE_MS);
                mpResults.push({ name: 'MP Invite & Party', success: true, duration: 'N/A' });
            } catch (err) {
                mpResults.push({ name: 'MP Invite & Party', success: false, error: err.message });
            }
            try {
                await runStep('MP Party Limit', () => runPartyLimitMobile(browser), MP_PARTY_MS);
                mpResults.push({ name: 'MP Party Limit', success: true, duration: 'N/A' });
            } catch (err) {
                mpResults.push({ name: 'MP Party Limit', success: false, error: err.message });
            }
        }
        for (const t of mpTests) {
            try {
                mpResults.push(await runStep(t.name, () => runMobileMP(browser, t), MP_GAME_MS));
            } catch (err) {
                mpResults.push({ name: t.name, success: false, error: err.message });
                break;
            }
        }
    } else {
        const pair = await createMobilePair(browser);
        try {
            if (!spec.skipPlatform) {
                try {
                    await runStep('MP Invite & Party', () => runMobileInviteParty(browser, pair), MP_INVITE_MS);
                    mpResults.push({ name: 'MP Invite & Party', success: true, duration: 'N/A' });
                } catch (err) {
                    mpResults.push({ name: 'MP Invite & Party', success: false, error: err.message });
                }
                try {
                    await runStep('MP Party Limit', () => runPartyLimitMobile(browser), MP_PARTY_MS);
                    mpResults.push({ name: 'MP Party Limit', success: true, duration: 'N/A' });
                } catch (err) {
                    mpResults.push({ name: 'MP Party Limit', success: false, error: err.message });
                }
            }
            for (const t of mpTests) {
                try {
                    mpResults.push(await runStep(t.name, () => runMobileMP(browser, t, pair), MP_GAME_MS));
                } catch (err) {
                    mpResults.push({ name: t.name, success: false, error: err.message });
                    break;
                }
            }
        } finally {
            if (shouldCloseBrowser()) await closeMobilePair(pair);
        }
    }
    return mpResults;
}

module.exports = { mainInner };
