/**
 * Cross-game MP wait helpers — diagnostics on timeout.
 */
const { STEP_MS } = require('../infra/timeouts');
const { WAIT_MS: PROFILE_WAIT_MS } = require('../infra/speed-profiles');

const WAIT_MS = PROFILE_WAIT_MS ?? STEP_MS;
const waitOpts = { timeout: WAIT_MS };

async function captureMpState(page, tag = 'page') {
    try {
        return await page.evaluate(({ tag: t }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const board = g?.roomData?.global?.board;
            const doc = document.getElementById('game-frame')?.contentDocument;
            const scores = board?.scores || g?._mpScores || {};
            const me = g?._myUid?.();
            return {
                tag: t,
                role: g?.playerRole,
                uid: me,
                tiles: g?.tiles?.length ?? 0,
                pool: g?._tilePool?.length ?? -1,
                poolHud: doc?.getElementById('banana-pool-count')?.textContent ?? null,
                gameStarted: !!g?.gameStarted,
                started: !!g?.started,
                dictReady: !!g?._dictReady,
                winnerUid: g?._winnerUid ?? null,
                boardWinner: board?.winnerUid ?? null,
                boardSeq: board?.seq ?? null,
                localBoardSeq: g?._boardSeq ?? null,
                scores,
                peelSeq: board?.peelSeq ?? null,
                lastPeelSeq: g?._lastPeelSeq ?? null,
                dumpSeq: board?.dumpSeq ?? null,
                banner: g?._bannerText ?? '',
                resetCount: g?.lastResetCount ?? null,
                roomReset: g?.roomData?.global?.resetCount ?? null,
                ownedLen: me && board?.tilesOwnedByPlayer?.[me]
                    ? board.tilesOwnedByPlayer[me].length
                    : (board?.hands?.[me]?.length ?? 0),
                layoutSeq: board?.layoutSeq?.[me] ?? null,
                inventorySeq: board?.inventorySeq?.[me] ?? null,
                localLayoutSeq: g?._localLayoutSeq ?? null,
                localInventorySeq: g?._localInventorySeq ?? null,
                networkReady: !!window.NetworkEngine?.isInitialized
            };
        }, { tag });
    } catch (e) {
        return { tag, error: String(e) };
    }
}

async function captureBothMpStates(page1, page2, label) {
    const [host, guest] = await Promise.all([
        captureMpState(page1, `${label} — host (P1)`),
        captureMpState(page2, `${label} — guest (P2)`)
    ]);
    return { label, host, guest };
}

function timeoutError(label, timeoutMs, snaps, cause) {
    const body = JSON.stringify(snaps, null, 2);
    const msg = `${label} timed out after ${timeoutMs}ms\n--- state ---\n${body}`;
    const err = new Error(cause ? `${msg}\n--- cause ---\n${cause}` : msg);
    err.name = 'TimeoutError';
    return err;
}

async function waitForDiag(page, label, predicate, arg, timeoutMs = WAIT_MS, mpPages = null) {
    try {
        await page.waitForFunction(predicate, arg, { timeout: timeoutMs });
    } catch (err) {
        const snaps = mpPages?.page1 && mpPages?.page2
            ? await captureBothMpStates(mpPages.page1, mpPages.page2, label)
            : { label, target: await captureMpState(page, label) };
        throw timeoutError(label, timeoutMs, snaps, err.message);
    }
}

async function getGameFrame(page) {
    const handle = await page.$('#game-frame');
    const frame = await handle.contentFrame();
    if (!frame) throw new Error('game iframe not ready');
    return frame;
}

async function getGame(page) {
    return page.evaluate(() => document.getElementById('game-frame')?.contentWindow?.game);
}

module.exports = {
    WAIT_MS,
    waitOpts,
    captureMpState,
    captureBothMpStates,
    timeoutError,
    waitForDiag,
    getGameFrame,
    getGame
};