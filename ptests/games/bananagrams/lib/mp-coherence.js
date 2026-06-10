/**
 * MP coherence gate helpers for ptests — mirrors __bananaMpDebug.requireCoherent.
 */

/**
 * @param {import('playwright').Frame} frame
 * @param {string} [ctx='inventory-apply']
 */
async function readMpRequireCoherent(frame, ctx = 'inventory-apply') {
    return frame.evaluate(({ gateCtx }) => {
        const g = window.game;
        const board = g?._mpBoardFromRoom?.(g.roomData);
        if (typeof g?._mpRequireCoherent === 'function') {
            return g._mpRequireCoherent(board, gateCtx, { log: false });
        }
        const dbg = window.__bananaMpDebug;
        const coh = typeof dbg?.requireCoherent === 'function'
            ? dbg.requireCoherent(gateCtx)
            : dbg?.coherence?.();
        if (!coh) return null;
        return { ok: coh.ok, failed: coh.failed || [], snap: coh.snap || coh, ctx: gateCtx };
    }, { gateCtx: ctx });
}

/** Guest authority ready — inventory-apply coherence gate. */
async function waitGuestAuthorityCoherent(frame, ctx = 'inventory-apply') {
    const req = await readMpRequireCoherent(frame, ctx);
    return !!(req && req.ok);
}

module.exports = {
    readMpRequireCoherent,
    waitGuestAuthorityCoherent
};
