const { runMultiplayerAudit } = require('../../shared/infra/multiplayer_base');
const { buildMpBeforeLoop } = require('../../shared/platform/capability-audit');
const { assertLineColorConsistency } = require('../../shared/platform/mp-scenarios');
const { MP_BOARD_SYNC_MS } = require('../../platform/mobile/lib/mobile-constants');
const { waitForOpponentPreviewLine } = require('../../platform/mobile/lib/mobile-waits');
const {
    assertLineDragTracksPointer,
    sustainLineDragPreview,
    finishLineDragInIframe
} = require('../../platform/mobile/lib/line-drag-utils');
const { assertGameBoardFitsViewport } = require('../../platform/mobile/lib/mobile_assertions');

async function lineMobileDrag(page1, page2, ctx) {
    const syncMs = MP_BOARD_SYNC_MS;
    await Promise.all([
        page1.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.nodes?.length > 0;
        }, { timeout: syncMs }),
        page2.waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.nodes?.length > 0;
        }, { timeout: syncMs })
    ]);
    await page1.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && g.playerRole === 'P1' && g.turn === 'P1' && g.isMyTurn();
    }, { timeout: syncMs });
    await assertGameBoardFitsViewport(page1, { ms: syncMs });
    await assertGameBoardFitsViewport(page2, { ms: syncMs });
    await assertLineDragTracksPointer(page1, '1', '5', 8, { release: false, ms: syncMs });
    await sustainLineDragPreview(page1, '1', '5');
    await waitForOpponentPreviewLine(page2, syncMs);
    await finishLineDragInIframe(page1, '5');
    await page2.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && g.path && g.path.length > 0;
    }, { timeout: syncMs });
}

const beforeLoop = buildMpBeforeLoop('line', {
    gameMode: 'classic',
    extra: [assertLineColorConsistency]
});

const config = {
    beforeLoop,
    gameMode: 'classic',
    initialMoveCount: 1
};

if (require.main === module) {
    runMultiplayerAudit('line', config);
}

module.exports = { ...config, lineMobileDrag, beforeLoop };
