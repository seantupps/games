/**
 * Bananagrams multiplayer audit — game-specific MP helpers.
 * Generic waits/banners/sync: ptests/shared/platform/mp-*.js
 */
const { ensureTestStack, buildAppUrl } = require('../../../shared/infra/emulator-utils');
const mpWaits = require('../../../shared/platform/mp-waits');
const mpBanners = require('../../../shared/platform/mp-banners');
const mpActionAssertions = require('../../../shared/platform/mp-action-assertions');
const mpHostSync = require('../../../shared/platform/mp-host-sync');
const { mpPollMs, mpVictoryWaitMs, mpReviewWaitMs, peelStabilitySettleMs } = require('../../../shared/infra/speed-profiles');

const { WAIT_MS, waitOpts, captureMpState, captureBothMpStates, timeoutError, waitForDiag, getGameFrame, getGame } = mpWaits;
const { clearBanners, enableFastBanners, enableInstantBanners, dismissBanners } = mpBanners;
const { assertActionBannerOnBoth } = mpActionAssertions;
const { hostPublishPartyBoard, syncGuestInventoryToHost, syncGuestPoolFromHost, syncGuestLettersFromHost, syncGuestFromHost, flushHostBananaInteractions, waitGuestDumpResult, waitDumpResult } = mpHostSync;

const RESET_WAIT_MS = Math.min(8000, Number(process.env.FIVE_MP_BANANA_RESET_MS || 6000));
const HOST_PEEL_GUEST_STABILITY_MS = peelStabilitySettleMs();
const HOST_UID = 'u_banana_host';
const GUEST_UID = 'u_banana_guest';
const BUNCH = 100;
const VERBOSE_FOCUS_DEBUG = false;

function log(msg) {
    if (!VERBOSE_FOCUS_DEBUG) {
        if (msg.startsWith('[FOCUSDBG]') || msg.startsWith('[PEELLAT]')) return;
    }
    console.log(`[TEST] ${msg}`);
}

async function seedBananaRoom(page, roomId) {
    const victoryDwellMs = Number(process.env.FIVE_VICTORY_DWELL_MS || 600);
    await page.addInitScript(({ uid, name, color, victoryDwellMs: dwell }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
        window.FIVE_VICTORY_DWELL_MS = dwell;
    }, { uid: HOST_UID, name: 'BananaHost', color: '#3b82f6', victoryDwellMs });
    await page.goto(buildAppUrl(roomId, 'P1', 'bananagrams', 'multiplayer'));
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await page.evaluate(({ rId, hostUid, guestUid }) => {
        const db = window.NetworkEngine.db;
        return db.ref().update({
            [`games/${rId}`]: {
                host: hostUid,
                status: 'playing',
                global: {
                    game: 'bananagrams',
                    mode: 'multiplayer',
                    firstPlayer: 'P1',
                    resetCount: 1,
                    turn: 'P1'
                },
                playerData: {
                    [hostUid]: { name: 'BananaHost', color: '#3b82f6' },
                    [guestUid]: { name: 'BananaGuest', color: '#ef4444' }
                }
            },
            [`gameData/${rId}`]: null
        });
    }, { rId: roomId, hostUid: HOST_UID, guestUid: GUEST_UID });
}

async function joinGuest(page, roomId) {
    await page.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
    }, { uid: GUEST_UID, name: 'BananaGuest', color: '#ef4444' });
    await page.goto(buildAppUrl(roomId, 'P2', 'bananagrams', 'multiplayer'));
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await page.evaluate(async ({ rId, uid, name, color }) => {
        const ne = window.NetworkEngine;
        if (ne.roomId !== rId) ne.joinRoom(rId);
        await ne.registerPlayerInRoom(name, color);
        await ne.db.ref(`games/${rId}/users/${uid}`).set(Date.now());
    }, { rId: roomId, uid: GUEST_UID, name: 'BananaGuest', color: '#ef4444' });
}

async function waitForDeal(page, role, mpPages = null) {
    await waitForDiag(page, `deal (${role})`, ({ r }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g
            && g.isMultiplayer
            && g.mode === 'multiplayer'
            && g.playerRole === r
            && g._dictReady
            && g._checker
            && g.started
            && g.tiles?.length > 0;
    }, { r: role }, WAIT_MS, mpPages);
}

/** Starting rack must not reshuffle after deal (catches double-deal / stale board apply). */
async function assertDealStable(page, role, options = {}) {
    const settleMs = options.settleMs ?? 450;
    const mpPages = options.mpPages || null;
    const frame = await getGameFrame(page);
    const snap = () => frame.evaluate(() => {
        const g = window.game;
        return {
            count: g.tiles.length,
            sig: g.tiles.map((t) => `${t.id}:${t.letter}@${Math.round(t.x)},${Math.round(t.y)}`).join('|')
        };
    });
    const a = await snap();
    await page.waitForTimeout(settleMs);
    const b = await snap();
    if (a.sig !== b.sig) {
        const snaps = mpPages?.page1 && mpPages?.page2
            ? await captureBothMpStates(mpPages.page1, mpPages.page2, `${role} deal stable`)
            : { role, a, b };
        throw new Error(`${role} starting rack switched after deal (${a.count} tiles, sig changed)\n${JSON.stringify(snaps)}`);
    }
}

async function getHandAndPool(page) {
    return page.evaluate(({ bunch }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const hand = g?.tiles?.length ?? 0;
        return { hand, poolAfterDeal: bunch - hand * 2 };
    }, { bunch: BUNCH });
}

async function assertStartingRackConnected(page, label, mpPages = null) {
    const deadline = Date.now() + WAIT_MS;
    let lastResult = null;
    while (Date.now() < deadline) {
        await waitForDiag(page, `${label} rack ready`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!(g && Array.isArray(g.tiles) && g.tiles.length > 0 && !g._bannerText);
        }, {}, Math.min(WAIT_MS, 800), mpPages);
        lastResult = await page.evaluate(() => {
            const win = document.getElementById('game-frame')?.contentWindow;
            const g = win?.game;
            const rules = win?.BananaRules;
            if (!g?.tiles?.length || !rules) {
                return { ok: false, reason: 'missing-game-or-tiles' };
            }
            const gap = rules.TILE_GAP;
            const tol = 2;
            const tiles = g.tiles.filter((t) => typeof t.x === 'number' && typeof t.y === 'number');
            if (!tiles.length) return { ok: false, reason: 'no-positioned-tiles' };
            const seen = new Set([0]);
            const q = [0];
            while (q.length) {
                const i = q.shift();
                const a = tiles[i];
                for (let j = 0; j < tiles.length; j++) {
                    if (seen.has(j)) continue;
                    const b = tiles[j];
                    const dx = Math.abs(a.x - b.x);
                    const dy = Math.abs(a.y - b.y);
                    const verticalNeighbor = dx <= tol && Math.abs(dy - gap) <= tol;
                    const horizontalNeighbor = dy <= tol && Math.abs(dx - gap) <= tol;
                    if (verticalNeighbor || horizontalNeighbor) {
                        seen.add(j);
                        q.push(j);
                    }
                }
            }
            const connected = seen.size === tiles.length;
            const coords = tiles.map((t) => ({ id: t.id, x: t.x, y: t.y }));
            return {
                ok: connected,
                connected,
                gap,
                coords,
                count: tiles.length,
                banner: g._bannerText || ''
            };
        });
        if (lastResult.ok) return;
        await page.waitForTimeout(40);
    }
    const snaps = mpPages?.page1 && mpPages?.page2
        ? await captureBothMpStates(mpPages.page1, mpPages.page2, `${label} rack connected`)
        : { label };
    throw new Error(`${label} rack disconnected\n${JSON.stringify({ result: lastResult, snaps }, null, 2)}`);
}

async function waitPool(page, count, label = `pool=${count}`, mpPages = null) {
    await waitForDiag(page, label, ({ n }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const hud = document.getElementById('game-frame')?.contentDocument?.getElementById('banana-pool-count');
        return g && g._tilePool.length === n && hud?.textContent === String(n);
    }, { n: count }, WAIT_MS, mpPages);
}

async function waitPoolBoth(page1, page2, count) {
    const label = `pool=${count} (both players)`;
    try {
        await Promise.all([
            waitPool(page1, count, `${label} host`),
            waitPool(page2, count, `${label} guest`)
        ]);
    } catch (err) {
        const snaps = await captureBothMpStates(page1, page2, label);
        throw timeoutError(label, WAIT_MS, snaps, err.message);
    }
}


async function splitViaDrag(frame, { mobile = false } = {}) {
    const pointerType = mobile ? 'touch' : 'mouse';
    return frame.evaluate(async ({ pointerType }) => {
        const g = window.game;
        const tile = document.querySelector('.tile');
        if (!tile) return { ok: false, reason: 'no-tile' };
        const r = tile.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        tile.dispatchEvent(mk('pointerdown', cx, cy));
        tile.dispatchEvent(mk('pointermove', cx + 24, cy + 24));
        tile.dispatchEvent(mk('pointerup', cx + 24, cy + 24));
        await new Promise((res) => requestAnimationFrame(res));
        await new Promise((res) => requestAnimationFrame(res));
        const faceUp = !document.querySelector('.tile')?.classList.contains('is-face-down');
        return {
            ok: g.gameStarted && faceUp,
            gameStarted: g.gameStarted,
            faceUp,
            hasTimer: !!document.getElementById('banana-timer')
        };
    }, { pointerType });
}

async function rightClickDump(frame, tileIndex = -1) {
    return frame.evaluate((idx) => {
        const g = window.game;
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx < 0 ? nodes.length + idx : idx];
        if (!node) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const before = g.tiles.length;
        const beforeIds = [...g.tiles.map((t) => t.id)];
        const ok = g._handleDump(tile);
        return { ok, before, beforeIds };
    }, tileIndex);
}



async function holdDump(frame, tileIndex = -1, holdMs = 480, hostPage = null) {
    const triggered = await frame.evaluate(async ({ idx, holdMs }) => {
        const g = window.game;
        g.beginGame?.();
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx < 0 ? nodes.length + idx : idx];
        if (!node) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const before = g.tiles.length;
        const beforeIds = [...g.tiles.map((t) => t.id)];
        const guestMp = g._isMultiplayerMode?.() && !g.isHost?.();
        if (guestMp) {
            g._sendBananaInteraction({ type: 'dump', tileId: tile.id });
            return {
                ok: true,
                before,
                beforeIds,
                after: g.tiles.length,
                guestMp: true
            };
        }
        const r = node.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type) => new PointerEvent(type, {
            clientX: cx,
            clientY: cy,
            bubbles: true,
            pointerId: 1,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        node.dispatchEvent(mk('pointerdown'));
        await new Promise((res) => setTimeout(res, holdMs));
        node.dispatchEvent(mk('pointerup'));
        await new Promise((res) => requestAnimationFrame(res));
        return {
            ok: g.tiles.length === beforeIds.length + 2,
            before,
            beforeIds,
            after: g.tiles.length,
            guestMp: false
        };
    }, { idx: tileIndex, holdMs });
    if (!triggered.ok && !triggered.guestMp) return triggered;
    if (!triggered.guestMp) return triggered;

    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        if (hostPage) await flushHostBananaInteractions(hostPage);
        const ready = await frame.evaluate(({ idList }) => {
            const g = window.game;
            return g.tiles.length === idList.length + 2;
        }, { idList: triggered.beforeIds });
        if (ready) {
            return {
                ok: true,
                before: triggered.before,
                beforeIds: triggered.beforeIds,
                after: triggered.beforeIds.length + 2
            };
        }
        await frame.waitForTimeout(mpPollMs());
    }
    const after = await frame.evaluate(() => window.game?.tiles?.length ?? 0);
    return {
        ok: false,
        before: triggered.before,
        beforeIds: triggered.beforeIds,
        after
    };
}

async function dumpTile(frame, tileIndex = -1, { mobile = false, hostPage = null } = {}) {
    if (mobile) return holdDump(frame, tileIndex, 480, hostPage);
    return rightClickDump(frame, tileIndex);
}

async function assertSpawnedAtViewportBottom(frame, beforeIds, label = 'spawn', minAdded = 1) {
    const result = await frame.evaluate(({ idList, minExpected }) => {
        const g = window.game;
        const size = BananaRules.TILE_SIZE;
        const pad = BananaRules.spawnViewportPad();
        const idSet = new Set(idList);
        const added = g.tiles.filter((t) => !idSet.has(t.id));
        const old = g.tiles.filter((t) => idSet.has(t.id));
        const bounds = g._getVisibleWorldBounds();
        const keys = new Set();
        if (added.length < minExpected) {
            return { ok: false, reason: 'missing-added', added: added.length, minExpected };
        }

        for (const t of added) {
            if (t.x < bounds.left + pad || t.y < bounds.top + pad
                || t.x + size > bounds.right - pad || t.y + size > bounds.bottom - pad) {
                return { ok: false, reason: 'not-visible', tile: t, bounds };
            }
            const key = BananaRules.tileCellKey(t.x, t.y, size);
            if (keys.has(key)) {
                return { ok: false, reason: 'duplicate-cell', key, tile: t };
            }
            keys.add(key);
            for (const o of old) {
                if (BananaRules.tilesOverlap(t.x, t.y, o.x, o.y, size)) {
                    return { ok: false, reason: 'overlap', tile: t, other: o };
                }
            }
        }
        for (let i = 0; i < added.length; i++) {
            for (let j = i + 1; j < added.length; j++) {
                if (BananaRules.tilesOverlap(added[i].x, added[i].y, added[j].x, added[j].y, size)) {
                    return { ok: false, reason: 'added-overlap', a: added[i], b: added[j] };
                }
            }
        }
        return { ok: true, added: added.map((t) => ({ id: t.id, x: t.x, y: t.y })), bounds };
    }, { idList: beforeIds, minExpected: minAdded });
    if (!result.ok) {
        throw new Error(`${label} spawn invalid (${JSON.stringify(result)})`);
    }
    return result;
}

async function assertAllTilesVisible(page, label, { minTiles = 1 } = {}) {
    const result = await page.evaluate(({ minExpected }) => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        const doc = frame?.contentDocument;
        if (!g || !doc) return { ok: false, reason: 'missing-game-frame' };
        const modelTiles = [...(g.tiles || [])];
        const missingDomIds = [];
        const hidden = [];
        if (modelTiles.length < minExpected) {
            return {
                ok: false,
                reason: 'too-few-model-tiles',
                modelCount: modelTiles.length,
                minExpected
            };
        }
        for (const t of modelTiles) {
            const node = doc.querySelector(`.tile[data-tile-id="${t.id}"]`);
            if (!node) {
                missingDomIds.push(t.id);
                continue;
            }
            const r = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            const visible = style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0.01
                && r.width > 0
                && r.height > 0;
            if (!visible) {
                hidden.push({
                    id: t.id,
                    rect: {
                        left: Math.round(r.left),
                        top: Math.round(r.top),
                        right: Math.round(r.right),
                        bottom: Math.round(r.bottom),
                        width: Math.round(r.width),
                        height: Math.round(r.height)
                    },
                    style: {
                        display: style.display,
                        visibility: style.visibility,
                        opacity: style.opacity
                    }
                });
            }
        }
        return {
            ok: missingDomIds.length === 0 && hidden.length === 0,
            modelCount: modelTiles.length,
            domCount: doc.querySelectorAll('.tile').length,
            missingDomIds,
            hidden
        };
    }, { minExpected: minTiles });
    if (!result.ok) {
        throw new Error(`${label} guest tiles not all visible (${JSON.stringify(result)})`);
    }
    return result;
}
async function naturalDrag(page, frame, tileId, targetWorldX, targetWorldY) {
    // 1. Get current screen position of the tile
    const startPos = await frame.evaluate((id) => {
        const node = document.querySelector(`.tile[data-tile-id="${id}"]`);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, tileId);

    if (!startPos) throw new Error(`Could not find tile ${tileId} for drag`);

    // 2. Convert world target to client coordinates
    const endPos = await frame.evaluate(({ tx, ty }) => {
        const g = window.game;
        const vp = window.GameViewport;
        return vp.worldToClient(g, tx, ty);
    }, { tx: targetWorldX, ty: targetWorldY });

    // 3. Perform the physical drag using Playwright's mouse
    // We adjust for the iframe offset
    const frameHandle = await page.$('#game-frame');
    const frameBox = await frameHandle.boundingBox();

    await page.mouse.move(frameBox.x + startPos.x, frameBox.y + startPos.y);
    await page.mouse.down();
    // Simulate a bit of human jitter or movement steps
    await page.mouse.move(frameBox.x + endPos.x, frameBox.y + endPos.y, { steps: 5 });
    await page.mouse.up();
}

async function dragTileByIndex(frame, tileIndex, dx, dy, { mobile = false } = {}) {
    const pointerType = mobile ? 'touch' : 'mouse';
    return frame.evaluate(({ idx, dx, dy, pointerType }) => {
        const g = window.game;
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx];
        if (!node || !g) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const r = node.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        node.dispatchEvent(mk('pointerdown', x0, y0));
        node.dispatchEvent(mk('pointermove', x0 + dx, y0 + dy));
        node.dispatchEvent(mk('pointerup', x0 + dx, y0 + dy));
        g.requestRender();
        return { ok: true, id: tile.id, x: tile.x, y: tile.y };
    }, { idx: tileIndex, dx, dy, pointerType });
}

function peelGridOnFrameScript() {
    const g = window.game;
    const opts = {
        cols: BananaRules.COLS,
        gap: BananaRules.TILE_GAP,
        tileSize: BananaRules.TILE_SIZE,
        handBelowCenter: BananaRules.HAND_BELOW_CENTER,
        handSize: BananaRules.startingHandSize(2)
    };
    const src = [...(g.tiles || [])].slice(0, 3);
    if (src.length < 3) return { placed: false, valid: false, reason: 'short-hand' };
    g.tiles = src.map((t, idx) => ({
        id: t.id || `peel-${idx}`,
        letter: t.letter || 'A',
        x: 2400,
        y: idx === 0 ? 2200 : idx === 1 ? 2240 : 2280,
        faceUp: true
    }));
    // Fixture only shapes local grid for peel validation; do not persist this temporary
    // 3-tile layout or we can evict positions for the rest of the hand.
    g.requestRender();
    const placed = BananaGrid.allTilesPlacedInGrid(g.tiles, { x: g.ORIGIN, y: g.ORIGIN }, opts);
    const valid = BananaGrid.validateGrid(g.tiles, g._checker);
    return { placed, valid: valid.ok };
}

function peelGridScriptEval({ nPlayers = 2 } = {}) {
    const g = window.game;
    const opts = {
        cols: BananaRules.COLS,
        gap: BananaRules.TILE_GAP,
        tileSize: BananaRules.TILE_SIZE,
        handBelowCenter: BananaRules.HAND_BELOW_CENTER,
        handSize: BananaRules.startingHandSize(nPlayers)
    };
    const src = [...(g.tiles || [])].slice(0, 3);
    if (src.length < 3) return { placed: false, valid: false, reason: 'short-hand' };
    g.tiles = src.map((t, idx) => ({
        id: t.id || `peel-${idx}`,
        letter: t.letter || 'A',
        x: 2400,
        y: idx === 0 ? 2200 : idx === 1 ? 2240 : 2280,
        faceUp: true
    }));
    // Fixture only shapes local grid for peel validation; do not persist this temporary
    // 3-tile layout or we can evict positions for the rest of the hand.
    g.requestRender();
    const placed = BananaGrid.allTilesPlacedInGrid(g.tiles, { x: g.ORIGIN, y: g.ORIGIN }, opts);
    const valid = BananaGrid.validateGrid(g.tiles, g._checker);
    return { placed, valid: valid.ok, words: valid.words };
}

const peelGridScript = peelGridScriptEval;

module.exports = {
    ...mpWaits,
    ...mpBanners,
    ...mpActionAssertions,
    ...mpHostSync,
    HOST_UID,
    GUEST_UID,
    BUNCH,
    VERBOSE_FOCUS_DEBUG,
    mpPollMs,
    mpVictoryWaitMs,
    mpReviewWaitMs,
    RESET_WAIT_MS,
    HOST_PEEL_GUEST_STABILITY_MS,
    log,
    waitPoolBoth,
    seedBananaRoom,
    joinGuest,
    waitForDeal,
    assertDealStable,
    getHandAndPool,
    assertStartingRackConnected,
    waitPool,
    splitViaDrag,
    rightClickDump,
    holdDump,
    dumpTile,
    assertSpawnedAtViewportBottom,
    assertAllTilesVisible,
    naturalDrag,
    dragTileByIndex,
    peelGridOnFrameScript,
    peelGridScriptEval,
    peelGridScript
};
