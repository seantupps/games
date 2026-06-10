/**
 * Focus stress: dump/peel state convergence with strict no-move tile checks.
 */
const lib = require('../../lib/mp-state');
const {
    log,
    HOST_UID,
    GUEST_UID,
    WAIT_MS,
    enableFastBanners,
    dismissBanners,
    waitForDiag,
    dumpTile,
    syncGuestInventoryToHost,
    flushHostBananaInteractions
} = lib;
const { sync, accounting, core, spawn, authority } = require('../../assertions');
const { assertAllTilesVisible } = spawn.visibility;
const { assertActionBannerOnBoth } = authority;
const { assertDumpSpawnComplete } = spawn.dump;
const { assertAllPlayersSynced } = sync;
const { assertPeelAccounting } = accounting;
const { capturePlayerStates } = core.capture;
const { patchMpThreeLetterChecker } = require('../../fixtures/mp-four-tile');

async function captureTileOffsets(page, ids) {
    return page.evaluate(({ idList }) => {
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
}

async function captureAllTileOffsets(page) {
    return page.evaluate(() => {
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
}

function assertOffsetsStable(before, after, label, tolerance = 1) {
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
}

function assertNoExistingTileMovement(before, after, afterIds, label, tolerance = 0) {
    const afterIdSet = new Set(afterIds || []);
    const moved = [];
    Object.keys(before || {}).forEach((id) => {
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
}

async function measureSpawnLatencyMs(page, beforeIds, mp, timeoutMs = WAIT_MS) {
    const t0 = Date.now();
    await waitForDiag(page, 'peel spawn appears', ({ ids }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        const idSet = new Set(ids || []);
        return (g?.tiles || []).some((t) => !idSet.has(t.id));
    }, { ids: beforeIds }, timeoutMs, mp);
    return Date.now() - t0;
}

async function settleRender(page) {
    await page.evaluate(async () => {
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        await nextFrame();
        await nextFrame();
    });
}

async function setTightObserverZoom(page, zoom = 1.9) {
    return page.evaluate(({ z }) => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        if (!g) return false;
        g.zoom = z;
        g.targetZoom = z;
        g.requestRender?.();
        return true;
    }, { z: zoom });
}

async function captureTileScreenPositions(page, ids) {
    return page.evaluate(({ idList }) => {
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
}

async function captureAllTileScreenPositions(page) {
    return page.evaluate(() => {
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
}

function assertScreenPositionsStable(before, after, label, tolerance = 2) {
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
}

function assertNoExistingTileScreenMovement(before, after, afterIds, label, tolerance = 1, mobile = false) {
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
}

/**
 * @param {object} opts
 * @param {import('./contract').MpCtx} opts.mpCtx
 * @param {import('playwright').Page} opts.page1
 * @param {import('playwright').Page} opts.page2
 * @param {import('playwright').Frame} opts.frame1
 * @param {import('playwright').Frame} opts.frame2
 * @param {object} opts.mp
 * @param {boolean} opts.mobile
 * @param {import('playwright').Page[]} opts.pages
 * @param {number} opts.focusRounds
 * @param {number} opts.focusJitterMs
 * @param {() => Promise<void>} opts.syncMpHeadedView
 */
async function runFocusDumpPeelStress(opts) {
    const {
        mpCtx,
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        pages,
        focusRounds,
        focusJitterMs,
        syncMpHeadedView
    } = opts;

    const capturePair = (action) => capturePlayerStates(mpCtx, action);

    const waitJitter = async () => {
        if (!focusJitterMs) return;
        const ms = 30 + Math.floor(Math.random() * focusJitterMs);
        await Promise.all([page1.waitForTimeout(ms), page2.waitForTimeout(ms)]);
    };

    log(`FOCUS: dump/peel state convergence stress (rounds=${focusRounds}, jitter<=${focusJitterMs}ms)`);
    log('FOCUS: strict no-move peel checks active (any existing tile movement fails).');
    await syncGuestInventoryToHost(page1, page2, GUEST_UID);
    await flushHostBananaInteractions(page1);
    await Promise.all([enableFastBanners(frame1), enableFastBanners(frame2)]);
    await Promise.all([setTightObserverZoom(page1, 1.9), setTightObserverZoom(page2, 1.9)]);
    await patchMpThreeLetterChecker([frame1, frame2]);

    const {
        setGuestPeelFixtureOnHost,
        prepareGuestPeelGridOnClient,
        setupHostPeelGrid
    } = require('../../fixtures/peel-grid');

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
        assertAllPlayersSynced(afterHostDump, `host dump r${i}`);
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
        if (mobile) {
            const spawn = await assertDumpSpawnComplete(
                frame2,
                guestDump.beforeIds,
                `focus guest dump spawn r${i}`,
                {
                    mobile: true,
                    hostPage: page1,
                    dumpSeqBefore: guestDumpBeforeSeq,
                    hostUid: HOST_UID
                }
            );
            if (!spawn.ok) {
                throw new Error(`focus guest dump spawn r${i} failed: ${JSON.stringify(spawn)}`);
            }
        }
        await waitJitter();
        const afterGuestDump = await capturePair(`r${i}-after-guest-dump`);
        const guestDumpAdded = afterGuestDump.guest.handIds.filter((id) => !guestDumpBeforeHand.has(id));
        if (!guestDumpAdded.length) {
            throw new Error(`guest dump r${i} added no tiles\n${JSON.stringify({ beforeGuestDump, afterGuestDump }, null, 2)}`);
        }
        log(`[FOCUSDBG] ${afterGuestDump.action} ${JSON.stringify(afterGuestDump)}`);
        assertAllPlayersSynced(afterGuestDump, `guest dump r${i}`);
        await assertAllTilesVisible(page2, `focus guest dump r${i} guest visibility`, { minTiles: 4 });
        await assertActionBannerOnBoth(
            page1,
            page2,
            'Dump!',
            GUEST_UID,
            `focus guest dump r${i} banner`
        );

        log(`FOCUS round ${i}/${focusRounds}: host peel`);
        const hostPeelSetup = await setupHostPeelGrid(frame1);
        if (!hostPeelSetup.placed || !hostPeelSetup.valid) {
            throw new Error(`focus host peel grid failed r${i}: ${JSON.stringify(hostPeelSetup)}`);
        }
        await flushHostBananaInteractions(page1);
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
            await lib.waitPoolAll(mpCtx, expectedPoolAfterHostPeel, WAIT_MS);
        }
        const nonHostSpawnMs = await measureSpawnLatencyMs(page2, [...nonHostBeforeHand], mp, WAIT_MS);
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
            `focus host peel r${i} host-any-screen`,
            1,
            mobile
        );
        assertNoExistingTileScreenMovement(
            guestAllBeforeScreen,
            guestAllAfterScreen,
            afterHostPeel.guest.handIds,
            `focus host peel r${i} guest-any-screen`,
            1,
            mobile
        );
        assertScreenPositionsStable(nonPeelingBeforeScreen, nonPeelingAfterScreen, `focus host peel r${i} nonpeeler-screen`);
        assertPeelAccounting(mpCtx, beforeHostPeel, afterHostPeel, `focus host peel r${i}`);
        await assertAllTilesVisible(page2, `focus host peel r${i} guest visibility`, { minTiles: 4 });
        log(`[PEELLAT] focus host peel r${i} nonhostSpawnMs=${nonHostSpawnMs} totalMs=${Date.now() - hostPeelStartedAt}`);
        log(`[FOCUSDBG] ${afterHostPeel.action} ${JSON.stringify(afterHostPeel)}`);
        assertAllPlayersSynced(afterHostPeel, `host peel r${i}`);

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
            await lib.waitPoolAll(mpCtx, expectedPoolAfterGuestPeel, WAIT_MS);
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
            `focus guest peel r${i} host-any-screen`,
            1,
            mobile
        );
        assertNoExistingTileScreenMovement(
            guestAllBeforeScreen2,
            guestAllAfterScreen2,
            afterGuestPeel.guest.handIds,
            `focus guest peel r${i} guest-any-screen`,
            1,
            mobile
        );
        assertScreenPositionsStable(nonPeelingBeforeScreen2, nonPeelingAfterScreen2, `focus guest peel r${i} nonpeeler-screen`);
        assertPeelAccounting(mpCtx, beforeGuestPeel, afterGuestPeel, `focus guest peel r${i}`);
        await assertAllTilesVisible(page2, `focus guest peel r${i} guest visibility`, { minTiles: 4 });
        log(`[FOCUSDBG] ${afterGuestPeel.action} ${JSON.stringify(afterGuestPeel)}`);
        assertAllPlayersSynced(afterGuestPeel, `guest peel r${i}`);
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
    await syncMpHeadedView(pages, mobile);
    return true;
}

module.exports = { runFocusDumpPeelStress };
