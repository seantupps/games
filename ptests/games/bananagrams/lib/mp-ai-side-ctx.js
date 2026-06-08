/**
 * MP AI playthrough — per-player side ctx from MpCtx (2p/3p/4p unified).
 */
const { buildMpCtx2p, buildMpCtxFromPages } = require('./mp-ctx');

/**
 * Resolve MpCtx from runner opts (ctx | pages[] | page1/page2).
 * @param {object} opts
 * @returns {import('../scenarios/mp/contract').MpCtx}
 */
function resolvePlaythroughCtx(opts) {
    if (opts.ctx) return opts.ctx;
    if (opts.pages?.length) {
        if (opts.pages.length >= 3 || (opts.playerCount ?? opts.pages.length) >= 3) {
            return buildMpCtxFromPages(opts.pages, null, {
                mobile: opts.mobile ?? opts.mobileAll,
                frames: opts.frames,
                roomId: opts.roomId
            });
        }
        return buildMpCtx2p(opts.pages[0], opts.pages[1], {
            mobile: opts.mobile ?? opts.mobileAll,
            frames: opts.frames,
            roomId: opts.roomId
        });
    }
    if (opts.page1 && opts.page2) {
        const frames = opts.frames
            ?? (opts.frame1 && opts.frame2 ? [opts.frame1, opts.frame2] : []);
        return buildMpCtx2p(opts.page1, opts.page2, {
            mobile: opts.mobile ?? opts.mobileAll,
            frames,
            roomId: opts.roomId
        });
    }
    throw new Error('resolvePlaythroughCtx: need ctx, pages[], or page1/page2');
}

/** Attach refreshed frames onto ctx.players. */
function attachFramesToCtx(ctx, frames) {
    if (frames?.length) {
        ctx.frames = frames;
        for (let i = 0; i < ctx.players.length; i++) {
            ctx.players[i].frame = frames[i] ?? ctx.players[i].frame;
        }
    }
    return ctx;
}

/**
 * Build per-actor side ctx objects for AI round loop (mirrors mp-ai-playthrough-n).
 * @param {import('../scenarios/mp/contract').MpCtx} ctx
 * @param {object} [opts]
 */
function buildAiSideCtxs(ctx, opts = {}) {
    const hostPage = ctx.host.page;
    return ctx.players.map((p, i) => ({
        frame: ctx.frames[i] ?? p.frame,
        page: p.page,
        hostPage,
        pages: ctx.pages,
        playerCount: ctx.playerCount,
        uid: p.uid,
        color: p.color,
        role: p.role,
        actorIndex: i,
        isGuest: i > 0,
        mp: ctx.mp,
        label: `${p.role}${i === 0 ? ' (Host)' : ''}`,
        ...opts
    }));
}

/** Legacy page1/page2 destructuring from ctx (for gradual migration). */
function legacyPagesFromCtx(ctx) {
    return {
        page1: ctx.pages[0],
        page2: ctx.pages[1] ?? ctx.pages[0],
        mp: ctx.mp,
        mobile: ctx.mobile,
        frames: ctx.frames,
        frame1: ctx.frames[0],
        frame2: ctx.frames[1]
    };
}

module.exports = {
    resolvePlaythroughCtx,
    attachFramesToCtx,
    buildAiSideCtxs,
    legacyPagesFromCtx
};
