/**
 * Repro: MP peel registration in 3p vs 2p.
 *
 *   node ptests/run.js mp --game=bananagrams --players=3 --scenario=peel-register-repro
 *   node ptests/run.js mp --game=bananagrams --players=2 --scenario=peel-register-repro
 *
 * Tests what the full audit skips: explicit peelSeq registration for each actor,
 * including guest peel WITHOUT pre-syncing inventory to host (manual-play path).
 */
const { defineMpScenario } = require('./contract');
const lib = require('../../lib/mp-state');
const { bootMpPlaySessionN, bootMpPlaySessionFromPages } = require('../../lib/mp-session-boot');
const { seedBananaParty } = require('./seed-party');
const {
    setupHostPeelGrid,
    prepareGuestPeelGridOnClient,
    setGuestPeelFixtureOnHost
} = require('../../fixtures/peel-grid');
const { peelGridInFrame } = require('../../fixtures/review-state');
const { sync, core, deal } = require('../../assertions');
const { readBoardField } = core;
const { failWithSnapshot } = core;

const { log, WAIT_MS, waitForDiag, flushHostBananaInteractions, getGameFrame } = lib;

/**
 * @param {import('./contract').MpScenarioContext} scenarioCtx
 * @param {{ syncGuestToHost?: boolean }} [opts]
 */
async function attemptPeel(scenarioCtx, actorIndex, opts = {}) {
    const { ctx } = scenarioCtx;
    const player = ctx.players[actorIndex];
    const hostPage = ctx.host.page;
    const frame = await getGameFrame(player.page);
    const peelSeqBefore = await readBoardField(hostPage, 'peelSeq');
    const poolBefore = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?._tilePool?.length ?? -1;
    });

    const peelRes = await frame.evaluate(() => {
        const g = window.game;
        const snapped = g._snapHandForValidation?.(g.tiles) || g.tiles;
        const grid = window.BananaGrid;
        const validation = grid && g._checker ? grid.validateGrid(snapped, g._checker) : { ok: false };
        g._bannerText = '';
        const peeled = g._checkPeel();
        return {
            peeled,
            banner: g._bannerText,
            tileCount: g.tiles?.length ?? 0,
            poolLocal: g._tilePool?.length ?? -1,
            partySize: (typeof g._peelPartyUids === 'function'
                ? g._peelPartyUids(g._myUid())
                : g._getPlayerUids?.() || []).length,
            phase: g.deriveGamePhase?.(),
            allPlaced: g._allTilesPlacedOn?.(snapped),
            gridOk: validation.ok,
            words: validation.words || []
        };
    });

    if (actorIndex !== 0 && peelRes.peeled) {
        await hostPage.waitForFunction(({ uid }) => {
            const banana = document.getElementById('game-frame')?.contentWindow?.game
                ?.roomData?.interactions?.banana?.[uid];
            if (!banana) return false;
            return Object.values(banana).some((m) => m?.type === 'peel');
        }, { uid: player.uid }, { timeout: WAIT_MS });
    }

    // Inspect host state BEFORE processing banana queue (explains drop vs register).
    const hostPeelDiag = actorIndex !== 0 ? await hostPage.evaluate(({ uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const bananaNode = g?.roomData?.interactions?.banana?.[uid] || {};
        const msgs = Object.values(bananaNode).filter((m) => m?.type === 'peel');
        const last = msgs[msgs.length - 1];
        if (!last) {
            return { hasPeelMsg: false, msgCount: msgs.length, bananaKeys: Object.keys(bananaNode) };
        }
        const layout = Array.isArray(last.positions) ? last.positions : null;
        const hand = g._handFromOwnedAndPositions?.(uid, layout) || [];
        const validation = window.BananaGrid?.validateGrid(hand, g._checker) || { ok: false };
        const partyLen = g._peelPartyUids?.(uid)?.length ?? -1;
        const pool = g._tilePool?.length ?? -1;
        return {
            hasPeelMsg: true,
            msgCount: msgs.length,
            layoutLen: layout?.length ?? 0,
            handLen: hand.length,
            handLetters: hand.map((t) => t.letter),
            allPlaced: g._allTilesPlacedOn?.(hand),
            gridOk: validation.ok,
            words: validation.words || [],
            pool,
            partyLen,
            poolOk: pool >= partyLen
        };
    }, { uid: player.uid }) : null;

    await flushHostBananaInteractions(hostPage);

    let hostRegistered = false;
    let diag = {};
    try {
        await waitForDiag(hostPage, `${player.role} peel registered`, ({ seq, uid }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
        }, { seq: peelSeqBefore, uid: player.uid }, WAIT_MS, ctx.mp);
        hostRegistered = true;
    } catch (err) {
        diag = await hostPage.evaluate(({ uid, seqBefore }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            const banana = room?.interactions?.banana || {};
            return {
                peelSeq: board?.peelSeq || 0,
                peelSeqBefore: seqBefore,
                peelActorUid: board?.peelActorUid || null,
                pool: g?._tilePool?.length ?? -1,
                partyUids: typeof g._peelPartyUids === 'function' ? g._peelPartyUids(uid) : [],
                playerUids: g._getPlayerUids?.() || [],
                ownedLens: Object.fromEntries(
                    (g._getPlayerUids?.() || []).map((u) => [u, (g._mpOwned?.[u]?.length || board?.tilesOwnedByPlayer?.[u]?.length || 0)])
                ),
                pendingBanana: Object.keys(banana)
            };
        }, { uid: player.uid, seqBefore: peelSeqBefore });
        diag.error = err.message;
    }

    const poolAfter = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?._tilePool?.length ?? -1;
    });

    return {
        actor: player.role,
        uid: player.uid,
        syncGuestToHost: !!opts.syncGuestToHost,
        peelRes,
        hostRegistered,
        peelSeqBefore,
        poolBefore,
        poolAfter,
        expectedPoolDrop: ctx.playerCount,
        hostPeelDiag,
        diag
    };
}

async function attemptPeelAfterGuestSend(scenarioCtx, actorIndex, peelRes) {
    const { ctx } = scenarioCtx;
    const player = ctx.players[actorIndex];
    const hostPage = ctx.host.page;
    const peelSeqBefore = await readBoardField(hostPage, 'peelSeq');
    const poolBefore = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?._tilePool?.length ?? -1;
    });

    if (peelRes.peeled) {
        await hostPage.waitForFunction(({ uid }) => {
            const banana = document.getElementById('game-frame')?.contentWindow?.game
                ?.roomData?.interactions?.banana?.[uid];
            if (!banana) return false;
            return Object.values(banana).some((m) => m?.type === 'peel');
        }, { uid: player.uid }, { timeout: WAIT_MS });
    }

    const hostPeelDiag = await hostPage.evaluate(({ uid }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const bananaNode = g?.roomData?.interactions?.banana?.[uid] || {};
        const msgs = Object.values(bananaNode).filter((m) => m?.type === 'peel');
        const last = msgs[msgs.length - 1];
        if (!last) {
            return { hasPeelMsg: false, msgCount: msgs.length, bananaKeys: Object.keys(bananaNode) };
        }
        const layout = Array.isArray(last.positions) ? last.positions : null;
        const hand = g._handFromOwnedAndPositions?.(uid, layout) || [];
        const validation = window.BananaGrid?.validateGrid(hand, g._checker) || { ok: false };
        const partyLen = g._peelPartyUids?.(uid)?.length ?? -1;
        const pool = g._tilePool?.length ?? -1;
        return {
            hasPeelMsg: true,
            msgCount: msgs.length,
            layoutLen: layout?.length ?? 0,
            handLen: hand.length,
            handLetters: hand.map((t) => t.letter),
            allPlaced: g._allTilesPlacedOn?.(hand),
            gridOk: validation.ok,
            words: validation.words || [],
            pool,
            partyLen,
            poolOk: pool >= partyLen
        };
    }, { uid: player.uid });

    await flushHostBananaInteractions(hostPage);

    let hostRegistered = false;
    let diag = {};
    try {
        await waitForDiag(hostPage, `${player.role} peel registered`, ({ seq, uid }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return (board?.peelSeq || 0) > seq && board?.peelActorUid === uid;
        }, { seq: peelSeqBefore, uid: player.uid }, WAIT_MS, ctx.mp);
        hostRegistered = true;
    } catch (err) {
        diag = await hostPage.evaluate(({ uid, seqBefore }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            return {
                peelSeq: board?.peelSeq || 0,
                peelSeqBefore: seqBefore,
                peelActorUid: board?.peelActorUid || null,
                pool: g?._tilePool?.length ?? -1
            };
        }, { uid: player.uid, seqBefore: peelSeqBefore });
        diag.error = err.message;
    }

    const poolAfter = await hostPage.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?._tilePool?.length ?? -1;
    });

    return {
        actor: player.role,
        uid: player.uid,
        syncGuestToHost: false,
        peelRes,
        hostRegistered,
        peelSeqBefore,
        poolBefore,
        poolAfter,
        expectedPoolDrop: ctx.playerCount,
        hostPeelDiag,
        diag
    };
}

async function attemptGuestManualPeel(frame) {
    return frame.evaluate((fnStr) => {
        const peelGridInFrame = new Function(`return (${fnStr})`)();
        const setup = peelGridInFrame();
        if (!setup?.placed || !setup?.valid) {
            return { ok: false, step: 'setup', setup };
        }
        const g = window.game;
        const snapped = g._snapHandForValidation?.(g.tiles) || g.tiles;
        const grid = window.BananaGrid;
        const validation = grid && g._checker ? grid.validateGrid(snapped, g._checker) : { ok: false };
        g._bannerText = '';
        const peeled = g._checkPeel();
        return {
            ok: true,
            peeled,
            banner: g._bannerText,
            tileCount: g.tiles?.length ?? 0,
            poolLocal: g._tilePool?.length ?? -1,
            partySize: (typeof g._peelPartyUids === 'function'
                ? g._peelPartyUids(g._myUid())
                : g._getPlayerUids?.() || []).length,
            allPlaced: g._allTilesPlacedOn?.(snapped),
            gridOk: validation.ok,
            words: validation.words || []
        };
    }, peelGridInFrame.toString());
}

async function setupActorPeelGrid(scenarioCtx, actorIndex, { syncGuestToHost = true } = {}) {
    const { ctx } = scenarioCtx;
    const player = ctx.players[actorIndex];
    const hostFrame = await getGameFrame(ctx.host.page);
    const actorFrame = await getGameFrame(player.page);

    await flushHostBananaInteractions(ctx.host.page);

    if (actorIndex === 0) {
        await setupHostPeelGrid(hostFrame);
        return;
    }

    if (syncGuestToHost) {
        await setGuestPeelFixtureOnHost({
            frame1: hostFrame,
            page2: player.page,
            mp: ctx.mp,
            suffix: `repro-${player.role}`,
            guestUid: player.uid,
            source: `peel-repro-${player.role}`
        });
        await prepareGuestPeelGridOnClient(actorFrame);
    }
}

async function runPeelRegisterRepro(scenarioCtx) {
    const { ctx, mobile } = scenarioCtx;
    const n = ctx.playerCount;

    await seedBananaParty(scenarioCtx, { dealLabel: 'peel-register host deal after invite' });

    if (n === 2) {
        await bootMpPlaySessionFromPages(ctx.pages[0], ctx.pages[1], { mobile });
    } else {
        await bootMpPlaySessionN(ctx, { mobile });
    }

    log(`peel-register-repro: ${n}p session booted`);

    const results = [];

    // Manual-play path FIRST on fresh session (before any fixture peels mutate hands).
    for (let guestIndex = 1; guestIndex < n; guestIndex++) {
        const player = ctx.players[guestIndex];
        log(`--- ${player.role} peel WITHOUT host sync (manual-play path, fresh session) ---`);
        const actorFrame = await getGameFrame(player.page);
        const peelRes = await attemptGuestManualPeel(actorFrame);
        if (!peelRes.ok) {
            failWithSnapshot('peel-register-repro', [`${player.role} local peel grid invalid`], { peelRes });
        }
        const manual = await attemptPeelAfterGuestSend(scenarioCtx, guestIndex, peelRes);
        results.push({ mode: 'manual-guest-fresh', ...manual });
        log(
            `${player.role} manual peel: guest peeled=${manual.peelRes.peeled}, `
            + `hostRegistered=${manual.hostRegistered}, `
            + `hostPeelMsg=${manual.hostPeelDiag?.hasPeelMsg}, `
            + `hostGridOk=${manual.hostPeelDiag?.gridOk}, `
            + `pool ${manual.poolBefore}→${manual.poolAfter}`
        );
        if (!manual.peelRes.peeled) {
            failWithSnapshot('peel-register-repro', [`${player.role} _checkPeel returned false locally`], { manual });
        }
        if (!manual.hostRegistered) {
            failWithSnapshot('peel-register-repro', [`${player.role} peel NOT registered on host`], { manual });
        }
    }

    for (let i = 0; i < n; i++) {
        const player = ctx.players[i];
        log(`--- ${player.role} peel WITH host fixture sync ---`);
        await setupActorPeelGrid(scenarioCtx, i, { syncGuestToHost: true });
        const synced = await attemptPeel(scenarioCtx, i, { syncGuestToHost: true });
        results.push({ mode: 'synced', ...synced });
        if (!synced.hostRegistered) {
            failWithSnapshot('peel-register-repro', [`${player.role} peel NOT registered (synced path)`], { synced });
        }
        log(`SUCCESS: ${player.role} peel registered (synced), pool ${synced.poolBefore}→${synced.poolAfter}`);
    }

    log(`SUCCESS: peel-register-repro ${n}p — all ${results.length} peel attempts registered`);
    return results;
}

module.exports = defineMpScenario({
    id: 'peel-register-repro',
    kind: 'micro-fixture',
    description: 'Repro: peelSeq registration per actor (synced + manual guest path)',
    platforms: ['desktop'],
    playerCounts: [2, 3],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: ['sync', 'accounting', 'core', 'peel-grid']
}, runPeelRegisterRepro);
