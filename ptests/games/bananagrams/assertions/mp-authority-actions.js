/**
 * MP peel/dump — banner visibility, actor color, and synchronized tile appearance.
 */

const BANNER_INSTANT_MS = Number(process.env.FIVE_BANANA_BANNER_INSTANT_MS || 2000);
const PEEL_SYNC_MAX_MS = Number(process.env.FIVE_BANANA_PEEL_SYNC_MS || 120);

const HOST_COLOR = '#3b82f6';
const GUEST_COLOR = '#ef4444';

function normalizeCssColor(c) {
    if (!c) return '';
    const s = String(c).trim().toLowerCase().replace(/\s+/g, '');
    if (s.startsWith('#')) {
        if (s.length === 4) {
            return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
        }
        return s;
    }
    const m = s.match(/^rgba?\((\d+),(\d+),(\d+)/);
    if (!m) return s;
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/** @param {import('playwright').Frame} frame */
async function readActionBanner(frame) {
    return frame.evaluate(() => {
        const el = document.getElementById('banana-banner');
        if (!el) return { ok: false, reason: 'no-banner-el' };
        const style = window.getComputedStyle(el);
        return {
            ok: true,
            visible: el.classList.contains('is-visible'),
            text: (el.textContent || '').trim(),
            color: el.style.color || style.color || ''
        };
    });
}

/**
 * Wait until banner shows expected text + actor color on one client.
 * @param {import('playwright').Frame} frame
 */
async function waitActionBanner(frame, text, actorColor, timeoutMs = BANNER_INSTANT_MS) {
    const want = normalizeCssColor(actorColor);
    await frame.waitForFunction(({ bannerText, color }) => {
        const el = document.getElementById('banana-banner');
        if (!el || !el.classList.contains('is-visible')) return false;
        if ((el.textContent || '').trim() !== bannerText) return false;
        const style = window.getComputedStyle(el);
        const got = (el.style.color || style.color || '').trim().toLowerCase().replace(/\s+/g, '');
        const norm = (c) => {
            if (!c) return '';
            if (c.startsWith('#')) return c.length === 4
                ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`
                : c;
            const m = c.match(/^rgba?\((\d+),(\d+),(\d+)/);
            if (!m) return c;
            const h = (n) => Number(n).toString(16).padStart(2, '0');
            return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
        };
        return norm(got) === norm(color);
    }, { bannerText: text, color: want }, { timeout: timeoutMs });
    return readActionBanner(frame);
}

/**
 * Both players see peel/dump banner with actor color within timeout.
 * @param {import('playwright').Frame} hostFrame
 * @param {import('playwright').Frame} guestFrame
 */
async function assertBothPlayersActionBanner(hostFrame, guestFrame, text, actorIsHost, label) {
    const color = actorIsHost ? HOST_COLOR : GUEST_COLOR;
    const [hostBanner, guestBanner] = await Promise.all([
        waitActionBanner(hostFrame, text, color),
        waitActionBanner(guestFrame, text, color)
    ]);
    const fail = (role, b) => {
        throw new Error(`${label} — ${role} banner wrong: want "${text}" ${color}, got ${JSON.stringify(b)}`);
    };
    if (!hostBanner.visible || hostBanner.text !== text) fail('host', hostBanner);
    if (!guestBanner.visible || guestBanner.text !== text) fail('guest', guestBanner);
    if (normalizeCssColor(hostBanner.color) !== normalizeCssColor(color)) fail('host color', hostBanner);
    if (normalizeCssColor(guestBanner.color) !== normalizeCssColor(color)) fail('guest color', guestBanner);
    return { hostBanner, guestBanner, actorColor: color };
}

/**
 * Peel: host and guest must show +1 tile DOM and banner within the same instant window.
 * @param {import('playwright').Frame} hostFrame
 * @param {import('playwright').Frame} guestFrame
 */
async function assertPeelInstantBothPlayers(hostFrame, guestFrame, hostBeforeIds, guestBeforeIds, label) {
    const actorIsHost = true;
    const color = HOST_COLOR;
    const deadline = Date.now() + BANNER_INSTANT_MS;

    const poll = async (frame, beforeIds, role) => frame.evaluate(({ ids, bannerText, wantColor, role: r }) => {
        const g = window.game;
        const added = g.tiles.filter((t) => !ids.includes(t.id));
        const el = document.getElementById('banana-banner');
        const bannerVisible = el?.classList.contains('is-visible')
            && (el.textContent || '').trim() === bannerText;
        const norm = (c) => {
            if (!c) return '';
            const s = String(c).trim().toLowerCase().replace(/\s+/g, '');
            if (s.startsWith('#')) return s.length === 4
                ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
                : s;
            const m = s.match(/^rgba?\((\d+),(\d+),(\d+)/);
            if (!m) return s;
            const h = (n) => Number(n).toString(16).padStart(2, '0');
            return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
        };
        const bannerColor = norm(el?.style.color || (el ? getComputedStyle(el).color : ''));
        let tileVisible = false;
        if (added.length === 1) {
            const node = document.querySelector(`[data-tile-id="${added[0].id}"]`);
            if (node) {
                const rect = node.getBoundingClientRect();
                tileVisible = rect.width > 4 && rect.height > 4;
            }
        }
        return {
            role: r,
            ready: added.length === 1 && tileVisible && bannerVisible
                && bannerColor === norm(wantColor),
            added: added.length,
            tileVisible,
            bannerVisible,
            bannerColor
        };
    }, { ids: beforeIds, bannerText: 'Peel!', wantColor: color, role });

    let hostAt = null;
    let guestAt = null;
    while (Date.now() < deadline) {
        if (!hostAt) {
            const h = await poll(hostFrame, hostBeforeIds, 'host');
            if (h.ready) hostAt = Date.now();
        }
        if (!guestAt) {
            const g = await poll(guestFrame, guestBeforeIds, 'guest');
            if (g.ready) guestAt = Date.now();
        }
        if (hostAt && guestAt) break;
        await new Promise((r) => setTimeout(r, 16));
    }

    if (!hostAt || !guestAt) {
        const h = await poll(hostFrame, hostBeforeIds, 'host');
        const g = await poll(guestFrame, guestBeforeIds, 'guest');
        throw new Error(`${label} — peel not instant on both (${JSON.stringify({ host: h, guest: g })})`);
    }

    const skew = Math.abs(hostAt - guestAt);
    if (skew > PEEL_SYNC_MAX_MS) {
        throw new Error(`${label} — peel tile/banner skew ${skew}ms > ${PEEL_SYNC_MAX_MS}ms`);
    }

    return { hostAt, guestAt, skew };
}

/**
 * Dump: both players see Dump! banner (actor color); only dumper gets +3 tiles (horizontal or singles).
 */
async function assertDumpInstantBothPlayers(hostFrame, guestFrame, hostBeforeIds, guestBeforeIds, actorIsHost, label) {
    const color = actorIsHost ? HOST_COLOR : GUEST_COLOR;
    const actorFrame = actorIsHost ? hostFrame : guestFrame;
    const observerFrame = actorIsHost ? guestFrame : hostFrame;
    const actorBefore = actorIsHost ? hostBeforeIds : guestBeforeIds;
    const observerBefore = actorIsHost ? guestBeforeIds : hostBeforeIds;

    const waitDumperTiles = async () => {
        await actorFrame.waitForFunction(({ ids }) => {
            const g = window.game;
            const added = g.tiles.filter((t) => !ids.includes(t.id));
            if (added.length !== 3) return false;
            return added.every((t) => {
                const el = document.querySelector(`[data-tile-id="${t.id}"]`);
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 4 && r.height > 4;
            });
        }, { ids: actorBefore }, { timeout: BANNER_INSTANT_MS });
    };

    const t0 = Date.now();
    await Promise.all([
        waitDumperTiles(),
        assertBothPlayersActionBanner(hostFrame, guestFrame, 'Dump!', actorIsHost, label)
    ]);

    const observerDelta = await observerFrame.evaluate(({ ids }) => (
        window.game.tiles.filter((t) => !ids.includes(t.id)).length
    ), { ids: observerBefore });
    if (observerDelta !== 0) {
        throw new Error(`${label} — observer gained tiles on dump (${observerDelta})`);
    }

    const placementOk = await actorFrame.evaluate(({ ids }) => {
        const g = window.game;
        const gap = BananaRules.TILE_GAP;
        const added = g.tiles.filter((t) => !ids.includes(t.id));
        return BananaRules.isDumpBatchPlacementValid(added, gap);
    }, { ids: actorBefore });

    if (!placementOk) {
        throw new Error(`${label} — dump batch invalid placement`);
    }

    return { elapsedMs: Date.now() - t0, actorColor: color };
}

module.exports = {
    BANNER_INSTANT_MS,
    PEEL_SYNC_MAX_MS,
    HOST_COLOR,
    GUEST_COLOR,
    normalizeCssColor,
    readActionBanner,
    waitActionBanner,
    assertBothPlayersActionBanner,
    assertPeelInstantBothPlayers,
    assertDumpInstantBothPlayers
};
