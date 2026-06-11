/** Review layout capture helpers. */
const { failWithSnapshot } = require('../core/format-failure');
async function captureEndingLayoutFromFrame(frame) {
    return frame.evaluate(() => {
        const g = window.game;
        const uid = g._myUid();
        const tiles = typeof g._captureEndingLayoutForUid === 'function'
            ? g._captureEndingLayoutForUid(uid)
            : (g.tiles || []).map((t) => ({
                id: t.id,
                letter: t.letter,
                x: Math.round(t.x),
                y: Math.round(t.y)
            }));
        return {
            uid,
            color: g.roomData?.playerData?.[uid]?.color || null,
            tiles
        };
    });
}

/** Apply crossword positions to guest local layout (simulates real play after host inventory bump). */

async function syncGuestLocalLayoutFromFixture(frame, tiles) {
    await frame.evaluate((fixtureTiles) => {
        const g = window.game;
        const layout = {};
        fixtureTiles.forEach((t) => {
            layout[t.id] = { x: t.x, y: t.y };
        });
        g._saveLocalLayout(layout);
        (g.tiles || []).forEach((t) => {
            const p = layout[t.id];
            if (p) {
                t.x = p.x;
                t.y = p.y;
                t.faceUp = true;
            }
        });
        g._persistMpLayout();
        g.requestRender?.();
    }, tiles);
}

/**
 * After review: every original tile id present with matching letter + relative layout (±2px).
 */

async function capturePreReviewBoardsByPlayer(frames) {
    const byUid = {};
    for (const frame of frames) {
        const snap = await captureEndingLayoutFromFrame(frame);
        if (!snap?.uid) continue;
        byUid[snap.uid] = { uid: snap.uid, tiles: snap.tiles, color: snap.color };
    }
    return byUid;
}

/** Host-authoritative review layouts from client ending snapshots (pre-win boards). */
async function seedHostReviewLayoutsFromSnapshots(hostFrame, snapsByUid) {
    return hostFrame.evaluate(({ snaps }) => {
        const g = window.game;
        if (!g?.isHost?.()) return { ok: false, reason: 'not-host' };
        if (!g._reviewLayouts) g._reviewLayouts = {};
        const uids = [];
        Object.values(snaps || {}).forEach((snap) => {
            if (!snap?.uid || !snap?.tiles?.length) return;
            g._reviewLayouts[snap.uid] = snap.tiles.map((t) => ({
                id: t.id,
                letter: t.letter,
                x: t.x,
                y: t.y,
                faceUp: t.faceUp !== false
            }));
            uids.push(snap.uid);
        });
        if (typeof g._ensureReviewLayoutsSnapshot === 'function') {
            g._ensureReviewLayoutsSnapshot();
        }
        if (typeof g._hostSyncReviewState === 'function') {
            g._hostSyncReviewState({ processBananaInteractions: false });
        }
        return { ok: true, uids };
    }, { snaps: snapsByUid });
}

/**
 * Validate one review layout in-frame — returns rich diagnostics for runner logs.
 * @param {import('playwright').Frame} frame
 */
async function diagnoseReviewLayoutOnFrame(frame, uid, tileList) {
    return frame.evaluate(({ targetUid, tilesIn }) => {
        const g = window.game;
        if (!g?._checker || typeof BananaGrid === 'undefined') {
            return { uid: targetUid, ok: false, reason: 'missing-game' };
        }
        const resolveLetter = (t) => {
            const layout = String(t.letter || '').toUpperCase();
            const canon = typeof g._mpLetter === 'function' ? g._mpLetter(t.id) : null;
            return (canon || layout || '?').toUpperCase();
        };
        const tiles = (tilesIn || []).map((t) => ({
            id: t.id,
            letter: resolveLetter(t),
            layoutLetter: String(t.letter || '').toUpperCase(),
            x: t.x,
            y: t.y,
            faceUp: true
        }));
        const letterDrifts = tiles
            .filter((t) => t.layoutLetter && t.letter !== t.layoutLetter)
            .slice(0, 12)
            .map((t) => ({ id: t.id, layout: t.layoutLetter, canonical: t.letter }));
        const { tiles: mainTiles, disconnected } = BananaGrid.largestComponentTiles(tiles);
        const mainGrid = mainTiles.length
            ? BananaGrid.validateGrid(mainTiles, g._checker)
            : { ok: false, words: [], reason: 'empty-main' };
        const mainConnected = mainTiles.length >= 6 && BananaGrid.isConnected(mainTiles);
        return {
            uid: targetUid,
            tileCount: tiles.length,
            mainTileCount: mainTiles.length,
            stragglerCount: disconnected,
            connected: mainConnected,
            gridOk: !!mainGrid.ok,
            invalidReason: mainGrid.ok ? null : (mainGrid.reason || null),
            invalidWord: mainGrid.word || null,
            words: (mainGrid.words || []).slice(0, 24),
            letterDrifts,
            sampleMain: mainTiles.slice(0, 10).map((t) => ({
                id: t.id,
                letter: t.letter,
                x: t.x,
                y: t.y
            }))
        };
    }, { targetUid: uid, tilesIn: tileList });
}

module.exports = {
    captureEndingLayoutFromFrame,
    syncGuestLocalLayoutFromFixture,
    capturePreReviewBoardsByPlayer,
    seedHostReviewLayoutsFromSnapshots,
    diagnoseReviewLayoutOnFrame
};
