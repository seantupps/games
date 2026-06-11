/**
 * dump-remove-tile — dumped tile leaves its hold position after authority applies.
 *
 * Only checks that the tile you dumped is gone from where you dumped it
 * (not still visible / not same-id redraw at hold coords). Does not assert spawn paint.
 *
 *   npm run mp:banana:dump-remove-tile
 *   npm run mp:banana:dump-remove-tile:mobile
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { bootMpPlaySessionN } = require('../../lib/mp-session-boot');
const { seedBananaParty } = require('./seed-party');
const { spawn } = require('../../assertions');
const { readBoardField } = require('../../assertions/core/capture');
const { assertDumpTileRemoved, readGuestBunchLen, MIN_DUMP_POOL } = spawn.dump;
const { resetMpForAiPlaythrough } = require('./ai-playthrough');

const ROUNDS = 30;

async function captureHeldTile(frame, tileIndex = -1) {
    return frame.evaluate((idx) => {
        const g = window.game;
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx < 0 ? nodes.length + idx : idx];
        if (!node) return null;
        const tile = (g?.tiles || []).find((t) => t.id === node.dataset.tileId);
        if (!tile) return null;
        const r = node.getBoundingClientRect();
        return {
            id: tile.id,
            x: tile.x,
            y: tile.y,
            screenX: r.left + r.width / 2,
            screenY: r.top + r.height / 2
        };
    }, tileIndex);
}

async function restartPlayingGame(ctx, page1, page2, mobile, log, gameNum) {
    const frame1 = await lib.getGameFrame(page1);
    const frame2 = await lib.getGameFrame(page2);
    log(`dump-remove-tile: bunch depleted — fresh game #${gameNum}`);
    return resetMpForAiPlaythrough({
        ctx,
        pages: [page1, page2],
        frames: [frame1, frame2],
        mobile,
        instantBanners: true
    });
}

/** Reset split when actor's bunch cannot supply 3 dump draws. */
async function ensureActorCanDump(actorFrame, ctx, page1, page2, mobile, log, gameNumRef) {
    let pool = await readGuestBunchLen(actorFrame);
    let frames = { frame1: await lib.getGameFrame(page1), frame2: await lib.getGameFrame(page2) };
    while (pool < MIN_DUMP_POOL) {
        gameNumRef.n += 1;
        frames = await restartPlayingGame(ctx, page1, page2, mobile, log, gameNumRef.n);
        pool = await readGuestBunchLen(frames.frame1);
    }
    return frames;
}

async function runDumpRemoveTileScenario(scenarioCtx) {
    const { ctx, mobile, mp: mpIn } = scenarioCtx;
    const mp = mpIn || ctx.mp;
    const page1 = ctx.pages[0];
    const page2 = ctx.pages[1];
    const {
        log,
        dumpTile,
        enableFastBanners,
        getGameFrame,
        flushHostBananaInteractions,
        waitForDiag,
        WAIT_MS
    } = lib;

    await seedBananaParty(scenarioCtx, { dealLabel: 'dump-remove-tile host deal' });
    const { frames } = await bootMpPlaySessionN(ctx, { mobile });
    let frame1 = frames[0];
    let frame2 = await getGameFrame(page2);
    await Promise.all([enableFastBanners(frame1), enableFastBanners(frame2)]);

    const gameNumRef = { n: 1 };
    log(`dump-remove-tile: ${ROUNDS}× alternating host/guest — dumped tile must leave hold spot (game #${gameNumRef.n})`);

    for (let i = 1; i <= ROUNDS; i++) {
        const guestTurn = i % 2 === 0;
        const actorLabel = guestTurn ? 'guest' : 'host';

        ({ frame1, frame2 } = await ensureActorCanDump(
            guestTurn ? frame2 : frame1,
            ctx,
            page1,
            page2,
            mobile,
            log,
            gameNumRef
        ));
        const actorFrame = guestTurn ? frame2 : frame1;

        const beforeIds = await actorFrame.evaluate(() => [...window.game.tiles.map((t) => t.id)]);
        const held = await captureHeldTile(actorFrame, -1);
        if (!held?.id) {
            throw new Error(`dump-remove-tile ${actorLabel} r${i}/${ROUNDS}: no held tile`);
        }

        const dumpSeqBefore = await readBoardField(page1, 'dumpSeq');

        const dumpRes = await dumpTile(actorFrame, -1, { mobile, hostPage: page1 });
        if (dumpRes?.reason === 'no-tile' || dumpRes?.reason === 'no-model') {
            throw new Error(`dump-remove-tile ${actorLabel} dump ${i}/${ROUNDS} gesture failed (${JSON.stringify(dumpRes)})`);
        }
        if (dumpRes?.ok === false) {
            throw new Error(`dump-remove-tile ${actorLabel} dump ${i}/${ROUNDS} rejected (${JSON.stringify(dumpRes)})`);
        }

        await flushHostBananaInteractions(page1);
        const actorUid = guestTurn ? lib.GUEST_UID : lib.HOST_UID;
        await waitForDiag(page1, `dump-remove-tile ${actorLabel} r${i}/${ROUNDS} dumpSeq`, ({ seq, uid }) => {
            const board = document.getElementById('game-frame')?.contentWindow?.game?.roomData?.global?.board;
            return (board?.dumpSeq || 0) > seq && board?.dumpActorUid === uid;
        }, { seq: dumpSeqBefore, uid: actorUid }, WAIT_MS, mp);

        await actorFrame.evaluate(() => {
            window.game?.requestRender?.();
            return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        });

        const result = await assertDumpTileRemoved(
            actorFrame,
            beforeIds,
            held.id,
            `dump-remove-tile ${actorLabel} r${i}/${ROUNDS}`,
            {
                mobile,
                heldWorldPos: { x: held.x, y: held.y },
                heldScreenPos: { x: held.screenX, y: held.screenY }
            }
        );

        if (!result.ok) {
            throw new Error(
                `dump-remove-tile ${actorLabel} r${i}/${ROUNDS} failed (${result.phase}/${result.reason}): `
                + `${JSON.stringify(result, null, 2)}`
            );
        }

        if (guestTurn) {
            frame2 = await getGameFrame(page2);
        }

        if (i % 10 === 0 || i === ROUNDS) {
            log(`SUCCESS: dump-remove-tile through r${i}/${ROUNDS} (game #${gameNumRef.n}).`);
        }
    }

    log(`SUCCESS: dump-remove-tile passed (${ROUNDS} dumps, ${gameNumRef.n} game(s), host + guest).`);
}

module.exports = defineMpScenario({
    id: 'dump-remove-tile',
    kind: 'micro-fixture',
    description: 'Dumped tile is removed from its hold position (host and guest)',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['dump-remove-tile']
}, runDumpRemoveTileScenario);
