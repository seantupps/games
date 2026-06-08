const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

/** MP board visibility — sequential join / mobile layout diagnostics.
 */
const { STEP_MS } = require('../../../../shared/infra/timeouts');

const DEFAULT_WAIT_MS = Math.min(STEP_MS, 3000);

function logVis(msg) {
    if (process.env.FIVE_3P_VIS_DEBUG === '1' || process.env.FIVE_MP_VIS_DEBUG === '1') {
        console.log(`[MP-VIS] ${msg}`);
    }
}

function logVisAlways(msg) {
    console.log(`[MP-VIS] ${msg}`);
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
            uid: g?._myUid?.() ?? null,
            tiles: g?.tiles?.length ?? -1,
            role: g?.playerRole ?? null,
            memberCount: Object.keys(pd).filter((k) => pd[k]).length,
            handsWithTiles: Object.keys(hands).filter((u) => hands[u]?.length > 0)
        };
    });
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
                inView
            };
        });
        return {
            hub: {
                fiveMobile: document.documentElement.classList.contains('five-mobile'),
                hubRoom: window.HubApp?.ctx?.roomId ?? null
            },
            iframe: { innerWidth: vw, innerHeight: vh, hasGame: !!g },
            game: g ? {
                uid: g._myUid?.() ?? null,
                role: g.playerRole ?? null,
                tilesRuntime: g.tiles?.length ?? 0,
                zoom: g.zoom,
                canvasPanX: g.canvasPanX,
                canvasPanY: g.canvasPanY
            } : null,
            dom: {
                tileCount: tileEls.length,
                anyTileInView: tileRects.some((t) => t.inView),
                visibleTileCount: tileRects.filter((t) => t.inView).length
            }
        };
    });
}

function formatVisDiag(diag) {
    return JSON.stringify(diag, null, 2);
}

async function nudgeMobileBoardInFrame(page, label = 'nudge', log = logVis) {
    const before = await captureBoardVisibilityDiag(page).catch((e) => ({ captureError: String(e) }));
    log(`${label}: before nudge — tiles=${before?.dom?.tileCount} inView=${before?.dom?.anyTileInView}`);
    let nudgeError = null;
    try {
        await page.evaluate(() => {
            window.FiveViewport?.syncHubViewport?.();
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g) return;
            g.refreshMobileLayout?.();
            if (typeof GameViewport !== 'undefined' && g._usesPanZoomBoard?.()) {
                GameViewport.reflowOnResize(g);
                const focal = g.getViewportContentCenter?.() || { x: g.ORIGIN, y: g.ORIGIN };
                GameViewport.centerWorldPoint(g, focal.x, focal.y);
            }
            g.requestRender?.();
        });
    } catch (e) {
        nudgeError = String(e);
    }
    const after = await captureBoardVisibilityDiag(page).catch((e) => ({ captureError: String(e) }));
    log(`${label}: after nudge — tiles=${after?.dom?.tileCount} inView=${after?.dom?.anyTileInView}`);
    return { before, after, nudgeError };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {number} [timeoutMs]
 * @param {object} [meta]
 */
async function assertBoardVisible(page, label, timeoutMs = DEFAULT_WAIT_MS, meta = {}) {
    const isMobile = timeoutMs > DEFAULT_WAIT_MS || meta.isMobilePlayer || await page.evaluate(() =>
        document.documentElement.classList.contains('five-mobile')
        || !!document.getElementById('game-frame')?.contentWindow?.game?.isMobileViewport?.()
    );
    const deadline = isMobile ? Math.max(timeoutMs, 15000) : timeoutMs;
    logVisAlways(`${label}: start isMobile=${isMobile} deadline=${deadline}`);

    const pre = await captureBoardVisibilityDiag(page).catch((e) => ({ captureError: String(e) }));
    if (isMobile) await nudgeMobileBoardInFrame(page, `${label}: pre-wait nudge`);

    const started = Date.now();
    let lastDiag = pre;

    try {
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
    } catch (err) {
        if (isMobile) {
            const nudge = await nudgeMobileBoardInFrame(page, `${label}: retry nudge`);
            lastDiag = nudge.after || lastDiag;
        }
        lastDiag = await captureBoardVisibilityDiag(page).catch(() => lastDiag);
        const deal = await readDealDiag(page).catch((e) => ({ dealError: String(e) }));
        const body = formatVisDiag({
            deal,
            visibility: lastDiag,
            meta,
            isMobile,
            deadline,
            elapsedMs: Date.now() - started
        });
        logVisAlways(`${label}: FAILED\n${body}`);
        failWithSnapshot('assertion', [`${label}: board not visible (${err.message})\n--- visibility diag ---\n${body}`], {});
    }
}

module.exports = {
    assertBoardVisible,
    captureBoardVisibilityDiag,
    nudgeMobileBoardInFrame,
    readDealDiag,
    formatVisDiag,
    logVis,
    logVisAlways
};
