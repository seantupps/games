/**
 * ctx-proof — micro scenario proving MpCtx assertions on 2p and 3p.
 *
 *   node ptests/run.js mp --game=bananagrams --scenario=ctx-proof
 *   node ptests/run.js mp --game=bananagrams --players=3 --scenario=ctx-proof
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { bootMpPlaySessionN } = require('../../lib/mp-session-boot');
const { setupHostPeelGrid } = require('../../fixtures/peel-grid');
const { seedBananaParty } = require('./seed-party');
const { sync, accounting, authority, core } = require('../../assertions');
const { readBoardField } = core;

async function runCtxProofScenario(scenarioCtx) {
    const { ctx, mobile } = scenarioCtx;
    const { WAIT_MS, waitForDiag, flushHostBananaInteractions } = lib;
    const log = lib.log;

    await seedBananaParty(scenarioCtx, { dealLabel: 'ctx-proof host deal' });

    log(`ctx-proof: boot ${ctx.playerCount}p session...`);
    const { frames } = await bootMpPlaySessionN(ctx, { mobile });
    ctx.frames = frames;

    log('ctx-proof: pool synced on all clients...');
    await sync.assertAllPlayersPoolSynced(ctx, 'ctx-proof pool');

    log('ctx-proof: host peel grid + ctx snapshot asserts...');
    const hostFrame = frames[0];
    await flushHostBananaInteractions(ctx.host.page);
    await setupHostPeelGrid(hostFrame);
    await flushHostBananaInteractions(ctx.host.page);
    await sync.waitAllPlayersBoardSynced(ctx, 'ctx-proof pre-peel grid');
    await sync.assertAllPlayersPoolSynced(ctx, 'ctx-proof pre-peel grid', { skipExpectedPool: true });

    const beforePeel = await core.capture.capturePlayerStates(ctx, 'ctx-proof-before-peel');
    const peelSeqBefore = await readBoardField(ctx.host.page, 'peelSeq');
    const expectedPoolAfter = beforePeel.host.boardPileCount - ctx.playerCount;

    const peelRes = await hostFrame.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        const peeled = g._checkPeel();
        return { peeled, banner: g._bannerText };
    });
    core.assertOk(
        peelRes.peeled && peelRes.banner === 'Peel!',
        'ctx-proof peel trigger failed',
        { peelRes }
    );

    await flushHostBananaInteractions(ctx.host.page);
    await waitForDiag(ctx.host.page, 'ctx-proof peel seq', ({ seq, uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
    }, { seq: peelSeqBefore, uid: ctx.host.uid }, WAIT_MS, ctx.mp);
    await lib.waitPoolAll(ctx, expectedPoolAfter);
    await sync.waitAllPlayersBoardSynced(ctx, 'ctx-proof post-peel');

    const afterPeel = await core.capture.capturePlayerStates(ctx, 'ctx-proof-after-peel');

    accounting.assertPeelAccounting(ctx, beforePeel, afterPeel, 'ctx-proof host peel');
    sync.assertAllPlayersSynced(afterPeel, 'ctx-proof after peel');

    await authority.assertActionBannerAllPlayers(
        ctx,
        'Peel!',
        ctx.host.uid,
        'ctx-proof host peel banner'
    );

    log(`SUCCESS: ctx-proof passed (${ctx.playerCount}p).`);
}

module.exports = defineMpScenario({
    id: 'ctx-proof',
    kind: 'micro-fixture',
    description: 'MpCtx assertion smoke — pool sync, peel accounting, banner on all clients',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2, 3],
    joinMode: 'sequential',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['sync', 'accounting', 'authority']
}, runCtxProofScenario);
