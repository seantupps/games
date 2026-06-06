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

/**
 * N-player diagnostic snapshot (topology-agnostic).
 * @param {import('playwright').Page[]} pages
 * @param {{ role?: string, uid?: string }[]} [playerMeta]
 * @param {string} [label]
 */
async function captureAllMpStates(pages, playerMeta, label = 'all players') {
    const snaps = await Promise.all(pages.map((page, i) => {
        const role = playerMeta?.[i]?.role || `P${i + 1}`;
        return captureMpState(page, `${label} — ${role}`);
    }));
    return { label, players: snaps };
}

/**
 * @param {import('playwright').Page} page
 * @param {object} [mpPages] — { page1, page2 } or { pages: Page[] } or MpCtx.mp
 */
async function resolveMpSnapshotPages(mpPages) {
    if (!mpPages) return null;
    if (Array.isArray(mpPages.pages)) return mpPages.pages;
    if (mpPages.page1 && mpPages.page2) return [mpPages.page1, mpPages.page2];
    return null;
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
        const pages = await resolveMpSnapshotPages(mpPages);
        let snaps;
        if (pages?.length >= 2) {
            snaps = await captureAllMpStates(pages, null, label);
        } else if (mpPages?.page1 && mpPages?.page2) {
            snaps = await captureBothMpStates(mpPages.page1, mpPages.page2, label);
        } else {
            snaps = { label, target: await captureMpState(page, label) };
        }
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
    captureAllMpStates,
    resolveMpSnapshotPages,
    timeoutError,
    waitForDiag,
    getGameFrame,
    getGame
};