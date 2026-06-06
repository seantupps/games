/**
 * N-player MP session boot — deal, pool sync, SPLIT (topology-agnostic).
 */
const lib = require('./mp-state');

const {
    log,
    WAIT_MS,
    waitForDeal,
    assertStartingRackConnected,
    waitPoolAll,
    getHandAndPool,
    getGameFrame,
    enableFastBanners,
    splitViaDrag,
    waitForDiag
} = lib;

/**
 * Wait for deal + starting rack on every client.
 * @param {import('../scenarios/mp/contract').MpCtx} ctx
 */
async function waitForDealAll(ctx) {
    const mp = ctx.mp;
    await Promise.all(ctx.players.map((p, i) =>
        waitForDeal(p.page, p.role || `P${i + 1}`, mp)
    ));
    await Promise.all(ctx.players.map((p, i) =>
        assertStartingRackConnected(p.page, `${p.role || `P${i + 1}`} deal`, mp)
    ));
}

/**
 * Host SPLIT; every remote syncs gameStarted (+ timer on host/remotes as applicable).
 * @param {import('../scenarios/mp/contract').MpCtx} ctx
 * @param {{ mobile?: boolean }} [opts]
 * @returns {Promise<{ frames: import('playwright').Frame[], poolAfterDeal: number }>}
 */
async function bootMpPlaySessionN(ctx, opts = {}) {
    const mobile = !!opts.mobile;
    const mp = ctx.mp;

    log(`Deal: ${ctx.playerCount} players, dictionary loaded...`);
    await waitForDealAll(ctx);

    const dealInfo = await getHandAndPool(ctx.host.page);
    const poolAfterDeal = dealInfo.poolAfterDeal;
    log(`SUCCESS: Deal — tiles dealt (${ctx.playerCount}-player MP).`);

    const faceDown = await ctx.host.page.evaluate(() => {
        const doc = document.getElementById('game-frame').contentDocument;
        const tiles = [...doc.querySelectorAll('.tile')];
        return tiles.length > 0 && tiles.every((t) => t.classList.contains('is-face-down'));
    });
    if (!faceDown) throw new Error('Tiles should start face-down before SPLIT');

    await waitPoolAll(ctx, poolAfterDeal);

    let frames = await Promise.all(ctx.pages.map((p) => getGameFrame(p)));

    if (mobile && ctx.playerCount >= 3) {
        const { runMpMobileExtras3p } = require('../runners/mp-3p');
        await runMpMobileExtras3p(ctx.pages, frames, { mobileAll: mobile, p3Mobile: false });
    }

    const { assertPreSplitDealAudit } = require('../assertions/mp-full-audit-ctx');
    await assertPreSplitDealAudit(ctx, frames);

    log('SPLIT: host starts game; remotes sync...');
    await Promise.all(frames.map((f) => enableFastBanners(f)));
    const splitHost = await splitViaDrag(frames[0], { mobile });
    if (!splitHost.ok || !splitHost.hasTimer) {
        throw new Error(`Host SPLIT failed (${JSON.stringify(splitHost)})`);
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
    return { frames, poolAfterDeal };
}

module.exports = {
    waitForDealAll,
    bootMpPlaySessionN
};
