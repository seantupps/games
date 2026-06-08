/**
 * join — sequential 3p invite join orders (P2→P3 and P3→P2).
 *
 *   node ptests/run.js mp --game=bananagrams --players=3 --scenario=join
 */
const { defineMpScenario } = require('./contract');
const { joinBananaPartySequentially } = require('../../lib/banana-mp-party');
const { BANANA_3P_PLAYERS } = require('../../lib/mp-ctx');
const { joinReady } = require('../../assertions');
const { assertJoinedPlayersReadyWithVisibility } = joinReady;
const lib = require('../../lib/mp-state');

/** Guest join orders after host (indices into player defs). */
const GUEST_ORDERS = [[1, 2], [2, 1]];

async function runJoinScenario(scenarioCtx) {
    const { ctx, roomId, mobile, options = {} } = scenarioCtx;
    const pages = ctx.pages;
    const playerDefs = ctx.players.length ? ctx.players : BANANA_3P_PLAYERS;
    const orders = options.guestOrders || GUEST_ORDERS;
    const mobilePageIndices = mobile
        ? pages.map((_, i) => i)
        : (options.mobilePageIndices || []);
    const log = options.log || lib.log;

    for (const guestOrder of orders) {
        const orderLabel = guestOrder.map((i) => playerDefs[i].role).join(' then ');
        const orderRoom = orders.length > 1
            ? `${roomId}_${guestOrder.join('')}`
            : roomId;
        log(`Sequential join-order (${orderLabel}) in ${orderRoom}...`);

        await joinBananaPartySequentially(pages, orderRoom, guestOrder, {
            log,
            mobilePageIndices,
            playerDefs,
            waitJoinedPlayersReady: (p, indices, rId, label, opts) =>
                assertJoinedPlayersReadyWithVisibility(p, indices, rId, label, {
                    ...opts,
                    playerDefs,
                    mobilePageIndices
                })
        });

        await pages[0].evaluate(({ rId }) => {
            const db = window.NetworkEngine?.db;
            if (db && rId) db.ref().update({ [`games/${rId}`]: null, [`gameData/${rId}`]: null });
        }, { rId: orderRoom }).catch(() => {});
    }

    log('SUCCESS: All sequential guest join orders passed.');
}

module.exports = defineMpScenario({
    id: 'join',
    kind: 'micro-fixture',
    description: 'Sequential 3p invite join — both guest orders, board visible after each join',
    platforms: ['desktop', 'mobile'],
    playerCounts: [3],
    joinMode: 'sequential',
    requiresFreshRoom: true,
    mutatesAuthority: false,
    assertions: ['mp-join-ready', 'mp-board-visible']
}, runJoinScenario);
