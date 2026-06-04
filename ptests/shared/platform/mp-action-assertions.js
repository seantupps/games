/**
 * Cross-game MP action banner assertions (text + actor color on both clients).
 */
const { waitForDiag, WAIT_MS } = require('./mp-waits');
const { resolveActionBannerHooks } = require('./action-banner-policy');

/**
 * @param {import('playwright').Page} page1
 * @param {import('playwright').Page} page2
 * @param {string} text
 * @param {string} actorUid
 * @param {string} label
 * @param {object} [opts]
 * @param {string} [opts.gameId]
 * @param {string} [opts.gameMode]
 * @param {number} [opts.timeoutMs]
 */
async function assertActionBannerOnBoth(page1, page2, text, actorUid, label, opts = {}) {
    const normalized = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
    const timeoutMs = normalized.timeoutMs ?? WAIT_MS;
    const gameId = normalized.gameId || 'bananagrams';
    const gameMode = normalized.gameMode || 'multiplayer';
    const hooks = resolveActionBannerHooks(gameId, gameMode);
    const { elementId, visibleClass, actorUidField, colorFn } = hooks;

    const check = async (page, player) => {
        await waitForDiag(page, `${label} banner visible ${player}`, ({ wantText, wantUid, bannerId, visClass, uidField }) => {
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
        }, timeoutMs, { page1, page2 });
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
    };
    const [host, guest] = await Promise.all([check(page1, 'host'), check(page2, 'guest')]);
    if (!host.color || !guest.color || !host.expect) {
        throw new Error(`${label} banner color capture failed (${JSON.stringify({ host, guest })})`);
    }
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    if (norm(host.color) !== norm(host.expect) || norm(guest.color) !== norm(guest.expect)) {
        throw new Error(`${label} banner color mismatch (${JSON.stringify({ host, guest })})`);
    }
}

module.exports = { assertActionBannerOnBoth, resolveActionBannerHooks };
