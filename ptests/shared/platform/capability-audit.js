/**
 * Registry capability checks — shared platform coverage for new games.
 */
const GameRegistry = require('../../../shared/games/registry');
const { logStep, evalHub, waitForGameReady } = require('./game-harness');
const { runScenario, composeBeforeLoop } = require('./scenario-runner');
const { STEP_MS } = require('../infra/timeouts');
const { applySpeedProfile } = require('../infra/speed-profiles');
const { parseScenarioSlices, normalizeScenario, isSmokeScenario } = require('../scenarios/registry');

function capsFor(gameId, ctx = {}) {
    const mode = ctx.gameMode || GameRegistry.defaultModeFor(gameId);
    return { mode, caps: GameRegistry.getCapabilities(gameId, mode) };
}

async function assertScoreboardState(page, expectScoreboard) {
    const state = await evalHub(page, () => {
        const hidden = (el) => !el || !el.classList.contains('show');
        const hubSb = document.querySelector('.scoreboard');
        const frame = document.getElementById('game-frame');
        const iframeSb = frame?.contentDocument?.querySelector('.scoreboard');
        const anyVisible = !hidden(hubSb) || !hidden(iframeSb);
        const anyPresent = !!(hubSb || iframeSb);
        return { anyVisible, anyPresent, hubSb: !!hubSb, iframeSb: !!iframeSb };
    });
    if (expectScoreboard) {
        if (!state.anyPresent) {
            throw new Error('Expected scoreboard element in hub or iframe');
        }
    } else if (state.anyVisible) {
        throw new Error(`Expected scoreboard hidden (hub/iframe has .show)`);
    }
}

async function assertTurnIndicatorState(page, expectTurnBased) {
    const state = await evalHub(page, () => {
        const el = document.getElementById('global-turn-indicator');
        const text = document.getElementById('turn-text');
        const visible = !!(el && el.classList.contains('visible'));
        const label = text?.innerText?.trim() || '';
        return { exists: !!el, visible, label };
    });
    if (expectTurnBased) {
        if (!state.exists) throw new Error('Expected #global-turn-indicator in hub DOM');
    } else if (state.visible && state.label) {
        throw new Error(`Simultaneous game should not show turn label (got "${state.label}")`);
    }
}

const GAME_TIMER_SELECTORS = [
    '.game-timer',
    '#game-timer',
    '[data-game-timer]',
    '[data-testid="game-timer"]',
    '[class*="timer"]',
    '[id*="timer"]'
].join(', ');

async function assertGameTimerInIframe(page, expectTimer) {
    const hasTimer = await page.evaluate((sel) => {
        const doc = document.getElementById('game-frame')?.contentDocument;
        if (!doc) return false;
        const el = doc.querySelector(sel);
        if (el) return true;
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g) return false;
        if (typeof g.getElapsedMs === 'function') {
            return !!g.gameStarted;
        }
        if (typeof g._usesGameTimer === 'function' && g._usesGameTimer()) return true;
        return false;
    }, GAME_TIMER_SELECTORS);
    if (expectTimer && !hasTimer) {
        throw new Error('Expected in-game timer HUD');
    }
}

/**
 * Platform checks derived from GameRegistry capabilities.
 * @param {import('playwright').Page} page
 * @param {string} gameId
 * @param {{ gameMode?: string, isMobile?: boolean }} [ctx]
 */
async function runCapabilityChecks(page, gameId, ctx = {}) {
    const { mode, caps } = capsFor(gameId, ctx);
    const gameMode = ctx.gameMode || mode;

    await runScenario('Game iframe ready', async () => {
        await waitForGameReady(page, { timeout: STEP_MS });
    });

    await runScenario('Scoreboard capability', async () => {
        await assertScoreboardState(page, !!caps.supportsScoreboard);
    });

    await runScenario('Turn indicator capability', async () => {
        await assertTurnIndicatorState(page, !!caps.supportsTurnIndicator);
    });

    if (caps.supportsGameTimer) {
        await runScenario('Game timer HUD', async () => {
            await assertGameTimerInIframe(page, true);
        });
    }

    const { resolveVictoryAuditPolicy } = require('./win-banner-policy');
    const victoryPolicy = resolveVictoryAuditPolicy(gameId, gameMode);
    await runScenario('Victory audit policy', async () => {
        logStep('Victory policy', JSON.stringify({
            hubBanner: victoryPolicy.verifyHubWinBanner,
            iframeOnly: victoryPolicy.verifyIframeVictoryOnly,
            autoReset: victoryPolicy.expectAutoReset,
            turnAlternation: victoryPolicy.expectTurnAlternation
        }));
    });

    if (ctx.isMobile && caps.supportsSettingsEdgeSwipe) {
        await runScenario('Settings edge swipe', async () => {
            const { assertSettingsEdgeSwipeOpens } = require('../../platform/mobile/lib/mobile_assertions');
            await assertSettingsEdgeSwipeOpens(page, ctx.mobileMs ?? STEP_MS);
        });
    }

    const { runMobileLayoutPolicyChecks } = require('./mobile-layout-audit');
    await runMobileLayoutPolicyChecks(page, gameId, { ...ctx, gameMode });

    const { runViewportCapabilityChecks } = require('./viewport-audit');
    await runViewportCapabilityChecks(page, gameId, {
        ...ctx,
        gameMode,
        deep: !!ctx.viewportDeep
    });

    if (ctx.isMobile) {
        const { ensureHubSettingsClosed } = require('../../platform/mobile/lib/mobile_assertions');
        await runScenario('Hub UI reset', async () => {
            await ensureHubSettingsClosed(page);
        });
    }

    logStep('Capability audit', `${gameId} (${gameMode}) ok`);
    return caps;
}

async function capabilityBeforeLoop(page, gameId, ctx = {}) {
    await runCapabilityChecks(page, gameId, ctx);
}

async function capabilityMpBeforeLoop(page1, page2, gameId, ctx = {}) {
    await Promise.all([
        runCapabilityChecks(page1, gameId, { ...ctx, role: 'P1' }),
        runCapabilityChecks(page2, gameId, { ...ctx, role: 'P2' })
    ]);
}

/**
 * Registry-driven MP beforeLoop: capability checks + scenarios implied by caps.
 * @param {string} gameId
 * @param {object} [options]
 * @param {string} [options.gameMode]
 * @param {boolean} [options.skipPilesSync]
 * @param {boolean} [options.skipPilesSelection]
 * @param {boolean} [options.skipRefresh]
 * @param {boolean} [options.skipLineDrag]
 * @param {Array<(p1: import('playwright').Page, p2: import('playwright').Page, ctx: object) => Promise<void>>} [options.extra]
 * @returns {(page1: import('playwright').Page, page2: import('playwright').Page, ctx?: object) => Promise<void>}
 */
function buildMpBeforeLoop(gameId, options = {}) {
    const { mpScenarioSkipFlags } = require('../infra/mp-player-utils');
    const scenarioSlices = options.scenarioSlices
        || parseScenarioSlices(process.argv.slice(2), process.env.FIVE_SCENARIO || 'default');
    const scenario = options.scenario || scenarioSlices[0];
    const inferred = mpScenarioSkipFlags(gameId, options.gameMode, scenario);
    const {
        gameMode,
        skipPilesSync = inferred.skipPilesSync,
        skipPilesSelection = inferred.skipPilesSelection,
        skipRefresh = inferred.skipRefresh,
        skipLineDrag = inferred.skipLineDrag,
        extra = [],
        runMobileExtras = true
    } = options;

    const { runCapabilityMpScenarios } = require('./mp-scenarios');

    return async (page1, page2, ctx = {}) => {
        const merged = {
            ...ctx,
            gameId,
            gameMode: gameMode || ctx.gameMode,
            scenario,
            scenarioSlices
        };
        await runCapabilityMpScenarios(gameId, page1, page2, merged, {
            gameMode: merged.gameMode,
            skipPilesSync,
            skipPilesSelection,
            skipRefresh,
            skipLineDrag,
            runMobileExtras
        });
        if (merged.baselineResetCount != null) {
            ctx.baselineResetCount = merged.baselineResetCount;
        }
        for (const fn of extra) {
            await fn(page1, page2, merged);
        }
    };
}

/**
 * Thin SP audit config — registry capability checks + optional hooks.
 * Smoke scenario skips the move loop (capability-only CI).
 *
 * @param {string} gameId
 * @param {object} [options]
 * @param {string} [options.gameMode]
 * @param {boolean} [options.skipGameLoop]
 * @param {Array<(page: import('playwright').Page, ctx: object) => Promise<void>>} [options.extra]
 */
function spConfig(gameId, options = {}) {
    const scenarioSlices = parseScenarioSlices(process.argv.slice(2), process.env.FIVE_SCENARIO || 'default');
    const scenario = normalizeScenario(scenarioSlices[0]);
    applySpeedProfile(null, { scenario });

    const { gameMode, extra = [], skipGameLoop: skipLoopOpt } = options;
    const mode = gameMode || GameRegistry.defaultModeFor(gameId);

    const beforeLoop = composeBeforeLoop(
        (page, ctx) => capabilityBeforeLoop(page, gameId, {
            ...ctx,
            gameMode: mode,
            scenario,
            scenarioSlices
        }),
        ...extra.map((fn) => (page, ctx) => fn(page, {
            ...ctx,
            gameMode: mode,
            scenario,
            scenarioSlices
        }))
    );

    return {
        beforeLoop,
        gameMode: mode,
        skipGameLoop: skipLoopOpt ?? isSmokeScenario(scenarioSlices)
    };
}

/**
 * @param {string} gameId
 * @param {object} [options] — passed to buildMpBeforeLoop; gameMode required for multi-mode games
 */
function mpConfig(gameId, options = {}) {
    const scenarioSlices = parseScenarioSlices(process.argv.slice(2), process.env.FIVE_SCENARIO || 'default');
    const scenario = normalizeScenario(scenarioSlices[0]);
    applySpeedProfile(null, { scenario });

    return {
        beforeLoop: buildMpBeforeLoop(gameId, { ...options, scenario, scenarioSlices }),
        gameMode: options.gameMode || GameRegistry.defaultModeFor(gameId)
    };
}

module.exports = {
    capsFor,
    runCapabilityChecks,
    capabilityBeforeLoop,
    capabilityMpBeforeLoop,
    buildMpBeforeLoop,
    spConfig,
    mpConfig,
    assertScoreboardState,
    assertTurnIndicatorState
};
