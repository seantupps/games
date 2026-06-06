/**
 * Bananagrams MP full audit orchestration.
 */
const lib = require('../../lib/mp-lib');
const {
    centerMpViewerOnPages,
    isMpHeaded,
    relayoutMpHeadedForReview,
    syncMpHeadedMobileViewport,
    syncMpHeadedReviewViewport
} = require('../../../../shared/platform/mp-headed-view');

async function syncMpHeadedView(pages, mobile, { review = false } = {}) {
    if (!isMpHeaded()) return;
    if (mobile && review) {
        await relayoutMpHeadedForReview(pages, { mobile: true });
    } else if (mobile) {
        await Promise.all(pages.map((p) => syncMpHeadedMobileViewport(p, { relayoutPages: pages })));
    } else if (review) {
        await relayoutMpHeadedForReview(pages, { mobile: false });
    } else {
        await centerMpViewerOnPages(pages);
    }
}
const {
    log,
    HOST_UID,
    GUEST_UID,
    BUNCH,
    WAIT_MS,
    waitOpts,
    RESET_WAIT_MS,
    HOST_PEEL_GUEST_STABILITY_MS,
    clearBanners,
    enableFastBanners,
    waitPoolBoth,
    dismissBanners,
    assertActionBannerOnBoth,
    captureMpState,
    captureBothMpStates,
    timeoutError,
    waitForDiag,
    getGameFrame,
    getGame,
    seedBananaRoom,
    joinGuest,
    waitForDeal,
    getHandAndPool,
    assertStartingRackConnected,
    waitPool,
    splitViaDrag,
    dumpTile,
    hostPublishPartyBoard,
    syncGuestInventoryToHost,
    syncGuestFromHost,
    flushHostBananaInteractions,
    assertSpawnedAtViewportBottom,
    assertAllTilesVisible,
    dragTileByIndex
} = lib;
const { assertDumpSpawnQuick } = require('../../assertions/bananagrams_dump_spawn_assertions');
const { parseScenarioArgv } = require('../../scenarios/registry');
const { solveAndApplyAiMove } = require('./mp-ai-playthrough');
const { peelGridInFrame } = require('../../assertions/bananagrams_peel_fixture');
const {
    assertConverged,
    assertPeelAccounting,
    captureActionPair
} = require('../../assertions/bananagrams_mp_board_assertions');

/** Desktop: world-bounds spawn rules. Mobile: DOM visibility (pan/zoom-safe). */
async function assertAuditDumpSpawn(frame, beforeIds, label, { mobile, hostPage, dumpSeqBefore, hostUid } = {}) {
    if (mobile) {
        const r = await assertDumpSpawnQuick(frame, beforeIds, label, {
            mobile: true,
            hostPage: hostPage || null,
            dumpSeqBefore,
            hostUid,
            stableMs: 200
        });
        if (!r.ok) throw new Error(`${label} spawn invalid (${JSON.stringify(r)})`);
        return r;
    }
    return assertSpawnedAtViewportBottom(frame, beforeIds, label);
}

async function runBananagramsMpAudit(page1, page2, options = {}) {
    const scenario = options.scenario ?? parseScenarioArgv(process.argv, 'full');
    const mobile = !!options.mobile;
    const mp = options.mp || { page1, page2 };
    const roomId = options.roomId || `MP_AUDIT_BANANA_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const focusDumpPeel = options.focusDumpPeel ?? scenario === 'focus';
    const focusRounds = 6;
    const focusJitterMs = 140;

    if (scenario === 'solve') {
        const { runMpBoardSolveScenarios } = require('../../scenarios/board-solve');
        const { bootMpPlaySession } = require('./mp-play-boot');
        const { resolveSessionRounds } = require('./mp-ai-playthrough');
        const rounds = resolveSessionRounds(options);
        if (rounds > 1) {
            log(`Note: --rounds=${rounds} on --scenario=solve runs the full solve suite once (use --scenario=review for solve-2 win loops).`);
        }
        if (!options.skipSeed) {
            const { joinBananaPartyViaInvite } = lib;
            await joinBananaPartyViaInvite(page1, page2, roomId);
        }
        await bootMpPlaySession(page1, page2, { mobile });
        await runMpBoardSolveScenarios(page1, page2);
        return;
    }

    if (scenario === 'review' || scenario === 'last-bunch') {
        const { runReviewScenarioAudit } = require('../../scenarios/review');
        const { parseWinSideArgv } = require('../../scenarios/registry');
        const { resolveSessionRounds, resolveSessionPause } = require('./mp-ai-playthrough');
        await runReviewScenarioAudit(page1, page2, {
            ...options,
            roomId,
            mobile,
            winSide: options.winSide ?? parseWinSideArgv(),
            rounds: resolveSessionRounds(options),
            pause: resolveSessionPause(options)
        });
        return;
    }

    if (scenario === 'sync') {
        const { runMpSyncInvariantAudit } = require('../../scenarios/mp/sync-invariants');
        if (!options.skipSeed) {
            const { joinBananaPartyViaInvite } = lib;
            await joinBananaPartyViaInvite(page1, page2, roomId);
        }
        await runMpSyncInvariantAudit(page1, page2, {
            ...options,
            roomId,
            mobile,
            mp
        });
        return;
    }

    if (scenario === 'actions') {
        const {
            runBananagramsMpActionsAudit,
            withActionsTimeout,
            ACTIONS_TIMEOUT_MS
        } = require('./actions-audit');
        const { STEP_MS } = require('../../../../shared/infra/timeouts');
        page1.setDefaultTimeout(STEP_MS);
        page2.setDefaultTimeout(STEP_MS);
        return withActionsTimeout((async () => {
            if (!options.skipSeed) {
                const { joinBananaPartyViaInvite } = require('../../lib/mp-lib');
                await joinBananaPartyViaInvite(page1, page2, roomId);
            }
            return runBananagramsMpActionsAudit(page1, page2, { ...options, skipSeed: true });
        })(), 'MP Actions');
    }

    let frame1;
    let frame2;
    let poolAfterDeal;

    if (scenario === 'focus') {
        const { bootMpPlaySession } = require('./mp-play-boot');
        const { resetMpForAiPlaythrough } = require('./mp-ai-playthrough');
        if (!options.skipSeed) {
            const { joinBananaPartyViaInvite, assertHostDealPool, EXPECTED_MP_2P_POOL } = lib;
            await joinBananaPartyViaInvite(page1, page2, roomId);
            await assertHostDealPool(page1, EXPECTED_MP_2P_POOL, 'focus host deal bunch', mp);
            await bootMpPlaySession(page1, page2, { mobile });
        } else {
            frame1 = await getGameFrame(page1);
            frame2 = await getGameFrame(page2);
            const reset = await resetMpForAiPlaythrough({
                page1, page2, frame1, frame2, mp, mobile
            });
            frame1 = reset.frame1;
            frame2 = reset.frame2;
        }
        frame1 = frame1 || await getGameFrame(page1);
        frame2 = frame2 || await getGameFrame(page2);
    } else {
    if (!options.skipSeed) {
        const { joinBananaPartyViaInvite, assertHostDealPool, EXPECTED_MP_2P_POOL } = lib;
        await joinBananaPartyViaInvite(page1, page2, roomId);
        await assertHostDealPool(page1, EXPECTED_MP_2P_POOL, 'host deal bunch after invite', mp);
    }

    log(`Bananagrams MP audit in room ${roomId}${mobile ? ' (mobile)' : ''}...`);
    log('Deal: tiles dealt per player, dictionary loaded...');
    await waitForDeal(page1, 'P1', mp);
    await waitForDeal(page2, 'P2', mp);
    await Promise.all([
        assertStartingRackConnected(page1, 'host deal', mp),
        assertStartingRackConnected(page2, 'guest deal', mp)
    ]);

    if (mobile) {
        const { runBananagramsMpMobileExtras } = require('../../mobile/bananagrams_mobile_suite');
        await runBananagramsMpMobileExtras(page1, page2);
        await Promise.all([
            enableFastBanners(await getGameFrame(page1)),
            enableFastBanners(await getGameFrame(page2))
        ]);
    }

    const dealInfo = await getHandAndPool(page1);
    poolAfterDeal = dealInfo.poolAfterDeal;

    log('SUCCESS: Deal â€” tiles dealt per player (2-player MP).');

    if (!mobile) {
        const { assertGuestFirstSplitStableAfterReset } = require('../../assertions/bananagrams_guest_first_split_assertions');
        await assertGuestFirstSplitStableAfterReset(page1, page2, lib, { mobile });
        log('Re-deal after guest-first-split test for main audit...');
        await (await getGameFrame(page1)).evaluate(() => {
            window.game.resetGame();
        });
        await waitForDeal(page1, 'P1', mp);
        await waitForDeal(page2, 'P2', mp);
        const { waitForPreSplitHand } = require('../../assertions/bananagrams_guest_first_split_assertions');
        await Promise.all([
            waitForPreSplitHand(page1, 'P1', mp, lib),
            waitForPreSplitHand(page2, 'P2', mp, lib)
        ]);
    } else {
        log('MP mobile: skip guest-first-split + re-deal (covered on desktop; saves ~4s).');
    }

    const faceDown = await page1.evaluate(() => {
        const doc = document.getElementById('game-frame').contentDocument;
        const tiles = [...doc.querySelectorAll('.tile')];
        return tiles.length > 0 && tiles.every((t) => t.classList.contains('is-face-down'));
    });
    if (!faceDown) throw new Error('Tiles should start face-down before SPLIT');

    log('Pool HUD shows shared bunch remainder...');
    await waitPoolBoth(page1, page2, poolAfterDeal);

    const hudLayout = await (await getGameFrame(page1)).evaluate(() => {
        const hud = document.getElementById('banana-hud');
        const pool = document.getElementById('banana-pool-count');
        const host = document.getElementById('game-container').getBoundingClientRect();
        const hr = hud.getBoundingClientRect();
        const poolColor = getComputedStyle(pool).color;
        const timer = document.getElementById('banana-timer');
        return {
            topLeft: hr.left - host.left < 40,
            hasTimer: !!timer,
            poolUsesTheme: poolColor.length > 0
        };
    });
    if (!hudLayout.hasTimer) throw new Error('Elapsed timer should show (no turn order)');
    if (!hudLayout.topLeft) throw new Error('HUD should be top-left');
    log('SUCCESS: Deal + pool HUD + top-left layout.');

    log('Global MP scoreboard (you first, opponent colors)...');
    const scoresUi = await (await getGameFrame(page1)).evaluate(() => {
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
        throw new Error(`MP scoreboard missing (${JSON.stringify(scoresUi)})`);
    }
    if (!scoresUi.hasDivider) throw new Error('Score divider expected');
    if (!scoresUi.hasTimer) throw new Error('Timer HUD should remain visible with scoreboard');
    log('SUCCESS: Global MP scoreboard visible.');

    log('Hub shell has no duplicate scoreboard...');
    const hubOnly = await page1.evaluate(() => {
        const hidden = (el) => !el || !el.classList.contains('show');
        return hidden(document.querySelector('.scoreboard'));
    });
    if (!hubOnly) throw new Error('Hub should not duplicate iframe scoreboard');

    log('SPLIT: host drag starts game; guest syncs face-up + timer...');
    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);
    await Promise.all([enableFastBanners(frame1), enableFastBanners(frame2)]);
    const splitHost = await splitViaDrag(frame1, { mobile });
    if (!splitHost.ok || !splitHost.hasTimer) {
        throw new Error(`Host SPLIT failed (${JSON.stringify(splitHost)})`);
    }

    await Promise.all([
        waitForDiag(page1, 'SPLIT host started', () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const doc = document.getElementById('game-frame')?.contentDocument;
            return g?.gameStarted && !!doc?.getElementById('banana-timer');
        }, undefined, WAIT_MS, mp),
        waitForDiag(page2, 'SPLIT guest started', () => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.gameStarted;
        }, undefined, WAIT_MS, mp)
    ]);
    const guestSplit = await page2.evaluate(() => {
        const doc = document.getElementById('game-frame').contentDocument;
        const tiles = [...doc.querySelectorAll('.tile')];
        const g = document.getElementById('game-frame').contentWindow.game;
        return {
            faceUp: tiles.every((t) => !t.classList.contains('is-face-down')),
            hasTimer: !!doc.getElementById('banana-timer'),
            gameStarted: g.gameStarted
        };
    });
    if (!guestSplit.faceUp || !guestSplit.hasTimer || !guestSplit.gameStarted) {
        throw new Error(`Guest SPLIT sync failed (${JSON.stringify(guestSplit)})`);
    }
    log('SUCCESS: SPLIT synced (timer on, no turns).');
    await syncMpHeadedView([page1, page2], mobile);
    } // scenario !== 'focus'

    const boardAssertOpts = { hostUid: HOST_UID, guestUid: GUEST_UID };
    const capturePair = (action) => captureActionPair(page1, page2, action, boardAssertOpts);

    const capturePlayerBoardSignature = async (page) => page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const room = g?.roomData;
        const board = (typeof RtdbSchema !== 'undefined' && room)
            ? RtdbSchema.readBoardFromRoom(room)
            : room?.global?.board;
        const tiles = (g?.tiles || [])
            .map((t) => ({ id: t.id, x: Math.round(t.x), y: Math.round(t.y), letter: t.letter }))
            .sort((a, b) => a.id.localeCompare(b.id));
        return JSON.stringify({
            tiles,
            localPool: g?._tilePool?.length ?? -1,
            boardPool: Array.isArray(board?.pool) ? board.pool.length : -1,
            localInventorySeq: g?._localInventorySeq ?? null,
            boardInventorySeq: board?.inventorySeq?.[g?._myUid?.() || ''] ?? null
        });
    });

    const captureViewportSignature = async (page) => page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return {
            panX: Math.round(g?.canvasPanX || 0),
            panY: Math.round(g?.canvasPanY || 0),
            zoom: Number((g?.zoom ?? 1).toFixed(4)),
            targetZoom: Number((g?.targetZoom ?? 1).toFixed(4)),
            focalX: Number.isFinite(g?._viewportFocal?.x) ? Math.round(g._viewportFocal.x) : null,
            focalY: Number.isFinite(g?._viewportFocal?.y) ? Math.round(g._viewportFocal.y) : null
        };
    });

    const assertNoPeelDisappearWindow = async (page, label, samples = 3, waitMs = 40) => {
        const ok = await page.evaluate(async ({ samples: n, waitMs: step }) => {
            const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            for (let i = 0; i < n; i++) {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                if (!g || (g.tiles?.length || 0) <= 0) return false;
                await delay(step);
            }
            return true;
        }, { samples, waitMs });
        if (!ok) throw new Error(`${label}: player hand disappeared during peel sync window`);
    };

    const assertViewportStable = async (page, label, before, maxPanDelta = 2, maxFocalDelta = 2) => {
        if (mobile) return;
        await page.waitForTimeout(120);
        const after = await captureViewportSignature(page);
        const panDrift = Math.max(Math.abs((after.panX || 0) - (before.panX || 0)),
            Math.abs((after.panY || 0) - (before.panY || 0)));
        const focalDrift = (before.focalX == null || before.focalY == null
            || after.focalX == null || after.focalY == null)
            ? 0
            : Math.max(Math.abs(after.focalX - before.focalX), Math.abs(after.focalY - before.focalY));
        const zoomDrift = Math.abs((after.zoom || 1) - (before.zoom || 1));
        if (panDrift > maxPanDelta || focalDrift > maxFocalDelta || zoomDrift > 0.001) {
            throw new Error(`${label}: viewport jitter detected before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
        }
    };

    const waitJitter = async () => {
        if (!focusJitterMs) return;
        const ms = 30 + Math.floor(Math.random() * focusJitterMs);
        await Promise.all([page1.waitForTimeout(ms), page2.waitForTimeout(ms)]);
    };

    const captureTileOffsets = async (page, ids) => page.evaluate(({ idList }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const idSet = new Set(idList || []);
        const out = {};
        (g?.tiles || []).forEach((t) => {
            if (!idSet.size || idSet.has(t.id)) {
                out[t.id] = {
                    dx: Math.round((t.x ?? 0) - (g?.ORIGIN ?? 0)),
                    dy: Math.round((t.y ?? 0) - (g?.ORIGIN ?? 0))
                };
            }
        });
        return out;
    }, { idList: ids });

    const captureAllTileOffsets = async (page) => page.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const out = {};
        (g?.tiles || []).forEach((t) => {
            out[t.id] = {
                dx: Math.round((t.x ?? 0) - (g?.ORIGIN ?? 0)),
                dy: Math.round((t.y ?? 0) - (g?.ORIGIN ?? 0))
            };
        });
        return out;
    });

    const assertOffsetsStable = (before, after, label, tolerance = 1) => {
        const bad = [];
        Object.keys(before || {}).forEach((id) => {
            if (!after?.[id]) return;
            const b = before[id];
            const a = after[id];
            if (Math.abs((a.dx ?? 0) - (b.dx ?? 0)) > tolerance
                || Math.abs((a.dy ?? 0) - (b.dy ?? 0)) > tolerance) {
                bad.push({ id, before: b, after: a });
            }
        });
        if (bad.length) {
            throw new Error(`${label} tile jitter detected (${JSON.stringify(bad.slice(0, 8))})`);
        }
    };

    const assertNoExistingTileMovement = (before, after, afterIds, label, tolerance = 0) => {
        const afterIdSet = new Set(afterIds || []);
        const moved = [];
        Object.keys(before || {}).forEach((id) => {
            // Ignore tiles that no longer exist after the action.
            if (!afterIdSet.has(id)) return;
            const b = before[id];
            const a = after?.[id];
            if (!a) return;
            if (Math.abs((a.dx ?? 0) - (b.dx ?? 0)) > tolerance
                || Math.abs((a.dy ?? 0) - (b.dy ?? 0)) > tolerance) {
                moved.push({ id, before: b, after: a });
            }
        });
        if (moved.length) {
            throw new Error(`${label} existing tiles moved (${JSON.stringify(moved.slice(0, 20))})`);
        }
    };

    const measureSpawnLatencyMs = async (page, beforeIds, timeoutMs = WAIT_MS) => {
        const t0 = Date.now();
        await waitForDiag(page, 'peel spawn appears', ({ ids }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            const idSet = new Set(ids || []);
            return (g?.tiles || []).some((t) => !idSet.has(t.id));
        }, { ids: beforeIds }, timeoutMs, mp);
        return Date.now() - t0;
    };

    const settleRender = async (page) => {
        await page.evaluate(async () => {
            const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            await nextFrame();
            await nextFrame();
        });
    };

    const setTightObserverZoom = async (page, zoom = 1.9) => page.evaluate(({ z }) => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        if (!g) return false;
        g.zoom = z;
        g.targetZoom = z;
        g.requestRender?.();
        return true;
    }, { z: zoom });

    const captureTileScreenPositions = async (page, ids) => page.evaluate(({ idList }) => {
        const frame = document.getElementById('game-frame');
        const win = frame?.contentWindow;
        const doc = frame?.contentDocument;
        const g = win?.game;
        if (!g || !doc) return {};
        const idSet = new Set(idList || []);
        const out = {};
        const nodes = [...doc.querySelectorAll('.tile')];
        nodes.forEach((node) => {
            const id = node?.dataset?.tileId;
            if (!id || (idSet.size && !idSet.has(id))) return;
            const r = node.getBoundingClientRect();
            out[id] = {
                cx: Math.round(r.left + (r.width / 2)),
                cy: Math.round(r.top + (r.height / 2))
            };
        });
        return out;
    }, { idList: ids });

    const captureAllTileScreenPositions = async (page) => page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const doc = frame?.contentDocument;
        const out = {};
        if (!doc) return out;
        const nodes = [...doc.querySelectorAll('.tile')];
        nodes.forEach((node) => {
            const id = node?.dataset?.tileId;
            if (!id) return;
            const r = node.getBoundingClientRect();
            out[id] = {
                cx: Math.round(r.left + (r.width / 2)),
                cy: Math.round(r.top + (r.height / 2))
            };
        });
        return out;
    });

    const assertScreenPositionsStable = (before, after, label, tolerance = 2) => {
        const bad = [];
        Object.keys(before || {}).forEach((id) => {
            if (!after?.[id]) return;
            const b = before[id];
            const a = after[id];
            if (Math.abs((a.cx ?? 0) - (b.cx ?? 0)) > tolerance
                || Math.abs((a.cy ?? 0) - (b.cy ?? 0)) > tolerance) {
                bad.push({ id, before: b, after: a });
            }
        });
        if (bad.length) {
            throw new Error(`${label} screen-space tile shift detected (${JSON.stringify(bad.slice(0, 8))})`);
        }
    };

    const assertNoExistingTileScreenMovement = (before, after, afterIds, label, tolerance = 1) => {
        // Mobile hub viewport sync shifts client rects without changing world layout.
        if (mobile) return;
        const afterIdSet = new Set(afterIds || []);
        const moved = [];
        Object.keys(before || {}).forEach((id) => {
            if (!afterIdSet.has(id)) return;
            const b = before[id];
            const a = after?.[id];
            if (!a) return;
            if (Math.abs((a.cx ?? 0) - (b.cx ?? 0)) > tolerance
                || Math.abs((a.cy ?? 0) - (b.cy ?? 0)) > tolerance) {
                moved.push({ id, before: b, after: a });
            }
        });
        if (moved.length) {
            throw new Error(`${label} existing tiles moved on screen (${JSON.stringify(moved.slice(0, 20))})`);
        }
    };

    if (focusDumpPeel) {
        log(`FOCUS: dump/peel state convergence stress (rounds=${focusRounds}, jitter<=${focusJitterMs}ms)`);
        log('FOCUS: strict no-move peel checks active (any existing tile movement fails).');
        await syncGuestInventoryToHost(page1, page2, GUEST_UID);
        await flushHostBananaInteractions(page1);
        await Promise.all([enableFastBanners(frame1), enableFastBanners(frame2)]);
        await Promise.all([setTightObserverZoom(page1, 1.9), setTightObserverZoom(page2, 1.9)]);
        await Promise.all([frame1, frame2].map((f) => f.evaluate(() => {
            const g = window.game;
            if (!g?._checker || g._checker._threeLetterPatched) return false;
            const base = g._checker;
            g._checker = {
                _threeLetterPatched: true,
                isPrefix(str) {
                    const s = String(str || '').toLowerCase();
                    if (/^[a-z]+$/.test(s) && s.length <= 3) return true;
                    return base.isPrefix(s);
                },
                isWord(str) {
                    const s = String(str || '').toLowerCase();
                    if (/^[a-z]{3}$/.test(s)) return true;
                    return base.isWord(s);
                }
            };
            return true;
        })));

        const {
            setGuestPeelFixtureOnHost,
            prepareGuestPeelGridOnClient
        } = require('../../lib/mp-peel-spawn-sync');

        const setGuestPeelFixture = (suffix) => setGuestPeelFixtureOnHost({
            frame1,
            page2,
            mp,
            suffix,
            source: 'focus-guest-peel',
            waitLabel: `focus guest peel fixture ${suffix}`
        });

        for (let i = 1; i <= focusRounds; i++) {
            log(`FOCUS round ${i}/${focusRounds}: host dump`);
            const beforeHostDump = await capturePair(`r${i}-before-host-dump`);
            const hostDumpBeforeSeq = beforeHostDump.host.dumpSeq;
            const hostDump = await dumpTile(frame1, -1, { mobile, hostPage: page1 });
            if (!hostDump.ok) throw new Error(`focus host dump trigger failed r${i}: ${JSON.stringify(hostDump)}`);
            await waitForDiag(page1, `focus host dump seq r${i}`, ({ seq }) => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const room = g?.roomData;
                const board = (typeof RtdbSchema !== 'undefined' && room) ? RtdbSchema.readBoardFromRoom(room) : room?.global?.board;
                return (board?.dumpSeq || 0) > seq && board?.dumpActorUid === 'u_banana_host';
            }, { seq: hostDumpBeforeSeq }, WAIT_MS, mp);
            await waitJitter();
            const afterHostDump = await capturePair(`r${i}-after-host-dump`);
            log(`[FOCUSDBG] ${afterHostDump.action} ${JSON.stringify(afterHostDump)}`);
            assertConverged(afterHostDump, `host dump r${i}`);
            await assertAllTilesVisible(page2, `focus host dump r${i} guest visibility`, { minTiles: 4 });
            await assertActionBannerOnBoth(
                page1,
                page2,
                'Dump!',
                HOST_UID,
                `focus host dump r${i} banner`
            );

            log(`FOCUS round ${i}/${focusRounds}: guest dump`);
            await flushHostBananaInteractions(page1);
            const beforeGuestDump = await capturePair(`r${i}-before-guest-dump`);
            const guestDumpBeforeSeq = beforeGuestDump.host.dumpSeq;
            const guestDumpBeforeHand = new Set(beforeGuestDump.guest.handIds);
            const guestDump = await dumpTile(frame2, -1, { mobile, hostPage: page1 });
            if (!guestDump.ok) throw new Error(`focus guest dump trigger failed r${i}: ${JSON.stringify(guestDump)}`);
            await waitForDiag(page1, `focus guest dump seq r${i}`, ({ seq }) => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const room = g?.roomData;
                const board = (typeof RtdbSchema !== 'undefined' && room) ? RtdbSchema.readBoardFromRoom(room) : room?.global?.board;
                return (board?.dumpSeq || 0) > seq && board?.dumpActorUid === 'u_banana_guest';
            }, { seq: guestDumpBeforeSeq }, WAIT_MS, mp);
            await waitJitter();
            const afterGuestDump = await capturePair(`r${i}-after-guest-dump`);
            const guestDumpAdded = afterGuestDump.guest.handIds.filter((id) => !guestDumpBeforeHand.has(id));
            if (!guestDumpAdded.length) {
                throw new Error(`guest dump r${i} added no tiles\n${JSON.stringify({ beforeGuestDump, afterGuestDump }, null, 2)}`);
            }
            log(`[FOCUSDBG] ${afterGuestDump.action} ${JSON.stringify(afterGuestDump)}`);
            assertConverged(afterGuestDump, `guest dump r${i}`);
            await assertAllTilesVisible(page2, `focus guest dump r${i} guest visibility`, { minTiles: 4 });
            await assertActionBannerOnBoth(
                page1,
                page2,
                'Dump!',
                GUEST_UID,
                `focus guest dump r${i} banner`
            );

            log(`FOCUS round ${i}/${focusRounds}: host peel`);
            const hostPeelSetup = await solveAndApplyAiMove(frame1);
            if (!hostPeelSetup.ok) {
                throw new Error(`focus host peel solve failed r${i}: ${JSON.stringify(hostPeelSetup)}`);
            }
            await Promise.all([settleRender(page1), settleRender(page2)]);
            const beforeHostPeel = await capturePair(`r${i}-before-host-peel`);
            const hostPeelBeforeSeq = beforeHostPeel.host.peelSeq;
            const nonHostBeforeHand = new Set(beforeHostPeel.guest.handIds);
            const hostBeforeOffsets = await captureTileOffsets(page1, beforeHostPeel.host.handIds);
            const guestBeforeOffsets = await captureTileOffsets(page2, beforeHostPeel.guest.handIds);
            const hostAllBeforeOffsets = await captureAllTileOffsets(page1);
            const guestAllBeforeOffsets = await captureAllTileOffsets(page2);
            const hostAllBeforeScreen = await captureAllTileScreenPositions(page1);
            const guestAllBeforeScreen = await captureAllTileScreenPositions(page2);
            const nonPeelingBeforeScreen = await captureTileScreenPositions(page2, beforeHostPeel.guest.handIds);
            const hostPeelStartedAt = Date.now();
            const hostPeelRes = await frame1.evaluate(() => {
                const g = window.game;
                g._bannerText = '';
                const peeled = g._checkPeel();
                return { peeled, banner: g._bannerText };
            });
            await flushHostBananaInteractions(page1);
            if (!hostPeelRes.peeled && hostPeelRes.banner !== 'Peel!') {
                throw new Error(`focus host peel failed r${i}: ${JSON.stringify(hostPeelRes)}`);
            }
            await waitForDiag(page2, `focus host peel seq r${i}`, ({ seq }) => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const room = g?.roomData;
                const board = (typeof RtdbSchema !== 'undefined' && room) ? RtdbSchema.readBoardFromRoom(room) : room?.global?.board;
                return (board?.peelSeq || 0) > seq && board?.peelActorUid === 'u_banana_host';
            }, { seq: hostPeelBeforeSeq }, WAIT_MS, mp);
            await flushHostBananaInteractions(page1);
            const expectedPoolAfterHostPeel = (beforeHostPeel.host.pileCount ?? -1) - 2;
            if (expectedPoolAfterHostPeel >= 0) {
                await waitPoolBoth(page1, page2, expectedPoolAfterHostPeel, WAIT_MS);
            }
            const nonHostSpawnMs = await measureSpawnLatencyMs(page2, [...nonHostBeforeHand], WAIT_MS);
            await page2.waitForTimeout(620);
            const afterHostPeel = await capturePair(`r${i}-after-host-peel`);
            const hostAfterOffsets = await captureTileOffsets(page1, beforeHostPeel.host.handIds);
            const guestAfterOffsets = await captureTileOffsets(page2, beforeHostPeel.guest.handIds);
            const hostAllAfterOffsets = await captureAllTileOffsets(page1);
            const guestAllAfterOffsets = await captureAllTileOffsets(page2);
            const hostAllAfterScreen = await captureAllTileScreenPositions(page1);
            const guestAllAfterScreen = await captureAllTileScreenPositions(page2);
            const nonPeelingAfterScreen = await captureTileScreenPositions(page2, beforeHostPeel.guest.handIds);
            const nonHostAdded = afterHostPeel.guest.handIds.filter((id) => !nonHostBeforeHand.has(id));
            if (!nonHostAdded.length || !afterHostPeel.guest.handIds.length) {
                throw new Error(`host peel r${i} nonhost hand disappeared/missing tile\n${JSON.stringify({
                    before: beforeHostPeel.guest,
                    after: afterHostPeel.guest
                }, null, 2)}`);
            }
            assertOffsetsStable(hostBeforeOffsets, hostAfterOffsets, `focus host peel r${i} host`);
            assertOffsetsStable(guestBeforeOffsets, guestAfterOffsets, `focus host peel r${i} guest`);
            assertNoExistingTileMovement(
                hostAllBeforeOffsets,
                hostAllAfterOffsets,
                afterHostPeel.host.handIds,
                `focus host peel r${i} host-any-tile`
            );
            assertNoExistingTileMovement(
                guestAllBeforeOffsets,
                guestAllAfterOffsets,
                afterHostPeel.guest.handIds,
                `focus host peel r${i} guest-any-tile`
            );
            assertNoExistingTileScreenMovement(
                hostAllBeforeScreen,
                hostAllAfterScreen,
                afterHostPeel.host.handIds,
                `focus host peel r${i} host-any-screen`
            );
            assertNoExistingTileScreenMovement(
                guestAllBeforeScreen,
                guestAllAfterScreen,
                afterHostPeel.guest.handIds,
                `focus host peel r${i} guest-any-screen`
            );
            assertScreenPositionsStable(nonPeelingBeforeScreen, nonPeelingAfterScreen, `focus host peel r${i} nonpeeler-screen`);
            assertPeelAccounting(beforeHostPeel, afterHostPeel, `focus host peel r${i}`);
            await assertAllTilesVisible(page2, `focus host peel r${i} guest visibility`, { minTiles: 4 });
            log(`[PEELLAT] focus host peel r${i} nonhostSpawnMs=${nonHostSpawnMs} totalMs=${Date.now() - hostPeelStartedAt}`);
            log(`[FOCUSDBG] ${afterHostPeel.action} ${JSON.stringify(afterHostPeel)}`);
            assertConverged(afterHostPeel, `host peel r${i}`);

            log(`FOCUS round ${i}/${focusRounds}: guest peel`);
            await setGuestPeelFixture(`r${i}`);
            await prepareGuestPeelGridOnClient(frame2);
            await flushHostBananaInteractions(page1);
            await Promise.all([settleRender(page1), settleRender(page2)]);
            const beforeGuestPeel = await capturePair(`r${i}-before-guest-peel`);
            const guestPeelBeforeSeq = beforeGuestPeel.host.peelSeq;
            const guestPeelBeforeHand = new Set(beforeGuestPeel.guest.handIds);
            const hostBeforeOffsets2 = await captureTileOffsets(page1, beforeGuestPeel.host.handIds);
            const guestBeforeOffsets2 = await captureTileOffsets(page2, beforeGuestPeel.guest.handIds);
            const hostAllBeforeOffsets2 = await captureAllTileOffsets(page1);
            const guestAllBeforeOffsets2 = await captureAllTileOffsets(page2);
            const hostAllBeforeScreen2 = await captureAllTileScreenPositions(page1);
            const guestAllBeforeScreen2 = await captureAllTileScreenPositions(page2);
            const nonPeelingBeforeScreen2 = await captureTileScreenPositions(page1, beforeGuestPeel.host.handIds);
            const guestPeelRes = await frame2.evaluate(() => {
                const g = window.game;
                g._bannerText = '';
                const peeled = g._checkPeel();
                return { peeled, banner: g._bannerText };
            });
            await flushHostBananaInteractions(page1);
            if (!guestPeelRes.peeled && guestPeelRes.banner !== 'Peel!') {
                throw new Error(`focus guest peel failed r${i}: ${JSON.stringify(guestPeelRes)}`);
            }
            await waitForDiag(page1, `focus guest peel seq r${i}`, ({ seq }) => {
                const g = document.getElementById('game-frame')?.contentWindow?.game;
                const room = g?.roomData;
                const board = (typeof RtdbSchema !== 'undefined' && room) ? RtdbSchema.readBoardFromRoom(room) : room?.global?.board;
                return (board?.peelSeq || 0) > seq && board?.peelActorUid === 'u_banana_guest';
            }, { seq: guestPeelBeforeSeq }, WAIT_MS, mp);
            await flushHostBananaInteractions(page1);
            const expectedPoolAfterGuestPeel = (beforeGuestPeel.host.pileCount ?? -1) - 2;
            if (expectedPoolAfterGuestPeel >= 0) {
                await waitPoolBoth(page1, page2, expectedPoolAfterGuestPeel, WAIT_MS);
            }
            await waitJitter();
            const afterGuestPeel = await capturePair(`r${i}-after-guest-peel`);
            const hostAfterOffsets2 = await captureTileOffsets(page1, beforeGuestPeel.host.handIds);
            const guestAfterOffsets2 = await captureTileOffsets(page2, beforeGuestPeel.guest.handIds);
            const hostAllAfterOffsets2 = await captureAllTileOffsets(page1);
            const guestAllAfterOffsets2 = await captureAllTileOffsets(page2);
            const hostAllAfterScreen2 = await captureAllTileScreenPositions(page1);
            const guestAllAfterScreen2 = await captureAllTileScreenPositions(page2);
            const nonPeelingAfterScreen2 = await captureTileScreenPositions(page1, beforeGuestPeel.host.handIds);
            const guestPeelAdded = afterGuestPeel.guest.handIds.filter((id) => !guestPeelBeforeHand.has(id));
            if (!guestPeelAdded.length) {
                throw new Error(`guest peel r${i} added no tile\n${JSON.stringify({
                    before: beforeGuestPeel.guest,
                    after: afterGuestPeel.guest
                }, null, 2)}`);
            }
            assertOffsetsStable(hostBeforeOffsets2, hostAfterOffsets2, `focus guest peel r${i} host`);
            assertOffsetsStable(guestBeforeOffsets2, guestAfterOffsets2, `focus guest peel r${i} guest`);
            assertNoExistingTileMovement(
                hostAllBeforeOffsets2,
                hostAllAfterOffsets2,
                afterGuestPeel.host.handIds,
                `focus guest peel r${i} host-any-tile`
            );
            assertNoExistingTileMovement(
                guestAllBeforeOffsets2,
                guestAllAfterOffsets2,
                afterGuestPeel.guest.handIds,
                `focus guest peel r${i} guest-any-tile`
            );
            assertNoExistingTileScreenMovement(
                hostAllBeforeScreen2,
                hostAllAfterScreen2,
                afterGuestPeel.host.handIds,
                `focus guest peel r${i} host-any-screen`
            );
            assertNoExistingTileScreenMovement(
                guestAllBeforeScreen2,
                guestAllAfterScreen2,
                afterGuestPeel.guest.handIds,
                `focus guest peel r${i} guest-any-screen`
            );
            assertScreenPositionsStable(nonPeelingBeforeScreen2, nonPeelingAfterScreen2, `focus guest peel r${i} nonpeeler-screen`);
            assertPeelAccounting(beforeGuestPeel, afterGuestPeel, `focus guest peel r${i}`);
            await assertAllTilesVisible(page2, `focus guest peel r${i} guest visibility`, { minTiles: 4 });
            log(`[FOCUSDBG] ${afterGuestPeel.action} ${JSON.stringify(afterGuestPeel)}`);
            assertConverged(afterGuestPeel, `guest peel r${i}`);
            await dismissBanners(page1, page2);
        }
        log('SUCCESS: Focus dump/peel stress finished with converged states.');
        await Promise.all([page1, page2].map((p) => p.evaluate(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            if (!g) return;
            const defZoom = typeof g.getDefaultZoomForViewport === 'function'
                ? g.getDefaultZoomForViewport()
                : 1;
            g.zoom = defZoom;
            g.targetZoom = defZoom;
            g.canvasPanX = 0;
            g.canvasPanY = 0;
            g._viewportFocal = null;
            g._fitZoomInitialized = false;
            g.requestRender?.();
        })));
        await syncMpHeadedView([page1, page2], mobile);
        return true;
    }

    log('DRAG: host moves tile...');
    const hostDrag = await dragTileByIndex(frame1, 0, 80, 60, { mobile });
    if (!hostDrag.ok) throw new Error(`Host drag failed (${JSON.stringify(hostDrag)})`);
    log('SUCCESS: Host drag.');
    await syncMpHeadedView([page1, page2], mobile);

    log('DRAG: guest moves tile (local board only)...');
    const guestCanDrag = await frame2.evaluate(() => {
        const g = window.game;
        return {
            role: g.playerRole,
            turn: g.turn,
            turnGated: g.hasCap('supportsTurnIndicator'),
            mpSimultaneous: !g.hasCap('supportsTurnIndicator')
        };
    });
    if (!guestCanDrag.mpSimultaneous) {
        throw new Error(`Guest drag should not be turn-gated (${JSON.stringify(guestCanDrag)})`);
    }
    if (guestCanDrag.turnGated && guestCanDrag.turn !== guestCanDrag.role) {
        throw new Error(`Guest blocked by turn (${JSON.stringify(guestCanDrag)})`);
    }
    const guestDrag = await dragTileByIndex(frame2, 1, -70, 50, { mobile });
    if (!guestDrag.ok) throw new Error(`Guest drag failed (${JSON.stringify(guestDrag)})`);
    await waitForDiag(page2, 'guest drag local', ({ id, x, y }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const tile = g?.tiles?.find((t) => t.id === id);
        return tile && Math.abs(tile.x - x) < 2 && Math.abs(tile.y - y) < 2;
    }, { id: guestDrag.id, x: guestDrag.x, y: guestDrag.y }, WAIT_MS);
    log('SUCCESS: Guest drag (local board).');
    await syncMpHeadedView([page1, page2], mobile);

    if (!mobile) {
    log('Refresh: guest restores layout from localStorage...');
    await frame2.evaluate(() => { window.game._persistMpLayout?.(); });
    const guestBoardBeforeRefresh = await capturePlayerBoardSignature(page2);
    const guestTileBefore = await page2.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.[1];
        return t ? { id: t.id, x: t.x, y: t.y, count: g.tiles.length } : null;
    });
    if (!guestTileBefore) throw new Error('Guest needs tiles before refresh test');
    await waitForDiag(page2, 'guest layout in localStorage (pre-refresh)', ({ id, x, y }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        let layout = {};
        try {
            layout = JSON.parse(localStorage.getItem(g.getLayoutPersistKey()) || '{}');
        } catch (_) { /* ignore */ }
        const p = layout[id];
        return p && Math.abs(p.x - x) < 2 && Math.abs(p.y - y) < 2;
    }, {
        id: guestTileBefore.id,
        x: guestTileBefore.x,
        y: guestTileBefore.y
    }, WAIT_MS, mp);
    await page2.reload({ waitUntil: 'load' });
    await page2.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await page2.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.identitySynced && g.isMultiplayer && g.mode === 'multiplayer';
    }, waitOpts);
    await waitForDeal(page2, 'P2', mp);
    await waitForDiag(page2, 'guest tile restored after refresh', ({ id, x, y }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const t = g?.tiles?.find((tile) => tile.id === id);
        return t && Math.abs(t.x - x) < 2 && Math.abs(t.y - y) < 2;
    }, {
        id: guestTileBefore.id,
        x: guestTileBefore.x,
        y: guestTileBefore.y
    }, WAIT_MS, mp);
    const guestBoardAfterRefresh = await capturePlayerBoardSignature(page2);
    if (guestBoardBeforeRefresh !== guestBoardAfterRefresh) {
        throw new Error(
            `Guest refresh board mismatch (pre-refresh != post-refresh)\n`
            + `before=${guestBoardBeforeRefresh}\nafter=${guestBoardAfterRefresh}`
        );
    }
    const guestTileCountAfterRefresh = await page2.evaluate(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.tiles?.length || 0;
    });
    if (guestTileCountAfterRefresh <= 0) {
        throw new Error('Guest refresh produced blank hand/board (0 tiles)');
    }
    // Also verify host refresh preserves exact in-play board state.
    const hostBoardBeforeRefresh = await capturePlayerBoardSignature(page1);
    await page1.reload({ waitUntil: 'load' });
    await page1.waitForFunction(() => window.NetworkEngine?.isInitialized, waitOpts);
    await page1.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g?.identitySynced && g.isMultiplayer && g.mode === 'multiplayer';
    }, waitOpts);
    await waitForDeal(page1, 'P1', mp);
    const hostBoardAfterRefresh = await capturePlayerBoardSignature(page1);
    if (hostBoardBeforeRefresh !== hostBoardAfterRefresh) {
        throw new Error(
            `Host refresh board mismatch (pre-refresh != post-refresh)\n`
            + `before=${hostBoardBeforeRefresh}\nafter=${hostBoardAfterRefresh}`
        );
    }
    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);
    await syncGuestFromHost(page1, page2, GUEST_UID);
    log('SUCCESS: Host/guest refresh preserved exact in-play board state.');
    } else {
        log('MP mobile: skip host/guest refresh (SP mobile audit covers refresh).');
        frame1 = await getGameFrame(page1);
        frame2 = await getGameFrame(page2);
    }

    log('Snap rules (host): adjacent edge, no stack, isolated drop...');
    const snap = await frame1.evaluate(() => {
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
    if (!snap.adjacent || !snap.free) throw new Error(`Snap rules failed (${JSON.stringify(snap)})`);
    log('SUCCESS: Snap rules.');

    log('No peel while tiles remain on starting rack (host)...');
    const noRackPeel = await frame1.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        g._checkPeel();
        return { banner: g._bannerText, count: g.tiles.length };
    });
    if (noRackPeel.banner !== '') {
        throw new Error(`Should not peel on rack (${JSON.stringify(noRackPeel)})`);
    }
    log('SUCCESS: No peel on rack.');

    const {
        runMpAiPlaythrough,
        resetMpForAiPlaythrough,
        resolveSessionRounds,
        resolveSessionPause,
        advanceActionsRoundAfterReview,
        finishPausedReviewSession,
        exitReviewAfterActionsSession
    } = require('./mp-ai-playthrough');
    const rounds = resolveSessionRounds(options);
    const pause = resolveSessionPause(options);
    const { getWinSide } = require('../../../../shared/infra/run-config');
    const winSide = options.winSide ?? getWinSide() ?? null;
    const usePlayToWin = true;

    log(
        `AI: play-to-win host + guest playthrough `
        + `(${rounds} round${rounds > 1 ? 's' : ''}`
        + `${pause ? ', pause in review' : ''})...`
    );
    if (mobile) {
        const { ensureWinBannerDwellForAudit } = require('../../assertions/bananagrams_hub_layout');
        const { enableMobileHub } = require('../../../../platform/mobile/lib/mobile_assertions');
        await ensureWinBannerDwellForAudit([page1, page2]);
        await Promise.all([page1, page2].map((p) => enableMobileHub(p)));
    }
    const reset = await resetMpForAiPlaythrough({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        expectedPool: poolAfterDeal
    });
    frame1 = reset.frame1;
    frame2 = reset.frame2;

    for (let round = 1; round <= rounds; round++) {
        log(`AI playthrough round ${round}/${rounds}...`);
        await runMpAiPlaythrough({
            page1,
            page2,
            frame1,
            frame2,
            mp,
            mobile,
            playToWin: usePlayToWin,
            assertActionsWinInvariants: true,
            assertWinBanner: !!mobile,
            winSide,
            winDrag: false,
            instantBanners: true,
            aggressiveDumping: !!options.aggressiveDumping,
            aggressiveDumpsPerPlayer: Number(options.aggressiveDumpsPerPlayer) || 10
        });
        log(`SUCCESS: AI playthrough round ${round}/${rounds} complete.`);

        if (round < rounds) {
            const next = await advanceActionsRoundAfterReview(
                page1, page2, frame1, frame2, mp, mobile, `round ${round}`,
                { pause }
            );
            frame1 = next.frame1;
            frame2 = next.frame2;
            continue;
        }

        if (pause) {
            await finishPausedReviewSession(page1, page2, { mobile });
            console.log(
                `SUCCESS: Bananagrams MP full 2-player audit passed `
                + `(${rounds} round${rounds > 1 ? 's' : ''}, paused in review).`
            );
            return true;
        }
    }

    frame1 = await getGameFrame(page1);
    frame2 = await getGameFrame(page2);
    await exitReviewAfterActionsSession(page1, page2, frame1, frame2, mp, 'play-to-win');

    const { assertHostSplitSyncsBothAfterPostGameReset } = require('../../assertions/bananagrams_post_done_split_assertions');
    await assertHostSplitSyncsBothAfterPostGameReset(page1, page2, lib, {
        label: 'full audit post-Done host SPLIT',
        mobile
    });

    console.log(
        `SUCCESS: Bananagrams MP full 2-player audit passed`
        + `${rounds > 1 ? ` (${rounds} rounds)` : ''}.`
    );
    return true;
}
module.exports = { runBananagramsMpAudit };
