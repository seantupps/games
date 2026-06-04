/**
 * Mobile lobby shell checks (phone-path URL on localhost — same shape as LAN play).
 * Each step is logged by name — see docs/MOBILE_TESTING.md § Hub checks.
 */
const { buildLocalPhonePathUrl } = require('../../../../scripts/test/phone-path-url');
const { assertPhonePathHub } = require('../../cross-client/phone-path-assertions');
const { createMobileContext } = require('../lib/mobile-utils');
const { waitForNetwork, runHubStep, runStep, NAV_MS, applyHubPageDefaults } = require('../lib/mobile-timeouts');
const { HUB_MS, HUB_INIT_MS } = require('../lib/mobile-constants');
const {
    assertNaturalMobileViewport,
    assertMobileBarLayout,
    assertHubChatToggle,
    assertSettingsButtonOpens,
    assertSettingsEdgeSwipeOpens,
    assertSettingsSmoothScroll,
    assertSettingsClosesOnOutsideTap,
    assertSettingsClosesImmediatelyAfterGearOpen,
    assertBoardFitsWhileChatOpen,
    assertHostGameSwitchQuick,
    assertPinchZoomDoesNotEndTurn,
    assertPinchZoomRange,
    assertLinePinchOutsideBoard,
    assertFullscreenKeepsChat,
    assertGameBoardFitsViewport,
    assertGameBoardFitsPortraitAndLandscape,
    assertClassicPilesOrientationLayout,
    assertLineNodeSnapRadius,
    assertLineBoardCenteredInLandscape,
    assertPilesHorizontalInLandscape,
    assertFreestyleMobileLayoutStable,
    assertSettingsAboveChat,
    assertMobileDefaultZoomFitsVisuals,
    assertFullscreenExpandsGame,
    assertChatAndSettingsWorkInFullscreen,
    assertCenteredAfterFullscreenToggle,
    assertChatReturnsLowAfterKeyboard,
    assertZoomPersistsAcrossGameSwitch,
    assertPhoneBootHiddenOnFullscreen
} = require('../lib/mobile_assertions');

/** @returns {Promise<{ deviceName: string, results: { name: string, success: boolean, duration?: string, error?: string }[] }>} */
async function runHubSuite(browser) {
    const { context, page, deviceName } = await createMobileContext(browser);
    const phoneUrl = process.env.FIVE_PHONE_TEST_URL?.trim()
        || buildLocalPhonePathUrl('127.0.0.1', 8000);
    const results = [];

    const step = async (name, fn, kind = 'assert', capMs = null) => {
        const t0 = Date.now();
        try {
            if (capMs != null) {
                await runStep(name, fn, capMs);
            } else {
                await runHubStep(name, fn, kind, page);
            }
            results.push({ name, success: true, duration: ((Date.now() - t0) / 1000).toFixed(2) });
            return null;
        } catch (err) {
            const errText = err.details
                ? `${err.message}\n--- trace ---\n${JSON.stringify(err.details, null, 2)}`
                : err.message;
            results.push({
                name,
                success: false,
                error: errText,
                duration: ((Date.now() - t0) / 1000).toFixed(2)
            });
            return err;
        }
    };

    try {
        const t0 = Date.now();
        console.log('\x1b[36m[MOBILE] ▶ Load phone-path hub URL\x1b[0m');
        let err = null;
        try {
            await page.goto(phoneUrl, { waitUntil: 'load', timeout: NAV_MS });
            console.log(`\x1b[32m[MOBILE] ✓ Load phone-path hub URL\x1b[0m (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
            results.push({ name: 'Load phone-path hub URL', success: true, duration: ((Date.now() - t0) / 1000).toFixed(2) });
        } catch (e) {
            console.log('\x1b[31m[MOBILE] ✗ Load phone-path hub URL\x1b[0m');
            err = e;
            results.push({ name: 'Load phone-path hub URL', success: false, error: e.message, duration: ((Date.now() - t0) / 1000).toFixed(2) });
        }
        if (err) return { deviceName, results, failed: err };

        err = await step('Phone path: Firebase SDK, rtdbUrl tunnel, game iframe', async () => {
            await assertPhonePathHub(page, 'hub', { fast: true, timeoutMs: HUB_INIT_MS });
        }, 'init');
        if (err) return { deviceName, results, failed: err };

        err = await step('NetworkEngine initialized', async () => {
            await waitForNetwork(page, HUB_INIT_MS);
            await page.evaluate(() => {
                localStorage.setItem('username', 'MobileTestUser');
                localStorage.setItem('settingsOpen', 'false');
            });
        }, 'init');
        if (err) return { deviceName, results, failed: err };

        applyHubPageDefaults(page);

        err = await step('Auto mobile viewport (five-mobile, hide desktop ⚙)', async () => {
            await assertNaturalMobileViewport(page);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Mobile bottom bar layout', async () => {
            await assertMobileBarLayout(page);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Settings gear → panel on left + theme color', async () => {
            await assertSettingsButtonOpens(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Settings smooth scroll', async () => {
            await assertSettingsSmoothScroll(page);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Settings closes immediately after gear (no mute delay)', async () => {
            await assertSettingsClosesImmediatelyAfterGearOpen(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Settings closes on outside tap', async () => {
            await assertSettingsClosesOnOutsideTap(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Settings edge swipe (left → right)', async () => {
            await assertSettingsEdgeSwipeOpens(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Chat opens with keyboard focus', async () => {
            const { assertChatOpensWithFocusedInput } = require('../lib/mobile_assertions');
            await assertChatOpensWithFocusedInput(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Settings panel above chat', async () => {
            await assertSettingsAboveChat(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Chat returns low when keyboard closes', async () => {
            await assertChatReturnsLowAfterKeyboard(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Board fits while chat/keyboard open', async () => {
            await assertBoardFitsWhileChatOpen(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Pinch zoom does not end piles turn', async () => {
            await assertPinchZoomDoesNotEndTurn(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Host: switch game (Line ↔ Piles)', async () => {
            await assertHostGameSwitchQuick(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Pinch zoom in/out range', async () => {
            await assertPinchZoomRange(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Line pinch outside board (not page zoom)', async () => {
            await assertLinePinchOutsideBoard(page, 5000);
        }, 'assert', 8000);
        if (err) return { deviceName, results, failed: err };

        err = await step('Fullscreen keeps chat + bar controls', async () => {
            await assertFullscreenKeepsChat(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Fullscreen expands game (gear stays)', async () => {
            await assertFullscreenExpandsGame(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Fullscreen: chat and settings open', async () => {
            await assertChatAndSettingsWorkInFullscreen(page, 5000);
        }, 'assert', 8000);
        if (err) return { deviceName, results, failed: err };

        err = await step('Line centered after fullscreen toggle', async () => {
            await assertCenteredAfterFullscreenToggle(page, 'line', 5000);
        }, 'assert', 8000);
        if (err) return { deviceName, results, failed: err };

        err = await step('Piles centered after fullscreen toggle', async () => {
            await assertCenteredAfterFullscreenToggle(page, 'piles', 5000);
        }, 'assert', 8000);
        if (err) return { deviceName, results, failed: err };

        err = await step('No boot banner on fullscreen', async () => {
            await assertPhoneBootHiddenOnFullscreen(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Line horizontal: centered in landscape', async () => {
            await assertLineBoardCenteredInLandscape(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Default zoom fits line visuals', async () => {
            await assertMobileDefaultZoomFitsVisuals(page, 'line', 5000);
        }, 'assert', 8000);
        if (err) return { deviceName, results, failed: err };

        err = await step('Default zoom fits piles visuals', async () => {
            await assertMobileDefaultZoomFitsVisuals(page, 'piles', 5000);
        }, 'assert', 8000);
        if (err) return { deviceName, results, failed: err };

        err = await step('Zoom persists per game+mode on switch', async () => {
            await assertZoomPersistsAcrossGameSwitch(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Classic piles vertical (portrait) / horizontal (landscape)', async () => {
            await assertClassicPilesOrientationLayout(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Piles classic horizontal: fits + centered', async () => {
            await assertPilesHorizontalInLandscape(page, 'classic', HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Freestyle piles: anchor stable after removals', async () => {
            await assertFreestyleMobileLayoutStable(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Piles freestyle horizontal: fits viewport (landscape)', async () => {
            await assertPilesHorizontalInLandscape(page, 'freestyle', HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };

        err = await step('Line node touch target (snap radius)', async () => {
            await assertLineNodeSnapRadius(page, HUB_MS);
        });
        if (err) return { deviceName, results, failed: err };
    } finally {
        await page.evaluate(() => {
            localStorage.setItem('settingsOpen', 'false');
            document.getElementById('settings-sidebar')?.classList.remove('open');
            if (typeof ChatEngine !== 'undefined') ChatEngine.toggle(false);
        }).catch(() => { });
        await context.close().catch(() => { });
    }

    return { deviceName, results };
}

module.exports = { runHubSuite };
