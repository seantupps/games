/** Solo UI audit scenarios (rack, drag, viewport). Action slices: solo-ui-actions.js */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { buildAppUrl } = require('../../../shared/infra/emulator-utils');
const { getGameFrame } = require('../../../shared/platform/game-harness');
const {
    prepareSoloUiSession,
    runSoloFullGameAudit
} = require('./solo-ui-actions');

/** @param {import('playwright').Page} page @param {{ includeAiSolver?: boolean }} [options] */
async function runSoloUiAudit(page, options = {}) {
    let { gameFrame } = await prepareSoloUiSession(page);

    console.log('[TEST] Tiles start face-down before first move...');
    const faceDown = await gameFrame.evaluate(() => {
        const tiles = [...document.querySelectorAll('.tile')];
        const lettersHidden = tiles.every((t) => {
            const face = t.querySelector('.tile-face');
            if (!face) return false;
            const c = getComputedStyle(face).color;
            return c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
        });
        return {
            ok: tiles.length >= 21
                && tiles.every((t) => t.classList.contains('is-face-down'))
                && lettersHidden
                && window.game.tiles.every((t) => !t.faceUp)
                && !window.game.gameStarted,
            count: tiles.length
        };
    });
    if (!faceDown.ok) throw new Error(`Tiles should start face-down with letters hidden (${JSON.stringify(faceDown)})`);
    console.log('[TEST] SUCCESS: Face-down starting rack (letters hidden).');

    console.log('[TEST] Hand dealt below viewport center...');
    const handBelow = await gameFrame.evaluate(() => {
        const host = document.getElementById('game-container').getBoundingClientRect();
        const tiles = [...document.querySelectorAll('.tile')];
        let sy = 0;
        tiles.forEach((t) => {
            const r = t.getBoundingClientRect();
            sy += r.top + r.height / 2;
        });
        sy /= tiles.length;
        const centerY = host.top + host.height / 2;
        return { ok: sy > centerY + 48, sy, centerY };
    });
    if (!handBelow.ok) throw new Error(`Hand should start below center (${JSON.stringify(handBelow)})`);
    console.log('[TEST] SUCCESS: Hand below center.');

    console.log('[TEST] Scoreboard hidden for Bananagrams...');
    const scoreboardHidden = await page.evaluate(() => {
        const hidden = (el) => !el || !el.classList.contains('show');
        const hubSb = document.querySelector('.scoreboard');
        const frame = document.getElementById('game-frame');
        const iframeSb = frame?.contentDocument?.querySelector('.scoreboard');
        return { ok: hidden(hubSb) && hidden(iframeSb) };
    });
    if (!scoreboardHidden.ok) throw new Error('Scoreboard should stay hidden for Bananagrams');
    console.log('[TEST] SUCCESS: Scoreboard hidden.');

    console.log('[TEST] Tiles are square (40Ã—40)...');
    const squareTiles = await gameFrame.evaluate(() => {
        const tiles = [...document.querySelectorAll('.tile')];
        const sizes = tiles.map((t) => {
            const r = t.getBoundingClientRect();
            const face = t.querySelector('.tile-face');
            const fr = face ? face.getBoundingClientRect() : r;
            return { w: r.width, h: r.height, fw: fr.width, fh: fr.height };
        });
        const ok = sizes.every((s) =>
            Math.abs(s.w - s.h) < 1
            && Math.abs(s.fw - s.fh) < 1
            && Math.abs(s.w - 40) < 3
        );
        return { ok, sample: sizes[0] };
    });
    if (!squareTiles.ok) throw new Error(`Tiles must be square 40px (${JSON.stringify(squareTiles)})`);
    console.log('[TEST] SUCCESS: Square tiles.');

    console.log('[TEST] Starting rack tiles touch (no extra gap)...');
    const rackTouching = await gameFrame.evaluate(() => {
        const row = window.game.tiles.slice(0, 7).sort((a, b) => a.x - b.x);
        const gaps = row.slice(1).map((t, i) => t.x - row[i].x);
        return { ok: gaps.every((g) => Math.abs(g - 40) < 0.01), gaps };
    });
    if (!rackTouching.ok) throw new Error(`Rack tiles should touch (${JSON.stringify(rackTouching)})`);
    console.log('[TEST] SUCCESS: Rack tiles flush together.');

    console.log('[TEST] Starting rack centered on board origin...');
    const rackCentered = await gameFrame.evaluate(() => {
        const g = window.game;
        const size = 40;
        const xs = g.tiles.map((t) => t.x);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const rackCenter = minX + (maxX - minX + size) / 2;
        return {
            ok: Math.abs(rackCenter - g.ORIGIN) < 1,
            rackCenter,
            origin: g.ORIGIN
        };
    });
    if (!rackCentered.ok) throw new Error(`Rack not centered on origin (${JSON.stringify(rackCentered)})`);
    console.log('[TEST] SUCCESS: Rack centered on origin.');

    console.log('[TEST] Solo pool is fast bag (default, not classic 72)...');
    const soloPool = await gameFrame.evaluate(() => ({
        fastTotal: BananaRules.poolTotal(BananaRules.SOLO_FAST_TILE_BAG),
        classicTotal: BananaRules.poolTotal(BananaRules.SOLO_CLASSIC_TILE_BAG),
        hand: BananaRules.SOLO_HAND,
        hud: document.getElementById('banana-pool-count')?.textContent,
        poolLen: window.game._tilePool.length,
        bagMode: window.game.serializeBoard?.()?.bagMode,
        mode: window.game.mode
    }));
    const expectedBunch = String(soloPool.fastTotal - soloPool.hand);
    if (soloPool.fastTotal !== 50 || soloPool.hand !== 21 || expectedBunch !== '29') {
        throw new Error(`Solo fast bag should be 50 tiles (21 dealt, 29 bunch) (${JSON.stringify(soloPool)})`);
    }
    if (soloPool.fastTotal >= soloPool.classicTotal) {
        throw new Error(`Solo fast bag should be smaller than classic 72 (${JSON.stringify(soloPool)})`);
    }
    if (soloPool.bagMode !== 'solo-fast' || soloPool.hud !== expectedBunch || soloPool.poolLen !== soloPool.fastTotal - soloPool.hand) {
        throw new Error(`Lobby solo fast bunch HUD ${expectedBunch} (${JSON.stringify(soloPool)})`);
    }
    console.log(`[TEST] SUCCESS: Solo fast bag (${soloPool.fastTotal} tiles), bunch HUD ${expectedBunch}.`);

    console.log('[TEST] Center dot hidden until dev mode (F6)...');
    const dotHidden = await gameFrame.evaluate(() => {
        const dot = document.getElementById('center-dot');
        return {
            ok: !dot || getComputedStyle(dot).display === 'none',
            display: dot ? getComputedStyle(dot).display : 'missing'
        };
    });
    if (!dotHidden.ok) throw new Error(`Center dot should be hidden (${JSON.stringify(dotHidden)})`);
    console.log('[TEST] SUCCESS: Center dot hidden without dev mode.');

    console.log('[TEST] Face-down tiles use theme color (same as face-up)...');
    const faceDownColor = await gameFrame.evaluate(() => {
        const face = document.querySelector('.tile.is-face-down .tile-face');
        if (!face) return { ok: false, reason: 'no-face-down' };
        const theme = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
        const probe = document.createElement('div');
        probe.style.background = theme || '#3b82f6';
        document.body.appendChild(probe);
        const themeBg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const faceBg = getComputedStyle(face).backgroundColor;
        return { ok: faceBg === themeBg, faceBg, themeBg };
    });
    if (!faceDownColor.ok) throw new Error(`Face-down color should match theme (${JSON.stringify(faceDownColor)})`);
    console.log('[TEST] SUCCESS: Face-down matches theme color.');

    console.log('[TEST] Timer HUD top-left (no dump zone â€” right-click to dump)...');
    const chrome = await gameFrame.evaluate(() => {
        const hud = document.getElementById('banana-hud');
        const timer = document.getElementById('banana-timer');
        const host = document.getElementById('game-container').getBoundingClientRect();
        const hr = hud?.getBoundingClientRect();
        return {
            timer: !!timer,
            noDumpZone: !document.querySelector('[data-testid="dump-zone"]'),
            topLeft: hr ? hr.left - host.left < 40 : false
        };
    });
    if (!chrome.timer || !chrome.noDumpZone || !chrome.topLeft) {
        throw new Error(`HUD chrome wrong: ${JSON.stringify(chrome)}`);
    }
    console.log('[TEST] SUCCESS: Timer top-left, no dump zone.');

    console.log('[TEST] Background pan enabled (drag empty board)...');
    const panEnabled = await gameFrame.evaluate(() => {
        const g = window.game;
        const surface = document.querySelector('.board-pan-layer') || document.getElementById('board-canvas');
        const before = { x: g.canvasPanX, y: g.canvasPanY };
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 9,
            pointerType: 'mouse',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        const x0 = r.left + 40;
        const y0 = r.top + 40;
        const x1 = r.left + 180;
        const y1 = r.top + 140;
        surface.dispatchEvent(mk('pointerdown', x0, y0));
        surface.dispatchEvent(mk('pointermove', x1, y1));
        surface.dispatchEvent(mk('pointerup', x1, y1));
        const after = { x: g.canvasPanX, y: g.canvasPanY };
        const dist = Math.hypot(after.x - before.x, after.y - before.y);
        return {
            ok: dist >= 20,
            dist,
            panInit: !!g._viewportPanInit,
            viewportPanEnabled: g.capabilities?.viewportPanEnabled !== false
        };
    });
    if (!panEnabled.viewportPanEnabled) {
        throw new Error(`Registry should enable viewportPanEnabled (${JSON.stringify(panEnabled)})`);
    }
    if (!panEnabled.panInit) {
        throw new Error(`Viewport pan handlers not attached (${JSON.stringify(panEnabled)})`);
    }
    if (!panEnabled.ok) {
        throw new Error(`Background pan should move the board (${JSON.stringify(panEnabled)})`);
    }
    console.log(`[TEST] SUCCESS: Background pan moves board (${Math.round(panEnabled.dist)}px).`);

    console.log('[TEST] Game starts + timer on first tile drag...');
    const gameStart = await gameFrame.evaluate(async () => {
        const g = window.game;
        const tile = document.querySelector('[data-tile-id="t-0"]');
        const r = tile.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        tile.dispatchEvent(mk('pointerdown', cx, cy));
        tile.dispatchEvent(mk('pointermove', cx + 30, cy + 30));
        tile.dispatchEvent(mk('pointerup', cx + 30, cy + 30));
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        const faceUp = document.querySelector('[data-tile-id="t-0"]')?.classList.contains('is-face-down') === false;
        return {
            ok: g.gameStarted && faceUp && !!document.getElementById('banana-timer'),
            gameStarted: g.gameStarted,
            faceUp
        };
    });
    if (!gameStart.ok) throw new Error(`Game did not start on drag (${JSON.stringify(gameStart)})`);
    console.log('[TEST] SUCCESS: Game started, tiles face-up, timer running.');

    console.log('[TEST] ` reset clears timer and restarts face-down rack...');
    await gameFrame.evaluate(() => {
        const g = window.game;
        g.elapsedMs = 15000;
        g._updateHudEl();
    });
    await gameFrame.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote', bubbles: true }));
    });
    await page.waitForFunction(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g || g.gameStarted || g.elapsedMs !== 0 || g.tiles.length < 21) return false;
        const doc = win.document;
        const tiles = [...doc.querySelectorAll('.tile')];
        return tiles.length >= 21 && tiles.every((t) => t.classList.contains('is-face-down'));
    }, { timeout: STEP_MS });
    const afterReset = await gameFrame.evaluate(() => {
        const g = window.game;
        const timer = document.getElementById('banana-timer')?.textContent;
        const faceDown = [...document.querySelectorAll('.tile')]
            .every((t) => t.classList.contains('is-face-down'));
        return {
            ok: timer === '0:00' && !g.gameStarted && g.elapsedMs === 0 && faceDown,
            timer,
            gameStarted: g.gameStarted,
            elapsedMs: g.elapsedMs,
            faceDown
        };
    });
    if (!afterReset.ok) throw new Error(`\` reset failed (${JSON.stringify(afterReset)})`);
    console.log('[TEST] SUCCESS: ` reset timer + fresh rack.');

    console.log('[TEST] Board persists across full desktop refresh...');
    const persisted = await gameFrame.evaluate(() => {
        const g = window.game;
        g.setupNewHand();
        g.beginGame();
        const t0 = g.tiles?.[0];
        const t1 = g.tiles?.[1];
        if (!t0 || !t1) return { ok: false, reason: 'short-hand' };
        // Use uncommon coordinates so restoration mismatches are obvious.
        t0.x = 1111; t0.y = 2222;
        t1.x = 1199; t1.y = 2266;
        g.persistState();
        return {
            ok: true,
            key: g.getPersistKey(),
            sig: JSON.stringify((g.tiles || []).map((t) => ({
                id: t.id,
                x: Math.round(t.x),
                y: Math.round(t.y),
                letter: t.letter,
                faceUp: !!t.faceUp
            })).sort((a, b) => String(a.id).localeCompare(String(b.id)))),
            gameStarted: !!g.gameStarted,
            pool: g._tilePool?.length ?? 0
        };
    });
    if (!persisted.ok) throw new Error(`Unable to seed persisted board (${JSON.stringify(persisted)})`);

    // Full-page refresh on the solo Bananagrams URL (PC F5), not iframe-only reload.
    await page.goto(buildAppUrl('lobby', 'P1', 'bananagrams', 'solo'), { waitUntil: 'load' });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, { timeout: STEP_MS });
    await page.waitForSelector('#game-frame');
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g
            && g.started
            && (g.tiles?.length ?? 0) >= 21
            && g._dictReady
            && g._checker;
    }, { timeout: STEP_MS });

    const restored = await (await getGameFrame(page)).evaluate(({ key, expectedSig, expectedStarted, expectedPool }) => {
        const g = window.game;
        const raw = window.localStorage.getItem(key);
        const sig = JSON.stringify((g?.tiles || []).map((t) => ({
            id: t.id,
            x: Math.round(t.x),
            y: Math.round(t.y),
            letter: t.letter,
            faceUp: !!t.faceUp
        })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
        return {
            ok: !!g
                && !!raw
                && sig === expectedSig
                && !!g.gameStarted === expectedStarted
                && (g._tilePool?.length ?? 0) === expectedPool,
            gameStarted: !!g?.gameStarted,
            pool: g?._tilePool?.length ?? null,
            sigMatches: sig === expectedSig,
            hasRaw: !!raw
        };
    }, {
        key: persisted.key,
        expectedSig: persisted.sig,
        expectedStarted: persisted.gameStarted,
        expectedPool: persisted.pool
    });
    if (!restored.ok) throw new Error(`Desktop refresh persistence failed (${JSON.stringify(restored)})`);
    console.log('[TEST] SUCCESS: Full-page refresh restored in-progress board.');
    gameFrame = await getGameFrame(page);

    console.log('[TEST] Dragging a tile...');
    const dragResult = await gameFrame.evaluate(() => {
        const g = window.game;
        const tile = document.querySelector('.tile');
        if (!tile) return { ok: false, reason: 'no-tile' };
        const id = tile.dataset.tileId;
        const r = tile.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const before = { x: g.tiles.find((t) => t.id === id).x, y: g.tiles.find((t) => t.id === id).y };
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        tile.dispatchEvent(mk('pointerdown', cx, cy));
        tile.dispatchEvent(mk('pointermove', cx + 80, cy + 60));
        tile.dispatchEvent(mk('pointerup', cx + 80, cy + 60));
        const after = { x: g.tiles.find((t) => t.id === id).x, y: g.tiles.find((t) => t.id === id).y };
        return { before, after, moved: Math.hypot(after.x - before.x, after.y - before.y) > 20 };
    });
    if (!dragResult.moved) throw new Error('Tile drag did not change position');
    console.log('[TEST] SUCCESS: Tile drag (no marquee highlight).');

    console.log('[TEST] Resize: viewport center stable...');
    const relBefore = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const win = frame.contentWindow;
        const g = win.game;
        const vp = win.GameViewport;
        g.centerViewOnOrigin();
        vp.applyPanZoom(g);
        const fb = frame.getBoundingClientRect();
        const p = vp.worldToClient(g, g.ORIGIN, g.ORIGIN);
        return {
            relX: (p.x - fb.left) / fb.width - 0.5,
            relY: (p.y - fb.top) / fb.height - 0.5
        };
    });
    await page.setViewportSize({ width: 960, height: 720 });
    await page.evaluate(() => window.FiveHubLayout?.notifyGameFrameLayout?.());
    await page.waitForTimeout(350);
    const relAfter = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const win = frame.contentWindow;
        const g = win.game;
        const vp = win.GameViewport;
        vp.reflowOnResize(g);
        vp.applyPanZoom(g);
        const fb = frame.getBoundingClientRect();
        const p = vp.worldToClient(g, g.ORIGIN, g.ORIGIN);
        return {
            relX: (p.x - fb.left) / fb.width - 0.5,
            relY: (p.y - fb.top) / fb.height - 0.5
        };
    });
    const centerDrift = Math.hypot(relAfter.relX - relBefore.relX, relAfter.relY - relBefore.relY);
    if (centerDrift > 0.03) {
        throw new Error(`Center dot drifted on resize (drift=${centerDrift.toFixed(4)})`);
    }
    console.log('[TEST] SUCCESS: Resize center stable.');

    const bg = await page.evaluate(() => {
        const doc = document.getElementById('game-frame').contentWindow.document;
        const container = doc.getElementById('game-container');
        const canvas = doc.getElementById('board-canvas');
        const layer = doc.querySelector('.board-pan-layer');
        const read = (el) => (el ? getComputedStyle(el).backgroundColor : null);
        return {
            container: read(container),
            canvas: read(canvas),
            layer: read(layer)
        };
    });
    const transparent = 'rgba(0, 0, 0, 0)';
    if (bg.container !== transparent || bg.canvas !== transparent || bg.layer !== transparent) {
        throw new Error(`Background should be transparent: ${JSON.stringify(bg)}`);
    }
    console.log('[TEST] SUCCESS: Background transparent.');

    const zoomFrame = await getGameFrame(page);

    const zoomWhileDragging = await page.evaluate(() => {
        const g = document.getElementById('game-frame').contentWindow.game;
        g._viewportPanning = false;
        const t = g.targetZoom;
        g._pointerDragging = true;
        g.handleZoom(-200);
        const allowed = g.targetZoom > t + 0.001;
        g._pointerDragging = false;
        return allowed;
    });
    if (!zoomWhileDragging) throw new Error('Zoom blocked during tile drag');
    console.log('[TEST] SUCCESS: Zoom allowed during tile drag.');

    console.log('[TEST] Wheel zoom always anchors to viewport center...');
    const centerZoom = await zoomFrame.evaluate(async () => {
        const g = window.game;
        const vp = window.GameViewport;
        const host = document.getElementById('game-container');
        const r = host.getBoundingClientRect();
        const vcx = r.left + r.width / 2;
        const vcy = r.top + r.height / 2;
        const focal = vp.clientToWorld(g, vcx, vcy);
        g._pointerDragging = false;
        g._viewportPanning = false;
        const startZoom = g.targetZoom;
        for (let i = 0; i < 15; i++) {
            if (g.targetZoom < startZoom * 1.5) g.handleZoom(-40);
            while (Math.abs(g.zoom - g.targetZoom) > 0.002) {
                vp.tick(g);
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }
        const after = vp.worldToClient(g, focal.x, focal.y);
        const drift = Math.hypot(after.x - vcx, after.y - vcy);
        return { ok: drift <= 8, drift, zoom: g.zoom };
    });
    if (!centerZoom.ok) throw new Error(`Viewport-center zoom drifted (${JSON.stringify(centerZoom)})`);
    console.log(`[TEST] SUCCESS: Viewport-center zoom (drift=${centerZoom.drift.toFixed(1)}px).`);

    console.log('[TEST] Drag + center zoom together...');
    const cursorAnchor = await zoomFrame.evaluate(async () => {
        const g = window.game;
        const vp = window.GameViewport;
        const host = document.getElementById('game-container');
        const hr = host.getBoundingClientRect();
        const vcx = hr.left + hr.width / 2;
        const vcy = hr.top + hr.height / 2;
        const centerFocal = vp.clientToWorld(g, vcx, vcy);
        const tile = document.querySelector('[data-tile-id="t-1"]') || document.querySelector('.tile');
        const r = tile.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x, clientY: y, bubbles: true, pointerId: 3,
            pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1
        });
        tile.dispatchEvent(mk('pointerdown', cx, cy));
        const px = cx + 6;
        const py = cy + 6;
        tile.dispatchEvent(mk('pointermove', px, py));
        g.mousePos = { x: px, y: py };
        const startZoom = g.targetZoom;
        for (let i = 0; i < 20; i++) {
            g._viewportPanning = false;
            if (g.targetZoom < startZoom * 1.6) g.handleZoom(-40);
            g.mousePos = { x: px, y: py };
            while (Math.abs(g.zoom - g.targetZoom) > 0.002) {
                vp.tick(g);
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }
        const tr = tile.getBoundingClientRect();
        const domDist = Math.hypot(tr.left + tr.width / 2 - px, tr.top + tr.height / 2 - py);
        const centerAfter = vp.worldToClient(g, centerFocal.x, centerFocal.y);
        const centerDriftPx = Math.hypot(centerAfter.x - vcx, centerAfter.y - vcy);
        tile.dispatchEvent(mk('pointerup', px, py));
        return { ok: domDist <= 12 && centerDriftPx <= 8, domDist, centerDriftPx };
    });
    if (!cursorAnchor.ok) throw new Error(`Drag + center zoom failed (${JSON.stringify(cursorAnchor)})`);
    console.log(`[TEST] SUCCESS: Drag + center zoom (cursor=${cursorAnchor.domDist.toFixed(1)}px).`);

    console.log('[TEST] Marquee multi-select + group drag...');
    const groupDrag = await page.evaluate(() => {
        const win = document.getElementById('game-frame').contentWindow;
        const doc = win.document;
        const g = win.game;
        const surface = doc.querySelector('.board-pan-layer');
        const r = surface.getBoundingClientRect();
        const mk = (type, x, y, button) => new win.PointerEvent(type, {
            clientX: x, clientY: y, bubbles: true, pointerId: 2,
            pointerType: 'mouse', button, buttons: button === 2 ? 2 : 0
        });
        surface.dispatchEvent(mk('pointerdown', r.left + 8, r.top + 8, 2));
        surface.dispatchEvent(mk('pointermove', r.right - 8, r.bottom - 8, 2));
        surface.dispatchEvent(mk('pointerup', r.right - 8, r.bottom - 8, 2));
        if (g._selectedIds.size < 2) return { ok: false, reason: 'marquee' };
        const ids = [...g._selectedIds];
        const lead = doc.querySelector(`[data-tile-id="${ids[0]}"]`);
        const before = ids.map((id) => {
            const t = g.tiles.find((x) => x.id === id);
            return { x: t.x, y: t.y };
        });
        const tr = lead.getBoundingClientRect();
        const cx = tr.left + tr.width / 2;
        const cy = tr.top + tr.height / 2;
        const mkL = (type, x, y) => new win.PointerEvent(type, {
            clientX: x, clientY: y, bubbles: true, pointerId: 1,
            pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1
        });
        lead.dispatchEvent(mkL('pointerdown', cx, cy));
        lead.dispatchEvent(mkL('pointermove', cx + 70, cy + 50));
        lead.dispatchEvent(mkL('pointerup', cx + 70, cy + 50));
        const after = ids.map((id) => {
            const t = g.tiles.find((x) => x.id === id);
            return { x: t.x, y: t.y };
        });
        const leadMoved = Math.hypot(after[0].x - before[0].x, after[0].y - before[0].y) > 15;
        const allMoved = after.every((p, i) => Math.hypot(p.x - before[i].x, p.y - before[i].y) > 15);
        return { ok: leadMoved && allMoved, selected: ids.length };
    });
    if (!groupDrag.ok) throw new Error(`Marquee/group drag failed (${JSON.stringify(groupDrag)}`);
    console.log(`[TEST] SUCCESS: Marquee selected ${groupDrag.selected}, group drag moved all.`);

    const smoothZoom = await page.evaluate(async () => {
        const win = document.getElementById('game-frame').contentWindow;
        const g = win.game;
        const vp = win.GameViewport;
        g.zoom = 1;
        g.targetZoom = 1;
        if (vp) {
            vp.syncFocalFromPan(g);
            vp.applyPanZoom(g);
        }
        const startZoom = g.zoom;
        win.postMessage({ type: 'wheel', deltaY: -160 }, '*');
        const samples = [g.zoom];
        for (let i = 0; i < 40; i++) {
            await new Promise((r) => win.requestAnimationFrame(r));
            samples.push(g.zoom);
        }
        const unique = [...new Set(samples.map((z) => z.toFixed(4)))];
        return {
            grew: g.targetZoom > startZoom && samples[samples.length - 1] > startZoom,
            gradual: unique.length >= 4,
            notInstant: Math.abs(samples[1] - samples[samples.length - 1]) > 0.01,
            uniqueSteps: unique.length
        };
    });
    if (!smoothZoom.grew) throw new Error('Zoom target did not increase');
    if (!smoothZoom.gradual) throw new Error(`Zoom not smooth (${smoothZoom.uniqueSteps} steps)`);
    if (!smoothZoom.notInstant) throw new Error('Zoom jumped instantly');
    console.log(`[TEST] SUCCESS: Smooth zoom (${smoothZoom.uniqueSteps} steps).`);

    if (options.includeAiSolver) {
        console.log('[TEST] AI solver playthrough (placement, peel, dump)...');
        await runSoloFullGameAudit(page);
        console.log('[TEST] SUCCESS: AI solver playthrough complete.');
        gameFrame = await getGameFrame(page);
    }

    const { runVictoryScenarios } = require('./victory');
    await runVictoryScenarios(page, gameFrame, { skipPeelWinFixture: !!options.includeAiSolver });
}

module.exports = { runSoloUiAudit };
