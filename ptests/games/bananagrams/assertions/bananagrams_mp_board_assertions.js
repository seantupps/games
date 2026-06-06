/**
 * Shared MP board invariants — pool sync, convergence, peel accounting.
 */

const HOST_UID = 'u_banana_host';
const GUEST_UID = 'u_banana_guest';

/**
 * @param {import('playwright').Page} page
 * @param {number} playerIdx 1=host frame eval context label
 */
async function readMpBoardHealthState(page, playerIdx, { hostUid = HOST_UID, guestUid = GUEST_UID } = {}) {
    return page.evaluate(({ hostUid: hUid, guestUid: gUid, player }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const activeUids = board?.playerUids || [];
        const owned = board?.tilesOwnedByPlayer || board?.hands || {};
        return {
            player,
            localPool: g?._tilePool?.length ?? -1,
            boardPool: Array.isArray(board?.pool) ? board.pool.length : -1,
            boardSeq: board?.seq ?? null,
            peelSeq: board?.peelSeq ?? null,
            dumpSeq: board?.dumpSeq ?? null,
            phase: board?.phase ?? null,
            activeUids,
            hostOwned: Array.isArray(owned?.[hUid]) ? owned[hUid].length : 0,
            guestOwned: Array.isArray(owned?.[gUid]) ? owned[gUid].length : 0,
            hostLocalTiles: g?._myUid?.() === hUid ? (g.tiles?.length ?? 0) : null,
            guestLocalTiles: g?._myUid?.() === gUid ? (g.tiles?.length ?? 0) : null
        };
    }, { hostUid, guestUid, player: playerIdx });
}

/**
 * Pool + board seq synced on both clients.
 * @param {import('playwright').Page} page1
 * @param {import('playwright').Page} page2
 */
async function assertPoolSynced(page1, page2, label, opts = {}) {
    const { hostUid = HOST_UID, guestUid = GUEST_UID, expectedPool = null } = opts;
    const states = await Promise.all([
        readMpBoardHealthState(page1, 1, { hostUid, guestUid }),
        readMpBoardHealthState(page2, 2, { hostUid, guestUid })
    ]);
    const [s1, s2] = states;
    if (s1.localPool !== s2.localPool || s1.boardPool !== s2.boardPool || s1.boardSeq !== s2.boardSeq) {
        throw new Error(`${label} pool/seq mismatch (${JSON.stringify(states)})`);
    }
    if (expectedPool != null && (s1.localPool !== expectedPool || s1.boardPool !== expectedPool)) {
        throw new Error(`${label} expected pool=${expectedPool}, got ${JSON.stringify(states)}`);
    }
    return states;
}

/**
 * Pool sync + owned counts + active players.
 */
async function assertBoardStatesHealthy(page1, page2, label, opts = {}) {
    const states = await assertPoolSynced(page1, page2, label, opts);
    const [s1, s2] = states;
    const { hostUid = HOST_UID, guestUid = GUEST_UID } = opts;
    const guestVisibleLocally = (s2.guestLocalTiles ?? 0) > 0;
    if (s1.hostOwned <= 0 || (!guestVisibleLocally && s1.guestOwned <= 0)) {
        throw new Error(`${label} missing owned/local tiles for a player (${JSON.stringify(states)})`);
    }
    if (!s1.activeUids.includes(hostUid) || !s1.activeUids.includes(guestUid)) {
        throw new Error(`${label} board missing active players (${JSON.stringify(states)})`);
    }
}

/**
 * @param {import('playwright').Page} page
 */
async function captureActionState(page, client, action, opts = {}) {
    const { hostUid = HOST_UID, guestUid = GUEST_UID } = opts;
    return page.evaluate(({ c, a, hostUid: hUid, guestUid: gUid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const doc = document.getElementById('game-frame')?.contentDocument;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const me = g?._myUid?.() || null;
        const owned = board?.tilesOwnedByPlayer || board?.hands || {};
        const boardPos = board?.tilePositionsByPlayer || {};
        const boardTileIds = Object.values(boardPos)
            .flat()
            .map((p) => p?.id)
            .filter(Boolean)
            .sort();
        const handIds = (g?.tiles || []).map((t) => t.id);
        const banner = doc?.getElementById('banana-banner');
        const doneBtn = doc?.querySelector('button#done-button,[data-action="done"],.done-button');
        return {
            client: c,
            uid: me,
            action: a,
            handIds,
            boardTileIds,
            pileCount: g?._tilePool?.length ?? -1,
            boardPileCount: Array.isArray(board?.pool) ? board.pool.length : -1,
            ownedCountsByUid: {
                [hUid]: Array.isArray(owned?.[hUid]) ? owned[hUid].length : 0,
                [gUid]: Array.isArray(owned?.[gUid]) ? owned[gUid].length : 0
            },
            boardSeq: board?.seq ?? null,
            inventorySeq: g?._localInventorySeq ?? null,
            boardInventorySeq: board?.inventorySeq?.[me || ''] ?? null,
            peelSeq: board?.peelSeq ?? 0,
            dumpSeq: board?.dumpSeq ?? 0,
            bannerVisible: !!(banner && banner.classList.contains('is-visible')),
            bannerText: banner?.textContent?.trim() || '',
            winner: g?._winnerUid ?? board?.winnerUid ?? null,
            isOver: !!g?.isOver,
            reviewPhase: board?.phase ?? null,
            doneVisible: !!(doneBtn && doneBtn.offsetParent !== null)
        };
    }, { c: client, a: action, hostUid, guestUid });
}

async function captureActionPair(page1, page2, action, opts = {}) {
    const [host, guest] = await Promise.all([
        captureActionState(page1, 'host', action, opts),
        captureActionState(page2, 'guest', action, opts)
    ]);
    return { action, host, guest };
}

function assertConverged(pair, label, opts = {}) {
    const { hostUid = HOST_UID, guestUid = GUEST_UID } = opts;
    const { host, guest } = pair;
    const problems = [];
    if (host.boardSeq !== guest.boardSeq) problems.push('boardSeq mismatch');
    if (host.pileCount !== guest.pileCount) problems.push('local pile mismatch');
    if (host.boardPileCount !== guest.boardPileCount) problems.push('board pile mismatch');
    if (host.ownedCountsByUid[hostUid] !== guest.ownedCountsByUid[hostUid]) problems.push('host owned mismatch');
    if (host.ownedCountsByUid[guestUid] !== guest.ownedCountsByUid[guestUid]) problems.push('guest owned mismatch');
    if (host.reviewPhase !== guest.reviewPhase) problems.push('phase mismatch');
    if (host.winner !== guest.winner) problems.push('winner mismatch');
    if (problems.length) {
        throw new Error(`${label} divergence: ${problems.join(', ')}\n${JSON.stringify(pair, null, 2)}`);
    }
}

function assertPeelAccounting(beforePair, afterPair, label, opts = {}) {
    const { hostUid = HOST_UID, guestUid = GUEST_UID } = opts;
    const beforeHostOwned = beforePair.host.ownedCountsByUid?.[hostUid] ?? 0;
    const beforeGuestOwned = beforePair.host.ownedCountsByUid?.[guestUid] ?? 0;
    const afterHostOwned = afterPair.host.ownedCountsByUid?.[hostUid] ?? 0;
    const afterGuestOwned = afterPair.host.ownedCountsByUid?.[guestUid] ?? 0;
    const deltaHost = afterHostOwned - beforeHostOwned;
    const deltaGuest = afterGuestOwned - beforeGuestOwned;
    const poolDelta = (afterPair.host.pileCount ?? -1) - (beforePair.host.pileCount ?? -1);
    if (deltaHost !== 1 || deltaGuest !== 1 || poolDelta !== -2) {
        throw new Error(`${label} peel accounting mismatch: expected host+1 guest+1 pool-2, got host${deltaHost >= 0 ? '+' : ''}${deltaHost} guest${deltaGuest >= 0 ? '+' : ''}${deltaGuest} pool${poolDelta}\n${JSON.stringify({
            before: beforePair,
            after: afterPair
        }, null, 2)}`);
    }
}

module.exports = {
    HOST_UID,
    GUEST_UID,
    readMpBoardHealthState,
    assertPoolSynced,
    assertBoardStatesHealthy,
    captureActionState,
    captureActionPair,
    assertConverged,
    assertPeelAccounting
};
