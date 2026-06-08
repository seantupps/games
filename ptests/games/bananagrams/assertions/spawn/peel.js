const { failWithSnapshot } = require('../core/format-failure');
const { evalSpawnTilesVisibility } = require('./spawn-visibility');

/** Peel spawn — world bounds + on-screen visibility inside #game-container. */

/** @param {import('playwright').Frame} frame */
async function evalPeelTileVisibility(frame, beforeIds, label, mobile = false) {
    return evalSpawnTilesVisibility(frame, {
        beforeIds,
        expectedCount: 1,
        label,
        mobile,
        mode: 'peel'
    });
}

/**
 * Peel tile must be in spawn viewport (world) and visible on screen.
 * @param {import('playwright').Frame} frame
 */
async function assertPeelSpawnInViewport(frame, beforeIds, label, options = {}) {
    const vis = await evalPeelTileVisibility(frame, beforeIds, label, !!options.mobile);
    if (!vis.ok) {
        failWithSnapshot(label, ['peel not in player view'], { vis });
    }
    return vis;
}

/**
 * Host and guest peel draws must both land in each player's visible viewport.
 */
async function assertPeelViewportBothPlayers(hostFrame, guestFrame, hostBeforeIds, guestBeforeIds, label, options = {}) {
    const mobile = !!options.mobile;
    await assertPeelSpawnInViewport(hostFrame, hostBeforeIds, `${label} (host)`, { mobile });
    await assertPeelSpawnInViewport(guestFrame, guestBeforeIds, `${label} (guest)`, { mobile });
}

module.exports = {
    evalPeelTileVisibility,
    assertPeelSpawnInViewport,
    assertPeelViewportBothPlayers
};
