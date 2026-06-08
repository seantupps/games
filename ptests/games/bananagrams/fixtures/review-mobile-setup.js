/**
 * Mobile MP post-game review — board fixture setup.
 */
const { PEEL_CROSSWORD_Y0 } = require('./review-state');
const { review } = require('../assertions');
const { syncGuestLocalLayoutFromFixture } = review;
/** Six tiles per player — vertical WORD + AT branch (valid crossword shape). */
function multiBoardTiles(originX, originY, prefix) {
    const gap = 40;
    const y0 = PEEL_CROSSWORD_Y0 + originY;
    return [
        { id: `${prefix}-w`, letter: 'W', x: originX, y: y0 },
        { id: `${prefix}-o`, letter: 'O', x: originX, y: y0 + gap },
        { id: `${prefix}-r`, letter: 'R', x: originX, y: y0 + gap * 2 },
        { id: `${prefix}-d`, letter: 'D', x: originX, y: y0 + gap * 3 },
        { id: `${prefix}-a`, letter: 'A', x: originX + gap, y: y0 + gap * 2 },
        { id: `${prefix}-t`, letter: 'T', x: originX + gap * 2, y: y0 + gap * 2 }
    ];
}

async function applyEndingSnapshotsForReview(frames, players, snapshots) {
    const hostFrame = frames[0];
    const layouts = players.map((p) => ({
        uid: p.uid,
        tiles: snapshots[p.uid]?.tiles || []
    }));
    const setup = await hostFrame.evaluate(({ playerLayouts }) => {
        const g = window.game;
        if (!g?.isHost?.()) return { ok: false, reason: 'not-host' };
        for (const { uid, tiles } of playerLayouts) {
            if (!tiles.length) return { ok: false, reason: 'empty-snapshot', uid };
            g._hostSetPlayerTiles(uid, tiles.map((t) => ({
                id: t.id,
                letter: t.letter,
                faceUp: true,
                x: t.x,
                y: t.y
            })), true, { allowTilesToOwned: true });
        }
        g._hostSyncBoard?.();
        return { ok: true };
    }, { playerLayouts: layouts });
    if (!setup.ok) throw new Error(`Snapshot board setup failed (${JSON.stringify(setup)})`);

    await Promise.all(frames.map((frame, i) => {
        const tiles = layouts[i]?.tiles || snapshots[players[i].uid]?.tiles || [];
        return syncGuestLocalLayoutFromFixture(frame, tiles);
    }));
    return layouts;
}

async function setupPlayerCrosswords(hostFrame, players) {
    return hostFrame.evaluate(({ layouts }) => {
        const g = window.game;
        if (!g?.isHost?.()) return { ok: false, reason: 'not-host' };
        layouts.forEach(({ uid, tiles }) => {
            g._hostSetPlayerTiles(uid, tiles.map((t) => ({
                id: t.id,
                letter: t.letter,
                faceUp: true
            })), true, { allowTilesToOwned: true });
        });
        g._hostSyncBoard();
        return { ok: true };
    }, {
        layouts: players.map((p) => ({
            uid: p.uid,
            tiles: multiBoardTiles(p.originX, p.originY, p.prefix || p.uid.slice(-2))
        }))
    });
}

async function triggerHostWin(hostFrame) {
    return hostFrame.evaluate(() => {
        const g = window.game;
        const uid = g._myUid();
        const params = new URLSearchParams(window.location.search);
        if (params.get('room')) g.roomId = params.get('room');
        g.mode = 'multiplayer';
        g.isMultiplayer = !!g.roomId && g.roomId !== 'lobby';
        if (typeof g._reconcileMpMode === 'function') g._reconcileMpMode();

        g._victoryRegistered = false;
        g._postGameReview = false;
        g._tilePool = [];

        const uids = g._getPlayerUids();
        uids.forEach((id) => {
            if (g._mpScores[id] == null) g._mpScores[id] = 0;
        });

        g._finishVictory(uid);

        if (!g._winnerUid && uid) {
            g._winnerUid = uid;
            g.isOver = true;
            if (!g._postGameReview && g.isHost?.()) {
                g._enterPostGameReview(uid);
            }
        }

        const board = g.roomData?.global?.board || g.roomData?.state?.board;
        return {
            banner: g._bannerText,
            winner: g._winnerUid,
            boardWinner: board?.winnerUid,
            phase: board?.phase,
            reviewPhase: board?.reviewPhase,
            hostTiles: g.tiles.length,
            mp: g._isMultiplayerMode?.(),
            isHost: g.isHost?.()
        };
    });
}

module.exports = {
    multiBoardTiles,
    setupPlayerCrosswords,
    applyEndingSnapshotsForReview,
    triggerHostWin
};
