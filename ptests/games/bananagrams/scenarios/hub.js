/** Hub navigation scenarios for solo Bananagrams. */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { buildHubUrl, buildAppUrl } = require('../../../shared/infra/emulator-utils');
const { getGameFrame } = require('../../../shared/platform/game-harness');
const { runScenarios } = require('../../../shared/platform/scenario-runner');
const { runDictCommandScenarios } = require('./dict-command');

async function testHubSwitchFromLine(page) {
    console.log('[TEST] Hub switch Line â†’ Bananagrams: board instant + centered...');
    await page.goto(buildHubUrl('lobby'));
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: STEP_MS });
    await page.goto(buildAppUrl('lobby', 'P1', 'line', 'classic'));
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.gameName === 'line' && g.nodes?.length > 0;
    }, { timeout: STEP_MS });

    const t0 = Date.now();
    await page.evaluate(() => {
        if (typeof window.setGame === 'function') window.setGame('bananagrams');
    });
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        return g?.gameName === 'bananagrams' && g.started && g.tiles?.length >= 21 && g._dictReady;
    }, { timeout: STEP_MS });
    const loadMs = Date.now() - t0;
    if (loadMs > 4000) {
        throw new Error(`Bananagrams board too slow after switch (${loadMs}ms)`);
    }

    const gameFrame = await getGameFrame(page);
    await gameFrame.evaluate(async () => {
        const g = window.game;
        if (g.centerViewOnOrigin) g.centerViewOnOrigin();
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
    });
    const placement = await gameFrame.evaluate(() => {
        const g = window.game;
        const host = document.getElementById('game-container').getBoundingClientRect();
        const centerX = host.left + host.width / 2;
        const centerY = host.top + host.height / 2;
        const toClient = (x, y) => (
            typeof GameViewport !== 'undefined' && GameViewport.worldToClient
                ? GameViewport.worldToClient(g, x, y)
                : { x, y }
        );
        let sx = 0;
        let sy = 0;
        g.tiles.forEach((t) => {
            const p = toClient(t.x + 20, t.y + 20);
            sx += p.x;
            sy += p.y;
        });
        sx /= g.tiles.length;
        sy /= g.tiles.length;
        const origin = toClient(g.ORIGIN, g.ORIGIN);
        return {
            rackCenterX: sx,
            viewportCenterX: centerX,
            originX: origin.x,
            horizOk: Math.abs(sx - centerX) < 36,
            originHorizOk: Math.abs(origin.x - centerX) < 40,
            belowCenter: sy > centerY + 48,
            tileCount: g.tiles.length
        };
    });
    if (!placement.horizOk && !placement.originHorizOk) {
        throw new Error(`Board not horizontally centered (${JSON.stringify(placement)})`);
    }
    if (!placement.belowCenter) {
        throw new Error(`Rack should be below viewport center (${JSON.stringify(placement)})`);
    }
    const noModeToggle = await page.evaluate(() => {
        const host = document.getElementById('mode-picker-host');
        return !host || host.children.length === 0;
    });
    if (!noModeToggle) throw new Error('Bananagrams should not show Solo/Multiplayer mode toggle');

    console.log(`[TEST] SUCCESS: Lineâ†’Bananagrams in ${loadMs}ms, rack centered (xâ‰ˆ${Math.round(placement.rackCenterX)}).`);
}

async function testReclickCurrentGameResets(page) {
    console.log('[TEST] Re-click Bananagrams in game picker resets face-down hand...');
    await page.evaluate(async () => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g) return;
        g.beginGame();
        g.gameStarted = true;
        g.tiles.forEach((t) => { t.faceUp = true; });
        g.requestRender?.();
        await new Promise((r) => win.requestAnimationFrame(r));
    });
    await page.waitForFunction(() => {
        const doc = document.getElementById('game-frame')?.contentDocument;
        return doc && [...doc.querySelectorAll('.tile')].some((t) => !t.classList.contains('is-face-down'));
    }, { timeout: STEP_MS });

    await page.evaluate(() => {
        if (typeof window.setGame === 'function') window.setGame('bananagrams');
    });
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const tiles = doc ? [...doc.querySelectorAll('.tile')] : [];
        if (!g || g.gameStarted || tiles.length < 21) return false;
        return tiles.every((t) => {
            const face = t.querySelector('.tile-face');
            if (!t.classList.contains('is-face-down') || !face) return false;
            const c = getComputedStyle(face).color;
            return c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
        });
    }, { timeout: STEP_MS });
    console.log('[TEST] SUCCESS: Re-click Bananagrams reset to face-down rack.');
}

async function runHubScenarios(page) {
    await runScenarios([
        { name: 'Hub switch Line to Bananagrams', run: () => testHubSwitchFromLine(page) },
        { name: 'Re-click game picker reset', run: () => testReclickCurrentGameResets(page) },
        { name: 'Chat /w dictionary commands', run: () => runDictCommandScenarios(page) }
    ]);
}

module.exports = { runHubScenarios, testHubSwitchFromLine, testReclickCurrentGameResets };
