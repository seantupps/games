/**
 * Browser ↔ ptest bridge for __bananaMpDebug.
 *
 * Prefer these helpers over ad-hoc page.evaluate blocks that read private game fields.
 * Stable contract: __bananaMpDebug.clientState() (see games/bananagrams/modules/mp-debug.js).
 */

/** Resolve game iframe window from Page or Frame. */
function gameWindowHandle(pageOrFrame) {
    const isFrame = pageOrFrame && typeof pageOrFrame.parentFrame === 'function';
    return isFrame ? 'window' : "document.getElementById('game-frame')?.contentWindow";
}

/**
 * @param {import('playwright').Page|import('playwright').Frame} pageOrFrame
 * @returns {Promise<object|null>}
 */
async function readMpDebugClientState(pageOrFrame) {
    const win = gameWindowHandle(pageOrFrame);
    return pageOrFrame.evaluate(({ w }) => {
        const frameWin = w === 'window' ? window : document.getElementById('game-frame')?.contentWindow;
        if (!frameWin) return null;
        if (typeof frameWin.__bananaMpDebug?.clientState === 'function') {
            return frameWin.__bananaMpDebug.clientState();
        }
        const g = frameWin.game;
        if (!g?._mpDebugClientState) return null;
        return g._mpDebugClientState();
    }, { w: win });
}

/**
 * @param {import('playwright').Page|import('playwright').Frame} pageOrFrame
 * @returns {Promise<object|null>}
 */
async function readMpDebugSnapshot(pageOrFrame) {
    const win = gameWindowHandle(pageOrFrame);
    return pageOrFrame.evaluate(({ w }) => {
        const frameWin = w === 'window' ? window : document.getElementById('game-frame')?.contentWindow;
        if (!frameWin) return null;
        return frameWin.__bananaMpDebug?.snapshot?.() ?? null;
    }, { w: win });
}

/**
 * @param {import('playwright').Page|import('playwright').Frame} pageOrFrame
 * @param {string} [why]
 */
async function readMpDebugCoherence(pageOrFrame, why = 'ptest') {
    const win = gameWindowHandle(pageOrFrame);
    return pageOrFrame.evaluate(({ w, tag }) => {
        const frameWin = w === 'window' ? window : document.getElementById('game-frame')?.contentWindow;
        const g = frameWin?.game;
        if (!g) return null;
        if (typeof frameWin.__bananaMpDebug?.coherence === 'function') {
            return frameWin.__bananaMpDebug.coherence();
        }
        const board = g._mpBoardFromRoom?.(g.roomData) ?? g.roomData?.global?.board ?? null;
        const uid = g._myUid?.() ?? null;
        return g._mpCoherenceSnapshot?.(board, uid, tag) ?? null;
    }, { w: win, tag: why });
}

/**
 * @param {import('playwright').Page|import('playwright').Frame} pageOrFrame
 * @param {string} [ctx]
 */
async function readMpRequireCoherent(pageOrFrame, ctx = 'inventory-apply') {
    const win = gameWindowHandle(pageOrFrame);
    return pageOrFrame.evaluate(({ w, gate }) => {
        const frameWin = w === 'window' ? window : document.getElementById('game-frame')?.contentWindow;
        const g = frameWin?.game;
        if (!g) return null;
        if (typeof frameWin.__bananaMpDebug?.requireCoherent === 'function') {
            return frameWin.__bananaMpDebug.requireCoherent(gate);
        }
        const board = g._mpBoardFromRoom?.(g.roomData) ?? g.roomData?.global?.board ?? null;
        return g._mpRequireCoherent?.(board, gate, { log: false }) ?? null;
    }, { w: win, gate: ctx });
}

/**
 * Guest spawn/dump seq snapshot — merges clientState + coherence gates for post-reset tests.
 * @param {import('playwright').Frame} frame
 */
async function readGuestSpawnClientState(frame) {
    const [client, coherence, requireCoherent] = await Promise.all([
        readMpDebugClientState(frame),
        readMpDebugCoherence(frame, 'guest-spawn'),
        readMpRequireCoherent(frame, 'inventory-apply')
    ]);
    if (!client) return null;
    return {
        ...client,
        isHost: client.role === 'host',
        localInventorySeq: client.clientInventorySeq,
        guestDumpPendingTileId: client.dumpPendingTileId,
        coherence,
        requireCoherent
    };
}

/**
 * Enriched wait-timeout / triage bundle — split authority, phase, epoch, last apply.
 * @param {import('playwright').Page|import('playwright').Frame} pageOrFrame
 * @returns {Promise<object|null>}
 */
async function readMpDebugWaitDiag(pageOrFrame) {
    const win = gameWindowHandle(pageOrFrame);
    return pageOrFrame.evaluate(({ w }) => {
        const frameWin = w === 'window' ? window : document.getElementById('game-frame')?.contentWindow;
        if (!frameWin?.__bananaMpDebug) return null;
        const snap = frameWin.__bananaMpDebug.snapshot?.() ?? null;
        const client = frameWin.__bananaMpDebug.clientState?.() ?? snap?.clientState ?? null;
        return {
            client,
            split: snap?.split ?? null,
            gamePhase: snap?.gamePhase ?? null,
            epoch: snap?.epoch ?? null,
            coherence: snap?.coherence ?? null,
            revision: snap?.revision ?? null,
            lastInventoryApply: snap?.seq?.lastInventoryApply ?? null,
            splitBundle: snap?.seq?.splitBundle ?? null,
            boardApply: snap?.seq?.boardApply ?? null
        };
    }, { w: win });
}

/**
 * Verify __bananaMpDebug is loaded in the game iframe (call after session boot).
 * @param {import('playwright').Page} page
 */
async function assertMpDebugLoaded(page) {
    const ok = await page.evaluate(() => {
        const dbg = document.getElementById('game-frame')?.contentWindow?.__bananaMpDebug;
        return !!(dbg && typeof dbg.clientState === 'function' && typeof dbg.snapshot === 'function');
    });
    if (!ok) {
        throw new Error(
            'Bananagrams __bananaMpDebug not loaded in game iframe — '
            + 'check index.html script order (mp-debug.js before gameplay.js)'
        );
    }
    return true;
}

module.exports = {
    readMpDebugClientState,
    readMpDebugSnapshot,
    readMpDebugCoherence,
    readMpRequireCoherent,
    readMpDebugWaitDiag,
    readGuestSpawnClientState,
    assertMpDebugLoaded
};
