/**

 * ctx-proof — micro scenario proving MpCtx assertions on 2p and 3p.

 *

 *   node ptests/run.js mp --game=bananagrams --scenario=ctx-proof

 *   node ptests/run.js mp --game=bananagrams --players=3 --scenario=ctx-proof

 */

const { defineMpScenario } = require('./contract');

const lib = require('../../lib/mp-state');

const { bootMpPlaySessionN } = require('../../lib/mp-session-boot');

const { assertJoinedPlayersReadyWithVisibility } = require('../../lib/mp-join-ready');

const { joinBananaPartySequentially } = require('../../../../shared/infra/scenarios/mp-3p-banana-party');

const { setupHostPeelGrid, readPeelSeq } = require('../../fixtures/peel-grid');

const {

    assertAllPlayersPoolSynced,

    waitAllPlayersBoardSynced,

    capturePlayerStates,

    assertAllPlayersSynced,

    assertPeelAccounting

} = require('../../assertions/mp-sync-board');

const { assertActionBannerAllPlayers } = require('../../../../shared/assertions/mp-authority');



async function seedParty(scenarioCtx) {

    const { ctx, roomId, mobile, options = {} } = scenarioCtx;

    if (scenarioCtx.skipSeed) return;



    if (ctx.playerCount === 2) {

        await lib.joinBananaPartyViaInvite(ctx.pages[0], ctx.pages[1], roomId);

        const { assertHostDealPool, EXPECTED_MP_2P_POOL } = lib;

        await assertHostDealPool(ctx.host.page, EXPECTED_MP_2P_POOL, 'ctx-proof host deal', ctx.mp);

        return;

    }



    const mobilePageIndices = mobile ? ctx.pages.map((_, i) => i) : (options.mobilePageIndices || []);

    const guestOrder = options.guestJoinOrder || [1, 2];

    await joinBananaPartySequentially(ctx.pages, roomId, guestOrder, {

        log: lib.log,

        mobilePageIndices,

        assertJoinedPlayersReady: (pages, indices, rId, label, opts) =>

            assertJoinedPlayersReadyWithVisibility(pages, indices, rId, label, {

                ...opts,

                playerDefs: ctx.players,

                mobilePageIndices

            })

    });

}



async function runCtxProofScenario(scenarioCtx) {

    const { ctx, mobile } = scenarioCtx;

    const { WAIT_MS, waitForDiag, flushHostBananaInteractions } = lib;

    const log = lib.log;



    await seedParty(scenarioCtx);



    log(`ctx-proof: boot ${ctx.playerCount}p session...`);

    const { frames } = await bootMpPlaySessionN(ctx, { mobile });



    log('ctx-proof: pool synced on all clients...');

    await assertAllPlayersPoolSynced(ctx, 'ctx-proof pool');



    log('ctx-proof: host peel grid + ctx snapshot asserts...');

    const hostFrame = frames[0];

    await flushHostBananaInteractions(ctx.host.page);

    await setupHostPeelGrid(hostFrame);

    await flushHostBananaInteractions(ctx.host.page);

    await waitAllPlayersBoardSynced(ctx, 'ctx-proof pre-peel grid');

    await assertAllPlayersPoolSynced(ctx, 'ctx-proof pre-peel grid', { skipExpectedPool: true });



    const beforePeel = await capturePlayerStates(ctx, 'ctx-proof-before-peel');

    const peelSeqBefore = await readPeelSeq(ctx.host.page);

    const expectedPoolAfter = beforePeel.host.boardPileCount - ctx.playerCount;



    const peelRes = await hostFrame.evaluate(() => {

        const g = window.game;

        g._bannerText = '';

        const peeled = g._checkPeel();

        return { peeled, banner: g._bannerText };

    });

    if (!peelRes.peeled || peelRes.banner !== 'Peel!') {

        throw new Error(`ctx-proof peel trigger failed (${JSON.stringify(peelRes)})`);

    }



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



    const afterPeel = await capturePlayerStates(ctx, 'ctx-proof-after-peel');



    assertPeelAccounting(ctx, beforePeel, afterPeel, 'ctx-proof host peel');

    assertAllPlayersSynced(afterPeel, 'ctx-proof after peel');



    await assertActionBannerAllPlayers(

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

    assertions: ['mp-sync-board', 'mp-authority', 'mp-join-ready']

}, runCtxProofScenario);


