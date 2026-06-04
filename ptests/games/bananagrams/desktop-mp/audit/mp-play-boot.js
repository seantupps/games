/**
 * Shared MP session boot — same path real players take after joining a room.
 * Mirrors run-audit.js through SPLIT (deal, face-down rack, pool HUD, host drag to start).
 */
const lib = require('../../lib/mp-lib');

const {
    log,
    WAIT_MS,
    waitForDeal,
    assertStartingRackConnected,
    waitPoolBoth,
    getHandAndPool,
    getGameFrame,
    enableFastBanners,
    splitViaDrag,
    waitForDiag
} = lib;

/**
 * @param {import('playwright').Page} page1 host
 * @param {import('playwright').Page} page2 guest
 * @param {{ mobile?: boolean }} [options]
 */
async function bootMpPlaySession(page1, page2, options = {}) {
    const mobile = !!options.mobile;
    const mp = { page1, page2 };

    log('Deal: tiles dealt per player, dictionary loaded...');
    await waitForDeal(page1, 'P1', mp);
    await waitForDeal(page2, 'P2', mp);
    await Promise.all([
        assertStartingRackConnected(page1, 'host deal', mp),
        assertStartingRackConnected(page2, 'guest deal', mp)
    ]);

    const dealInfo = await getHandAndPool(page1);
    const poolAfterDeal = dealInfo.poolAfterDeal;
    log('SUCCESS: Deal — tiles dealt per player (2-player MP).');

    const faceDown = await page1.evaluate(() => {
        const doc = document.getElementById('game-frame').contentDocument;
        const tiles = [...doc.querySelectorAll('.tile')];
        return tiles.length > 0 && tiles.every((t) => t.classList.contains('is-face-down'));
    });
    if (!faceDown) throw new Error('Tiles should start face-down before SPLIT');

    log('Pool HUD shows shared bunch remainder...');
    await waitPoolBoth(page1, page2, poolAfterDeal);

    log('SPLIT: host drag starts game; guest syncs face-up + timer...');
    let frame1 = await getGameFrame(page1);
    let frame2 = await getGameFrame(page2);
    await Promise.all([enableFastBanners(frame1), enableFastBanners(frame2)]);
    const splitHost = await splitViaDrag(frame1, { mobile });
    if (!splitHost.ok || !splitHost.hasTimer) {
        throw new Error(`Host SPLIT failed (${JSON.stringify(splitHost)})`);
    }

    await Promise.all([
        waitForDiag(page1, 'SPLIT host started', () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            return g?.gameStarted && !!doc?.getElementById('banana-timer');
        }, undefined, WAIT_MS, mp),
        waitForDiag(page2, 'SPLIT guest started', () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.gameStarted;
        }, undefined, WAIT_MS, mp)
    ]);

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
    log('SUCCESS: SPLIT synced (timer on, no turns).');

    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);
    const { centerMpViewerOnPages } = require('../../../../shared/platform/mp-headed-view');
    await centerMpViewerOnPages([page1, page2]);
    return { frame1, frame2, mp, poolAfterDeal, mobile };
}

module.exports = { bootMpPlaySession };
