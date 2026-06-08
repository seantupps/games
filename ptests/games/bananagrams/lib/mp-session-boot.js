/**
 * N-player MP session boot — deal, pool sync, SPLIT (topology-agnostic, mechanical only).
 * Scenarios call audit.assertPreSplitDealAudit between throughDeal and split when needed.
 */
const {
    log,
    WAIT_MS,
    waitForDeal,
    waitPoolAll,
    getHandAndPool,
    getGameFrame,
    enableFastBanners,
    splitViaDrag,
    waitForDiag
} = require('./mp-state');

/**
 * Wait for deal on every client (mechanical — no rack connectivity verdict).
 * @param {import('../scenarios/mp/contract').MpCtx} ctx
 */
async function waitForDealAll(ctx) {
    const mp = ctx.mp;
    await Promise.all(ctx.players.map((p, i) =>
        waitForDeal(p.page, p.role || `P${i + 1}`, mp)
    ));
}

/**
 * Deal + pool sync through pre-SPLIT frames (no assertions, no SPLIT).
 * @param {import('../scenarios/mp/contract').MpCtx} ctx
 * @param {{ mobile?: boolean }} [opts]
 * @returns {Promise<{ frames: import('playwright').Frame[], poolAfterDeal: number }>}
 */
async function bootMpPlaySessionThroughDeal(ctx, opts = {}) {
    const mobile = !!opts.mobile;
    const mp = ctx.mp;

    log(`Deal: ${ctx.playerCount} players, dictionary loaded...`);
    await waitForDealAll(ctx);

    const dealInfo = await getHandAndPool(ctx.host.page);
    const poolAfterDeal = dealInfo.poolAfterDeal;
    log(`SUCCESS: Deal — tiles dealt (${ctx.playerCount}-player MP).`);

    await Promise.all(ctx.pages.map((page, i) => waitForDiag(
        page,
        `deal settled P${i + 1}`,
        () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            const tiles = doc ? [...doc.querySelectorAll('.tile')] : [];
            if (!g || !tiles.length) return false;
            if (g.gameStarted) return true;
            return tiles.every((t) => t.classList.contains('is-face-down'));
        },
        {},
        WAIT_MS,
        mp
    )));

    await waitPoolAll(ctx, poolAfterDeal);

    let frames = await Promise.all(ctx.pages.map((p) => getGameFrame(p)));

    if (mobile && ctx.playerCount >= 3) {
        const { runMpMobileExtrasN } = require('../adapters/mobile-suite');
        await runMpMobileExtrasN(ctx.pages, frames, { mobileAll: mobile, p3Mobile: false });
    }

    return { frames, poolAfterDeal };
}

/**
 * Host SPLIT; every remote syncs gameStarted (+ timer on host/remotes as applicable).
 * @param {import('../scenarios/mp/contract').MpCtx} ctx
 * @param {import('playwright').Frame[]} frames
 * @param {{ mobile?: boolean }} [opts]
 */
async function bootMpPlaySessionSplit(ctx, frames, opts = {}) {
    const mobile = !!opts.mobile;
    const mp = ctx.mp;

    log('SPLIT: host starts game; remotes sync...');
    await Promise.all(frames.map((f) => enableFastBanners(f)));

    const alreadySplit = await ctx.host.page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return !!g?.gameStarted;
    });

    if (!alreadySplit) {
        const splitHost = await splitViaDrag(frames[0], { mobile });
        if (!splitHost.ok || !splitHost.hasTimer) {
            throw new Error(`Host SPLIT failed (${JSON.stringify(splitHost)})`);
        }
    } else {
        log('SPLIT: host already started — skip drag');
    }

    await Promise.all(ctx.pages.map((page, i) => waitForDiag(
        page,
        `SPLIT P${i + 1} started`,
        ({ needTimer }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            return g?.gameStarted && (!needTimer || !!doc?.getElementById('banana-timer'));
        },
        { needTimer: i === 0 },
        WAIT_MS,
        mp
    )));

    log(`SUCCESS: SPLIT synced (${ctx.playerCount}p).`);
}

/**
 * Full mechanical boot — deal through SPLIT (no pre-SPLIT audit).
 * @param {import('../scenarios/mp/contract').MpCtx} ctx
 * @param {{ mobile?: boolean }} [opts]
 * @returns {Promise<{ frames: import('playwright').Frame[], poolAfterDeal: number }>}
 */
async function bootMpPlaySessionN(ctx, opts = {}) {
    const deal = await bootMpPlaySessionThroughDeal(ctx, opts);
    await bootMpPlaySessionSplit(ctx, deal.frames, opts);
    return deal;
}

/**
 * 2p boot from raw pages — builds MpCtx, runs bootMpPlaySessionN, validates guest face-up.
 * @param {import('playwright').Page} page1 host
 * @param {import('playwright').Page} page2 guest
 * @param {{ mobile?: boolean, roomId?: string, options?: object }} [options]
 */
async function bootMpPlaySessionFromPages(page1, page2, options = {}) {
    const mobile = !!options.mobile;
    const { buildMpCtx2p } = require('./mp-ctx');
    const { centerMpViewerOnPages } = require('../../../shared/platform/mp-headed-view');
    const ctx = buildMpCtx2p(page1, page2, {
        mobile,
        roomId: options.roomId,
        options: options.options || {}
    });
    const { frames, poolAfterDeal } = await bootMpPlaySessionN(ctx, { mobile });

    const guestSplit = await page2.evaluate(() => {
        const doc = document.getElementById('game-frame').contentDocument;
        const tiles = [...doc.querySelectorAll('.tile')];
        const g = document.getElementById('game-frame').contentWindow.game;
        return {
            faceUp: tiles.every((t) => !t.classList.contains('is-face-down')),
            hasTimer: !!doc.getElementById('banana-timer'),
            gameStarted: g.gameStarted
        };
    });
    if (!guestSplit.faceUp || !guestSplit.hasTimer || !guestSplit.gameStarted) {
        throw new Error(`Guest SPLIT sync failed (${JSON.stringify(guestSplit)})`);
    }

    for (let i = 0; i < ctx.players.length; i++) {
        ctx.frames[i] = frames[i];
        ctx.players[i].frame = frames[i];
    }
    await centerMpViewerOnPages([page1, page2], { mobile });

    return {
        ctx,
        frames,
        frame1: frames[0],
        frame2: frames[1],
        mp: ctx.mp,
        poolAfterDeal,
        mobile
    };
}

module.exports = {
    waitForDealAll,
    bootMpPlaySessionThroughDeal,
    bootMpPlaySessionSplit,
    bootMpPlaySessionN,
    bootMpPlaySessionFromPages
};
