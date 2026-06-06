/**
 * MP peel scenario — spawn sync timing (host + guest peel) on both platforms.
 */
const { getGameFrame } = require('../../../../shared/platform/mp-waits');
const { runMpPeelSpawnSyncAudit } = require('../../lib/mp-peel-spawn-sync');

/**
 * @param {object} opts
 * @param {import('playwright').Page} opts.page1
 * @param {import('playwright').Page} opts.page2
 * @param {import('playwright').Frame} [opts.frame1]
 * @param {import('playwright').Frame} [opts.frame2]
 * @param {object} opts.mp
 * @param {boolean} [opts.mobile]
 * @param {Function} [opts.log]
 */
async function runMpPeelSpawnScenario(opts) {
    const {
        page1,
        page2,
        frame1: frame1In,
        frame2: frame2In,
        mp,
        mobile = false,
        microFixture = false,
        log = (msg) => console.log(`[TEST] ${msg}`)
    } = opts;

    const frame1 = frame1In || await getGameFrame(page1);
    const frame2 = frame2In || await getGameFrame(page2);

    log('MP peel spawn visible at same time on host + guest...');
    await runMpPeelSpawnSyncAudit({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        microFixture,
        log
    });

    if (mobile && process.env.FIVE_MP_MOBILE_TILE_STABILITY === '1') {
        const { runBananagramsMpMobilePeelDumpTileStability } = require('../../mobile/bananagrams_mobile_peel_dump_stability');
        await runBananagramsMpMobilePeelDumpTileStability({
            page1,
            page2,
            frame1,
            frame2,
            mp,
            log
        });
    } else if (mobile) {
        log('MP mobile: skip peel/dump tile stability (set FIVE_MP_MOBILE_TILE_STABILITY=1 to enable).');
    }

    return { frame1, frame2 };
}

module.exports = {
    runMpPeelSpawnScenario
};
