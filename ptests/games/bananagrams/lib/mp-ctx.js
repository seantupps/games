/**
 * Topology-agnostic MP session context — single player model for 2p/3p/4p.
 *
 * Assertions loop ctx.players / ctx.remotes; runners build ctx; scenarios pass it through.
 */

/** Legacy 2p audit UIDs (invite flow + desktop MP suite). */
const BANANA_2P_PLAYERS = [
    { uid: 'u_banana_host', name: 'BananaHost', color: '#3b82f6', role: 'P1' },
    { uid: 'u_banana_guest', name: 'BananaGuest', color: '#ef4444', role: 'P2' }
];

const HOST_UID = BANANA_2P_PLAYERS[0].uid;
const GUEST_UID = BANANA_2P_PLAYERS[1].uid;

/** MP bag: Scrabble (100) for 2p; official TILE_BAG (144) for 3p+. */
const BAG_BY_PLAYER_COUNT = {
    2: 100,
    3: 144,
    4: 144
};

const STARTING_HAND = 21;

/**
 * @param {number} playerCount
 * @returns {{ total: number, expectedPoolAfterDeal: number, startingHand: number }}
 */
function bagForPlayerCount(playerCount) {
    const n = Math.max(2, playerCount);
    const total = BAG_BY_PLAYER_COUNT[n] || BAG_BY_PLAYER_COUNT[2];
    return {
        total,
        startingHand: STARTING_HAND,
        expectedPoolAfterDeal: total - n * STARTING_HAND
    };
}

/**
 * @param {typeof BANANA_2P_PLAYERS[0][]} defs
 * @param {import('playwright').Page[]} pages
 * @param {object} [opts]
 * @returns {import('../scenarios/mp/contract').MpCtx}
 */
function buildMpCtx(defs, pages, opts = {}) {
    if (!defs?.length || defs.length !== pages.length) {
        throw new Error(`buildMpCtx: need matching defs (${defs?.length}) and pages (${pages?.length})`);
    }
    const bag = bagForPlayerCount(defs.length);
    const topology = `${defs.length}p`;
    const players = defs.map((def, index) => ({
        ...def,
        index,
        page: pages[index],
        frame: opts.frames?.[index] || null
    }));
    const host = players[0];
    const remotes = players.slice(1);
    /** @deprecated use remotes */
    const guests = remotes;

    return {
        topology,
        playerCount: players.length,
        host,
        players,
        remotes,
        guests,
        pages,
        frames: opts.frames || [],
        roomId: opts.roomId || null,
        mobile: !!opts.mobile,
        bag,
        mp: { pages, page1: pages[0], page2: pages[1] || pages[0] },
        uids: players.map((p) => p.uid),
        options: opts.options || {}
    };
}

/** @param {import('playwright').Page} page1 @param {import('playwright').Page} page2 @param {object} [opts] */
function buildMpCtx2p(page1, page2, opts = {}) {
    return buildMpCtx(BANANA_2P_PLAYERS, [page1, page2], opts);
}

/**
 * @param {import('playwright').Page[]} pages
 * @param {typeof BANANA_2P_PLAYERS[0][]} [defs]
 * @param {object} [opts]
 */
function buildMpCtxFromPages(pages, defs, opts = {}) {
    const { BANANA_3P_PLAYERS } = require('../../../shared/infra/scenarios/mp-3p-banana-party');
    const playerDefs = defs || (pages.length === 3 ? BANANA_3P_PLAYERS : BANANA_2P_PLAYERS.slice(0, pages.length));
    if (playerDefs.length !== pages.length) {
        throw new Error(`buildMpCtxFromPages: ${playerDefs.length} defs for ${pages.length} pages`);
    }
    return buildMpCtx(playerDefs, pages, opts);
}

/** @param {import('../scenarios/mp/contract').MpCtx} ctx */
function mpCtxFromLegacy(page1, page2, opts = {}) {
    return buildMpCtx2p(page1, page2, opts);
}

/** @param {import('../scenarios/mp/contract').MpCtx} ctx @returns {string[]} */
function playerUids(ctx) {
    return ctx.players.map((p) => p.uid);
}

module.exports = {
    BANANA_2P_PLAYERS,
    HOST_UID,
    GUEST_UID,
    BAG_BY_PLAYER_COUNT,
    STARTING_HAND,
    bagForPlayerCount,
    buildMpCtx,
    buildMpCtx2p,
    buildMpCtxFromPages,
    mpCtxFromLegacy,
    playerUids
};
