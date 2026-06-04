/**
 * Classic piles — game-specific ready checks (after platform capability audit).
 */
const { STEP_MS } = require('../../../shared/infra/timeouts');
const { evalGame, logStep, waitForGameReady } = require('../../../shared/platform/game-harness');
const { runScenario } = require('../../../shared/platform/scenario-runner');

async function assertClassicPilesReady(page) {
    await runScenario('Classic piles initialized', async () => {
        await waitForGameReady(page, {
            timeout: STEP_MS,
            predicate: 'return g && g.piles && Object.keys(g.piles).length > 0;'
        });
        const pileCount = await evalGame(page, () => Object.keys(window.game.piles).length);
        logStep('Pile count', String(pileCount));
        if (pileCount < 1) throw new Error('No piles on board');
    });
}

async function assertClassicPilesMpSync(page1, page2) {
    const verify = async (page, name) => {
        await waitForGameReady(page, {
            timeout: STEP_MS,
            predicate: 'return g && g.piles && Object.keys(g.piles).length > 0;'
        });
        return evalGame(page, () => {
            const piles = window.game.piles;
            return {
                pileKeys: Object.keys(piles),
                bCount: (piles.B || []).length,
                rCount: (piles.R || []).length,
                gCount: (piles.G || []).length
            };
        });
    };
    const [p1, p2] = await Promise.all([
        verify(page1, 'P1'),
        verify(page2, 'P2')
    ]);
    if (p1.pileKeys.length !== 3 || p2.pileKeys.length !== 3) {
        throw new Error('Unexpected pile count on a client');
    }
    if (p1.bCount !== p2.bCount || p1.rCount !== p2.rCount || p1.gCount !== p2.gCount) {
        throw new Error('Client pile configuration mismatch');
    }
    logStep('MP piles in sync', `P1/P2 keys=[${p1.pileKeys.join(',')}]`);
}

module.exports = {
    assertClassicPilesReady,
    assertClassicPilesMpSync
};
