const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

/** Topology-agnostic MP full-audit checks — all take MpCtx. */
const lib = require('../../lib/mp-state');
const { readDealDiag } = require('./visibility');
const { assertAllPlayersScoreboard } = require('./scoreboard');
const { assertAllPlayersPoolSynced } = require('./sync');

const { log, WAIT_MS, waitOpts, waitForDiag, dragTileByIndex, hostPublishPartyBoard } = lib;
const { captureAllMpStates } = require('../../../../shared/platform/mp-waits');
const { timeoutError } = lib;

/**
 * Pre-SPLIT: pool HUD layout, scoreboard, hub shell (after pool synced, before SPLIT).
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {import('playwright').Frame[]} frames
 */
async function assertPreSplitDealAudit(ctx, frames) {
    const hostFrame = frames[0];

    log('Pool HUD shows shared bunch remainder...');
    await assertAllPlayersPoolSynced(ctx, 'pre-SPLIT pool');

    const hudLayout = await hostFrame.evaluate(() => {
        const hud = document.getElementById('banana-hud');
        const poolEl = document.getElementById('banana-pool-count');
        const host = document.getElementById('game-container').getBoundingClientRect();
        const hr = hud.getBoundingClientRect();
        return {
            topLeft: hr.left - host.left < 40,
            hasTimer: !!document.getElementById('banana-timer'),
            poolUsesTheme: getComputedStyle(poolEl).color.length > 0
        };
    });
    if (!hudLayout.hasTimer) failWithSnapshot('pre-SPLIT deal', ['Elapsed timer should show (no turn order)'], { hudLayout });
    if (!hudLayout.topLeft) failWithSnapshot('pre-SPLIT deal', ['HUD should be top-left'], { hudLayout });
    log('SUCCESS: Deal + pool HUD + top-left layout.');

    log('Scoreboard: all players see zeros with opponent colors...');
    const zeroScores = Object.fromEntries(ctx.players.map((p) => [p.uid, 0]));
    await assertAllPlayersScoreboard(frames, ctx.players, zeroScores, 'Scoreboard');
    log('SUCCESS: Scoreboard synced on all clients.');

    if (ctx.playerCount === 2) {
        log('Global MP scoreboard (you first, opponent colors)...');
        const scoresUi = await hostFrame.evaluate(() => {
            const sb = document.querySelector('.scoreboard');
            const user = sb ? sb.querySelector('.score-user') : null;
            const ai = sb ? sb.querySelector('.score-ai') : null;
            const divider = sb ? sb.querySelector('.score-divider') : null;
            const timer = document.getElementById('banana-timer');
            return {
                visible: sb?.classList.contains('show'),
                userScore: user?.textContent,
                oppScore: ai?.textContent,
                hasDivider: !!divider,
                hasTimer: !!timer
            };
        });
        if (!scoresUi.visible || scoresUi.userScore !== '0' || scoresUi.oppScore !== '0') {
            failWithSnapshot('pre-SPLIT scoreboard', ['MP scoreboard missing or wrong scores'], { scoresUi });
        }
        if (!scoresUi.hasDivider) failWithSnapshot('pre-SPLIT scoreboard', ['Score divider expected'], { scoresUi });
        if (!scoresUi.hasTimer) failWithSnapshot('pre-SPLIT scoreboard', ['Timer HUD should remain visible with scoreboard'], { scoresUi });
        log('SUCCESS: Global MP scoreboard visible.');
    }

    log('Hub shell has no duplicate scoreboard...');
    const hubOnly = await ctx.host.page.evaluate(() => {
        const hidden = (el) => !el || !el.classList.contains('show');
        return hidden(document.querySelector('.scoreboard'));
    });
    if (!hubOnly) failWithSnapshot('pre-SPLIT hub', ['Hub should not duplicate iframe scoreboard'], { hubOnly });
    log('SUCCESS: Pool HUD synced across all clients.');
}

/**
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {string} label
 */
async function assertPartyBoardOnRtdb(ctx, label) {
    const party = ctx.uids;
    await waitForDiag(ctx.host.page, `${label}: host _mpOwned`, ({ uids }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return uids.every((u) => (g._mpOwned?.[u]?.length || 0) > 0);
    }, { uids: party }, WAIT_MS, ctx.mp);
    try {
        await ctx.host.page.waitForFunction(async ({ uids, rId }) => {
            const snap = await window.NetworkEngine.db
                .ref(`gameData/${rId}/global/board/tilesOwnedByPlayer`)
                .once('value');
            const hands = snap.val() || {};
            return uids.every((u) => (hands[u]?.length || 0) > 0);
        }, { uids: party, rId: ctx.roomId }, waitOpts);
    } catch (err) {
        const snaps = await captureAllMpStates(ctx.pages, ctx.players, label);
        throw timeoutError(`${label}: RTDB hands`, WAIT_MS, snaps, err.message);
    }
}

/**
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {import('../scenarios/mp/contract').MpPlayerDef} player
 * @param {import('playwright').Frame} frame
 * @param {string} tileId
 */
async function assertRefreshPreservesLayout(ctx, player, frame, tileId) {
    await frame.evaluate(() => window.game._persistMpLayout?.());
    const tileBefore = await player.page.evaluate(({ id }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === id);
        return t ? { id: t.id, x: t.x, y: t.y } : null;
    }, { id: tileId });
    if (!tileBefore) {
        const diag = await readDealDiag(player.page).catch(() => ({}));
        failWithSnapshot(`${player.role} refresh`, [`needs tile ${tileId} before refresh test`], { diag, tileId });
    }
    await player.page.reload({ waitUntil: 'load' });
    await player.page.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await player.page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.identitySynced && g.isMultiplayer && g.mode === 'multiplayer';
    }, waitOpts);
    await waitForDiag(player.page, `${player.role} hand after reload`, ({ u }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g
            && g.isMultiplayer
            && g.mode === 'multiplayer'
            && g._dictReady
            && g._checker
            && g.tiles?.length > 0
            && g._myUid?.() === u;
    }, { u: player.uid }, WAIT_MS, ctx.mp);
    const after = await player.page.evaluate(({ id }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === id);
        return t ? { x: t.x, y: t.y } : null;
    }, { id: tileBefore.id });
    if (!after || Math.abs(after.x - tileBefore.x) > 2 || Math.abs(after.y - tileBefore.y) > 2) {
        failWithSnapshot(`${player.role} refresh`, ['board reset on refresh'], { before: tileBefore, after });
    }
}

/**
 * Guests first, then host — host reload must not clobber guest hands.
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {import('playwright').Frame[]} frames
 * @param {Record<string, string>} tileIdByUid
 * @returns {Promise<import('playwright').Frame[]>}
 */
async function assertAllPlayersRefreshPreservesLayout(ctx, frames, tileIdByUid) {
    log('Refresh: each player restores layout from localStorage...');
    await hostPublishPartyBoard(ctx.host.page);
    await assertPartyBoardOnRtdb(ctx, 'pre-refresh');

    const order = [...ctx.remotes, ctx.host];
    const outFrames = [...frames];
    for (const player of order) {
        const tileId = tileIdByUid[player.uid];
        if (!tileId) failWithSnapshot('refresh layout', [`Missing tile id for refresh test (${player.role})`], { tileIdByUid });
        await assertRefreshPreservesLayout(ctx, player, outFrames[player.index], tileId);
        outFrames[player.index] = await lib.getGameFrame(player.page);
    }
    log('SUCCESS: All players refresh preserved layout.');
    return outFrames;
}

async function assertNoSnapBack(page, id, x, y, label) {
    await page.waitForFunction(({ tileId, tx, ty }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === tileId);
        return !!t && Math.abs(t.x - tx) < 3 && Math.abs(t.y - ty) < 3;
    }, { tileId: id, tx: x, ty: y }, waitOpts);
    await page.waitForTimeout(400);
    const snap = await page.evaluate(({ tileId }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === tileId);
        return t ? { x: t.x, y: t.y } : null;
    }, { tileId: id });
    if (!snap || Math.abs(snap.x - x) > 6 || Math.abs(snap.y - y) > 6) {
        failWithSnapshot(label, ['tile snapped back after drag'], { id, expected: { x, y }, got: snap });
    }
}

/**
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {import('playwright').Frame[]} frames
 * @param {{ mobile?: boolean, remoteOffsets?: Array<{ dx: number, dy: number, tileIndex?: number }> }} [opts]
 * @returns {Promise<Record<string, { id: string, x: number, y: number }>>}
 */
async function assertAllPlayersDragLocal(ctx, frames, opts = {}) {
    const mobile = !!opts.mobile;
    const dragByUid = {};

    log('DRAG: host moves tile...');
    const hostDrag = await dragTileByIndex(frames[0], 0, 80, 60, { mobile });
    if (!hostDrag.ok) failWithSnapshot('host drag', ['Host drag failed'], { hostDrag });
    await assertNoSnapBack(ctx.host.page, hostDrag.id, hostDrag.x, hostDrag.y, 'Host drag');
    dragByUid[ctx.host.uid] = hostDrag.id;
    log('SUCCESS: Host drag.');

    const remoteOffsets = opts.remoteOffsets || ctx.remotes.map(() => ({
        dx: -70,
        dy: 50,
        tileIndex: 1
    }));

    for (let i = 0; i < ctx.remotes.length; i++) {
        const remote = ctx.remotes[i];
        const off = remoteOffsets[i] || { dx: -70, dy: 50, tileIndex: 1 };
        log(`DRAG: ${remote.role} moves tile (local board only)...`);
        const remoteFrame = frames[remote.index];
        const remoteDrag = await dragTileByIndex(
            remoteFrame,
            off.tileIndex ?? 1,
            off.dx,
            off.dy,
            { mobile }
        );
        if (!remoteDrag.ok) {
            failWithSnapshot(`${remote.role} drag`, ['drag failed'], { remoteDrag });
        }
        await assertNoSnapBack(remote.page, remoteDrag.id, remoteDrag.x, remoteDrag.y, `${remote.role} drag`);
        dragByUid[remote.uid] = remoteDrag.id;
        log(`SUCCESS: ${remote.role} drag (local board).`);
    }

    return dragByUid;
}

/**
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {import('playwright').Frame} hostFrame
 */
async function assertSnapRules(ctx, hostFrame) {
    log('Snap rules (host): adjacent edge, no stack, isolated drop...');
    const snap = await hostFrame.evaluate(() => {
        const tileA = { id: 'mp-a', letter: 'A', x: 2400, y: 2500, faceUp: true };
        const tileT = { id: 'mp-t', letter: 'T', x: 2434, y: 2503, faceUp: true };
        const snapped = BananaGrid.snapTilePosition(tileT, [tileA]);
        tileT.x = snapped.x;
        tileT.y = snapped.y;
        const shares = BananaGrid.tilesShareCell(tileA, tileT);
        const free = BananaGrid.snapTilePosition({ id: 'x', letter: 'X', x: 2050, y: 2100 }, []);
        return {
            adjacent: snapped.snapped && tileT.x === 2440 && tileT.y === 2500 && !shares,
            free: !free.snapped && free.x === 2050 && free.y === 2100
        };
    });
    if (!snap.adjacent || !snap.free) failWithSnapshot('snap rules', ['Snap rules failed'], { snap });
    log('SUCCESS: Snap rules.');
}

/**
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {import('playwright').Frame} hostFrame
 */
async function assertNoPeelOnRack(ctx, hostFrame) {
    log('No peel while tiles remain on starting rack (host)...');
    const noRackPeel = await hostFrame.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        g._checkPeel();
        return { banner: g._bannerText, count: g.tiles.length };
    });
    if (noRackPeel.banner !== '') {
        failWithSnapshot('no peel on rack', ['Should not peel while tiles remain on starting rack'], { noRackPeel });
    }
    log('SUCCESS: No peel on rack.');
}

/**
 * Drop persisted drag/refresh layouts before AI reset (avoids disconnected racks after re-SPLIT).
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {import('playwright').Frame[]} frames
 */
async function clearMpLayoutPersistence(ctx, frames) {
    await Promise.all(frames.map((f) => f.evaluate(() => {
        const g = window.game;
        if (!g) return;
        try {
            const key = typeof g.getLayoutPersistKey === 'function' ? g.getLayoutPersistKey() : null;
            if (key) localStorage.removeItem(key);
        } catch (_) { /* ignore */ }
        g._mpPlayerLayouts = {};
        g._viewportFocal = null;
    })));
    await lib.flushHostBananaInteractions(ctx.host.page);
}

/**
 * Post-game review + Done reset + host SPLIT sync (N-player).
 * @param {import('../lib/mp-ctx').MpCtx} ctx
 * @param {import('playwright').Frame[]} frames
 * @param {object} [opts]
 */
async function runPostGameReviewAudit(ctx, frames, opts = {}) {
    const { captureEndingLayoutFromFrame } = require('./review');
    const { runBananagramsMpMobilePostGame } = require('../../scenarios/mp/review-mobile');
    const { assertHostSplitSyncsAllAfterPostGameReset } = require('./review-done-split');
    const mobile = !!opts.mobile;
    const RESET_WAIT_MS = opts.resetMs ?? Math.min(WAIT_MS, Number(process.env.FIVE_MP_BANANA_RESET_MS || WAIT_MS));

    const endingSnapshots = {};
    for (const frame of frames) {
        const snap = await captureEndingLayoutFromFrame(frame);
        endingSnapshots[snap.uid] = snap;
    }

    log('Post-game review: crosswords, win, host Done → face-down redeal...');
    const ox = await frames[0].evaluate(() => window.game.ORIGIN);
    const reviewPlayers = ctx.players.map((p, i) => ({
        uid: p.uid,
        prefix: `p${i + 1}`,
        originX: ox + i * 320,
        originY: 0
    }));

    await runBananagramsMpMobilePostGame(
        ctx.pages,
        frames,
        reviewPlayers,
        {
            resetMs: RESET_WAIT_MS,
            skipTouch: !mobile,
            skipPlayableAfterReset: !mobile,
            endingSnapshots,
            assertWinBannerFade: true,
            naturalWin: true,
            mobile
        }
    );

    if (!mobile) {
        await assertHostSplitSyncsAllAfterPostGameReset(ctx, lib, {
            label: 'full audit post-Done host SPLIT',
            mobile: false
        });
    }

    log('SUCCESS: Post-game review + reset audit passed.');
}

module.exports = {
    assertPreSplitDealAudit,
    assertPartyBoardOnRtdb,
    assertRefreshPreservesLayout,
    assertAllPlayersRefreshPreservesLayout,
    assertAllPlayersDragLocal,
    assertSnapRules,
    assertNoPeelOnRack,
    clearMpLayoutPersistence,
    runPostGameReviewAudit
};
