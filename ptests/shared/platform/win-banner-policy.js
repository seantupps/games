/**
 * Victory / hub banner audit policy from GameRegistry capabilities.
 * Use in audit_base, multiplayer_base, and custom extended audits.
 */
const GameRegistry = require('../../../shared/games/registry');
const { runScenario } = require('../infra/scenario-runner');
const {
    assertWinBannerFadeStableAfterVictory,
    resolveWinnerFromBannerText
} = require('../assertions/win-banner');

/**
 * @param {string} gameId
 * @param {string} [gameMode]
 */
function resolveVictoryAuditPolicy(gameId, gameMode) {
    const caps = GameRegistry.getCapabilities(gameId, gameMode);
    const postGame = !!caps.supportsPostGameReview;
    const hubBanner = caps.supportsWinBanner !== false;

    return {
        caps,
        /** Standard turn-based SP/MP: hub #global-win-banner with "WINS" text. */
        verifyHubWinBanner: hubBanner && !postGame,
        /** Hub banner fade stability (after visible win). */
        verifyHubBannerFade: hubBanner && !postGame,
        /** Extended games: victory in iframe; hub banner optional / fades during review. */
        verifyIframeVictoryOnly: postGame || !hubBanner,
        /** Wait for banner hide + game live after win (Piles/Line default). */
        expectAutoReset: caps.supportsVictoryAutoReset !== false,
        /** MP post-reset turn flip (turn-based games only). */
        expectTurnAlternation: !!caps.supportsTurnIndicator
    };
}

async function readHubBanner(page) {
    return page.evaluate(() => {
        const banner = document.getElementById('global-win-banner');
        return {
            visible: banner ? banner.classList.contains('visible') : false,
            text: banner ? banner.innerText : '',
            color: banner ? getComputedStyle(banner).color : ''
        };
    });
}

function hubBannerOk(b) {
    return b && b.text.includes('WINS') && (b.visible || b.text.length > 4);
}

/**
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 */
async function assertHubWinBannerVisible(page, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    await page.waitForSelector('#global-win-banner.visible', { timeout: timeoutMs }).catch(() => { });
    const banner = await readHubBanner(page);
    if (!hubBannerOk(banner)) {
        throw new Error(`Hub victory banner failed: ${JSON.stringify(banner)}`);
    }
    return banner;
}

/**
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 */
async function assertIframeVictoryState(page, opts = {}) {
    const state = await page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return {
            isOver: !!g?.isOver,
            winner: g?.winner ?? null,
            review: !!(g?._postGameReview || g?.roomData?.global?.board?.phase === 'review')
        };
    });
    if (!state.isOver && !state.review) {
        throw new Error(`Expected iframe victory or review state, got ${JSON.stringify(state)}`);
    }
    return state;
}

/**
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.resetMs]
 * @param {boolean} [opts.isMobile]
 */
async function waitForVictoryAutoReset(page, opts = {}) {
    const resetMs = opts.resetMs ?? (opts.isMobile ? 8000 : 5000);
    await page.waitForFunction(() => {
        const banner = document.getElementById('global-win-banner');
        const bannerHidden = banner && !banner.classList.contains('visible');
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const gameLive = g ? !g.isOver : true;
        return bannerHidden && gameLive;
    }, { timeout: resetMs });
}

/**
 * SP victory footer — branches on registry caps.
 * @param {import('playwright').Page} page
 * @param {string} gameId
 * @param {string} gameMode
 * @param {object} [opts]
 */
async function verifySpVictoryOutcome(page, gameId, gameMode, opts = {}) {
    const policy = resolveVictoryAuditPolicy(gameId, gameMode);
    const fadeMs = Number(process.env.FIVE_WIN_BANNER_FADE_MS || 150);

    if (policy.verifyHubWinBanner) {
        await runScenario('Hub victory banner', async () => {
            await assertHubWinBannerVisible(page, opts);
        });
        if (policy.verifyHubBannerFade) {
            await assertWinBannerFadeStableAfterVictory(page, null, { fadeMs });
        }
    } else if (policy.verifyIframeVictoryOnly) {
        await runScenario('Iframe victory state', async () => {
            await assertIframeVictoryState(page, opts);
        });
    }

    if (policy.expectAutoReset && !opts.skipAutoReset) {
        await runScenario('Victory auto-reset', async () => {
            await waitForVictoryAutoReset(page, opts);
        });
    }
}

/**
 * MP victory footer — both clients; branches on registry caps.
 * @param {import('playwright').Page} page1
 * @param {import('playwright').Page} page2
 * @param {string} gameId
 * @param {string} gameMode
 * @param {object} [opts]
 * @returns {Promise<{ winner: string|null, p1Banner: object, p2Banner: object }>}
 */
async function verifyMpVictoryOutcome(page1, page2, gameId, gameMode, opts = {}) {
    const policy = resolveVictoryAuditPolicy(gameId, gameMode);
    const fadeMs = Number(process.env.FIVE_WIN_BANNER_FADE_MS || 150);
    let p1Banner;
    let p2Banner;

    if (policy.verifyHubWinBanner) {
        const bannerMs = opts.bannerMs ?? 1200;
        await Promise.all([
            page1.waitForSelector('#global-win-banner.visible', { timeout: bannerMs }).catch(() => { }),
            page2.waitForSelector('#global-win-banner.visible', { timeout: bannerMs }).catch(() => { })
        ]);
        p1Banner = await readHubBanner(page1);
        p2Banner = await readHubBanner(page2);
        if (!hubBannerOk(p1Banner) || !hubBannerOk(p2Banner)) {
            throw new Error(
                `Victory banner failed. P1: ${JSON.stringify(p1Banner)}, P2: ${JSON.stringify(p2Banner)}`
            );
        }
        if (p1Banner.text !== p2Banner.text) {
            throw new Error(`Victory banner text mismatch: P1="${p1Banner.text}" P2="${p2Banner.text}"`);
        }
        const normalizeColor = (c) => {
            if (!c) return null;
            c = c.replace(/\s/g, '').toLowerCase();
            if (c.startsWith('#')) {
                const r = parseInt(c.slice(1, 3), 16);
                const g = parseInt(c.slice(3, 5), 16);
                const b = parseInt(c.slice(5, 7), 16);
                return `rgb(${r},${g},${b})`;
            }
            return c;
        };
        if (normalizeColor(p1Banner.color) !== normalizeColor(p2Banner.color)) {
            throw new Error(
                `Victory banner color mismatch: P1="${p1Banner.color}" P2="${p2Banner.color}"`
            );
        }
        if (policy.verifyHubBannerFade) {
            await assertWinBannerFadeStableAfterVictory(page1, page2, { fadeMs });
        }
    } else if (policy.verifyIframeVictoryOnly) {
        await Promise.all([
            assertIframeVictoryState(page1, opts),
            assertIframeVictoryState(page2, opts)
        ]);
        p1Banner = { text: '', visible: false };
        p2Banner = { text: '', visible: false };
    }

    let winner = opts.victoryWinner
        || resolveWinnerFromBannerText(p1Banner?.text)
        || await page1.evaluate(() => document.getElementById('game-frame')?.contentWindow?.game?.winner || null);

    if (policy.expectAutoReset && !opts.skipAutoReset) {
        const resetMs = opts.resetMs ?? (opts.isMobile ? 8000 : 1500);
        await runScenario('Victory auto-reset', async () => {
            await page1.evaluate(() => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                if (g?.isOver && typeof g.resetGame === 'function') g.resetGame();
            });
            await Promise.all([
                waitForVictoryAutoReset(page1, { resetMs, isMobile: opts.isMobile }),
                waitForVictoryAutoReset(page2, { resetMs, isMobile: opts.isMobile })
            ]);
        });
    }

    return { winner, p1Banner, p2Banner, policy };
}

module.exports = {
    resolveVictoryAuditPolicy,
    assertHubWinBannerVisible,
    assertIframeVictoryState,
    waitForVictoryAutoReset,
    verifySpVictoryOutcome,
    verifyMpVictoryOutcome,
    readHubBanner,
    resolveWinnerFromBannerText
};
