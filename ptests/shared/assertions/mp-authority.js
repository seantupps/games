/**
 * Cross-game MP action banner assertions (text + actor color on all clients).
 */
const { waitForDiag, WAIT_MS } = require('../platform/mp-waits');
const { resolveActionBannerHooks } = require('../platform/action-banner-policy');

/**
 * @param {import('playwright').Page} page
 * @param {string} playerLabel
 * @param {string} text
 * @param {string} actorUid
 * @param {object} hooks
 * @param {number} timeoutMs
 * @param {object} mpPages
 */
async function assertActionBannerOnPage(page, playerLabel, text, actorUid, hooks, timeoutMs, mpPages) {
    const { elementId, visibleClass, actorUidField, colorFn } = hooks;

    await waitForDiag(page, `${playerLabel} banner visible`, ({ wantText, wantUid, bannerId, visClass, uidField }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const g = win?.game;
        const b = doc?.getElementById(bannerId);
        if (!g || !b) return false;
        const visible = b.classList.contains(visClass);
        return visible && b.textContent?.trim() === wantText && g[uidField] === wantUid;
    }, {
        wantText: text,
        wantUid: actorUid,
        bannerId: elementId,
        visClass: visibleClass,
        uidField: actorUidField
    }, timeoutMs, mpPages);

    return page.evaluate(({ bannerId, uidField, colorFnName }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const g = win?.game;
        const b = doc?.getElementById(bannerId);
        const colorFn = g?.[colorFnName];
        const actorUid = g?.[uidField] || '';
        const expectedRaw = typeof colorFn === 'function' ? colorFn.call(g, actorUid) : null;
        let expectedRgb = null;
        if (doc?.body && expectedRaw) {
            const probe = doc.createElement('span');
            probe.style.color = expectedRaw;
            doc.body.appendChild(probe);
            expectedRgb = getComputedStyle(probe).color;
            probe.remove();
        }
        return {
            color: b ? getComputedStyle(b).color : null,
            expect: expectedRgb || expectedRaw
        };
    }, { bannerId: elementId, uidField: actorUidField, colorFnName: colorFn });
}

/**
 * Topology-agnostic: banner visible + actor color on every client.
 * @param {import('../../games/bananagrams/lib/mp-ctx').MpCtx} ctx
 */
async function assertActionBannerAllPlayers(ctx, text, actorUid, label, opts = {}) {
    const normalized = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
    const timeoutMs = normalized.timeoutMs ?? WAIT_MS;
    const gameId = normalized.gameId || 'bananagrams';
    const gameMode = normalized.gameMode || 'multiplayer';
    const hooks = resolveActionBannerHooks(gameId, gameMode);
    const mpPages = ctx.mp || { pages: ctx.pages };

    const results = await Promise.all(ctx.players.map((p, i) => assertActionBannerOnPage(
        p.page,
        p.role || `P${i + 1}`,
        text,
        actorUid,
        hooks,
        timeoutMs,
        mpPages
    )));

    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.color || !r.expect) {
            throw new Error(`${label} banner color capture failed on ${ctx.players[i].role} (${JSON.stringify(r)})`);
        }
        if (norm(r.color) !== norm(r.expect)) {
            throw new Error(`${label} banner color mismatch on ${ctx.players[i].role} (${JSON.stringify(r)})`);
        }
    }
}

/** @deprecated use assertActionBannerAllPlayers(ctx, …) */
async function assertActionBannerOnBoth(page1, page2, text, actorUid, label, opts = {}) {
    const { buildMpCtx2p } = require('../../games/bananagrams/lib/mp-ctx');
    const ctx = buildMpCtx2p(page1, page2);
    return assertActionBannerAllPlayers(ctx, text, actorUid, label, opts);
}

module.exports = {
    assertActionBannerOnBoth,
    assertActionBannerAllPlayers,
    assertActionBannerOnPage,
    resolveActionBannerHooks
};
