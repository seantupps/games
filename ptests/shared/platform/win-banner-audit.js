/**
 * Hub win-banner audits — including fast fade stability (no 4s wait).
 *
 * Test ideas implemented here:
 * - Sample fontSize / width / height while fading (default fadeMs=150)
 * - Trigger fade via HubApp.ctx.startWinBannerFadeOut or short autoFadeMs
 * - Env FIVE_WIN_BANNER_FADE_MS on hub window for showWinBanner
 */
const { runScenario } = require('./scenario-runner');

/** Infer P1/P2 from hub banner text (e.g. "GUESTP2 WINS!"). */
function resolveWinnerFromBannerText(text) {
    if (!text) return null;
    const t = String(text).toUpperCase();
    if (/\bP1\b/.test(t) && !/\bP2\b/.test(t)) return 'P1';
    if (/\bP2\b/.test(t)) return 'P2';
    if (t.includes('HOST')) return 'P1';
    if (t.includes('GUEST')) return 'P2';
    return null;
}

function bannerMetricsScript() {
    return () => {
        const b = document.getElementById('global-win-banner');
        if (!b) return null;
        const fs = parseFloat(b.style.fontSize) || parseFloat(getComputedStyle(b).fontSize) || 0;
        return {
            fontSize: fs,
            width: b.offsetWidth,
            height: b.offsetHeight,
            visible: b.classList.contains('visible'),
            fading: b.classList.contains('is-fading-out'),
            fitting: b.classList.contains('is-fitting')
        };
    };
}

/**
 * Poll banner metrics in the hub page.
 * @param {import('playwright').Page} page
 * @param {number} durationMs
 * @param {number} intervalMs
 */
async function sampleWinBannerMetrics(page, durationMs, intervalMs = 40) {
    return page.evaluate(async ({ durationMs: dur, intervalMs: step }) => {
        const snap = () => {
            const b = document.getElementById('global-win-banner');
            if (!b) return null;
            const fs = parseFloat(b.style.fontSize) || parseFloat(getComputedStyle(b).fontSize) || 0;
            return {
                fontSize: fs,
                width: b.offsetWidth,
                height: b.offsetHeight,
                visible: b.classList.contains('visible'),
                fading: b.classList.contains('is-fading-out'),
                fitting: b.classList.contains('is-fitting')
            };
        };
        const samples = [snap()];
        const end = Date.now() + dur;
        while (Date.now() < end) {
            await new Promise((r) => setTimeout(r, step));
            samples.push(snap());
        }
        return samples.filter(Boolean);
    }, { durationMs, intervalMs });
}

/**
 * Assert banner dimensions stay stable from first settled sample through fade-out.
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.fadeMs=150]
 * @param {number} [opts.maxFontDelta=2]
 * @param {number} [opts.maxSizeDelta=4]
 */
async function assertWinBannerStableThroughFade(page, opts = {}) {
    const fadeMs = opts.fadeMs ?? Number(process.env.FIVE_WIN_BANNER_FADE_MS || 150);
    const maxFontDelta = opts.maxFontDelta ?? 2;
    const maxSizeDelta = opts.maxSizeDelta ?? 4;

    await runScenario('Win banner stable through fade', async () => {
        await page.evaluate((ms) => {
            window.FIVE_WIN_BANNER_FADE_MS = ms;
            const ctx = window.HubApp?.ctx;
            if (!ctx?.showWinBanner) throw new Error('HubApp.ctx.showWinBanner missing');
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const winner = g?.winner || g?.turn || 'P1';
            ctx.showWinBanner({ visible: true, winner, autoFadeMs: ms });
        }, fadeMs);

        await page.waitForSelector('#global-win-banner.visible', { timeout: 3000 });
        await page.waitForFunction(() => {
            const b = document.getElementById('global-win-banner');
            return b?.classList.contains('visible') && !b.classList.contains('is-fitting');
        }, { timeout: 3000 });

        const baseline = await page.evaluate(bannerMetricsScript());
        if (!baseline?.fontSize) {
            throw new Error(`Win banner baseline missing: ${JSON.stringify(baseline)}`);
        }

        const samples = await sampleWinBannerMetrics(page, fadeMs + 750, 35);
        const settled = samples.filter((s) => s.visible && !s.fitting);
        if (settled.length < 2) {
            throw new Error(`Too few banner samples during fade: ${samples.length}`);
        }

        const ref = settled[0];
        for (const s of settled) {
            if (Math.abs(s.fontSize - ref.fontSize) > maxFontDelta) {
                throw new Error(
                    `Win banner fontSize jumped during fade: ${ref.fontSize} → ${s.fontSize} `
                    + `(samples=${JSON.stringify(settled)})`
                );
            }
            if (Math.abs(s.width - ref.width) > maxSizeDelta || Math.abs(s.height - ref.height) > maxSizeDelta) {
                throw new Error(
                    `Win banner size jumped during fade: ${ref.width}x${ref.height} → ${s.width}x${s.height}`
                );
            }
        }

        const sawFade = samples.some((s) => s.fading);
        const endedHidden = !samples[samples.length - 1]?.visible;
        if (!sawFade && !endedHidden) {
            throw new Error('Banner never entered fade-out state');
        }
    });
}

/**
 * After a real victory, fade the banner on each hub page (MP: one context per player).
 * @param {import('playwright').Page} page1
 * @param {import('playwright').Page} [page2]
 * @param {object} [opts]
 */
async function assertWinBannerFadeStableAfterVictory(page1, page2, opts = {}) {
    const maxFontDelta = opts.maxFontDelta ?? 2;
    const maxSizeDelta = opts.maxSizeDelta ?? 4;
    const pages = [page1, page2].filter(Boolean);

    await runScenario('Win banner post-victory fade stability', async () => {
        await Promise.all(pages.map((p) => p.waitForSelector('#global-win-banner.visible', { timeout: 5000 })));
        await Promise.all(pages.map((p) => p.waitForFunction(() => {
            const b = document.getElementById('global-win-banner');
            return b?.classList.contains('visible') && !b.classList.contains('is-fitting');
        }, { timeout: 3000 })));

        const baseline = await page1.evaluate(bannerMetricsScript());
        if (!baseline?.fontSize) {
            throw new Error(`Win banner baseline missing: ${JSON.stringify(baseline)}`);
        }

        const fadeOut = () => {
            const b = document.getElementById('global-win-banner');
            const ctx = window.HubApp?.ctx;
            if (!ctx?.startWinBannerFadeOut) throw new Error('HubApp.ctx.startWinBannerFadeOut missing');
            ctx.startWinBannerFadeOut(b);
        };
        await Promise.all(pages.map((p) => p.evaluate(fadeOut)));

        const samples = await sampleWinBannerMetrics(page1, 750, 35);
        const duringFade = samples.filter((s) => s?.fading);
        if (duringFade.length < 2) {
            throw new Error(`Too few banner samples during fade: ${JSON.stringify(samples)}`);
        }
        const sawFading = duringFade.length > 0;

        for (const s of duringFade) {
            if (Math.abs(s.fontSize - baseline.fontSize) > maxFontDelta) {
                throw new Error(
                    `Win banner fontSize jumped during fade: ${baseline.fontSize} → ${s.fontSize} `
                    + `(samples=${JSON.stringify(duringFade)})`
                );
            }
            if (Math.abs(s.width - baseline.width) > maxSizeDelta || Math.abs(s.height - baseline.height) > maxSizeDelta) {
                throw new Error(
                    `Win banner size jumped during fade: ${baseline.width}x${baseline.height} `
                    + `→ ${s.width}x${s.height}`
                );
            }
        }

        if (!sawFading) {
            throw new Error('Banner never entered is-fading-out state');
        }
    });
}

module.exports = {
    resolveWinnerFromBannerText,
    assertWinBannerStableThroughFade,
    assertWinBannerFadeStableAfterVictory,
    sampleWinBannerMetrics
};
