/**
 * MP deal invariants — host pool, starting rack stability, connected rack.
 */
const {
    log,
    WAIT_MS,
    waitForDiag,
    getGameFrame,
    captureBothMpStates
} = require('../../lib/mp-state');

async function assertHostDealPool(hostPage, expectedPool, label = 'host deal pool', mpPages = null) {
    await waitForDiag(hostPage, label, ({ exp }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        if (!g?.isHost?.()) return false;
        const local = g._tilePool?.length ?? -1;
        const room = g.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const boardPool = Array.isArray(board?.pool) ? board.pool.length : local;
        const poolEl = g._isMultiplayerMode?.() && document.getElementById('game-frame')?.contentDocument
            ? document.getElementById('game-frame')?.contentDocument?.getElementById('banana-pool-count')
            : null;
        const hud = poolEl ? parseInt(poolEl.textContent, 10) : local;
        return local === exp && boardPool === exp && hud === exp;
    }, { exp: expectedPool }, WAIT_MS, mpPages);
    log(`SUCCESS: ${label} — bunch=${expectedPool}`);
}

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

module.exports = {
    assertHostDealPool,
    assertDealStable,
    assertStartingRackConnected
};
