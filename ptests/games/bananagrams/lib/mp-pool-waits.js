/**
 * MP pool/deal waits — mechanics only, no pass/fail verdicts (except wait timeouts).
 */
const mpWaits = require('../../../shared/platform/mp-waits');
const { mpPollMs } = require('../../../shared/infra/speed-profiles');
const { flushHostBananaInteractions } = require('../../../shared/adapters/mp-client');

const { WAIT_MS, waitForDiag, timeoutError, captureBothMpStates } = mpWaits;

async function waitForDeal(page, role, mpPages = null) {
    await waitForDiag(page, `deal (${role})`, ({ r }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const dealt = (g?.tiles?.length || 0) > 0;
        return g
            && g.isMultiplayer
            && g.mode === 'multiplayer'
            && g.playerRole === r
            && g._dictReady
            && g._checker
            && dealt
            && (g.started || dealt);
    }, { r: role }, WAIT_MS, mpPages);
}

async function getHandAndPool(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const hand = g?.tiles?.length ?? 0;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const boardPool = Array.isArray(board?.pool) ? board.pool.length : null;
        const localPool = g?._tilePool?.length ?? -1;
        const poolAfterDeal = boardPool != null ? boardPool : localPool;
        return { hand, poolAfterDeal, localPool, boardPool };
    });
}

async function waitPool(page, count, label = `pool=${count}`, mpPages = null, timeoutMs = WAIT_MS) {
    await waitForDiag(page, label, ({ n }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const hud = document.getElementById('game-frame')?.contentDocument?.getElementById('banana-pool-count');
        const local = g?._tilePool?.length ?? -1;
        const hudOk = hud?.textContent === String(n);
        if (g && typeof g.isHost === 'function' && g.isHost()) {
            return local === n && hudOk;
        }
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const remote = Array.isArray(board?.pool) ? board.pool.length : local;
        return local === n && remote === n && hudOk;
    }, { n: count }, timeoutMs, mpPages);
}

async function waitPoolBoth(page1, page2, count, timeoutMs = WAIT_MS) {
    const label = `pool=${count} (both players)`;
    try {
        await Promise.all([
            waitPool(page1, count, `${label} host`, null, timeoutMs),
            waitPool(page2, count, `${label} guest`, null, timeoutMs)
        ]);
    } catch (err) {
        const snaps = await captureBothMpStates(page1, page2, label);
        throw timeoutError(label, timeoutMs, snaps, err.message);
    }
}

async function waitPoolBothWithFlush(hostPage, guestPage, count, timeoutMs, mp) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        await flushHostBananaInteractions(hostPage);
        try {
            await waitPoolBoth(hostPage, guestPage, count, Math.min(250, timeoutMs));
            return;
        } catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, mpPollMs()));
    }
    if (lastErr) throw lastErr;
    await waitPoolBoth(hostPage, guestPage, count, Math.min(250, timeoutMs));
}

async function waitPoolAll(ctx, count, timeoutMs = WAIT_MS) {
    const label = `pool=${count} (${ctx.playerCount}p)`;
    try {
        await Promise.all(ctx.players.map((p, i) => waitPool(
            p.page,
            count,
            `${label} ${p.role || `P${i + 1}`}`,
            ctx.mp,
            timeoutMs
        )));
    } catch (err) {
        const { captureAllMpStates } = mpWaits;
        const snaps = await captureAllMpStates(ctx.pages, ctx.players, label);
        throw timeoutError(label, timeoutMs, snaps, err.message);
    }
}

async function waitPoolBothFromCtx(ctx, count, timeoutMs = WAIT_MS) {
    if (ctx.players.length === 2) {
        return waitPoolBoth(ctx.pages[0], ctx.pages[1], count, timeoutMs);
    }
    return waitPoolAll(ctx, count, timeoutMs);
}

async function readPoolSyncState(page) {
    return page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const localPool = g?._tilePool?.length ?? -1;
        const boardPool = Array.isArray(board?.pool) ? board.pool.length : -1;
        const hudRaw = doc?.getElementById('banana-pool-count')?.textContent ?? null;
        const hud = hudRaw != null && hudRaw !== '' ? parseInt(hudRaw, 10) : null;
        const authBunch = typeof g?._mpAuthoritativeBunchLen === 'function'
            ? g._mpAuthoritativeBunchLen()
            : localPool;
        return {
            role: g?.isHost?.() ? 'host' : 'guest',
            uid: g?._myUid?.() || null,
            localPool,
            boardPool,
            hud,
            authBunch,
            peelSeq: board?.peelSeq ?? null,
            lastPeelSeq: g?._lastPeelSeq ?? null,
            dumpSeq: board?.dumpSeq ?? null,
            boardSeq: board?.seq ?? null,
            localBoardSeq: g?._boardSeq ?? null
        };
    });
}

module.exports = {
    waitForDeal,
    getHandAndPool,
    waitPool,
    waitPoolBoth,
    waitPoolBothWithFlush,
    waitPoolAll,
    waitPoolBothFromCtx,
    readPoolSyncState
};
