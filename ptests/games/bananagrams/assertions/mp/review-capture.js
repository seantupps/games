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

/**
 * Grid-cell check for connected boards: each occupied cell keeps the same tile id + letter in review.
 * Catches letter scrambles that leave tiles on the same connected layout.
 */

module.exports = { captureEndingLayoutFromFrame, syncGuestLocalLayoutFromFixture, capturePreReviewBoardsByPlayer };
