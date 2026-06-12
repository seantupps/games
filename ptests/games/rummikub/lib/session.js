/**
 * Rummikub SP session helpers — no seeded puzzles; use whatever the game generated.
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { getGameFrame, waitForGameReady } = require('../../../shared/adapters/desktop-input');

const EXPECTED_TILES = 54;

async function waitForRummikubReady(page, opts = {}) {
    const timeout = opts.timeout ?? STEP_MS;
    await waitForGameReady(page, {
        timeout,
        predicate: `return g && g.started && g.tiles && g.tiles.length === ${EXPECTED_TILES}
            && (typeof g.isAuditReady === 'function' ? g.isAuditReady() : true);`
    });
    return getGameFrame(page);
}

module.exports = {
    EXPECTED_TILES,
    waitForRummikubReady
};
