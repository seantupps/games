const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

/** MP peel spawn — host and guest peel tiles should become visible at the same time.
 */

const DEFAULT_MAX_SKEW_MS = Number(process.env.FIVE_MP_PEEL_SPAWN_MAX_SKEW_MS || 250);
const DEFAULT_TIMEOUT_MS = Number(process.env.FIVE_MP_PEEL_SPAWN_TIMEOUT_MS || 3000);
const POLL_MS = 16;

/** @param {import('playwright').Page} page */
async function isPeelSpawnDomVisible(page, beforeIds) {
    return page.evaluate(({ ids }) => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        const doc = frame?.contentDocument;
        if (!g || !doc) return { visible: false, reason: 'no-frame' };

        const added = g.tiles.filter((t) => !ids.includes(t.id));
        if (added.length < 1) {
            return { visible: false, reason: 'no-added', got: added.length };
        }

        const t = added[0];
        const el = doc.querySelector(`[data-tile-id="${t.id}"]`);
        if (!el) return { visible: false, reason: 'no-dom', id: t.id };

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
            return { visible: false, reason: 'css-hidden', id: t.id };
        }

        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) {
            return { visible: false, reason: 'tiny-rect', id: t.id, w: r.width, h: r.height };
        }

        return { visible: true, id: t.id, letter: t.letter };
    }, { ids: beforeIds });
}

/**
 * Poll until the peel tile is DOM-visible; returns ms since t0, or null on timeout.
 * @param {import('playwright').Page} page
 */
async function measurePeelSpawnVisibleMs(page, beforeIds, t0, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? POLL_MS;
    const deadline = t0 + timeoutMs;

    while (Date.now() < deadline) {
        if (page.isClosed()) return null;
        try {
            const check = await isPeelSpawnDomVisible(page, beforeIds);
            if (check.visible) return Date.now() - t0;
        } catch (err) {
            if (page.isClosed() || /closed|destroyed/i.test(String(err?.message || ''))) return null;
            throw err;
        }
        try {
            await page.waitForTimeout(pollMs);
        } catch (err) {
            if (page.isClosed() || /closed|destroyed/i.test(String(err?.message || ''))) return null;
            throw err;
        }
    }
    return null;
}

/**
 * Fire host peel and assert host + guest peel tiles appear within maxSkewMs of each other.
 * @param {object} opts
 * @param {import('playwright').Page} opts.page1
 * @param {import('playwright').Page} opts.page2
 * @param {import('playwright').Frame} opts.frame1
 * @param {import('playwright').Frame} [opts.peelFrame] frame that triggers peel (default frame1)
 * @param {string[]} opts.hostBeforeIds
 * @param {string[]} opts.guestBeforeIds
 * @param {string} opts.label
 * @param {number} [opts.maxSkewMs]
 */
async function assertPeelSpawnVisibleSameTime(opts) {
    const {
        page1,
        page2,
        frame1,
        peelFrame = frame1,
        hostBeforeIds,
        guestBeforeIds,
        label,
        maxSkewMs = DEFAULT_MAX_SKEW_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS
    } = opts;

    const peelRes = opts.peelEvaluate
        ? await opts.peelEvaluate()
        : await peelFrame.evaluate(() => {
            const g = window.game;
            g._bannerText = '';
            const peeled = g._checkPeel();
            return { banner: g._bannerText, count: g.tiles.length, peeled };
        });
    const peelTriggered = peelRes.banner === 'Peel!' || peelRes.peeled === true || peelRes.ok === true;
    if (!peelTriggered) {
        failWithSnapshot(label, ['peel trigger failed'], { peelRes });
    }
    if (peelRes.setup && (!peelRes.setup.placed || !peelRes.setup.valid)) {
        failWithSnapshot(label, ['peel grid invalid'], { setup: peelRes.setup });
    }

    const flushHost = opts.flushHost;
    if (flushHost) await flushHost();

    const t0 = Date.now();
    let hostMs = null;
    let guestMs = null;
    const deadline = t0 + timeoutMs;

    while (Date.now() < deadline) {
        if (page1.isClosed() || page2.isClosed()) break;
        if (flushHost) await flushHost();
        if (hostMs == null) {
            const hostCheck = await isPeelSpawnDomVisible(page1, hostBeforeIds);
            if (hostCheck.visible) hostMs = Date.now() - t0;
        }
        if (guestMs == null) {
            const guestCheck = await isPeelSpawnDomVisible(page2, guestBeforeIds);
            if (guestCheck.visible) guestMs = Date.now() - t0;
        }
        if (hostMs != null && guestMs != null) break;
        try {
            await page1.waitForTimeout(POLL_MS);
        } catch (err) {
            if (page1.isClosed() || page2.isClosed() || /closed|destroyed/i.test(String(err?.message || ''))) break;
            throw err;
        }
    }
    if (hostMs == null || guestMs == null) {
        const [hostState, guestState] = await Promise.all([
            isPeelSpawnDomVisible(page1, hostBeforeIds),
            isPeelSpawnDomVisible(page2, guestBeforeIds)
        ]);
        failWithSnapshot(label, ['peel spawn visibility timeout'], { hostMs, guestMs, hostState, guestState });
    }

    const skew = Math.abs(hostMs - guestMs);
    if (skew > maxSkewMs) {
        failWithSnapshot(label, [`peel spawn skew ${skew}ms exceeds ${maxSkewMs}ms`], { hostMs, guestMs });
    }

    return { hostMs, guestMs, skew, maxSkewMs };
}

/**
 * Fire peel and assert every client's peel tile appears within maxSkewMs of the first.
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {object} opts — peelFrame, beforeIdsByPlayer, label, maxSkewMs, peelEvaluate, flushHost
 */
async function assertPeelSpawnVisibleAllPlayers(ctx, opts) {
    const pages = ctx.pages;
    const beforeIdsList = opts.beforeIdsByPlayer || pages.map((_, i) => {
        if (opts[`p${i + 1}BeforeIds`]) return opts[`p${i + 1}BeforeIds`];
        if (i === 0 && opts.hostBeforeIds) return opts.hostBeforeIds;
        if (i === 1 && opts.guestBeforeIds) return opts.guestBeforeIds;
        failWithSnapshot('peel spawn sync', [`missing beforeIds for P${i + 1}`], { beforeIdsByPlayer: opts.beforeIdsByPlayer });
    });
    if (beforeIdsList.length !== pages.length) {
        failWithSnapshot('peel spawn sync', ['beforeIdsByPlayer length mismatch'], {
            beforeIdsLen: beforeIdsList.length,
            pagesLen: pages.length
        });
    }
    return assertPeelSpawnVisibleSameTime({
        page1: pages[0],
        page2: pages[1] || pages[0],
        frame1: opts.frame1 || opts.peelFrame,
        peelFrame: opts.peelFrame || opts.frame1,
        hostBeforeIds: beforeIdsList[0],
        guestBeforeIds: beforeIdsList[1] || beforeIdsList[0],
        label: opts.label,
        maxSkewMs: opts.maxSkewMs,
        timeoutMs: opts.timeoutMs,
        peelEvaluate: opts.peelEvaluate,
        flushHost: opts.flushHost
    });
}

module.exports = {
    assertPeelSpawnVisibleSameTime,
    assertPeelSpawnVisibleAllPlayers,
    measurePeelSpawnVisibleMs,
    isPeelSpawnDomVisible,
    DEFAULT_MAX_SKEW_MS
};
