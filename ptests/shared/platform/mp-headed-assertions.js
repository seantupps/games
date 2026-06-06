/**
 * Unified headed MP layout assertions (mobile + desktop).
 * Toggle checks in HEADED_ASSERT below (no env vars).
 */
const { getDeviceContextOptions } = require('../../platform/mobile/lib/device-presets');
const { MOBILE_WINDOW } = require('../infra/viewport-constants');
const { shouldAhkForceMobileHeaded } = require('./ahk');
const {
    isMpHeaded,
    mpHeadedSlotSize,
    mpHeadedGap,
    readHeadedWindowBounds,
    relayoutMpHeadedForReview,
    applyHeadedDesktopReviewView
} = require('./mp-headed-view');

const DEFAULTS = {
    maxOuterWidthMobile: MOBILE_WINDOW.width + 3,
    maxInnerWidthDelta: 20,
    maxInnerHeightDelta: 40,
    maxFrameWidth: 120,
    maxTileGap: 4
};

/** In-code headed assertion toggles — flip booleans here. */
const HEADED_ASSERT = {
    enabled: false,
    /** Window/content size vs target (MOBILE_VIEWPORT / MOBILE_WINDOW, 960×931, etc.) */
    size: false,
    /** Side-by-side tile gap between MP windows */
    gap: false,
    /** Mobile outer width / desktop AHK-shrink guard */
    ahk: false,
    /** Re-tile windows before measuring (only when size/gap/ahk run) */
    relayout: false,
    /** Host=P1 window, guest=P2 */
    roles: true,
    /** Desktop 1× zoom + Done/rack in frame */
    zoom: true,
    /** Post-game review + host Done on-screen */
    review: true,
    /** Headed mobile — Playwright + iframe must stay at emulated MOBILE_VIEWPORT */
    mobileViewport: true,
    maxTileGap: DEFAULTS.maxTileGap,
    maxZoom: 1.02,
    minZoom: 0.98
};

/** @returns {typeof HEADED_ASSERT} */
function headedAssertConfig() {
    const master = HEADED_ASSERT.enabled;
    return {
        enabled: master,
        size: master && HEADED_ASSERT.size,
        gap: master && HEADED_ASSERT.gap,
        ahk: master && HEADED_ASSERT.ahk,
        relayout: master && HEADED_ASSERT.relayout,
        review: master && HEADED_ASSERT.review,
        roles: master && HEADED_ASSERT.roles,
        zoom: master && HEADED_ASSERT.zoom,
        mobileViewport: master && HEADED_ASSERT.mobileViewport,
        maxTileGap: HEADED_ASSERT.maxTileGap,
        maxZoom: HEADED_ASSERT.maxZoom,
        minZoom: HEADED_ASSERT.minZoom
    };
}

async function readPageWindowMetrics(page) {
    const cdp = await readHeadedWindowBounds(page);
    const viewport = page.viewportSize();
    return { cdp, viewport };
}

/** @param {import('playwright').Page} page */
async function readHeadedMobileViewportSnap(page) {
    const target = getDeviceContextOptions().viewport;
    const { cdp, viewport } = await readPageWindowMetrics(page);
    const dom = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const doc = frame?.contentDocument;
        const win = doc?.defaultView;
        const rack = doc?.querySelector('.rack-hand, .banana-rack, #rack-hand');
        const rackRect = rack?.getBoundingClientRect?.();
        const vh = win?.innerHeight ?? 0;
        return {
            innerH: window.innerHeight,
            innerW: window.innerWidth,
            hubH: document.getElementById('game-hub-container')?.offsetHeight ?? 0,
            iframeH: frame?.getBoundingClientRect?.().height ?? 0,
            gameIframeH: vh,
            rackBottom: rackRect?.bottom ?? null,
            rackInView: rackRect
                ? rackRect.bottom <= vh + 2 && rackRect.height > 0
                : null
        };
    }).catch(() => ({}));
    return { target, viewport, cdp, dom };
}

/**
 * Headed mobile MP — emulated viewport height must not shrink (SP uses full 412×915).
 * @param {import('playwright').Page[]} pages
 * @param {string} [label]
 * @param {(msg: string) => void} [log]
 */
async function assertHeadedMobileEmulatedViewport(pages, label = 'mobile viewport', log = (m) => console.log(m)) {
    const failures = [];
    const passes = [];
    const maxHDelta = Number(process.env.FIVE_MP_HEADED_MOBILE_MAX_H_DELTA || 8);
    const maxWDelta = DEFAULTS.maxInnerWidthDelta;

    for (let i = 0; i < pages.length; i++) {
        const snap = await readHeadedMobileViewportSnap(pages[i]);
        const tag = `P${i + 1}`;
        const { target, viewport, cdp, dom } = snap;
        const vpH = viewport?.height;
        const vpW = viewport?.width;

        if (!viewport) {
            failures.push(`${tag}: no Playwright viewport`);
            continue;
        }

        const hDelta = Math.abs(vpH - target.height);
        const wDelta = Math.abs(vpW - target.width);
        if (hDelta > maxHDelta) {
            failures.push(
                `${tag}: Playwright height ${vpH}px vs emulated ${target.height}px (Δ${hDelta}) `
                + `[innerH=${dom.innerH}, iframeH=${dom.iframeH}, gameIframeH=${dom.gameIframeH}, outer=${cdp?.height}]`
            );
        } else {
            passes.push(`${tag}: Playwright ${vpW}×${vpH} matches emulated ${target.width}×${target.height}`);
        }
        if (wDelta > maxWDelta) {
            failures.push(`${tag}: Playwright width ${vpW}px vs emulated ${target.width}px (Δ${wDelta})`);
        }
        if (dom.gameIframeH && dom.gameIframeH < target.height - maxHDelta) {
            failures.push(
                `${tag}: game iframe innerHeight ${dom.gameIframeH}px < emulated ${target.height}px`
            );
        }
        if (dom.rackInView === false) {
            failures.push(
                `${tag}: rack bottom ${dom.rackBottom}px past iframe ${dom.gameIframeH}px (cropped)`
            );
        } else if (dom.rackInView === true) {
            passes.push(`${tag}: rack visible in iframe (bottom=${Math.round(dom.rackBottom)})`);
        }
    }

    const tag = '[HEADED mobile-vp]';
    log(`${tag} ${label} — ${failures.length ? 'FAIL' : 'PASS'}`);
    for (const p of passes) log(`${tag} PASS — ${p}`);
    for (const f of failures) log(`${tag} FAIL — ${f}`);

    if (failures.length) {
        throw new Error(`Headed mobile viewport (${label}):\n  - ${failures.join('\n  - ')}`);
    }
    return { ok: true, passes, failures };
}

function headedMobileViewportProbeEnabled() {
    try {
        const { isHeadedMobileViewportProbeEnabled } = require('../infra/run-config');
        return isHeadedMobileViewportProbeEnabled();
    } catch (_) {
        return false;
    }
}

/**
 * @param {import('playwright').Page[]} pages
 * @param {boolean} mobile
 */
async function assertHeadedWindowSize(pages, mobile) {
    const failures = [];
    const passes = [];
    const target = mobile
        ? getDeviceContextOptions().viewport
        : mpHeadedSlotSize(pages.length);
    const expectAhk = mobile && shouldAhkForceMobileHeaded();

    for (let i = 0; i < pages.length; i++) {
        const { cdp, viewport } = await readPageWindowMetrics(pages[i]);
        const innerW = viewport?.width;
        const innerH = viewport?.height;
        const outerW = cdp?.width;
        const outerH = cdp?.height;
        const label = `P${i + 1}`;

        if (!cdp || !viewport) {
            failures.push(`${label}: could not read window metrics`);
            continue;
        }

        const innerWDelta = Math.abs(innerW - target.width);
        const innerHDelta = Math.abs(innerH - target.height);
        if (innerWDelta > DEFAULTS.maxInnerWidthDelta) {
            failures.push(`${label}: content width ${innerW}px vs target ${target.width}px (Δ${innerWDelta})`);
        } else {
            passes.push(`${label}: content ${innerW}×${innerH} matches target ${target.width}×${target.height}`);
        }
        if (innerHDelta > DEFAULTS.maxInnerHeightDelta) {
            failures.push(`${label}: content height ${innerH}px vs target ${target.height}px (Δ${innerHDelta})`);
        }

        const frameW = outerW - innerW;
        if (frameW > DEFAULTS.maxFrameWidth) {
            failures.push(`${label}: chrome frame ${frameW}px exceeds ${DEFAULTS.maxFrameWidth}px`);
        }

        if (mobile && expectAhk) {
            const outerWDelta = Math.abs(outerW - MOBILE_WINDOW.width);
            const outerHDelta = Math.abs(outerH - MOBILE_WINDOW.height);
            if (outerWDelta > DEFAULTS.maxFrameWidth) {
                failures.push(`${label}: mobile outer width ${outerW}px vs target ${MOBILE_WINDOW.width}px (Δ${outerWDelta})`);
            } else {
                passes.push(`${label}: mobile outer width ${outerW}px ≈ ${MOBILE_WINDOW.width}px`);
            }
            if (outerHDelta > DEFAULTS.maxInnerHeightDelta) {
                failures.push(`${label}: mobile outer height ${outerH}px vs target ${MOBILE_WINDOW.height}px (Δ${outerHDelta})`);
            }
        } else if (!mobile) {
            passes.push(`${label}: desktop outer ${outerW}×${outerH} (no AHK check)`);
        }
    }

    return { ok: failures.length === 0, passes, failures };
}

/**
 * @param {import('playwright').Page[]} pages
 * @param {number} maxGap
 */
async function assertHeadedWindowsFlush(pages, maxGap) {
    if (pages.length < 2) {
        return { ok: true, passes: ['gap: skipped (single window)'], failures: [] };
    }

    const bounds = [];
    for (let i = 0; i < pages.length; i++) {
        const b = await readHeadedWindowBounds(pages[i]);
        if (!b) return { ok: false, passes: [], failures: [`P${i + 1}: could not read CDP bounds for gap check`] };
        bounds.push({ ...b, slot: i });
    }
    bounds.sort((a, b) => a.left - b.left || a.top - b.top);

    const failures = [];
    const passes = [];
    const configuredGap = mpHeadedGap();

    for (let i = 0; i < bounds.length - 1; i++) {
        const cur = bounds[i];
        const next = bounds[i + 1];
        const rightEdge = cur.left + cur.width;
        const actualGap = next.left - rightEdge;
        const allowed = configuredGap + maxGap;
        if (actualGap > allowed) {
            failures.push(
                `P${cur.slot + 1}→P${next.slot + 1}: gap ${actualGap}px exceeds allowed ${allowed}px `
                + `(right=${rightEdge}, next.left=${next.left})`
            );
        } else {
            passes.push(
                `P${cur.slot + 1}→P${next.slot + 1}: gap ${actualGap}px (allowed ≤${allowed}px) `
                + `[P${cur.slot + 1} left=${cur.left} w=${cur.width} right=${rightEdge}, `
                + `P${next.slot + 1} left=${next.left}]`
            );
        }
    }

    return { ok: failures.length === 0, passes, failures };
}

/** Mobile only — outer width shrunk below Chrome minimum via AHK. */
async function assertHeadedMobileAhk(pages) {
    if (!shouldAhkForceMobileHeaded()) {
        return { ok: true, passes: ['ahk-mobile: disabled (HEADED_AHK_ENABLED=false)'], failures: [] };
    }
    const targetW = getDeviceContextOptions().viewport.width;
    const failures = [];
    const passes = [];
    for (let i = 0; i < pages.length; i++) {
        const { cdp } = await readPageWindowMetrics(pages[i]);
        const outerW = cdp?.width;
        const label = `P${i + 1}`;
        if (!outerW) {
            failures.push(`${label}: could not read outer width`);
            continue;
        }
        if (outerW >= 500) {
            failures.push(`${label}: outer width ${outerW}px not under 500`);
        } else {
            passes.push(`${label}: outer width ${outerW}px under 500`);
        }
        if (Math.abs(outerW - targetW) > DEFAULTS.maxFrameWidth) {
            failures.push(`${label}: outer ${outerW}px not close to emulator ${targetW}px`);
        }
    }
    return { ok: failures.length === 0, passes, failures };
}

/** Desktop should never have AHK-shrunk (mobile-sized) windows. */
async function assertDesktopNoAhkShrink(pages) {
    const failures = [];
    const passes = [];
    if (!shouldAhkForceMobileHeaded()) {
        return { ok: true, passes: ['ahk-desktop: disabled (HEADED_AHK_ENABLED=false)'], failures: [] };
    }
    for (let i = 0; i < pages.length; i++) {
        const b = await readHeadedWindowBounds(pages[i]);
        if (!b) {
            failures.push(`P${i + 1}: could not read bounds`);
            continue;
        }
        const slotW = mpHeadedSlotSize(pages.length).width;
        if (b.width < 500 && b.width <= slotW - 200) {
            failures.push(`P${i + 1}: desktop outer width ${b.width}px looks AHK-shrunk (mobile-sized)`);
        } else {
            passes.push(`P${i + 1}: desktop outer width ${b.width}px (not mobile/AHK sized)`);
        }
    }
    return { ok: failures.length === 0, passes, failures };
}

/**
 * @param {import('playwright').Page[]} pages
 */
async function assertHeadedMpPlayerRoles(pages) {
    const failures = [];
    const passes = [];
    for (let i = 0; i < pages.length; i++) {
        const expectHost = i === 0;
        const label = `P${i + 1}`;
        const snap = await pages[i].evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const ne = window.NetworkEngine;
            return {
                hubRole: ne?.playerRole ?? null,
                hubUid: ne?.uid ?? null,
                gameRole: g?.playerRole ?? null,
                isHost: typeof g?.isHost === 'function' ? g.isHost() : null,
                roomHost: g?.roomData?.host ?? ne?.roomData?.host ?? null,
                title: document.title
            };
        });
        if (expectHost) {
            if (!snap.isHost || snap.hubRole !== 'P1' || snap.gameRole !== 'P1') {
                failures.push(
                    `${label} should be host — hubRole=${snap.hubRole} gameRole=${snap.gameRole} `
                    + `isHost=${snap.isHost} uid=${snap.hubUid} roomHost=${snap.roomHost}`
                );
            } else {
                passes.push(`${label} is host (uid=${snap.hubUid}, title=${snap.title})`);
            }
        } else if (snap.isHost || snap.hubRole === 'P1' || snap.gameRole === 'P1') {
            failures.push(
                `${label} should be guest — hubRole=${snap.hubRole} gameRole=${snap.gameRole} isHost=${snap.isHost}`
            );
        } else {
            passes.push(`${label} is guest (hubRole=${snap.hubRole}, gameRole=${snap.gameRole})`);
        }
    }
    return { ok: failures.length === 0, passes, failures };
}

/**
 * @param {import('playwright').Page} hostPage
 */
async function assertHeadedHostReviewDone(hostPage) {
    const snap = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const btn = doc?.querySelector('#banana-done-btn.show');
        const rect = btn?.getBoundingClientRect?.();
        const style = btn ? doc.defaultView.getComputedStyle(btn) : null;
        const inReview = !!(board?.phase === 'review' || board?.reviewPhase === true || g?._postGameReview);
        const canShow = typeof g?._canShowDoneButton === 'function' ? g._canShowDoneButton() : false;
        let hitTest = false;
        if (btn && rect?.width > 0 && rect?.height > 0 && doc?.defaultView) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const topEl = doc.elementFromPoint(cx, cy);
            hitTest = topEl === btn || btn.contains(topEl);
        }
        return {
            inReview,
            canShow,
            isHost: typeof g?.isHost === 'function' ? g.isHost() : null,
            hubRole: window.NetworkEngine?.playerRole ?? null,
            gameRole: g?.playerRole ?? null,
            phase: board?.phase ?? null,
            hasShowClass: !!btn,
            rect: rect ? { w: rect.width, h: rect.height, top: rect.top, left: rect.left } : null,
            opacity: style ? Number(style.opacity) : null,
            hitTest
        };
    });

    const doneBtn = hostPage.frameLocator('#game-frame').locator('#banana-done-btn.show');
    const pwVisible = (await doneBtn.count()) > 0 && await doneBtn.first().isVisible().catch(() => false);
    const box = pwVisible ? await doneBtn.first().boundingBox().catch(() => null) : null;

    const failures = [];
    const passes = [];
    if (!snap.inReview) {
        failures.push(`host not in review (phase=${snap.phase}, postGameReview expected)`);
    } else {
        passes.push('host in post-game review');
    }
    if (!snap.isHost || snap.hubRole !== 'P1' || snap.gameRole !== 'P1') {
        failures.push(
            `host window is not P1/host (hubRole=${snap.hubRole}, gameRole=${snap.gameRole}, isHost=${snap.isHost})`
        );
    }
    const iframeH = await hostPage.evaluate(() =>
        document.getElementById('game-frame')?.getBoundingClientRect?.().height ?? 0
    ).catch(() => 0);
    const inIframeViewport = !!(box && box.y >= 0 && box.y + box.height <= iframeH + 4);
    if (!pwVisible || !box || box.width < 20 || box.height < 20 || !inIframeViewport) {
        failures.push(
            `host Done not on-screen (pwVisible=${pwVisible}, box=${JSON.stringify(box)}, iframeH=${iframeH}, `
            + `canShow=${snap.canShow}, hasShowClass=${snap.hasShowClass}, rect=${JSON.stringify(snap.rect)}, `
            + `hitTest=${snap.hitTest})`
        );
    } else {
        passes.push(
            `host Done on-screen (${Math.round(box.width)}×${Math.round(box.height)} `
            + `at ${Math.round(box.x)},${Math.round(box.y)} in ${Math.round(iframeH)}px iframe)`
        );
    }

    return { ok: failures.length === 0, passes, failures, snap: { ...snap, pwVisible, box } };
}

/**
 * Desktop headed must stay at 1× — play/review fit zoom clips the bottom (Done, rack).
 * @param {import('playwright').Page[]} pages
 * @param {number} maxZoom
 */
async function assertHeadedDesktopViewportZoom(pages, maxZoom = 1.02, minZoom = 0.98) {
    const failures = [];
    const passes = [];
    for (let i = 0; i < pages.length; i++) {
        const label = `P${i + 1}`;
        const snap = await pages[i].evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            const vh = doc?.defaultView?.innerHeight ?? 0;
            const done = doc?.querySelector('#banana-done-btn.show');
            const doneRect = done?.getBoundingClientRect?.();
            const rack = doc?.querySelector('.rack-hand, .banana-rack, #rack-hand');
            const rackRect = rack?.getBoundingClientRect?.();
            return {
                zoom: g?.zoom ?? null,
                targetZoom: g?.targetZoom ?? null,
                iframeH: vh,
                inReview: !!(g?._postGameReview || g?._isBoardInReview?.()),
                lock: !!g?._headedMpReviewLock,
                doneBottom: doneRect?.bottom ?? null,
                doneInView: doneRect
                    ? doneRect.bottom <= vh + 2 && doneRect.top >= 0 && doneRect.height > 0
                    : null,
                rackBottom: rackRect?.bottom ?? null
            };
        });
        const z = snap.zoom ?? 99;
        const tz = snap.targetZoom ?? 99;
        if (z > maxZoom || tz > maxZoom || z < minZoom || tz < minZoom) {
            failures.push(
                `${label}: zoom=${z} targetZoom=${tz} not ~1× (allowed ${minZoom}–${maxZoom}) `
                + `(iframeH=${snap.iframeH}, inReview=${snap.inReview}, lock=${snap.lock})`
            );
        } else {
            passes.push(`${label}: zoom=${z} targetZoom=${tz} (~1×)`);
        }
        if (i === 0 && snap.doneInView === false) {
            failures.push(
                `${label}: host Done clipped (doneBottom=${snap.doneBottom}, iframeH=${snap.iframeH})`
            );
        } else if (i === 0 && snap.doneInView === true) {
            passes.push(`${label}: host Done within iframe (bottom=${Math.round(snap.doneBottom)})`);
        }
    }
    return { ok: failures.length === 0, passes, failures };
}

function logCheck(log, name, result, skipped = false) {
    const tag = '[HEADED]';
    if (skipped) {
        log(`${tag} ${name}: SKIP`);
        return;
    }
    for (const p of result.passes) log(`${tag} ${name} PASS — ${p}`);
    for (const f of result.failures) log(`${tag} ${name} FAIL — ${f}`);
}

/**
 * Run unified headed layout assertions after review layout sync.
 *
 * @param {object} options
 * @param {import('playwright').Page[]} options.pages
 * @param {boolean} [options.mobile]
 * @param {import('playwright').Page} [options.hostPage]
 * @param {import('playwright').Frame} [options.hostFrame]
 * @param {(msg: string) => void} [options.log]
 */
async function assertHeadedMpLayout(options = {}) {
    const { pages, mobile = false, hostPage, hostFrame, log = (m) => console.log(m) } = options;
    if (!isMpHeaded()) return { skipped: true, reason: 'not headed' };

    const cfg = headedAssertConfig();
    if (!cfg.enabled) {
        log('[HEADED] assertions disabled (HEADED_ASSERT.enabled=false)');
        return { skipped: true, reason: 'disabled' };
    }

    log(`[HEADED] assertions (${mobile ? 'mobile' : 'desktop'}) — `
        + `size=${cfg.size ? 'on' : 'off'} gap=${cfg.gap ? 'on' : 'off'} `
        + `ahk=${cfg.ahk ? 'on' : 'off'} roles=${cfg.roles ? 'on' : 'off'} `
        + `zoom=${cfg.zoom && !mobile ? 'on' : 'off'} review=${cfg.review ? 'on' : 'off'} `
        + `mobileVp=${cfg.mobileViewport && mobile ? 'on' : 'off'}`);

    if (cfg.relayout) {
        await relayoutMpHeadedForReview(pages, { mobile });
        await pages[0]?.waitForTimeout?.(150).catch(() => { });
    }

    const allFailures = [];

    if (cfg.size) {
        const r = await assertHeadedWindowSize(pages, mobile);
        logCheck(log, 'size', r);
        allFailures.push(...r.failures);
    }

    if (cfg.gap) {
        const r = await assertHeadedWindowsFlush(pages, cfg.maxTileGap);
        logCheck(log, 'gap', r);
        allFailures.push(...r.failures);
    }

    if (cfg.ahk) {
        const r = mobile
            ? await assertHeadedMobileAhk(pages)
            : await assertDesktopNoAhkShrink(pages);
        logCheck(log, mobile ? 'ahk-mobile' : 'ahk-desktop', r);
        allFailures.push(...r.failures);
    }

    if (cfg.roles) {
        const r = await assertHeadedMpPlayerRoles(pages);
        logCheck(log, 'roles', r);
        allFailures.push(...r.failures);
    }

    if (cfg.zoom && !mobile) {
        await Promise.all(pages.map((p) => applyHeadedDesktopReviewView(p)));
        await pages[0]?.waitForTimeout?.(120).catch(() => { });
        const r = await assertHeadedDesktopViewportZoom(pages, cfg.maxZoom, cfg.minZoom);
        logCheck(log, 'zoom', r);
        allFailures.push(...r.failures);
    }

    if (cfg.mobileViewport && mobile) {
        await assertHeadedMobileEmulatedViewport(pages, 'review layout', log);
    }

    if (cfg.review) {
        const page = hostPage || pages[0];
        if (!page) {
            allFailures.push('review: no host page available');
            log('[HEADED] review FAIL — no host page');
        } else {
            const r = await assertHeadedHostReviewDone(page);
            logCheck(log, 'review', r);
            allFailures.push(...r.failures);
        }
    }

    if (allFailures.length) {
        throw new Error(`Headed MP layout assertions failed:\n  - ${allFailures.join('\n  - ')}`);
    }

    log('[HEADED] all enabled assertions passed');
    return { ok: true };
}

module.exports = {
    HEADED_ASSERT,
    headedAssertConfig,
    assertHeadedWindowSize,
    assertHeadedWindowsFlush,
    assertHeadedMobileAhk,
    assertDesktopNoAhkShrink,
    assertHeadedMpPlayerRoles,
    assertHeadedHostReviewDone,
    assertHeadedDesktopViewportZoom,
    assertHeadedMpLayout,
    readPageWindowMetrics,
    readHeadedMobileViewportSnap,
    assertHeadedMobileEmulatedViewport,
    headedMobileViewportProbeEnabled
};
