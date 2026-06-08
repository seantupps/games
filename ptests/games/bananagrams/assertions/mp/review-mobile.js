/**
 * Mobile MP post-game review — touch interaction asserts.
 */
const { touchDragTile, touchPanBackground } = require('../../adapters/mobile-touch');

async function assertTilesFrozenOnMobile(frame, label) {
    const snap = await frame.evaluate(() => {
        const g = window.game;
        const tile = g.tiles?.[0];
        if (!tile) return { ok: false, reason: 'no-tiles' };
        const idx = [...document.querySelectorAll('.tile')].findIndex(
            (n) => n.dataset.tileId === tile.id
        );
        return { ok: true, idx, x: tile.x, y: tile.y, id: tile.id };
    });

    if (!snap.ok) throw new Error(`${label}: no tiles to test freeze (${JSON.stringify(snap)})`);

    const drag = await touchDragTile(frame, snap.idx, 72, 56);

    const after = await frame.evaluate(({ id }) => {
        const t = window.game.tiles.find((tile) => tile.id === id);
        return t ? { x: t.x, y: t.y } : null;
    }, { id: snap.id });

    const moved = after && Math.hypot(after.x - snap.x, after.y - snap.y) > 10;

    if (moved || drag.moved) {
        throw new Error(`${label}: tiles must not move after game over (${JSON.stringify({ snap, drag, after })})`);
    }
}

async function assertPanStillWorks(frame, label) {
    const pan = await touchPanBackground(frame);
    if (!pan.ok || pan.dist < 12) {
        throw new Error(`${label}: pan/zoom review should allow background pan (${JSON.stringify(pan)})`);
    }
}

module.exports = {
    assertTilesFrozenOnMobile,
    assertPanStillWorks
};
