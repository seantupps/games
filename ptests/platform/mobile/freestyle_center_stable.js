/**
 * Freestyle piles: mobile layout centers once, never recenters on removal.
 * Run: npm run test:mobile:freestyle:center
 */
const { applyEnvProfiles } = require('../../shared/infra/env-defaults');
applyEnvProfiles(['stack', 'mobile']);

const { buildLocalPhonePathUrl } = require('../../../scripts/test/phone-path-url');
const { launchMobileBrowser, createMobileContext } = require('./lib/mobile-utils');
const { ensureStackBounded } = require('./lib/mobile-timeouts');
const { applyHubPageDefaults, waitForNetwork, NAV_MS } = require('./lib/mobile-timeouts');
const { HUB_INIT_MS } = require('./lib/mobile-constants');
const { assertPhonePathHub } = require('../cross-client/phone-path-assertions');
const {
    assertNaturalMobileViewport,
    assertFreestyleMobileLayoutStable
} = require('./lib/mobile_assertions');

async function main() {
    await ensureStackBounded();
    const phoneUrl = process.env.FIVE_PHONE_TEST_URL?.trim()
        || buildLocalPhonePathUrl('127.0.0.1', 8000);

    const browser = await launchMobileBrowser();
    const { context, page } = await createMobileContext(browser);
    try {
        await page.goto(phoneUrl, { waitUntil: 'load', timeout: NAV_MS });
        await assertPhonePathHub(page, 'hub', { fast: true, timeoutMs: HUB_INIT_MS });
        await waitForNetwork(page, HUB_INIT_MS);
        applyHubPageDefaults(page);
        await assertNaturalMobileViewport(page);
        await assertFreestyleMobileLayoutStable(page);
        console.log('[TEST] Freestyle mobile layout anchor stable OK');
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('[TEST] FAIL:', err.message);
    process.exit(1);
});
