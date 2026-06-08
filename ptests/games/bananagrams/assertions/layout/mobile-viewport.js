const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

/** Solo mobile: settings menu Bananagrams re-click must match refresh rack placement exactly.
 */
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const { getGameFrame } = require('../../../../shared/adapters/desktop-input');
const { touchPanBackground } = require('../../adapters/mobile-touch');
const { waitForSettingsSidebar } = require('../../../../platform/mobile/lib/mobile-waits');

const MIN_BELOW_CENTER = 48;

async function settleMobileViewport(page) {
    await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
}

/** Rack center vs visible game viewport center (worldToClient, matches hub scenarios). */
async function captureRackPlacementRelativeToCenter(frame, minBelow = MIN_BELOW_CENTER) {
    return frame.evaluate((minBelowCenter) => {
        const g = window.game;
        const container = document.getElementById('game-container');
        if (!g || !container) return { ok: false, reason: 'no-game-or-container' };
        const host = container.getBoundingClientRect();
        const viewportCx = host.left + host.width / 2;
        const viewportCy = host.top + host.height / 2;
        const tiles = g.tiles || [];
        if (!tiles.length) return { ok: false, reason: 'no-tiles' };
        const toClient = (x, y) => (
            typeof GameViewport !== 'undefined' && GameViewport.worldToClient
                ? GameViewport.worldToClient(g, x, y)
                : { x, y }
        );
        const half = (typeof BananaRules !== 'undefined' && BananaRules.TILE_SIZE)
            ? BananaRules.TILE_SIZE / 2
            : 20;
        let sx = 0;
        let sy = 0;
        tiles.forEach((t) => {
            const p = toClient(t.x + half, t.y + half);
            sx += p.x;
            sy += p.y;
        });
        const rackCx = sx / tiles.length;
        const rackCy = sy / tiles.length;
        return {
            ok: true,
            rackCx: Math.round(rackCx),
            rackCy: Math.round(rackCy),
            viewportCx: Math.round(viewportCx),
            viewportCy: Math.round(viewportCy),
            dxFromCenter: Math.round(rackCx - viewportCx),
            dyFromCenter: Math.round(rackCy - viewportCy),
            belowCenter: rackCy > viewportCy + minBelowCenter,
            tileCount: tiles.length,
            gameStarted: !!g?.gameStarted,
            fitZoomInitialized: !!g?._fitZoomInitialized
        };
    }, minBelow);
}

async function waitRackPlacementSettled(frame, timeoutMs = STEP_MS) {
    await frame.waitForFunction(() => {
        const g = window.game;
        const container = document.getElementById('game-container');
        if (!g || !container || !(g.tiles?.length >= 21) || !g._fitZoomInitialized) return false;
        if (typeof GameViewport === 'undefined' || !GameViewport.worldToClient) return false;
        const host = container.getBoundingClientRect();
        const half = (typeof BananaRules !== 'undefined' && BananaRules.TILE_SIZE)
            ? BananaRules.TILE_SIZE / 2
            : 20;
        const p = GameViewport.worldToClient(g, g.tiles[0].x + half, g.tiles[0].y + half);
        return p.x >= host.left - 8 && p.x <= host.right + 8
            && p.y >= host.top - 8 && p.y <= host.bottom + 8;
    }, { timeout: timeoutMs });
    await frame.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
}

async function waitMobileDefaultLayout(page, timeoutMs = STEP_MS) {
    await page.waitForFunction(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        return g && g.started && (g.tiles?.length ?? 0) >= 21 && !g.gameStarted && g._fitZoomInitialized;
    }, { timeout: timeoutMs });
    const frame = await getGameFrame(page);
    await waitRackPlacementSettled(frame, timeoutMs);
}

async function waitSoloStartingHand(page, timeoutMs = STEP_MS) {
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && g.started && (g.tiles?.length ?? 0) >= 21 && !g.gameStarted;
    }, { timeout: timeoutMs });
}

async function openMobileSettings(page, timeoutMs = STEP_MS) {
    await page.evaluate(() => {
        document.getElementById('settings-sidebar')?.classList.remove('open');
        localStorage.setItem('settingsOpen', 'false');
    });
    await page.waitForTimeout(400);
    await page.locator('#mobile-settings-btn').click({ timeout: timeoutMs });
    await waitForSettingsSidebar(page, true, timeoutMs);
}

async function closeMobileSettings(page, timeoutMs = STEP_MS) {
    await page.evaluate(() => {
        if (typeof window.toggleSidebar === 'function') window.toggleSidebar(false);
        else document.getElementById('settings-sidebar')?.classList.remove('open');
        localStorage.setItem('settingsOpen', 'false');
    });
    await waitForSettingsSidebar(page, false, timeoutMs);
    await page.evaluate(() => {
        window.FiveHubLayout?.notifyGameFrameLayout?.();
        window.FiveViewport?.syncHubViewport?.();
    });
    await settleMobileViewport(page);
}

async function clickBananagramsInSettingsMenu(page, timeoutMs = STEP_MS) {
    const btn = page.locator('#btn-bananagrams');
    await btn.waitFor({ state: 'visible', timeout: timeoutMs });
    await btn.click({ timeout: timeoutMs });
}

function assertPlacementExactMatch(refreshPl, resetPl, label) {
    if (refreshPl.dxFromCenter !== resetPl.dxFromCenter
        || refreshPl.dyFromCenter !== resetPl.dyFromCenter) {
        failWithSnapshot(label, ['rack placement must match refresh exactly'], { refreshPl, resetPl });
    }
    if (refreshPl.rackCx !== resetPl.rackCx || refreshPl.rackCy !== resetPl.rackCy) {
        failWithSnapshot(label, ['rack screen center must match refresh exactly'], { refreshPl, resetPl });
    }
}

/**
 * Solo mobile: reload baseline, pan away, settings → Bananagrams, rack identical to refresh.
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 */
async function assertMobileSoloSettingsResetMatchesRefresh(page, opts = {}) {
    const label = opts.label || 'solo mobile settings Bananagrams reset vs refresh';
    const timeoutMs = opts.timeoutMs ?? STEP_MS;

    await waitSoloStartingHand(page, timeoutMs);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
        window.FiveViewport?.syncHubViewport?.();
    });
    await waitSoloStartingHand(page, timeoutMs);
    await waitMobileDefaultLayout(page, timeoutMs);

    let frame = await getGameFrame(page);
    const refreshPl = await captureRackPlacementRelativeToCenter(frame);
    if (!refreshPl.ok) {
        failWithSnapshot('assertion', [`${label}: refresh baseline failed (${JSON.stringify(refreshPl)})`], {});
    }
    if (!refreshPl.belowCenter) {
        failWithSnapshot('assertion', [`${label}: refresh rack should be below viewport center (${JSON.stringify(refreshPl)})`], {});
    }

    const pan = await touchPanBackground(frame);
    if (!pan.ok || (pan.dist ?? 0) < 20) {
        failWithSnapshot('assertion', [`${label}: could not pan board away before settings reset (${JSON.stringify(pan)})`], {});
    }
    await settleMobileViewport(page);

    await openMobileSettings(page, timeoutMs);
    await clickBananagramsInSettingsMenu(page, timeoutMs);
    await waitSoloStartingHand(page, timeoutMs);
    await closeMobileSettings(page, timeoutMs);
    await waitMobileDefaultLayout(page, timeoutMs);

    frame = await getGameFrame(page);
    const resetPl = await captureRackPlacementRelativeToCenter(frame);
    if (!resetPl.ok) {
        failWithSnapshot('assertion', [`${label}: settings reset snapshot failed (${JSON.stringify(resetPl)})`], {});
    }
    if (!resetPl.belowCenter) {
        failWithSnapshot(label, ['settings reset should place rack below center'], { refreshPl, resetPl });
    }

    assertPlacementExactMatch(refreshPl, resetPl, label);

    return { refreshPl, resetPl };
}

module.exports = {
    assertMobileSoloSettingsResetMatchesRefresh,
    assertPlacementExactMatch,
    captureRackPlacementRelativeToCenter,
    settleMobileViewport
};
