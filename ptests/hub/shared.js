/**
 * Shared hub test helpers and constants.
 */
require('../shared/infra/bootstrap');

const { chromium } = require('playwright');
const { buildAppUrl, isPortOpen, STATIC_HOST, STATIC_PORT } = require('../shared/infra/emulator-utils');
const { HUB_MS } = require('../shared/infra/timeouts');

const TURN_GAP_PX = 1;
const DESKTOP_TURN_INDENT_PX = 0;
const MOBILE_TURN_INDENT_PX = 4;
const LAYOUT_TOLERANCE_PX = 3;
const DESKTOP_SCORE = { top: 32, left: 32, indent: DESKTOP_TURN_INDENT_PX };
const MOBILE_SCORE = { top: 12, left: 12, indent: MOBILE_TURN_INDENT_PX };

async function ensureStackQuick() {
    const up = await isPortOpen(STATIC_HOST, STATIC_PORT);
    if (!up) {
        throw new Error(
            `Static server not on :${STATIC_PORT}. Run: npm run serve (and npm run emulators if needed).`
        );
    }
}

async function openHubLobby(page, username = 'HubTest') {
    page.setDefaultTimeout(HUB_MS);
    page.setDefaultNavigationTimeout(HUB_MS);
    const url = buildAppUrl('lobby', 'P1', 'piles', 'classic');
    await page.goto(url, { waitUntil: 'commit', timeout: HUB_MS });
    await page.waitForSelector('#game-frame', { timeout: HUB_MS });
    await page.evaluate((name) => {
        localStorage.setItem('username', name);
        localStorage.setItem('settingsOpen', 'false');
        localStorage.setItem('game_scoreVisible', 'true');
        document.getElementById('settings-sidebar')?.classList.remove('open');
    }, username);
}

async function launchDesktopBrowser(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    return { context, page };
}

function normalizeHex(color) {
    if (!color) return '';
    const c = color.trim().toLowerCase();
    if (c.startsWith('rgb')) return c;
    return c.length === 4
        ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`
        : c;
}

async function primeTurnIndicator(page) {
    await page.waitForSelector('#game-frame', { timeout: HUB_MS });
    await page.waitForFunction(
        () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g || typeof g.renderScoreboard !== 'function') return false;
            g.roomId = 'SP_HUB_TURN_TEST';
            g.turn = 'P1';
            g.isOver = false;
            g.renderScoreboard();
            g.updateTurnIndicator();
            return true;
        },
        { timeout: HUB_MS }
    );
    await page.waitForFunction(
        () => {
            const el = document.getElementById('global-turn-indicator');
            const text = document.getElementById('turn-text')?.innerText?.trim();
            return el?.classList.contains('visible') && text && text.length > 0;
        },
        { timeout: HUB_MS }
    );
}

async function measureTurnFlagLayout(page, scoreExpect) {
    return page.evaluate(
        ({ scoreTop, scoreLeft, gapPx, indentPx, tol }) => {
            const frame = document.getElementById('game-frame');
            const hubTurn = document.getElementById('global-turn-indicator');
            const win = frame?.contentWindow;
            const sb = win?.document?.querySelector('.scoreboard.show')
                || win?.document?.querySelector('.scoreboard');
            if (!frame || !hubTurn || !sb) {
                return { ok: false, reason: 'missing frame, turn indicator, or scoreboard' };
            }

            const frameBox = frame.getBoundingClientRect();
            const sbBox = sb.getBoundingClientRect();
            const turnBox = hubTurn.getBoundingClientRect();
            const scoreBottom = frameBox.top + sbBox.bottom;
            const gap = turnBox.top - scoreBottom;
            const leftDelta = turnBox.left - (frameBox.left + sbBox.left);
            const scoreTopActual = sbBox.top - frameBox.top;
            const scoreLeftActual = sbBox.left - frameBox.left;

            return {
                ok: sbBox.height >= 8
                    && Math.abs(scoreTopActual - scoreTop) <= tol
                    && Math.abs(scoreLeftActual - scoreLeft) <= tol
                    && Math.abs(leftDelta - indentPx) <= tol
                    && Math.abs(gap - gapPx) <= tol,
                gap,
                leftDelta,
                scoreBottom,
                turnTop: turnBox.top,
                turnLeft: turnBox.left,
                scoreTop: scoreTopActual,
                scoreLeft: scoreLeftActual,
                fiveMobile: document.documentElement.classList.contains('five-mobile')
            };
        },
        {
            scoreTop: scoreExpect.top,
            scoreLeft: scoreExpect.left,
            gapPx: TURN_GAP_PX,
            indentPx: scoreExpect.indent ?? MOBILE_TURN_INDENT_PX,
            tol: LAYOUT_TOLERANCE_PX
        }
    );
}

function assertTurnLayout(label, layout) {
    if (!layout.ok) {
        throw new Error(
            `${label} turn spacing invalid `
            + `(gap≈${TURN_GAP_PX}px): ${JSON.stringify(layout)}`
        );
    }
}

function assertTurnLayoutParity(desktop, mobile) {
    const dg = Math.abs(desktop.gap - mobile.gap);
    if (dg > LAYOUT_TOLERANCE_PX) {
        throw new Error(
            `Desktop/mobile turn gap mismatch: desktop=${JSON.stringify(desktop)} mobile=${JSON.stringify(mobile)}`
        );
    }
}

async function loadHubForTurnCheck(page, expectMobile) {
    const url = buildAppUrl('lobby', 'P1', 'piles', 'classic');
    await page.goto(url, { waitUntil: 'commit', timeout: HUB_MS });
    await page.waitForSelector('#game-frame', { timeout: HUB_MS });
    await page.evaluate(() => {
        localStorage.setItem('username', 'HubTurnLayoutTest');
        localStorage.setItem('settingsOpen', 'false');
        localStorage.setItem('game_scoreVisible', 'true');
        document.getElementById('settings-sidebar')?.classList.remove('open');
    });
    if (expectMobile) {
        await page.waitForFunction(
            () => document.documentElement.classList.contains('five-mobile'),
            { timeout: HUB_MS }
        );
    }
    await primeTurnIndicator(page);
    const layout = await measureTurnFlagLayout(page, expectMobile ? MOBILE_SCORE : DESKTOP_SCORE);
    assertTurnLayout(expectMobile ? 'Mobile' : 'Desktop', layout);
    return layout;
}

async function assertSoloOpponentColorIsAiInvert(page) {
    const c = await page.evaluate(() => {
        function invertHex(hex) {
            const h = hex.replace('#', '');
            const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
            const r = parseInt(full.slice(0, 2), 16);
            const g = parseInt(full.slice(2, 4), 16);
            const b = parseInt(full.slice(4, 6), 16);
            const toHex = (n) => (255 - n).toString(16).padStart(2, '0');
            return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }
        const themeHex = (sessionStorage.getItem('userColor') || '#3b82f6').trim();
        const opp = getComputedStyle(document.documentElement).getPropertyValue('--opponent-color').trim();
        return { themeHex, opp, expected: invertHex(themeHex) };
    });
    const opp = normalizeHex(c.opp);
    const expected = normalizeHex(c.expected);
    if (opp !== expected) {
        throw new Error(`Solo AI color should invert theme: got opp=${opp} expected=${expected} (theme ${c.themeHex})`);
    }
}

/**
 * Run one hub component standalone (CLI) or return result for runner.
 * @param {{ id: string, name: string, run: (browser: import('playwright').Browser) => Promise<void> }} spec
 * @param {{ quiet?: boolean }} [opts]
 */
async function runComponent(spec, opts = {}) {
    const ownsBrowser = !opts.browser;
    if (!opts.browser) await ensureStackQuick();
    const { playwrightHeadless } = require('../shared/infra/env-defaults');
    const browser = opts.browser || await chromium.launch({ headless: playwrightHeadless() });
    const start = Date.now();
    try {
        await spec.run(browser);
        const ms = Date.now() - start;
        if (!opts.quiet) {
            console.log(`\x1b[32mPASS\x1b[0m [${spec.id}] ${spec.name} (${(ms / 1000).toFixed(2)}s)`);
        }
        return { id: spec.id, name: spec.name, ok: true, ms };
    } catch (err) {
        const ms = Date.now() - start;
        if (!opts.quiet) {
            console.error(`\x1b[31mFAIL\x1b[0m [${spec.id}] ${spec.name} (${(ms / 1000).toFixed(2)}s)`);
            console.error(err.message);
            if (err.stack) console.error(err.stack);
        }
        return { id: spec.id, name: spec.name, ok: false, ms, error: err.message };
    } finally {
        if (ownsBrowser) await browser.close().catch(() => {});
    }
}

module.exports = {
    HUB_MS,
    TURN_GAP_PX,
    DESKTOP_TURN_INDENT_PX,
    MOBILE_TURN_INDENT_PX,
    DESKTOP_SCORE,
    MOBILE_SCORE,
    ensureStackQuick,
    openHubLobby,
    launchDesktopBrowser,
    normalizeHex,
    primeTurnIndicator,
    measureTurnFlagLayout,
    assertTurnLayout,
    assertTurnLayoutParity,
    loadHubForTurnCheck,
    assertSoloOpponentColorIsAiInvert,
    runComponent,
    buildAppUrl
};
