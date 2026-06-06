/**
 * Bananagrams MP — 3-player audit (2p gameplay parity + 3p banners + AI playthrough + post-game).
 * Run: npm run mp:banana:3p
 */
require('../../../shared/infra/bootstrap');

const { chromium } = require('playwright');
const { shouldCloseBrowser } = require('../../../shared/infra/env-defaults');
const { printSuiteHeader, printBenchmarkResults, runnerLog } = require('../../../shared/infra/runner-results');
const { ensureTestStack, buildAppUrl } = require('../../../shared/infra/emulator-utils');
const {
    setPlayerIdentity,
    openHubLobby
} = require('../../../shared/infra/hub-party');
const {
    BANANA_3P_PLAYERS,
    BANANA_HOST,
    createBanana3pSession,
    joinBananaPartySequentially,
    waitForRoomMembers
} = require('../../../shared/infra/scenarios/mp-3p-banana-party');
const { STEP_MS } = require('../../../shared/infra/timeouts');
const {
    dumpTile,
    dragTileByIndex,
    assertSpawnedAtViewportBottom,
    waitForDiag,
    waitDumpResult,
    splitViaDrag
} = require('./index');

const WAIT_MS = Math.min(STEP_MS, 3000);
const RESET_WAIT_MS = Math.min(WAIT_MS, Number(process.env.FIVE_MP_BANANA_RESET_MS || WAIT_MS));
const waitOpts = { timeout: WAIT_MS };
const BUNCH = 144;
const N_PLAYERS = 3;
const PLAYERS = BANANA_3P_PLAYERS;
const HOST = BANANA_HOST;

async function readPoolState(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return {
            hand: g?.tiles?.length ?? 0,
            pool: g?._tilePool?.length ?? -1
        };
    });
}

function log(msg) {
    console.log(`[3P] ${msg}`);
}

/** Verbose board-fit logging (mobile join / visibility). Set FIVE_3P_VIS_DEBUG=1 */
function logVis(msg) {
    if (process.env.FIVE_3P_VIS_DEBUG === '1' || process.env.FIVE_MP_VIS_DEBUG === '1') {
        console.log(`[3P-VIS] ${msg}`);
    }
}

function logVisAlways(msg) {
    console.log(`[3P-VIS] ${msg}`);
}

async function getGameFrame(page) {
    const handle = await page.$('#game-frame');
    const frame = await handle.contentFrame();
    if (!frame) throw new Error('game iframe not ready');
    return frame;
}

/** Guest join orders after host (indices into PLAYERS): P2→P3 and P3→P2. */
const SEQUENTIAL_GUEST_ORDERS = [[1, 2], [2, 1]];

async function assertJoinedPlayersReady(pages, playerIndices, roomId, label, opts = {}) {
    const hostPage = pages[0];
    try {
        await waitForRoomMembers(hostPage, roomId, playerIndices.length);
    } catch (err) {
        const snaps = await captureAllPlayersState(pages, `${label} (room members)`);
        throw timeoutError(`${label}: room members`, WAIT_MS, snaps, err.message);
    }

    // Bananagrams MP deals only once 2+ players are in the room.
    if (playerIndices.length < 2) {
        await waitForDiag3p(hostPage, `${label}: host iframe ready`, () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.isMultiplayer && g?.mode === 'multiplayer' && g?._dictReady && g?._checker;
        }, undefined, WAIT_MS, pages);
        return;
    }

    await waitForDiag3p(hostPage, `${label}: host dealt board`, ({ n }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?._dictReady || !g?._checker) return false;
        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const hands = board?.tilesOwnedByPlayer || {};
        return Object.values(hands).filter((h) => h?.length > 0).length >= n;
    }, { n: playerIndices.length }, WAIT_MS, pages);

    for (const idx of playerIndices) {
        const player = PLAYERS[idx];
        const page = pages[idx];
        await waitForDiag3p(page, `${label}: ${player.role} deal`, ({ u }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g
                && g.isMultiplayer
                && g.mode === 'multiplayer'
                && g._dictReady
                && g._checker
                && g.tiles?.length > 0
                && g._myUid?.() === u;
        }, { u: player.uid }, WAIT_MS, pages);
        if (opts.mobilePageIndices?.includes(idx)) {
            const { enableMobileHub } = require('../../../platform/mobile/lib/mobile_assertions');
            await enableMobileHub(pages[idx]);
            await pages[idx].evaluate(() => window.FiveViewport?.syncHubViewport?.());
        }
        const isMobilePlayer = !!(opts.mobilePageIndices && opts.mobilePageIndices.includes(idx));
        const visTimeout = isMobilePlayer ? 15000 : WAIT_MS;
        logVisAlways(
            `${label}: assertBoardVisible ${player.role} idx=${idx} mobile=${isMobilePlayer} `
            + `timeout=${visTimeout} mobilePageIndices=${JSON.stringify(opts.mobilePageIndices || [])}`
        );
        await assertBoardVisible(page, `${label}: ${player.role} board visible`, visTimeout, {
            role: player.role,
            playerIndex: idx,
            isMobilePlayer
        });
    }
}

/**
 * Realistic invite flow: host first, then each guest one at a time (any guest order).
 * After every join, every player already in the room must have a visible board.
 */
async function joinPartySequentially(pages, roomId, guestOrderIndices, opts = {}) {
    return joinBananaPartySequentially(pages, roomId, guestOrderIndices, {
        ...opts,
        log,
        assertJoinedPlayersReady
    });
}

async function assertRefreshPreservesLayout(page, player, frame, tileId) {
    await frame.evaluate(() => window.game._persistMpLayout?.());
    const tileBefore = await page.evaluate(({ id }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === id);
        return t ? { id: t.id, x: t.x, y: t.y } : null;
    }, { id: tileId });
    if (!tileBefore) {
        const diag = await readDealDiag(page).catch(() => ({}));
        throw new Error(
            `${player.role} needs tile ${tileId} before refresh test; diag=${JSON.stringify(diag)}`
        );
    }
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.identitySynced && g.isMultiplayer && g.mode === 'multiplayer';
    }, waitOpts);
    await waitForDiag3p(page, `${player.role} hand after reload`, ({ u }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g
            && g.isMultiplayer
            && g.mode === 'multiplayer'
            && g._dictReady
            && g._checker
            && g.tiles?.length > 0
            && g._myUid?.() === u;
    }, { u: player.uid }, WAIT_MS, [page]);
    const after = await page.evaluate(({ id }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === id);
        return t ? { x: t.x, y: t.y } : null;
    }, { id: tileBefore.id });
    if (!after || Math.abs(after.x - tileBefore.x) > 2 || Math.abs(after.y - tileBefore.y) > 2) {
        throw new Error(`${player.role} board reset on refresh (${JSON.stringify({ before: tileBefore, after })})`);
    }
}

/** Force portrait on a mobile context so review stacks vertically. */
async function setPortraitForReview(page) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g?._postGameReview) return;
        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const orig = board?.reviewLayoutsOrig || g._reviewLayouts;
        if (!orig || !Object.keys(orig).length) return;
        g._reviewLayoutsFp = null;
        const display = typeof g._displayReviewLayoutsFromOrig === 'function'
            ? g._displayReviewLayoutsFromOrig(orig)
            : board?.reviewLayouts;
        if (display) g._applyReviewLayouts(display);
        g._applyReviewViewportTransform?.();
    });
}

async function assertDepartedPlayerPurged(pages, departedUid, label) {
    const states = await Promise.all(pages.map((p, i) => p.evaluate(({ gone }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const party = g?._getPlayerUids?.() || [];
        const sb = document.querySelector('.scoreboard');
        const scoreSpans = sb ? sb.querySelectorAll('.score-user, .score-ai').length : 0;
        return {
            role: g?.playerRole,
            party,
            scoreSpans,
            mpOwned: Object.keys(g?._mpOwned || {}),
            boardHands: Object.keys(board?.tilesOwnedByPlayer || {}),
            reviewKeys: Object.keys(board?.reviewLayouts || {}),
            hasDeparted: party.includes(gone)
                || (g?._mpOwned || {})[gone]?.length > 0
                || (board?.tilesOwnedByPlayer || {})[gone]?.length > 0
        };
    }, { gone: departedUid })));
    for (const s of states) {
        if (s.hasDeparted || s.party.includes(departedUid)) {
            throw new Error(`${label}: ${s.role} still shows departed player (${JSON.stringify(s)})`);
        }
        if (s.scoreSpans > 2) {
            throw new Error(`${label}: ${s.role} scoreboard has >2 rows (${JSON.stringify(s)})`);
        }
    }
}

async function runNonHostLeaveAudit(browser, options = {}) {
    const roomId = `MP_BANANA_3P_LEAVE_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    log(`Non-host leave purge audit in ${roomId}...`);
    const { contexts, pages } = await createTestContexts(browser, options);
    const [page1, , page3] = pages;
    const departed = PLAYERS[1];

    try {
        await joinPartySequentially(pages, roomId, [1, 2]);
        await pages[1].evaluate(() => {
            window.HubApp.ctx.leaveParty();
        });
        await waitForRoomMembers(page1, roomId, 2);
        await waitForDiag3p(page1, 'host purged P2 after leave', ({ gone }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g?.isHost?.()) return false;
            const party = g._getPlayerUids?.() || [];
            const room = g.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            const hands = board?.tilesOwnedByPlayer || {};
            return party.length === 2
                && !party.includes(gone)
                && !(g._mpOwned || {})[gone]?.length
                && !(hands[gone]?.length > 0);
        }, { gone: departed.uid }, WAIT_MS, [page1, page3]);
        await assertDepartedPlayerPurged([page1, page3], departed.uid, 'after P2 leave');
        log('SUCCESS: Non-host leave purged departed player from party/scoreboard/board.');
        return true;
    } finally {
        await page1.evaluate(({ rId }) => {
            const db = window.NetworkEngine?.db;
            if (db) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
        }, { rId: roomId }).catch(() => {});
        await Promise.all(contexts.map((ctx) => ctx.close()));
    }
}

async function assertMobileReviewBoardsStacked(page, label) {
    const layout = await page.evaluate(() => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        if (!g?.tiles?.length) return { ok: false, reason: 'no-tiles' };
        const portrait = win.innerHeight > win.innerWidth;
        if (!portrait) return { ok: true, skipped: 'landscape' };
        const byOwner = {};
        g.tiles.forEach((t) => {
            const o = t.ownerUid || g._myUid();
            if (!byOwner[o]) byOwner[o] = { minY: t.y, maxY: t.y };
            byOwner[o].minY = Math.min(byOwner[o].minY, t.y);
            byOwner[o].maxY = Math.max(byOwner[o].maxY, t.y);
        });
        const bands = Object.values(byOwner).sort((a, b) => a.minY - b.minY);
        if (bands.length < 2) return { ok: false, reason: 'need-2-owners', count: bands.length };
        for (let i = 1; i < bands.length; i++) {
            if (bands[i].minY <= bands[i - 1].maxY + 20) {
                return { ok: false, reason: 'overlap', bands };
            }
        }
        return { ok: true, bands: bands.length };
    });
    if (!layout.ok && !layout.skipped) {
        throw new Error(`${label}: mobile review boards not stacked (${JSON.stringify(layout)})`);
    }
}

async function captureBoardVisibilityDiag(page) {
    return page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        const doc = frame?.contentDocument;
        const g = win?.game;
        const vw = win?.innerWidth ?? 0;
        const vh = win?.innerHeight ?? 0;
        const tileEls = doc ? [...doc.querySelectorAll('.tile')] : [];
        const tileRects = tileEls.map((el) => {
            const r = el.getBoundingClientRect();
            const inView = r.width > 8 && r.height > 8 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
            return {
                id: el.id,
                w: Math.round(r.width),
                h: Math.round(r.height),
                left: Math.round(r.left),
                top: Math.round(r.top),
                right: Math.round(r.right),
                bottom: Math.round(r.bottom),
                inView
            };
        });
        const sampleTiles = (g?.tiles || []).slice(0, 6).map((t) => ({
            id: t.id,
            x: t.x,
            y: t.y,
            faceUp: !!t.faceUp
        }));
        const canvas = doc?.getElementById('board-canvas');
        const panLayer = doc?.querySelector('.board-pan-layer');
        const canvasTransform = canvas ? getComputedStyle(canvas).transform : null;
        const panStyle = panLayer ? getComputedStyle(panLayer).transform : null;
        const container = doc?.getElementById('game-container');
        const containerRect = container?.getBoundingClientRect();
        return {
            hub: {
                fiveMobile: document.documentElement.classList.contains('five-mobile'),
                hubRoom: window.HubApp?.ctx?.roomId ?? null,
                frameSrc: frame?.src?.slice(-72) ?? null,
                hubVv: window.FiveViewport?.getVisibleSize?.() ?? null
            },
            iframe: {
                innerWidth: vw,
                innerHeight: vh,
                hasFrame: !!frame,
                hasDoc: !!doc,
                hasGame: !!g
            },
            game: g ? {
                uid: g._myUid?.() ?? null,
                role: g.playerRole ?? null,
                mode: g.mode ?? null,
                isMultiplayer: !!g.isMultiplayer,
                gameStarted: !!g.gameStarted,
                tilesRuntime: g.tiles?.length ?? 0,
                zoom: g.zoom,
                targetZoom: g.targetZoom,
                canvasPanX: g.canvasPanX,
                canvasPanY: g.canvasPanY,
                ORIGIN: g.ORIGIN,
                isMobileViewport: !!g.isMobileViewport?.(),
                usesPanZoom: !!g._usesPanZoomBoard?.(),
                fitZoomInitialized: !!g._fitZoomInitialized,
                mobileAnchorLocked: !!g._mobileLayoutAnchorLocked,
                hubVisibleViewport: g._hubVisibleViewport ?? null,
                boardSeq: g._boardSeq ?? null,
                localInventorySeq: g._localInventorySeq ?? null,
                capabilities: g.capabilities?.mobileLayoutPolicy ?? null
            } : null,
            platform: {
                EngineMobileLayout: typeof EngineMobileLayout !== 'undefined',
                EngineRoomSync: typeof EngineRoomSync !== 'undefined',
                GameViewport: typeof GameViewport !== 'undefined',
                MobileLayoutPolicy: typeof MobileLayoutPolicy !== 'undefined',
                refreshMobileLayout: typeof g?.refreshMobileLayout === 'function',
                getVisibleViewportSize: typeof g?.getVisibleViewportSize === 'function'
            },
            dom: {
                tileCount: tileEls.length,
                anyTileInView: tileRects.some((t) => t.inView),
                visibleTileCount: tileRects.filter((t) => t.inView).length,
                tileRects: tileRects.slice(0, 12),
                sampleTiles,
                canvasTransform,
                panLayerTransform: panStyle,
                container: containerRect ? {
                    w: Math.round(containerRect.width),
                    h: Math.round(containerRect.height),
                    left: Math.round(containerRect.left),
                    top: Math.round(containerRect.top)
                } : null
            }
        };
    });
}

function formatVisDiag(diag) {
    return JSON.stringify(diag, null, 2);
}

async function nudgeMobileBoardInFrame(page, label = 'nudge') {
    const before = await captureBoardVisibilityDiag(page).catch((e) => ({ captureError: String(e) }));
    logVis(`${label}: before nudge — tiles=${before?.dom?.tileCount} inView=${before?.dom?.anyTileInView}`);
    let nudgeError = null;
    try {
        await page.evaluate(() => {
            if (typeof window.FiveViewport !== 'undefined') {
                window.FiveViewport.syncHubViewport?.();
            }
            const win = document.getElementById('game-frame')?.contentWindow;
            const g = win?.game;
            if (!g) return;
            if (typeof g.refreshMobileLayout === 'function') g.refreshMobileLayout();
            if (typeof GameViewport !== 'undefined' && g._usesPanZoomBoard?.()) {
                GameViewport.reflowOnResize(g);
                const focal = typeof g.getViewportContentCenter === 'function'
                    ? g.getViewportContentCenter()
                    : { x: g.ORIGIN, y: g.ORIGIN };
                GameViewport.centerWorldPoint(g, focal.x, focal.y);
            }
            g.requestRender?.();
        });
    } catch (e) {
        nudgeError = String(e);
    }
    const after = await captureBoardVisibilityDiag(page).catch((e) => ({ captureError: String(e) }));
    logVis(`${label}: after nudge — tiles=${after?.dom?.tileCount} inView=${after?.dom?.anyTileInView}`);
    if (nudgeError) logVisAlways(`${label}: nudge evaluate error: ${nudgeError}`);
    return { before, after, nudgeError };
}

async function assertBoardVisible(page, label, timeout = WAIT_MS, meta = {}) {
    const isMobile = timeout > WAIT_MS || meta.isMobilePlayer || await page.evaluate(() =>
        document.documentElement.classList.contains('five-mobile')
        || !!document.getElementById('game-frame')?.contentWindow?.game?.isMobileViewport?.()
    );
    const deadline = isMobile ? Math.max(timeout, 15000) : timeout;
    logVisAlways(
        `${label}: start isMobile=${isMobile} deadline=${deadline} meta=${JSON.stringify(meta)}`
    );

    const pre = await captureBoardVisibilityDiag(page).catch((e) => ({ captureError: String(e) }));
    logVisAlways(
        `${label}: pre-wait tiles=${pre?.dom?.tileCount} inView=${pre?.dom?.anyTileInView} `
        + `iframe=${pre?.iframe?.innerWidth}x${pre?.iframe?.innerHeight} zoom=${pre?.game?.zoom}`
    );
    if (process.env.FIVE_3P_VIS_DEBUG === '1') {
        logVisAlways(`${label}: pre-wait full\n${formatVisDiag(pre)}`);
    }

    if (isMobile) await nudgeMobileBoardInFrame(page, `${label}: pre-wait nudge`);

    const pollMs = process.env.FIVE_3P_VIS_DEBUG === '1' ? 2000 : 0;
    const started = Date.now();
    let lastDiag = pre;

    try {
        if (pollMs > 0) {
            while (Date.now() - started < deadline) {
                const ok = await page.evaluate(() => {
                    const frame = document.getElementById('game-frame');
                    const win = frame?.contentWindow;
                    const doc = frame?.contentDocument;
                    const g = win?.game;
                    if (!g || !doc) return false;
                    const tiles = [...doc.querySelectorAll('.tile')];
                    if (!tiles.length) return false;
                    const vw = win.innerWidth;
                    const vh = win.innerHeight;
                    return tiles.some((t) => {
                        const r = t.getBoundingClientRect();
                        return r.width > 8 && r.height > 8 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
                    }) && g.isMultiplayer && g.mode === 'multiplayer';
                });
                if (ok) {
                    logVisAlways(`${label}: visible after ${Date.now() - started}ms`);
                    return;
                }
                lastDiag = await captureBoardVisibilityDiag(page);
                logVis(`${label}: poll +${Date.now() - started}ms inView=${lastDiag?.dom?.anyTileInView}`);
                await page.waitForTimeout(Math.min(pollMs, deadline - (Date.now() - started)));
            }
            throw new Error(`poll timeout after ${deadline}ms`);
        }

        await page.waitForFunction(() => {
            const frame = document.getElementById('game-frame');
            const win = frame?.contentWindow;
            const doc = frame?.contentDocument;
            const g = win?.game;
            if (!g || !doc) return false;
            const tiles = [...doc.querySelectorAll('.tile')];
            if (!tiles.length) return false;
            const vw = win.innerWidth;
            const vh = win.innerHeight;
            const visible = tiles.some((t) => {
                const r = t.getBoundingClientRect();
                return r.width > 8 && r.height > 8 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
            });
            return g.isMultiplayer && g.mode === 'multiplayer' && visible;
        }, { timeout: deadline });
        logVisAlways(`${label}: visible (waitForFunction ${Date.now() - started}ms)`);
    } catch (err) {
        if (isMobile) {
            const nudge = await nudgeMobileBoardInFrame(page, `${label}: retry nudge`);
            lastDiag = nudge.after || lastDiag;
        }
        lastDiag = await captureBoardVisibilityDiag(page).catch(() => lastDiag);
        const deal = await readDealDiag(page).catch((e) => ({ dealError: String(e) }));
        const body = formatVisDiag({ deal, visibility: lastDiag, meta, isMobile, deadline, elapsedMs: Date.now() - started });
        logVisAlways(`${label}: FAILED\n${body}`);
        throw new Error(`${label}: board not visible (${err.message})\n--- visibility diag ---\n${body}`);
    }
}

async function assertNoSnapBack(page, id, x, y, label) {
    await page.waitForFunction(({ tileId, tx, ty }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === tileId);
        return !!t && Math.abs(t.x - tx) < 3 && Math.abs(t.y - ty) < 3;
    }, { tileId: id, tx: x, ty: y }, waitOpts);
    await page.waitForTimeout(400);
    const snap = await page.evaluate(({ tileId }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === tileId);
        return t ? { x: t.x, y: t.y } : null;
    }, { tileId: id });
    if (!snap || Math.abs(snap.x - x) > 6 || Math.abs(snap.y - y) > 6) {
        throw new Error(`${label}: tile snapped back after drag (${JSON.stringify({ id, expected: { x, y }, got: snap })})`);
    }
}

async function enableFastBanners(frame) {
    await frame.evaluate(() => {
        const g = window.game;
        if (!g || g._bannerFast) return;
        g._bannerFast = true;
        const orig = g._showBanner.bind(g);
        g._showBanner = (text, ms = 2200, opts) => orig(text, Math.min(ms, 500), opts);
    });
}

async function clearBanners(frame) {
    await frame.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        g._bannerUntil = 0;
        g._syncBannerEl();
    });
}

async function dismissBannersAll(pages) {
    await Promise.all(pages.map(async (p) => clearBanners(await getGameFrame(p))));
}

async function seedRoom(page, roomId) {
    await page.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
    }, { uid: HOST.uid, name: HOST.name, color: HOST.color });
    await page.goto(buildAppUrl(roomId, HOST.role, 'bananagrams', 'multiplayer'));
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    const playerData = {};
    for (const p of PLAYERS) {
        playerData[p.uid] = { name: p.name, color: p.color };
    }
    await page.evaluate(({ rId, hostUid, pd }) => {
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
                playerData: pd
            },
            [`gameData/${rId}`]: null
        });
    }, { rId: roomId, hostUid: HOST.uid, pd: playerData });
}

async function joinPlayer(page, roomId, player) {
    await page.addInitScript(({ uid, name, color }) => {
        sessionStorage.setItem('game_uid', uid);
        sessionStorage.setItem('username', name);
        sessionStorage.setItem('userColor', color);
    }, { uid: player.uid, name: player.name, color: player.color });
    await page.goto(buildAppUrl(roomId, player.role, 'bananagrams', 'multiplayer'));
    await page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await page.evaluate(async ({ rId, uid, name, color }) => {
        const ne = window.NetworkEngine;
        if (ne.roomId !== rId) ne.joinRoom(rId);
        await ne.registerPlayerInRoom(name, color);
        await ne.db.ref(`games/${rId}/users/${uid}`).set(Date.now());
    }, { rId: roomId, uid: player.uid, name: player.name, color: player.color });
}

async function waitForDeal(page, uid, timeout = WAIT_MS, allPages = null) {
    await waitForDiag3p(page, `deal uid=${uid}`, ({ u }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g
            && g.isMultiplayer
            && g.mode === 'multiplayer'
            && g._dictReady
            && g._checker
            && g.tiles?.length > 0
            && g._myUid?.() === u;
    }, { u: uid }, timeout, allPages);
}

async function readDealDiag(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const pd = room?.playerData || {};
        const hands = board?.tilesOwnedByPlayer || {};
        return {
            hasGame: !!g,
            uid: g?._myUid?.() ?? null,
            isMultiplayer: !!g?.isMultiplayer,
            mode: g?.mode ?? null,
            dictReady: !!g?._dictReady,
            checker: !!g?._checker,
            tiles: g?.tiles?.length ?? -1,
            role: g?.playerRole ?? null,
            roomId: g?.roomId ?? null,
            hubRoom: window.HubApp?.ctx?.roomId ?? null,
            memberCount: Object.keys(pd).filter((k) => pd[k]).length,
            playerUids: Object.keys(pd).filter((k) => pd[k]),
            boardSeq: board?.seq ?? null,
            handsWithTiles: Object.keys(hands).filter((u) => hands[u]?.length > 0),
            handSizes: Object.fromEntries(
                Object.entries(hands).map(([u, h]) => [u, Array.isArray(h) ? h.length : 0])
            )
        };
    });
}

async function capturePartyDealState(page, tag) {
    try {
        return await readDealDiag(page).then((d) => ({ tag, ...d }));
    } catch (e) {
        return { tag, error: String(e) };
    }
}

async function captureAllPlayersState(pages, label) {
    const players = await Promise.all(
        pages.map((p, i) => capturePartyDealState(p, PLAYERS[i].role))
    );
    return { label, players };
}

function timeoutError(label, timeoutMs, snaps, cause) {
    const body = JSON.stringify(snaps, null, 2);
    const msg = `${label} timed out after ${timeoutMs}ms\n--- state ---\n${body}`;
    const err = new Error(cause ? `${msg}\n--- cause ---\n${cause}` : msg);
    err.name = 'TimeoutError';
    return err;
}

async function waitForDiag3p(page, label, predicate, arg, timeoutMs = WAIT_MS, allPages = null) {
    try {
        await page.waitForFunction(predicate, arg, { timeout: timeoutMs });
    } catch (err) {
        const snaps = allPages
            ? await captureAllPlayersState(allPages, label)
            : { label, target: await capturePartyDealState(page, label) };
        throw timeoutError(label, timeoutMs, snaps, err.message);
    }
}

async function syncGuestInventoriesToHost(hostPage, guestPages) {
    for (let i = 0; i < guestPages.length; i++) {
        const player = PLAYERS[i + 1];
        const page = guestPages[i];
        const owned = await page.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return (g?.tiles || []).map((t) => ({
                id: t.id,
                letter: t.letter,
                faceUp: !!t.faceUp
            }));
        });
        if (!owned.length) {
            throw new Error(`${player.role} has no tiles to sync to host`);
        }
        await hostPage.evaluate(({ uid, tiles }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g?.isHost?.()) return;
            g._hostSetOwned(uid, tiles, false);
        }, { uid: player.uid, tiles: owned });
    }
    await hostPublishPartyBoard(hostPage);
}

async function hostPublishPartyBoard(hostPage) {
    await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?.isHost?.()) return;
        g._hostReconcileOwnedFromRoomBoard?.();
        const board = (typeof RtdbSchema !== 'undefined' && g.roomData)
            ? RtdbSchema.readBoardFromRoom(g.roomData)
            : g.roomData?.global?.board;
        const hands = board?.tilesOwnedByPlayer || {};
        g._getPlayerUids().forEach((uid) => {
            if (g._mpOwned?.[uid]?.length) return;
            if (hands[uid]?.length) g._hostSetOwned(uid, hands[uid], false);
        });
        g._hostSyncBoard?.({ immediate: true });
    });
}

async function assertPartyBoardOnRtdb(hostPage, roomId, pages, label) {
    await waitForDiag3p(hostPage, `${label}: host _mpOwned`, ({ party }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return party.every((u) => (g._mpOwned?.[u]?.length || 0) > 0);
    }, { party: PLAYERS.map((p) => p.uid) }, WAIT_MS, pages);
    try {
        await hostPage.waitForFunction(async ({ party, rId }) => {
            const snap = await window.NetworkEngine.db
                .ref(`gameData/${rId}/global/board/tilesOwnedByPlayer`)
                .once('value');
            const hands = snap.val() || {};
            return party.every((u) => (hands[u]?.length || 0) > 0);
        }, { party: PLAYERS.map((p) => p.uid), rId: roomId }, waitOpts);
    } catch (err) {
        const snaps = await captureAllPlayersState(pages, label);
        throw timeoutError(`${label}: RTDB hands`, WAIT_MS, snaps, err.message);
    }
}

async function hostFlushBananaInteractions(hostPage) {
    await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?.isHost?.()) return;
        g._processBananaInteractions?.(g.roomData?.interactions?.banana);
        g._hostSyncBoard?.({ immediate: true });
    });
}

/** Guest dump is host-authoritative — poll host processing until guest inventory updates. */
async function waitGuestDumpResult(guestPage, hostPage, role, beforeIds, pages) {
    const label = `dump result (${role})`;
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        await hostFlushBananaInteractions(hostPage);
        const ready = await guestPage.evaluate(({ idList, r }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return !!(g && g.playerRole === r && g.tiles.length === idList.length + 2);
        }, { idList: beforeIds, r: role });
        if (ready) {
            return guestPage.evaluate((ids) => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                return {
                    count: g.tiles.length,
                    netPlusTwo: g.tiles.length === ids.length + 2
                };
            }, beforeIds);
        }
        await guestPage.waitForTimeout(80);
    }
    const frame = await getGameFrame(guestPage);
    const detail = await frame.evaluate(({ idList, r }) => {
        const g = window.game;
        const idSet = new Set(idList);
        const added = g.tiles.filter((t) => !idSet.has(t.id));
        return {
            role: g.playerRole,
            before: idList.length,
            after: g.tiles.length,
            added: added.length
        };
    }, { idList: beforeIds, r: role });
    const snaps = await captureAllPlayersState(pages, label);
    throw timeoutError(label, WAIT_MS, { ...snaps, dumpDetail: detail }, 'guest dump not applied');
}

async function waitPool(page, count, label = `pool=${count}`) {
    await page.waitForFunction(({ n }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const hud = document.getElementById('game-frame')?.contentDocument?.getElementById('banana-pool-count');
        return g && g._tilePool.length === n && hud?.textContent === String(n);
    }, { n: count }, { timeout: WAIT_MS }).catch((err) => {
        throw new Error(`${label} timed out: ${err.message}`);
    });
}

async function waitPoolAll(pages, count) {
    await Promise.all(pages.map((p, i) => waitPool(p, count, `P${i + 1} pool=${count}`)));
}

async function runMpMobileExtras3p(pages, frames, opts = {}) {
    const mobileAll = !!opts.mobileAll;
    const p3Mobile = !!opts.p3Mobile;
    if (!mobileAll && !p3Mobile) return;
    const { runBananagramsMpMobileExtras } = require('../mobile/bananagrams_mobile_suite');
    const {
        assertBananagramsRackFitsViewport,
        assertFaceDownRack,
        assertNoMarqueeOnMobile
    } = require('../mobile/bananagrams_touch');
    const { assertPinchZoomRange } = require('../../../platform/mobile/lib/mobile_assertions');
    const { MP_BOARD_SYNC_MS } = require('../../../platform/mobile/lib/mobile-constants');
    const syncMs = MP_BOARD_SYNC_MS;
    if (mobileAll) {
        await runBananagramsMpMobileExtras(pages[0], pages[1]);
    }
    log('MP mobile: P3 rack fits viewport...');
    await assertBananagramsRackFitsViewport(pages[2], { ms: syncMs, minTiles: 4 });
    await assertFaceDownRack(frames[2], 'P3 pre-SPLIT');
    log('SUCCESS: P3 mobile rack + face-down checks.');
    log('MP mobile: no marquee on P3...');
    await assertNoMarqueeOnMobile(frames[2]);
    log('SUCCESS: P3 no marquee on mobile.');
}

async function readScoreboard(frame) {
    return frame.evaluate(() => {
        const sb = document.querySelector('.scoreboard');
        if (!sb?.classList.contains('show')) return { visible: false };
        const spans = [...sb.querySelectorAll('span')].filter(
            (s) => s.classList.contains('score-user') || s.classList.contains('score-ai')
        );
        return {
            visible: true,
            scores: spans.map((s) => s.textContent),
            colors: spans.map((s) => s.style.color || null),
            classes: spans.map((s) => s.className),
            text: sb.textContent.replace(/\s+/g, ' ').trim()
        };
    });
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
}

function expectedScoreboardRows(viewerUid, scoresByUid) {
    const others = PLAYERS.filter((p) => p.uid !== viewerUid)
        .sort((a, b) => a.uid.localeCompare(b.uid));
    const rows = [{ uid: viewerUid, isMe: true }, ...others.map((p) => ({ ...p, isMe: false }))];
    return rows.map((row) => ({
        score: String(scoresByUid[row.uid] ?? 0),
        isMe: row.isMe,
        color: row.isMe ? null : row.color
    }));
}

async function assertScoreboard(frame, viewerUid, scoresByUid, label) {
    const sb = await readScoreboard(frame);
    if (!sb.visible) throw new Error(`${label}: scoreboard not visible (${JSON.stringify(sb)})`);
    const expected = expectedScoreboardRows(viewerUid, scoresByUid);
    if (sb.scores.length !== expected.length) {
        throw new Error(`${label}: score count ${sb.scores.length} !== ${expected.length} (${JSON.stringify(sb)})`);
    }
    for (let i = 0; i < expected.length; i++) {
        const exp = expected[i];
        if (sb.scores[i] !== exp.score) {
            throw new Error(`${label}: score[${i}] ${sb.scores[i]} !== ${exp.score} (${JSON.stringify(sb)})`);
        }
        if (exp.isMe && sb.classes[i] !== 'score-user') {
            throw new Error(`${label}: row[${i}] should be score-user (${JSON.stringify(sb)})`);
        }
        if (!exp.isMe && sb.classes[i] !== 'score-ai') {
            throw new Error(`${label}: row[${i}] should be score-ai (${JSON.stringify(sb)})`);
        }
        if (!exp.isMe && exp.color) {
            const got = (sb.colors[i] || '').toLowerCase();
            const wantHex = exp.color.toLowerCase();
            const wantRgb = hexToRgb(exp.color).toLowerCase();
            if (got !== wantHex && got !== wantRgb) {
                throw new Error(`${label}: opponent color[${i}] ${got} !== ${wantHex} (${JSON.stringify(sb)})`);
            }
        }
    }
    const joined = sb.scores.join(' - ');
    const wantJoined = expected.map((r) => r.score).join(' - ');
    if (joined !== wantJoined) {
        throw new Error(`${label}: joined scores "${joined}" !== "${wantJoined}"`);
    }
}

async function waitActionBanner(page, text, actorColor, label) {
    const wantRgb = hexToRgb(actorColor).toLowerCase();
    const wantHex = actorColor.toLowerCase();
    await page.waitForFunction(({ t, rgbCol, hexCol }) => {
        const doc = document.getElementById('game-frame')?.contentDocument;
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g || !doc) return false;
        const el = doc.getElementById('banana-banner');
        if (!el || !el.classList.contains('is-visible')) return false;
        if ((g._bannerText || el.textContent) !== t) return false;
        const c = (el.style.color || '').toLowerCase();
        return c === rgbCol || c === hexCol;
    }, { t: text, rgbCol: wantRgb, hexCol: wantHex }, waitOpts).catch((err) => {
        throw new Error(`${label} banner timed out (${text}, ${actorColor}): ${err.message}`);
    });
}

async function hostSetGuestThreeLetterWord(hostFrame, guestUid, word, runIndex) {
    return hostFrame.evaluate(({ uid, w, idx, nPlayers }) => {
        const g = window.game;
        if (!g.isHost()) return { ok: false, reason: 'host-only' };
        const gap = BananaRules.TILE_GAP;
        const x0 = 2400;
        const y0 = 2200;
        const tiles = w.split('').map((letter, i) => ({
            id: `t-guest-${idx}-${i}`,
            letter,
            x: x0 + i * gap,
            y: y0,
            faceUp: true
        }));
        g._hostSetPlayerTiles(uid, tiles, true, { allowTilesToOwned: true });
        g._hostSyncBoard({ immediate: true });
        const hand = g._handFromOwnedAndPositions(uid, tiles.map((t) => ({
            id: t.id,
            x: t.x,
            y: t.y
        })));
        const opts = {
            cols: BananaRules.COLS,
            gap,
            tileSize: BananaRules.TILE_SIZE,
            handBelowCenter: BananaRules.HAND_BELOW_CENTER,
            handSize: BananaRules.startingHandSize(nPlayers)
        };
        const placed = BananaGrid.allTilesPlacedInGrid(hand, { x: g.ORIGIN, y: g.ORIGIN }, opts);
        const valid = BananaGrid.validateGrid(hand, g._checker);
        return {
            ok: placed && valid.ok,
            count: tiles.length,
            placed,
            valid: valid.ok,
            words: valid.words
        };
    }, { uid: guestUid, w: word, idx: runIndex, nPlayers: PLAYERS.length });
}

async function waitGuestThreeTileHand(page, word) {
    const letters = word.split('').sort().join('');
    await page.waitForFunction(({ want }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g || g.tiles?.length !== 3) return false;
        const got = g.tiles.map((t) => t.letter).sort().join('');
        return got === want;
    }, { want: letters }, { timeout: WAIT_MS });
}

async function guestLayoutAndPeel(guestFrame, playerCount = PLAYERS.length) {
    return guestFrame.evaluate(({ nPlayers }) => {
        const g = window.game;
        const gap = BananaRules.TILE_GAP;
        const opts = {
            cols: BananaRules.COLS,
            gap,
            tileSize: BananaRules.TILE_SIZE,
            handBelowCenter: BananaRules.HAND_BELOW_CENTER,
            handSize: BananaRules.startingHandSize(nPlayers)
        };
        if (g.tiles.length !== 3) {
            return { ok: false, reason: 'count', count: g.tiles.length };
        }
        if (typeof g._clearLocalLayout === 'function') g._clearLocalLayout();
        const x0 = 2400;
        const y0 = 2200;
        const sorted = [...g.tiles].sort((a, b) => a.id.localeCompare(b.id));
        sorted.forEach((t, i) => {
            t.x = x0 + i * gap;
            t.y = y0;
        });
        g._persistMpLayout();
        const placed = BananaGrid.allTilesPlacedInGrid(g.tiles, { x: g.ORIGIN, y: g.ORIGIN }, opts);
        const valid = BananaGrid.validateGrid(g.tiles, g._checker);
        if (!placed || !valid.ok) {
            return {
                ok: false,
                placed,
                valid: valid.ok,
                words: valid.words,
                letters: g.tiles.map((t) => t.letter).join('')
            };
        }

        const beforeIds = [...g.tiles.map((t) => t.id)];
        const poolBefore = g._tilePool.length;
        g._bannerText = '';
        g._checkPeel();
        return {
            ok: g._bannerText === 'Peel!',
            banner: g._bannerText,
            beforeIds,
            count: g.tiles.length,
            poolBefore,
            poolAfter: g._tilePool.length
        };
    }, { nPlayers: playerCount });
}

async function createTestContexts(browser, opts = {}) {
    const { contexts, pages } = await createBanana3pSession(browser, opts);
    return { contexts, pages };
}

async function runBananagrams3pTest(browser, options = {}) {
    const mobileAll = !!options.mobile;
    const p3Mobile = !!options.p3Mobile;
    const inviteFlow = options.inviteFlow !== false;
    const mobileActions = mobileAll;
    const roomId = `MP_BANANA_3P_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const modeTag = mobileAll ? ' (mobile)' : (p3Mobile ? ' (mixed: P3 mobile)' : '');
    log(`3-player Bananagrams audit in room ${roomId}${modeTag}...`);

    const { contexts, pages } = await createTestContexts(browser, { mobileAll, p3Mobile });
    const [page1, page2, page3] = pages;
    const frames = [];
    const mobilePageIndices = mobileAll ? [0, 1, 2] : (p3Mobile ? [2] : []);

    try {
        if (inviteFlow) {
            const guestOrder = options.guestJoinOrder || [1, 2];
            await joinPartySequentially(pages, roomId, guestOrder, { mobilePageIndices });
        } else {
            await seedRoom(page1, roomId);
            await joinPlayer(page2, roomId, PLAYERS[1]);
            await joinPlayer(page3, roomId, PLAYERS[2]);
        }

        if (!inviteFlow) {
            log('Deal: 3 players, dictionary loaded...');
            for (let i = 0; i < PLAYERS.length; i++) {
                await waitForDeal(pages[i], PLAYERS[i].uid, WAIT_MS, pages);
            }
            await Promise.all([
                assertBoardVisible(page1, 'P1 board visible'),
                assertBoardVisible(page2, 'P2 board visible'),
                assertBoardVisible(page3, 'P3 board visible')
            ]);
        } else {
            log('Deal: all 3 players ready after sequential invite joins.');
        }
        const dealHost = await readPoolState(page1);
        let pool = dealHost.pool;
        if (pool < 0) throw new Error(`Host pool missing after deal (${JSON.stringify(dealHost)})`);
        log(`SUCCESS: Deal — ${dealHost.hand} tiles each, pool ${pool}.`);

        for (let i = 0; i < pages.length; i++) {
            frames[i] = await getGameFrame(pages[i]);
        }

        await runMpMobileExtras3p(pages, frames, { mobileAll, p3Mobile });

        const faceDown = await page1.evaluate(() => {
            const doc = document.getElementById('game-frame').contentDocument;
            const tiles = [...doc.querySelectorAll('.tile')];
            return tiles.length > 0 && tiles.every((t) => t.classList.contains('is-face-down'));
        });
        if (!faceDown) throw new Error('Tiles should start face-down before SPLIT');

        log('Pool HUD shows shared bunch remainder...');
        const hudLayout = await frames[0].evaluate(() => {
            const hud = document.getElementById('banana-hud');
            const poolEl = document.getElementById('banana-pool-count');
            const host = document.getElementById('game-container').getBoundingClientRect();
            const hr = hud.getBoundingClientRect();
            return {
                topLeft: hr.left - host.left < 40,
                hasTimer: !!document.getElementById('banana-timer'),
                poolUsesTheme: getComputedStyle(poolEl).color.length > 0
            };
        });
        if (!hudLayout.hasTimer) throw new Error('Elapsed timer should show (no turn order)');
        if (!hudLayout.topLeft) throw new Error('HUD should be top-left');
        log('SUCCESS: Deal + pool HUD + top-left layout.');

        log('Scoreboard: all players see 0-0-0 with opponent colors...');
        const zeroScores = Object.fromEntries(PLAYERS.map((p) => [p.uid, 0]));
        for (let i = 0; i < PLAYERS.length; i++) {
            await assertScoreboard(frames[i], PLAYERS[i].uid, zeroScores, PLAYERS[i].name);
        }
        log('SUCCESS: Scoreboard 0-0-0 with correct colors on all clients.');

        log('Hub shell has no duplicate scoreboard...');
        const hubOnly = await page1.evaluate(() => {
            const hidden = (el) => !el || !el.classList.contains('show');
            return hidden(document.querySelector('.scoreboard'));
        });
        if (!hubOnly) throw new Error('Hub should not duplicate iframe scoreboard');

        await waitPoolAll(pages, pool);
        log('SUCCESS: Pool HUD synced across 3 clients.');

        log('SPLIT: host starts game; guests sync...');
        await Promise.all(frames.map((f) => enableFastBanners(f)));
        const split = await splitViaDrag(frames[0], { mobile: mobileActions });
        if (!split.ok || !split.hasTimer) {
            throw new Error(`SPLIT failed (${JSON.stringify(split)})`);
        }
        await Promise.all([
            page2.waitForFunction(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const doc = document.getElementById('game-frame')?.contentDocument;
                return g?.gameStarted && !!doc?.getElementById('banana-timer');
            }, waitOpts),
            page3.waitForFunction(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const doc = document.getElementById('game-frame')?.contentDocument;
                return g?.gameStarted && !!doc?.getElementById('banana-timer');
            }, waitOpts)
        ]);
        log('SUCCESS: SPLIT synced to all 3 players.');

        log('DRAG: host moves tile...');
        const hostDrag = await dragTileByIndex(frames[0], 0, 80, 60, { mobile: mobileActions });
        if (!hostDrag.ok) throw new Error(`Host drag failed (${JSON.stringify(hostDrag)})`);
        await assertNoSnapBack(page1, hostDrag.id, hostDrag.x, hostDrag.y, 'Host drag');
        log('SUCCESS: Host drag.');

        log('DRAG: P2 moves tile (local board only)...');
        const p2Drag = await dragTileByIndex(frames[1], 1, -70, 50, { mobile: mobileActions });
        if (!p2Drag.ok) throw new Error(`P2 drag failed (${JSON.stringify(p2Drag)})`);
        await assertNoSnapBack(page2, p2Drag.id, p2Drag.x, p2Drag.y, 'P2 drag');
        log('SUCCESS: P2 drag (local board).');

        log('Refresh: each player restores layout from localStorage...');
        await hostPublishPartyBoard(page1);
        await assertPartyBoardOnRtdb(page1, roomId, pages, 'pre-refresh');
        const p3TileId = await page3.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.tiles?.[0]?.id ?? null;
        });
        if (!p3TileId) throw new Error('P3 needs tiles before refresh test');
        // Guests first — host reload re-initializes _mpOwned from RTDB and can clobber guest hands.
        await assertRefreshPreservesLayout(page2, PLAYERS[1], frames[1], p2Drag.id);
        frames[1] = await getGameFrame(page2);
        await assertRefreshPreservesLayout(page3, PLAYERS[2], frames[2], p3TileId);
        frames[2] = await getGameFrame(page3);
        await assertRefreshPreservesLayout(page1, PLAYERS[0], frames[0], hostDrag.id);
        frames[0] = await getGameFrame(page1);
        log('SUCCESS: All players refresh preserved layout.');

        log('Snap rules (host): adjacent edge, no stack, isolated drop...');
        const snap = await frames[0].evaluate(() => {
            const tileA = { id: 'mp-a', letter: 'A', x: 2400, y: 2500, faceUp: true };
            const tileT = { id: 'mp-t', letter: 'T', x: 2434, y: 2503, faceUp: true };
            const snapped = BananaGrid.snapTilePosition(tileT, [tileA]);
            tileT.x = snapped.x;
            tileT.y = snapped.y;
            const shares = BananaGrid.tilesShareCell(tileA, tileT);
            const free = BananaGrid.snapTilePosition({ id: 'x', letter: 'X', x: 2050, y: 2100 }, []);
            return {
                adjacent: snapped.snapped && tileT.x === 2440 && tileT.y === 2500 && !shares,
                free: !free.snapped && free.x === 2050 && free.y === 2100
            };
        });
        if (!snap.adjacent || !snap.free) throw new Error(`Snap rules failed (${JSON.stringify(snap)})`);
        log('SUCCESS: Snap rules.');

        log('No peel while tiles remain on starting rack (host)...');
        const noRackPeel = await frames[0].evaluate(() => {
            const g = window.game;
            g._bannerText = '';
            g._checkPeel();
            return { banner: g._bannerText, count: g.tiles.length };
        });
        if (noRackPeel.banner !== '') {
            throw new Error(`Should not peel on rack (${JSON.stringify(noRackPeel)})`);
        }
        log('SUCCESS: No peel on rack.');

        log('AI: solver-driven 3-player playthrough (placement, peel, dump)...');
        const { runMpAiPlaythrough3p, resetMpForAiPlaythrough3p } = require('./audit/mp-ai-playthrough-3p');
        const { captureEndingLayoutFromFrame } = require('../assertions/bananagrams_postgame_assertions');
        await resetMpForAiPlaythrough3p({
            pages,
            frames,
            playerCount: N_PLAYERS,
            expectedPool: pool
        });
        await runMpAiPlaythrough3p({
            pages,
            frames,
            playerCount: N_PLAYERS
        });
        log('SUCCESS: 3p AI playthrough complete.');

        for (let i = 0; i < frames.length; i++) {
            frames[i] = await getGameFrame(pages[i]);
        }
        const endingSnapshots = {};
        for (const frame of frames) {
            const snap = await captureEndingLayoutFromFrame(frame);
            endingSnapshots[snap.uid] = snap;
        }

        log('Post-game review: crosswords, win, host Done → face-down redeal...');
        const {
            runBananagramsMpMobilePostGame,
            clickDone
        } = require('../mobile/bananagrams_mp_postgame');
        const { waitMpResetAfterDone, assertMpPlayableAfterReset } = require('../assertions/bananagrams_postgame_assertions');
        const ox = await frames[0].evaluate(() => window.game.ORIGIN);
        await runBananagramsMpMobilePostGame(
            pages,
            frames,
            [
                { uid: PLAYERS[0].uid, prefix: 'p1', originX: ox, originY: 0 },
                { uid: PLAYERS[1].uid, prefix: 'p2', originX: ox + 320, originY: 0 },
                { uid: PLAYERS[2].uid, prefix: 'p3', originX: ox + 640, originY: 0 }
            ],
            {
                resetMs: RESET_WAIT_MS,
                skipTouch: !mobileAll && !p3Mobile,
                skipPlayableAfterReset: !mobileAll && !p3Mobile,
                endingSnapshots,
                assertWinBannerFade: true,
                stopAfterReview: !!p3Mobile,
                naturalWin: true
            }
        );

        if (!mobileAll && !p3Mobile) {
            log('After Done: host SPLIT; guests sync...');
            await Promise.all(frames.map((f) => enableFastBanners(f)));
            const split = await splitViaDrag(frames[0], { mobile: false });
            if (!split.ok || !split.hasTimer) {
                throw new Error(`Post-Done SPLIT failed (${JSON.stringify(split)})`);
            }
            await hostPublishPartyBoard(page1);
            await Promise.all([
                page2.waitForFunction(() => {
                    const g = document.getElementById('game-frame')?.contentWindow?.game;
                    const doc = document.getElementById('game-frame')?.contentDocument;
                    return g?.gameStarted && !!doc?.getElementById('banana-timer');
                }, undefined, waitOpts),
                page3.waitForFunction(() => {
                    const g = document.getElementById('game-frame')?.contentWindow?.game;
                    const doc = document.getElementById('game-frame')?.contentDocument;
                    return g?.gameStarted && !!doc?.getElementById('banana-timer');
                }, undefined, waitOpts)
            ]);
            log('SUCCESS: All players playable after post-game Done.');
        }

        if (p3Mobile) {
            log('Mobile portrait: review boards stacked on P3...');
            const { pushHostReviewStateToClients } = require('../assertions/bananagrams_postgame_assertions');
            await setPortraitForReview(page3);
            await pushHostReviewStateToClients(frames[0], pages);
            await page3.waitForFunction(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const owners = new Set((g?.tiles || []).map((t) => t.ownerUid).filter(Boolean));
                return owners.size >= 2;
            }, waitOpts);
            await assertMobileReviewBoardsStacked(page3, 'P3 review');
            log('SUCCESS: P3 mobile portrait review boards stacked.');

            log('MP post-game: host taps Done (after portrait review)...');
            await clickDone(frames[0]);
            await Promise.all(frames.map((frame, i) =>
                waitMpResetAfterDone(frame, `P${i + 1}`, RESET_WAIT_MS)
            ));
            await Promise.all(frames.map((frame, i) =>
                assertMpPlayableAfterReset(frame, `P${i + 1} after Done`, {
                    pointerType: i === 2 ? 'touch' : 'mouse'
                })
            ));
            log('SUCCESS: All players playable after post-game Done.');
        }

        console.log('SUCCESS: Bananagrams MP 3-player audit passed.');
        return true;
    } finally {
        await page1.evaluate(({ rId }) => {
            const db = window.NetworkEngine?.db;
            if (db) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
        }, { rId: roomId }).catch(() => {});
        await Promise.all(contexts.map((ctx) => ctx.close()));
    }
}

/** Reproduces real lobby flow: invite guest 1, wait, invite guest 2. */
async function runDelayedBetweenInvitesAudit(browser, options = {}) {
    const delayMs = options.delayBetweenInvitesMs ?? 2000;
    const roomId = `MP_BANANA_3P_DELAY_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    log(`Delayed-between-invites smoke (${delayMs}ms gap) in ${roomId}...`);

    const { contexts, pages } = await createTestContexts(browser, options);
    try {
        await joinPartySequentially(pages, roomId, [1, 2], { delayBetweenInvitesMs: delayMs });
    } finally {
        await pages[0].evaluate(({ rId }) => {
            const db = window.NetworkEngine?.db;
            if (db) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
        }, { rId: roomId }).catch(() => {});
        await Promise.all(contexts.map((ctx) => ctx.close()));
    }
    log(`SUCCESS: Delayed-between-invites (${delayMs}ms) passed.`);
}

/**
 * Real UI path: host stays in lobby, sends both invites before anyone accepts,
 * with a delay between sends. Both invites must target the same room.
 */
async function runLobbyPendingInvitesAudit(browser, options = {}) {
    const delayMs = options.delayBetweenInvitesMs ?? 2000;
    log(`Lobby pending invites (${delayMs}ms between sends, accept after)...`);

    const { contexts, pages } = await createTestContexts(browser, options);
    const [hostPage, page2, page3] = pages;
    let pendingRoom = null;

    try {
        await Promise.all(pages.map((p, i) => setPlayerIdentity(p, PLAYERS[i])));
        await Promise.all(pages.map((p) => openHubLobby(p)));

        await hostPage.evaluate(() => {
            window.HubApp.ctx.currentGame = 'bananagrams';
            window.HubApp.ctx.gameMode = 'multiplayer';
            localStorage.setItem('bananagrams_mode', 'multiplayer');
        });

        await hostPage.evaluate(({ u2 }) => {
            window.HubApp.ctx.sendInvite(u2, 'BananaP2');
        }, { u2: PLAYERS[1].uid });
        await hostPage.waitForTimeout(delayMs);
        await hostPage.evaluate(({ u3 }) => {
            window.HubApp.ctx.sendInvite(u3, 'BananaP3');
        }, { u3: PLAYERS[2].uid });

        await page3.waitForFunction(({ hostUid }) => {
            const path = `invites/${window.NetworkEngine.uid}/${hostUid}/roomId`;
            return window.NetworkEngine.db.ref(path).once('value').then((s) => !!s.val());
        }, { hostUid: HOST.uid }, waitOpts);

        const inviteRooms = await Promise.all([
            page2.evaluate(({ hostUid }) => {
                const inv = window.NetworkEngine.db.ref(`invites/${window.NetworkEngine.uid}/${hostUid}`);
                return inv.once('value').then((s) => s.val()?.roomId ?? null);
            }, { hostUid: HOST.uid }),
            page3.evaluate(({ hostUid }) => {
                const inv = window.NetworkEngine.db.ref(`invites/${window.NetworkEngine.uid}/${hostUid}`);
                return inv.once('value').then((s) => s.val()?.roomId ?? null);
            }, { hostUid: HOST.uid })
        ]);
        if (!inviteRooms[0] || inviteRooms[0] !== inviteRooms[1]) {
            throw new Error(
                `Invites must share one room; got P2=${inviteRooms[0]} P3=${inviteRooms[1]}`
            );
        }
        pendingRoom = inviteRooms[0];

        const p2Accept = await page2.evaluate(async ({ hostUid, rId }) => {
            const accepted = await window.NetworkEngine.acceptInvite(hostUid, rId);
            if (!accepted?.ok) return false;
            return window.HubApp.ctx.enterPartyRoom(rId, {
                role: 'P2',
                game: 'bananagrams',
                mode: 'multiplayer',
                skipJoin: true
            });
        }, { hostUid: HOST.uid, rId: pendingRoom });
        if (p2Accept === false) throw new Error('P2 failed to accept pending invite');

        await hostPage.waitForFunction(
            () => window.HubApp?.ctx?.roomId && window.HubApp.ctx.roomId !== 'lobby',
            waitOpts
        );
        await hostPage.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.isMultiplayer && g?.mode === 'multiplayer' && g?._dictReady && g?._checker;
        }, waitOpts);
        await assertJoinedPlayersReady(pages, [0, 1], pendingRoom, 'after P2 accept');

        const p3Accept = await page3.evaluate(async ({ hostUid, rId }) => {
            const accepted = await window.NetworkEngine.acceptInvite(hostUid, rId);
            if (!accepted?.ok) return false;
            return window.HubApp.ctx.enterPartyRoom(rId, {
                role: 'P3',
                game: 'bananagrams',
                mode: 'multiplayer',
                skipJoin: true
            });
        }, { hostUid: HOST.uid, rId: pendingRoom });
        if (p3Accept === false) throw new Error('P3 failed to accept pending invite');
        await assertJoinedPlayersReady(pages, [0, 1, 2], pendingRoom, 'after P3 accept');
    } finally {
        await hostPage.evaluate(({ rId }) => {
            const db = window.NetworkEngine?.db;
            if (db && rId) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
        }, { rId: pendingRoom }).catch(() => {});
        await Promise.all(contexts.map((ctx) => ctx.close()));
    }
    log(`SUCCESS: Lobby pending invites (${delayMs}ms gap).`);
}

/** Fast audit: host + guests join one-by-one in each guest order (P2→P3 and P3→P2). */
async function runSequentialJoinOrdersAudit(browser, options = {}) {
    const mobileAll = !!options.mobile;
    const p3Mobile = !!options.p3Mobile;

    for (const guestOrder of SEQUENTIAL_GUEST_ORDERS) {
        const orderLabel = guestOrder.map((i) => PLAYERS[i].role).join(' then ');
        const roomId = `MP_BANANA_3P_SEQ_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        log(`Sequential join-order smoke (${orderLabel}) in ${roomId}...`);

        const { contexts, pages } = await createTestContexts(browser, { mobileAll, p3Mobile });
        const mobilePageIndices = mobileAll ? [0, 1, 2] : (p3Mobile ? [2] : []);
        try {
            await joinPartySequentially(pages, roomId, guestOrder, { mobilePageIndices });
        } finally {
            await pages[0].evaluate(({ rId }) => {
                const db = window.NetworkEngine?.db;
                if (db) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
            }, { rId: roomId }).catch(() => {});
            await Promise.all(contexts.map((ctx) => ctx.close()));
        }
    }
    log('SUCCESS: All sequential guest join orders passed.');
}

/**
 * @param {import('../../../shared/infra/run-spec').RunSpec} [spec]
 */
async function runMp3pSuite(spec = {}) {
    const summarize = spec.summarize !== false;
    const totalStart = Date.now();
    const topology = spec.topology || 'desktop';
    const mobileAll = topology === 'mobile' || !!spec.mobileAll;
    const mixed = topology === 'mixed' || !!spec.mixed;
    const scenario = String(spec.scenario || '').trim().toLowerCase();
    const actionsOnly = scenario === 'actions';
    const joinOnly = !!spec.joinOnly;
    const auditOnly = !!spec.auditOnly;

    if (summarize) {
        printSuiteHeader('BANANAGRAMS MP 3P', [
            `${topology}${mobileAll ? ', all mobile' : mixed ? ', mixed' : ''}`,
            scenario ? `scenario=${scenario}` : 'full audit'
        ]);
    }

    if (summarize || !spec.skipStackCheck) {
        await ensureTestStack();
    }

    let browser = spec.browser;
    let ownsBrowser = !browser;
    if (!browser) {
        if (mobileAll) {
            const { applyBootstrap } = require('../../../shared/infra/bootstrap');
            applyBootstrap(['viewportMobile']);
            const { launchMobileBrowser } = require('../../../platform/mobile/lib/mobile-utils');
            browser = await launchMobileBrowser();
        } else {
            const { playwrightHeadless } = require('../../../shared/infra/env-defaults');
            browser = await chromium.launch({ headless: playwrightHeadless() });
        }
    }

    const results = [];

    const runTimed = async (name, fn) => {
        const t0 = Date.now();
        runnerLog(`[RUNNER] ${name}...`);
        try {
            await fn();
            return {
                name,
                success: true,
                duration: ((Date.now() - t0) / 1000).toFixed(2)
            };
        } catch (err) {
            return {
                name,
                success: false,
                duration: ((Date.now() - t0) / 1000).toFixed(2),
                error: err.message
            };
        }
    };

    try {
        if (actionsOnly) {
            results.push(await runTimed('MP Bananagrams 3p', async () => {
                const { runBananagramsMpActionsAudit3p } = require('./audit/actions-audit-3p');
                await runBananagramsMpActionsAudit3p(browser, { mobileAll });
            }));
        } else if (joinOnly) {
            results.push(await runTimed('3p join orders', () => runSequentialJoinOrdersAudit(browser)));
        } else if (auditOnly) {
            results.push(await runTimed('3p audit', () => runBananagrams3pTest(browser, { guestJoinOrder: [1, 2] })));
        } else if (mobileAll) {
            results.push(await runTimed('3p mobile audit', () => runBananagrams3pTest(browser, { mobile: true })));
        } else if (mixed) {
            results.push(await runTimed('3p leave audit', () => runNonHostLeaveAudit(browser, { p3Mobile: true })));
            if (results[0].success) {
                results.push(await runTimed('3p mixed audit', () => runBananagrams3pTest(browser, { p3Mobile: true })));
            }
        } else {
            results.push(await runTimed('3p join orders', () => runSequentialJoinOrdersAudit(browser)));
            if (results.every((r) => r.success)) {
                results.push(await runTimed('3p leave audit', () => runNonHostLeaveAudit(browser)));
            }
            if (results.every((r) => r.success)) {
                results.push(await runTimed('3p audit', () => runBananagrams3pTest(browser, { guestJoinOrder: [1, 2] })));
            }
        }
    } finally {
        if (ownsBrowser && shouldCloseBrowser()) {
            await browser.close().catch(() => {});
        }
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    const allPassed = results.length > 0 && results.every((r) => r.success);
    const firstFail = results.find((r) => !r.success);

    if (summarize) {
        printBenchmarkResults({
            results,
            totalDuration,
            namePad: 24,
            title: 'BENCHMARK RESULTS'
        });
    }

    return { allPassed, totalDuration, results, error: firstFail?.error || null };
}

if (require.main === module) {
    (async () => {
        const joinOnly = process.argv.includes('--join-only');
        const auditOnly = process.argv.includes('--audit-only');
        const mixed = process.argv.includes('--mixed');
        const mobileAll = process.argv.includes('--mobile-all');
        const result = await runMp3pSuite({ joinOnly, auditOnly, mixed, mobileAll });
        if (!result.allPassed) process.exit(1);
    })().catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
}

module.exports = {
    runBananagrams3pTest,
    runSequentialJoinOrdersAudit,
    runNonHostLeaveAudit,
    runDelayedBetweenInvitesAudit,
    runLobbyPendingInvitesAudit,
    joinPartySequentially,
    runMp3pSuite
};
