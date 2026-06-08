/**
 * MP join readiness assertions — deal sync + board visibility after sequential join.
 */
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const { waitJoinedPlayersReady } = require('../../lib/mp-join');
const { assertBoardVisible, logVisAlways } = require('./visibility');
const { waitForDiag } = require('../../../../shared/platform/mp-waits');

const WAIT_MS = Math.min(STEP_MS, 3000);

function mpPages(pages) {
    return pages?.length ? { pages } : null;
}

/**
 * Host-only wait before second guest joins (1 player in room).
 */
async function assertHostOnlyReady(hostPage, pages, label) {
    await waitForDiag(hostPage, `${label}: host iframe ready`, () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.isMultiplayer && g?.mode === 'multiplayer' && g?._dictReady && g?._checker;
    }, undefined, WAIT_MS, mpPages(pages));
}

/**
 * @param {import('playwright').Page[]} pages
 * @param {number[]} playerIndices
 * @param {string} roomId
 * @param {string} label
 * @param {object} opts
 * @param {{ uid: string, role: string, name?: string }[]} opts.playerDefs
 * @param {number[]} [opts.mobilePageIndices]
 */
async function assertJoinedPlayersReadyWithVisibility(pages, playerIndices, roomId, label, opts = {}) {
    const playerDefs = opts.playerDefs || [];
    const snapPages = mpPages(pages);

    if (playerIndices.length < 2) {
        await assertHostOnlyReady(pages[0], pages, label);
        return;
    }

    await waitJoinedPlayersReady(pages, playerIndices, roomId, label, {
        ...opts,
        playerDefs
    });

    for (const idx of playerIndices) {
        const player = playerDefs[idx];
        const page = pages[idx];
        if (opts.mobilePageIndices?.includes(idx)) {
            const { enableMobileHub } = require('../../../../platform/mobile/lib/mobile_assertions');
            await enableMobileHub(page);
            await page.evaluate(() => window.FiveViewport?.syncHubViewport?.());
        }
        const isMobilePlayer = !!(opts.mobilePageIndices && opts.mobilePageIndices.includes(idx));
        const visTimeout = isMobilePlayer ? 15000 : WAIT_MS;
        logVisAlways(
            `${label}: assertBoardVisible ${player.role} idx=${idx} mobile=${isMobilePlayer}`
        );
        await assertBoardVisible(page, `${label}: ${player.role} board visible`, visTimeout, {
            role: player.role,
            playerIndex: idx,
            isMobilePlayer
        });
    }
}

module.exports = {
    assertHostOnlyReady,
    assertJoinedPlayersReadyWithVisibility
};
