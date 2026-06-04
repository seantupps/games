/**
 * Playwright: phone-shaped hub URL on localhost (rtdbUrl + phoneDebug + mobile viewport).
 * Uses buildLocalPhonePathUrl against the local stack.
 * Optional FIVE_PHONE_TEST_URL overrides the hub URL (e.g. LAN IP for a real device).
 */
const { applyEnvProfiles } = require('../../shared/infra/env-defaults');
applyEnvProfiles(['stack']);
if (process.env.FIVE_DEVICE == null) process.env.FIVE_DEVICE = 'galaxys24';

const { execSync } = require('child_process');
const path = require('path');
const { launchMobileBrowser, createMobileContext } = require('../mobile/lib/mobile-utils');
const { buildLocalPhonePathUrl } = require('../../../scripts/test/phone-path-url');
const { ensureTestStack } = require('../../shared/infra/emulator-utils');
const { printBenchmarkResults } = require('../../shared/infra/runner-results');
const {
    requireDevStaticServer,
    assertPhonePathHub,
    assertDebugReportReceived,
    assertMobileHubControls,
    assertGameMove
} = require('./phone-path-assertions');
const { withTimeout } = require('../mobile/lib/mobile-timeouts');

const ROOT = path.join(__dirname, '../../..');
const LIVE_URL = process.env.FIVE_PHONE_TEST_URL?.trim();
const SUITE_MS = Number(process.env.FIVE_PHONE_PATH_TIMEOUT_MS || 90000);

/**
 * @param {{ summarize?: boolean }} [options]
 * @returns {Promise<{ results: import('../../shared/infra/runner-results').BenchmarkResult[], allPassed: boolean, totalDuration: string }>}
 */
async function runPhonePathSuite(options = {}) {
    const { summarize = true } = options;
    const totalStart = Date.now();
    const results = [];
    const step = async (name, fn) => {
        const t0 = Date.now();
        try {
            await fn();
            results.push({
                name,
                success: true,
                duration: ((Date.now() - t0) / 1000).toFixed(2)
            });
        } catch (err) {
            results.push({
                name,
                success: false,
                duration: ((Date.now() - t0) / 1000).toFixed(2),
                error: err.message
            });
        }
    };

    execSync('node scripts/test/setup-vendor-firebase.js', { cwd: ROOT, stdio: summarize ? 'inherit' : 'ignore' });
    await ensureTestStack();
    await requireDevStaticServer();

    const testUrl = LIVE_URL || buildLocalPhonePathUrl('127.0.0.1', 8000);
    const browser = await launchMobileBrowser();
    try {
        const { context, page, deviceName } = await createMobileContext(browser);
        try {
            await step('Load phone-path URL', async () => {
                const response = await page.goto(testUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 25000
                });
                if (!response || !response.ok()) {
                    throw new Error(`HTTP ${response?.status() ?? 'no response'} (${testUrl})`);
                }
            });

            await step('Hub + game visible', async () => {
                await assertPhonePathHub(page, LIVE_URL ? 'phone-live' : 'phone-local');
            });

            await step('Mobile bar visible', async () => {
                await assertMobileHubControls(page);
            });

            await step('Game interaction', async () => {
                await assertGameMove(page, 'move');
            });

            await step('Debug relay report', async () => {
                await assertDebugReportReceived(page, { label: 'debug-relay' });
            });

            if (results.every((r) => r.success)) {
                results.unshift({
                    name: `Phone path (${deviceName})`,
                    success: true,
                    duration: ((Date.now() - totalStart) / 1000).toFixed(2)
                });
            }
        } finally {
            await context.close();
        }
    } finally {
        await browser.close();
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    const allPassed = results.length > 0 && results.every((r) => r.success);

    if (summarize) {
        printBenchmarkResults({
            results,
            totalDuration,
            namePad: 28,
            title: 'PHONE PATH RESULTS'
        });
        if (!allPassed) {
            throw new Error('Phone path suite had failures');
        }
    }

    return { results, allPassed, totalDuration };
}

async function main() {
    return withTimeout(runPhonePathSuite({ summarize: true }), SUITE_MS, 'test:phone:path');
}

module.exports = { runPhonePathSuite, main };

if (require.main === module) {
    main().catch((err) => {
        console.error('\n\x1b[31mFAIL\x1b[0m', err.message);
        if (err.stack) console.error(err.stack);
        console.error('\nTips: npm run stack && npm run phone:dev (debug proxy on :8002)');
        console.error('PC logs: http://127.0.0.1:8002/\n');
        process.exit(1);
    });
}
