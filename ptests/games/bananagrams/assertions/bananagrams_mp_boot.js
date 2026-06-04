/**
 * Shared MP room boot for spawn/audit tests (uses games/bananagrams/lib/mp-lib).
 */
const lib = require('../lib/mp-lib');

const HOST_UID = lib.HOST_UID;
const GUEST_UID = lib.GUEST_UID;

/**
 * Seed room, join guest, wait for deal, assert rack does not switch again.
 * @param {import('playwright').Page} page1
 * @param {import('playwright').Page} page2
 * @param {{ roomId: string, mobile?: boolean }} ctx
 */
async function bootMpBananaRoom(page1, page2, ctx) {
    const roomId = ctx.roomId;
    const mp = { page1, page2 };
    const mobile = !!ctx.isMobile;
    lib.log(`Bananagrams MP spawn setup in room ${roomId}${mobile ? ' (mobile)' : ''}...`);
    lib.log('Deal: tiles dealt per player, dictionary loaded...');
    await lib.seedBananaRoom(page1, roomId);
    await lib.joinGuest(page2, roomId);
    await lib.waitForDeal(page1, 'P1', mp);
    await lib.waitForDeal(page2, 'P2', mp);
    await lib.assertDealStable(page1, 'P1', { mpPages: mp });
    await lib.assertDealStable(page2, 'P2', { mpPages: mp });
    lib.log('SUCCESS: Deal stable — starting rack did not reshuffle.');
    return { roomId, mp, HOST_UID, GUEST_UID };
}

module.exports = {
    HOST_UID,
    GUEST_UID,
    bootMpBananaRoom,
    ...lib
};
