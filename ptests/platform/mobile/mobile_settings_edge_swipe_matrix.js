/**
 * Mobile settings edge-swipe matrix:
 * - piles: enabled (should open settings)
 * - line: disabled
 * - bananagrams: disabled
 */
const { applyEnvProfiles } = require('../../shared/infra/env-defaults');
applyEnvProfiles(['stack', 'quiet', 'mobile']);

const { ensureTestStack, buildAppUrl, buildHubUrl } = require('../../shared/infra/emulator-utils');
const { launchMobileBrowser, createMobileContext } = require('./lib/mobile-utils');
const { enableMobileHub } = require('./lib/mobile_assertions');

async function openGameOnMobile(page, gameId, gameMode = 'classic') {
    await page.goto(buildHubUrl('lobby'));
    await enableMobileHub(page);
    await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('username', 'TotallyAwesome5');
    });
    await page.goto(buildAppUrl('lobby', 'P1', gameId, gameMode));
    await page.waitForSelector('#game-frame');
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        return !!(frame?.contentWindow?.game?.identitySynced || frame?.contentWindow?.game?.playerRole);
    });
    await page.evaluate(() => window.FiveViewport?.syncHubViewport?.());
}

async function runEdgeSwipeProbe(page) {
    return page.evaluate(async () => {
        const sidebar = document.getElementById('settings-sidebar');
        const edge = document.getElementById('mobile-settings-edge');
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        if (!sidebar || !edge || !win) return { ok: false, reason: 'missing-sidebar-edge-or-frame' };
        const g = win.game;

        const closeSidebar = () => {
            sidebar.classList.remove('open');
            document.body.classList.remove('settings-open');
        };
        closeSidebar();

        const rect = edge.getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        const x0 = rect.left + 8;
        const x1 = x0 + 120;
        const mk = (type, x, yv) => new PointerEvent(type, {
            clientX: x,
            clientY: yv,
            bubbles: true,
            pointerId: 11,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });

        edge.dispatchEvent(mk('pointerdown', x0, y));
        edge.dispatchEvent(mk('pointermove', x1, y));
        edge.dispatchEvent(mk('pointerup', x1, y));
        await new Promise((r) => setTimeout(r, 120));

        const openedByGesture = sidebar.classList.contains('open');
        closeSidebar();

        // Real path: iframe pan edge gesture relays to hub.
        const target = win.document.querySelector('.board-pan-layer')
            || win.document.getElementById('game-container')
            || win.document.body;
        if (!target) return { ok: false, reason: 'no-iframe-target' };
        const mkInner = (type, x, yv) => new win.PointerEvent(type, {
            clientX: x,
            clientY: yv,
            bubbles: true,
            pointerId: 17,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const yIn = Math.max(24, Math.round(win.innerHeight * 0.45));
        target.dispatchEvent(mkInner('pointerdown', 6, yIn));
        target.dispatchEvent(mkInner('pointermove', 96, yIn));
        target.dispatchEvent(mkInner('pointerup', 96, yIn));
        await new Promise((r) => setTimeout(r, 120));
        const openedByIframeRelay = sidebar.classList.contains('open');
        closeSidebar();

        return {
            ok: true,
            opened: openedByGesture || openedByIframeRelay,
            openedByGesture,
            openedByIframeRelay,
            gameName: g?.gameName || null,
            gameMode: g?.mode || null,
            supportsSettingsEdgeSwipe: g?.hasCap?.('supportsSettingsEdgeSwipe') ?? null
        };
    });
}

async function assertEdgeSwipeForGame(browser, gameId, expectOpen) {
    const { context, page } = await createMobileContext(browser);
    try {
        await openGameOnMobile(page, gameId, gameId === 'bananagrams' ? 'solo' : 'classic');
        const result = await runEdgeSwipeProbe(page);
        if (!result.ok) throw new Error(`${gameId}: probe failed (${JSON.stringify(result)})`);
        if (!!result.opened !== !!expectOpen) {
            throw new Error(
                `${gameId}: edge swipe expectation failed (${JSON.stringify({
                    expectOpen,
                    result
                })})`
            );
        }
        console.log(
            `[MOBILE] settings edge swipe ${gameId}: ${expectOpen ? 'enabled' : 'disabled'} OK`
        );
    } finally {
        await context.close().catch(() => {});
    }
}

async function main() {
    await ensureTestStack();
    const browser = await launchMobileBrowser();
    try {
        await assertEdgeSwipeForGame(browser, 'piles', true);
        await assertEdgeSwipeForGame(browser, 'line', false);
        await assertEdgeSwipeForGame(browser, 'bananagrams', false);
        console.log('[MOBILE] settings edge swipe matrix OK');
    } finally {
        await browser.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('[MOBILE] settings edge swipe matrix failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});

