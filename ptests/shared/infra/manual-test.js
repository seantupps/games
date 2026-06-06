/**
 * Manual test mode (--test) — boot party / solo session only; no audits or scenarios.
 */
const { chromium } = require('playwright');
const GameRegistry = require('../../../shared/games/registry');
const { ensureTestStack, buildAppUrl } = require('./emulator-utils');
const { DESKTOP_VIEWPORT } = require('./viewport-constants');
const { STEP_MS } = require('./timeouts');
const {
    playwrightHeadless,
    playwrightSlowMo,
    registerKeepOpenBrowser
} = require('./env-defaults');
const { printSuiteHeader } = require('./runner-results');
const { setupHubParty, gotoPartyGameUrls } = require('./hub-party');
const { formatAuditLabel } = require('./run-spec');

const PLAYER_COLORS = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#95a5a6'];

/**
 * @param {number} count
 */
function manualPlayerDefs(count) {
    return Array.from({ length: count }, (_, i) => ({
        uid: `u_manual_p${i + 1}`,
        name: `ManualP${i + 1}`,
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        role: `P${i + 1}`
    }));
}

function resolveManualGameId(spec) {
    const raw = spec.game || 'bananagrams';
    const token = String(raw).split(',')[0].trim().toLowerCase();
    for (const game of GameRegistry.list()) {
        if (game.id === token || game.id.includes(token) || game.label.toLowerCase().includes(token)) {
            return game.id;
        }
    }
    return token || 'bananagrams';
}

function resolveManualTopology(spec) {
    if (spec.topology === 'all') return 'desktop';
    return spec.topology || 'desktop';
}

/**
 * @param {import('playwright').Browser} browser
 * @param {import('./run-spec').RunSpec} spec
 */
async function bootManualSp(browser, spec) {
    const gameId = resolveManualGameId(spec);
    const gameMode = GameRegistry.defaultModeFor(gameId);
    const topology = resolveManualTopology(spec);
    const isMobile = topology === 'mobile';

    let context;
    let page;
    if (isMobile) {
        const { createMobileContext } = require('../../platform/mobile/lib/mobile-utils');
        ({ context, page } = await createMobileContext(browser));
        const { enableMobileHub } = require('../../platform/mobile/lib/mobile_assertions');
        await enableMobileHub(page);
        if (!playwrightHeadless()) {
            const { syncMpHeadedMobileViewport } = require('../platform/mp-headed-view');
            await syncMpHeadedMobileViewport(page);
        }
    } else {
        context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
        page = await context.newPage();
    }

    page.setDefaultTimeout(STEP_MS);
    const url = buildAppUrl('lobby', 'P1', gameId, gameMode);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_MS });
    await page.waitForSelector('#game-frame', { timeout: STEP_MS });
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        return !!(frame?.contentWindow?.game || frame?.contentWindow);
    }, { timeout: STEP_MS }).catch(() => {});

    console.log(`[MANUAL] SP ready — ${gameId} (${gameMode}), ${topology}, ${url}`);
    return { pages: [page], contexts: [context], gameId, gameMode, topology };
}

/**
 * @param {import('playwright').Browser} browser
 * @param {import('./run-spec').RunSpec} spec
 */
async function bootManualMp(browser, spec) {
    const gameId = resolveManualGameId(spec);
    const gameMode = GameRegistry.hubModeFor(gameId, true) || GameRegistry.defaultModeFor(gameId);
    const topology = resolveManualTopology(spec);
    const playerCount = spec.players || spec.playerCounts?.[0] || 2;
    const players = manualPlayerDefs(playerCount);

    const party = await setupHubParty(browser, {
        gameId,
        gameMode,
        players,
        topology,
        mixedLayout: spec.mixedLayout || []
    });

    await gotoPartyGameUrls(party);

    const mobile = topology === 'mobile';
    if (!playwrightHeadless()) {
        const { centerMpViewerOnPages } = require('../platform/mp-headed-view');
        await centerMpViewerOnPages(party.pages, { mobile });
    }

    console.log(
        `[MANUAL] MP ${playerCount}p ready — room ${party.roomId}, `
        + `game ${gameId} (${gameMode}), topology ${topology}`
    );
    party.pages.forEach((p, i) => {
        console.log(`[MANUAL]   P${i + 1} (${players[i].name}) — ${p.url()}`);
    });

    return {
        party,
        pages: party.pages,
        contexts: party.session.contexts,
        gameId,
        gameMode,
        topology,
        roomId: party.roomId
    };
}

/**
 * @param {import('./run-spec').RunSpec} spec
 */
async function runManualTest(spec) {
    const mode = spec.mode === 'all' ? 'mp' : spec.mode;
    if (mode === 'hub') {
        spec.mode = 'mp';
    }
    if (spec.topology === 'all') {
        spec.topology = 'desktop';
    }

    printSuiteHeader('MANUAL TEST — setup only (no audits)', [
        `mode=${mode}  ${formatAuditLabel({ ...spec, mode })}`,
        'Press Ctrl+C or close browser windows when finished.'
    ]);

    await ensureTestStack();

    const browser = await chromium.launch({
        headless: playwrightHeadless(),
        slowMo: playwrightSlowMo()
    });
    registerKeepOpenBrowser(browser);

    try {
        if (mode === 'sp') {
            await bootManualSp(browser, spec);
        } else if (mode === 'mp') {
            await bootManualMp(browser, spec);
        } else {
            throw new Error(`--test supports sp or mp mode (got ${spec.mode}). Use: node ptests/run.js mp --test`);
        }
        console.log('\n\x1b[33m[MANUAL] Session ready for manual testing.\x1b[0m');
    } catch (err) {
        if (!spec.keepBrowserOpen) await browser.close().catch(() => {});
        throw err;
    }
}

module.exports = {
    runManualTest,
    bootManualSp,
    bootManualMp,
    manualPlayerDefs,
    resolveManualGameId
};
