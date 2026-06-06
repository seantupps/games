/**
 * B. MP micro sync invariant audit — host-authoritative 4-tile fixtures (both platforms).
 *
 * Synthetic layouts are allowed; authority violations (guest teleport, asymmetric owned) are not.
 * Covers: disconnected stragglers on host peel + peel spawn timing only.
 * Pool drain (last-bunch) lives in --scenario=review. Run via --scenario=sync.
 */
const lib = require('../../lib/mp-lib');
const { bootMpPlaySession } = require('../../desktop-mp/audit/mp-play-boot');
const { getGameFrame } = lib;
const { patchMpThreeLetterChecker } = require('../../lib/mp-micro-fixture');
const {
    assertHostPeelGuestDisconnectedTilesStable
} = require('../../assertions/bananagrams_mp_host_peel_guest_disconnected_assertions');
const { runMpPeelSpawnScenario } = require('./peel');

/**
 * @param {import('playwright').Page} page1
 * @param {import('playwright').Page} page2
 * @param {object} opts
 */
async function runMpSyncInvariantAudit(page1, page2, opts = {}) {
    const {
        mobile = false,
        log = lib.log,
        mp: mpIn = null
    } = opts;
    const mp = mpIn || { page1, page2 };

    log('MP sync invariants: host-authoritative micro fixtures (4-tile symmetric)...');

    const boot = await bootMpPlaySession(page1, page2, { mobile });
    let frame1 = boot.frame1;
    let frame2 = boot.frame2;

    await patchMpThreeLetterChecker([frame1, frame2]);

    log('MP sync: guest disconnected stragglers stable when host peels...');
    await assertHostPeelGuestDisconnectedTilesStable({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        log
    });

    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);

    log('MP sync: peel spawn visible at same time on host + guest...');
    await runMpPeelSpawnScenario({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        log,
        microFixture: true
    });

    log('SUCCESS: MP sync invariant audit passed.');
}

module.exports = {
    runMpSyncInvariantAudit
};
