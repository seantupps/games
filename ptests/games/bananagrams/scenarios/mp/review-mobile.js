/**
 * Mobile MP post-game review: multi-board view, frozen tiles, Done reset.
 */
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const {
    isMpHeaded,
    syncMpHeadedMobileViewport,
    syncMpHeadedDesktopViewport
} = require('../../../../shared/platform/mp-headed-view');
const { layout, review, distributionSeed, reviewMobile } = require('../../assertions');
const { ensureWinBannerDwellForAudit, assertWinBannerLayout } = layout.hub;
const { getGameFrame } = require('../../adapters/mobile-touch');
const {
    multiBoardTiles,
    setupPlayerCrosswords,
    applyEndingSnapshotsForReview,
    triggerHostWin
} = require('../../fixtures/review-mobile-setup');
const {
    SYNC_MS,
    log,
    dumpBoardEpoch,
    dumpPostGameDiag,
    waitPostGameReview,
    readReviewState,
    clickDone
} = require('../../lib/review-mobile-mechanics');
const { assertTilesFrozenOnMobile, assertPanStillWorks } = reviewMobile;
function startWinBannerLayoutAsserts(pages) {
    return Promise.all(pages.map((p, i) => assertWinBannerLayout(p, `P${i + 1}-win-banner`)));
}

const {
    assertTimerFrozenInReview,
    assertMpReviewShowsAllBoards,
    assertMpReviewPreservesSnapshots,
    assertReviewViewportStable,
    assertReviewBoardsFullyVisible,
    assertReviewLayoutOrientation,
    mergeGuestLayoutOnHost,
    pushHostReviewStateToClients,
    waitForHostReviewReady,
    waitMpClientsInReview,
    waitMpClientsPostWinReady,
    assertGuestReviewVisibleWithoutInteraction,
    waitMpResetAfterDone,
    assertMpResetHostGuestLayoutSynced,
    assertMpPlayableAfterReset,
    captureEndingLayoutFromFrame,
    syncGuestLocalLayoutFromFixture,
    assertDoneButtonVisible,
    prepareGuestReviewViewport
} = review;

/**
 * @param {import('playwright').Page[]} pages
 * @param {import('playwright').Frame[]} frames
 * @param {{ uid: string, originX: number, originY: number }[]} players
 */
async function runBananagramsMpMobilePostGame(pages, frames, players, opts = {}) {
    const { finiteTimeout } = distributionSeed;
    const resetMs = finiteTimeout(opts.resetMs ?? STEP_MS, STEP_MS);

    const hostFrame = frames[0];
    const allUids = players.map((p) => p.uid);
    const reviewSyncMs = opts.reviewSyncMs
        ?? (players.length > 2 ? Math.max(SYNC_MS, 8000) : SYNC_MS);
    const minTilesPerPlayer = opts.minTilesPerPlayer ?? 6;
    const useSnapshots = opts.endingSnapshots && typeof opts.endingSnapshots === 'object';

    let preWinSnapshots = useSnapshots ? { ...opts.endingSnapshots } : null;

    const hostAlreadyInReview = await hostFrame.evaluate(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        const won = !!(g?._winnerUid || g?.isOver || g?._victoryRegistered);
        const inReview = !!(g._postGameReview || board?.phase === 'review' || board?.reviewPhase === true);
        return won || inReview;
    });
    const naturalWin = !!opts.naturalWin || hostAlreadyInReview;

    if (useSnapshots && !naturalWin) {
        log('MP post-game: use ending boards from AI playthrough (no fixture tiles)...');
        await applyEndingSnapshotsForReview(frames, players, preWinSnapshots);
        await Promise.all(players.map((p, i) => pages[i].waitForFunction(({ min }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.tiles?.length >= min && g.tiles.every((t) => t.faceUp);
        }, { min: Math.min(minTilesPerPlayer, 3) }, { timeout: SYNC_MS })));
        log('SUCCESS: Each player has live board tiles before victory.');
    } else if (useSnapshots && naturalWin) {
        log('MP post-game: natural win — keep live ending boards (skip snapshot re-apply).');
        await Promise.all(players.map((p, i) => pages[i].waitForFunction(({ min }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return (g?.tiles?.length ?? 0) >= min;
        }, { min: Math.min(minTilesPerPlayer, 3) }, { timeout: SYNC_MS })));
        log('SUCCESS: Each player has live board tiles before victory trigger.');
    } else {
        log('MP post-game: place crosswords for each player...');
        const setup = await setupPlayerCrosswords(hostFrame, players);
        if (!setup.ok) throw new Error(`Crossword setup failed (${JSON.stringify(setup)})`);

        await Promise.all(players.map((p, i) => pages[i].waitForFunction(({ min }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.tiles?.length >= min && g.tiles.every((t) => t.faceUp);
        }, { min: minTilesPerPlayer }, { timeout: SYNC_MS })));

        log('SUCCESS: Each player has tiles on board before victory.');

        log('MP post-game: sync guest local layouts (simulates real drag positions)...');
        await Promise.all(players.slice(1).map((p, i) => {
            const guestFrame = frames[i + 1];
            const tiles = multiBoardTiles(p.originX, p.originY, p.prefix || p.uid.slice(-2));
            return syncGuestLocalLayoutFromFixture(guestFrame, tiles);
        }));

        await Promise.all(players.map((p, i) => pages[i].waitForFunction(({ min }) => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.tiles?.length >= min && g.tiles.every((t) => t.faceUp);
        }, { min: minTilesPerPlayer }, { timeout: SYNC_MS })));

        log('MP post-game: snapshot ending boards from each client before win...');
        preWinSnapshots = {};
        for (let i = 0; i < frames.length; i++) {
            const snap = await captureEndingLayoutFromFrame(frames[i]);
            preWinSnapshots[snap.uid] = snap;
            log(`[REVIEW pre-win] P${i + 1} ${snap.uid}: ${snap.tiles.length} tiles color=${snap.color}`);
        }
    }

    if (!preWinSnapshots) preWinSnapshots = {};
    for (let i = 0; i < players.length; i++) {
        const uid = players[i].uid;
        const snap = preWinSnapshots[uid];
        log(`[REVIEW pre-win] P${i + 1} ${uid}: ${snap?.tiles?.length ?? 0} tiles${useSnapshots ? ' (from AI)' : ''}`);
    }
    if (allUids.some((uid) => (preWinSnapshots[uid]?.tiles?.length || 0) < Math.min(minTilesPerPlayer, 3))) {
        throw new Error(`Expected tiles per player before win (${JSON.stringify(preWinSnapshots)})`);
    }

    if (isMpHeaded()) {
        if (opts.mobile) {
            await Promise.all(pages.map((p) => syncMpHeadedMobileViewport(p)));
        } else {
            await Promise.all(pages.map((p) => syncMpHeadedDesktopViewport(p)));
        }
    }

    let win;
    let bannerLayoutPromise = null;
    if (opts.assertWinBanner && !naturalWin) {
        await ensureWinBannerDwellForAudit(pages);
        if (opts.mobile) {
            const { enableMobileHub } = require('../../../../platform/mobile/lib/mobile_assertions');
            await Promise.all(pages.map((p) => enableMobileHub(p)));
            if (isMpHeaded()) {
                await Promise.all(pages.map((p) => syncMpHeadedMobileViewport(p)));
            }
        }
    }
    if (naturalWin) {
        log('MP post-game: natural win — register victory without pool wipe.');
        const alreadyWon = await hostFrame.evaluate(() => {
            const g = window.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            return !!(g?._winnerUid || board?.winnerUid);
        });
        if (!alreadyWon) {
            await hostFrame.evaluate(() => {
                const g = window.game;
                if (!g?.isHost?.() || g._winnerUid || g._postGameReview) return;
                if (typeof g.debugTriggerWin === 'function') {
                    g.debugTriggerWin();
                    return;
                }
                g._onPlayerWins?.(g._myUid?.());
            }).catch(() => {});
            if (opts.assertWinBanner) {
                log('MP post-game: hub win banner fits viewport (before auto-fade)...');
                bannerLayoutPromise = startWinBannerLayoutAsserts(pages);
            }
        } else if (opts.assertWinBanner) {
            log('MP post-game: natural win — hub win banner already asserted at victory.');
        }
        await hostFrame.waitForFunction(() => {
            const g = window.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            return !!(g?._winnerUid && (board?.phase === 'review' || board?.reviewPhase || g?._postGameReview));
        }, undefined, { timeout: reviewSyncMs }).catch(() => {});
        win = await hostFrame.evaluate(() => {
            const g = window.game;
            const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
            return {
                banner: g._bannerText,
                winner: g._winnerUid,
                boardWinner: board?.winnerUid,
                phase: board?.phase,
                reviewPhase: board?.reviewPhase,
                postGameReview: g._postGameReview
            };
        });
    } else {
        log('MP post-game: host wins...');
        win = await triggerHostWin(hostFrame);
        if (opts.assertWinBanner) {
            log('MP post-game: hub win banner fits viewport (before auto-fade)...');
            bannerLayoutPromise = startWinBannerLayoutAsserts(pages);
        }
    }

    await hostFrame.waitForFunction(() => {
        const g = window.game;
        const board = g?.roomData?.global?.board || g?.roomData?.state?.board;
        return !!(g?._winnerUid && (board?.phase === 'review' || board?.reviewPhase === true));
    }, undefined, { timeout: reviewSyncMs });

    if (!win.winner) {
        throw new Error(`Win registration failed (${JSON.stringify(win)})`);
    }

    if (win.banner) {
        throw new Error(`Win should not show BANANAS banner (${JSON.stringify(win)})`);
    }

    if (bannerLayoutPromise) {
        await bannerLayoutPromise;
        log('SUCCESS: Win banner layout OK on all clients.');
    }

    let bannerFadePromise = null;
    if (opts.assertWinBannerFade) {
        const fadeWait = (opts.winBannerFadeMs || 4000) + 1500;
        log('MP post-game: hub win banner auto-fade (parallel with review)...');
        bannerFadePromise = (async () => {
            let sawVisible = false;
            await pages[0].waitForFunction(() => {
                const b = document.getElementById('global-win-banner');
                if (b?.classList.contains('visible')) sawVisible = true;
                return sawVisible && b && !b.classList.contains('visible');
            }, undefined, { timeout: fadeWait });
            log('SUCCESS: Hub win banner faded after victory.');
        })();
    }

    await waitForHostReviewReady(hostFrame, pages[0], SYNC_MS);

    if (!naturalWin) {
        log('MP post-game: guests publish ending layouts to host...');
        await Promise.all(frames.slice(1).map((frame) => frame.evaluate(() => {
            const g = window.game;
            if (!g || g.isHost?.()) return;
            g._myEndingLayoutPublished = false;
            if (typeof g._freezeMyEndingLayout === 'function') g._freezeMyEndingLayout();
            g._publishMyEndingLayout?.();
        })));
    } else {
        log('MP post-game: natural win — skip guest layout re-publish (review already synced).');
    }
    await hostFrame.evaluate(() => {
        const g = window.game;
        g._processBananaInteractions?.(g.roomData?.interactions?.banana);
    }).catch(() => {});

    if (players.length >= 2 && !naturalWin) {
        await hostFrame.evaluate(({ snaps }) => {
            const g = window.game;
            if (!g?.isHost?.()) return;
            if (!g._reviewLayouts) g._reviewLayouts = {};
            Object.values(snaps || {}).forEach((snap) => {
                const uid = snap?.uid;
                const tiles = snap?.tiles;
                if (uid && tiles?.length) g._reviewLayouts[uid] = tiles;
            });
            g._hostSyncReviewState?.();
        }, { snaps: preWinSnapshots });
    }

    await pushHostReviewStateToClients(hostFrame, pages);
    await mergeGuestLayoutOnHost(hostFrame, pages);
    if (players.length > 2) {
        for (let i = 1; i < pages.length; i++) {
            await prepareGuestReviewViewport(pages[i], `P${i + 1}`);
        }
    }

    log('MP post-game: waiting for all clients to enter review...');
    await waitMpClientsInReview(frames, 'post-win-in-review', SYNC_MS, pages, hostFrame);
    log('SUCCESS: All clients in review.');

    if (bannerFadePromise) {
        await bannerFadePromise;
    }

    log('MP post-game: waiting for merged review boards on all clients...');
    await waitMpClientsPostWinReady(frames, allUids, 'post-win-boards', reviewSyncMs, pages, hostFrame);
    log('SUCCESS: Merged review boards on all clients.');

    log('MP post-game: guest sees review boards without interaction...');
    if (pages.length <= 2) {
        for (let i = 1; i < pages.length; i++) {
            await assertGuestReviewVisibleWithoutInteraction(pages[i], `P${i + 1}-guest-review-visible`);
        }
        log('SUCCESS: Guest review boards visible immediately.');
    } else {
        log('SUCCESS: Skipping 2p touch-free visibility check (3+ players use merged-board waits).');
    }

    await waitPostGameReview(pages[0], 'host', { hostOnly: true });
    await Promise.all(pages.slice(1).map((page, i) => waitPostGameReview(page, `P${i + 2}`)));

    log('SUCCESS: All clients in post-game review; host has Done button.');

    await mergeGuestLayoutOnHost(hostFrame, pages, Math.max(8, players.length * 3));

    await hostFrame.waitForFunction(
        ({ min, uids }) => {
            const g = window.game;
            const board = g?.roomData?.global?.board;
            const keys = board?.reviewLayouts ? Object.keys(board.reviewLayouts) : [];
            const inReview = board?.phase === 'review' || board?.reviewPhase === true;
            if (!inReview) return false;
            if (keys.length >= min) return true;
            const counts = {};
            uids.forEach((u) => { counts[u] = 0; });
            (g.tiles || []).forEach((t) => {
                const o = t.ownerUid || (typeof g._myUid === 'function' ? g._myUid() : null);
                if (o && counts[o] != null) counts[o] += 1;
            });
            return uids.every((u) => (counts[u] || 0) >= 1);
        },
        { min: players.length, uids: allUids },
        { timeout: SYNC_MS }
    ).catch(async (err) => {
        await dumpPostGameDiag(pages, 'wait-review-layouts');
        throw new Error(`review layout sync timeout (${err.message})`);
    });

    await hostFrame.waitForFunction(
        ({ uids, min }) => {
            const layouts = window.game?.roomData?.global?.board?.reviewLayouts || {};
            return uids.every((u) => (layouts[u]?.length || 0) >= min);
        },
        { uids: allUids, min: 6 },
        { timeout: SYNC_MS }
    ).catch(async (err) => {
        await dumpPostGameDiag(pages, 'wait-guest-ending-layouts');
        throw new Error(`guest ending layout sync timeout (${err.message})`);
    });

    log('SUCCESS: Review layouts synced for all players.');

    for (let i = 0; i < frames.length; i++) {
        const isHost = i === 0;
        const state = await readReviewState(frames[i]);
        if (!state.postGame) {
            throw new Error(`P${i + 1} review state bad (${JSON.stringify(state)})`);
        }
        await assertDoneButtonVisible(frames[i], isHost, `P${i + 1}-done`);
        await assertMpReviewShowsAllBoards(
            frames[i],
            allUids,
            `P${i + 1}-multi-board`,
            6
        );
        if (!opts.skipSnapshotAssert) {
            await assertMpReviewPreservesSnapshots(
                frames[i],
                preWinSnapshots,
                `P${i + 1}-snapshots`
            );
        }
        await assertReviewBoardsFullyVisible(frames[i], `P${i + 1}-review-fit`);
        const portrait = await pages[i].evaluate(() => {
            const win = document.getElementById('game-frame')?.contentWindow;
            const vis = win?.game?.getVisibleViewportSize?.() || { width: window.innerWidth, height: window.innerHeight };
            return vis.height > vis.width;
        });
        if (allUids.length >= 2) {
            await assertReviewLayoutOrientation(
                frames[i],
                allUids,
                portrait,
                `P${i + 1}-review-orient-${portrait ? 'portrait' : 'landscape'}`
            );
        }
        await assertTimerFrozenInReview(frames[i], `P${i + 1}-timer`);
        await assertReviewViewportStable(frames[i], `P${i + 1}-viewport`);
        log(`P${i + 1} review: ${state.tileCount} tiles, owners=${state.owners.join(',')}.`);
    }

    log('SUCCESS: All boards visible, timer frozen, viewport stable, host-only Done.');

    if (opts.stopAfterReview) {
        log('SUCCESS: stopAfterReview — skipping Done reset tail.');
        return;
    }

    if (!opts.skipTouch) {
        log('MP post-game: tiles frozen, pan still works...');
        for (let i = 0; i < frames.length; i++) {
            await assertTilesFrozenOnMobile(frames[i], `P${i + 1}`);
            await assertPanStillWorks(frames[i], `P${i + 1}`);
        }
        log('SUCCESS: Tiles cannot move; background pan still works.');
    }

    log('MP post-game: host taps Done...');
    await clickDone(hostFrame);
    const dealTimeout = finiteTimeout(resetMs, STEP_MS);

    await Promise.all(frames.map((frame, i) =>
        waitMpResetAfterDone(frame, `P${i + 1}`, dealTimeout)
    )).catch(async (err) => {
        await dumpBoardEpoch(pages, 'wait-reset-after-done');
        await dumpPostGameDiag(pages, 'wait-reset-after-done');
        throw err;
    });

    log('SUCCESS: Done reset — both clients left review, face-down hands, victory cleared.');

    if (!opts.skipPlayableAfterReset) {
        log('MP post-game: host/guest rack + viewport synced after reset...');
        await assertMpResetHostGuestLayoutSynced(pages[0], pages[1], {
            hostUid: players[0]?.uid,
            guestUid: players[1]?.uid,
            label: 'post-reset host/guest layout'
        });
        log('SUCCESS: Host and guest share rack positions and viewport after reset.');

        log('MP post-game: both players can split and drag after reset...');
        if (isMpHeaded()) {
            if (opts.mobile) {
                await Promise.all(pages.map((p) => syncMpHeadedMobileViewport(p)));
            } else {
                await Promise.all(pages.map((p) => syncMpHeadedDesktopViewport(p)));
            }
        }
        const pointerType = opts.pointerType ?? (opts.skipTouch ? 'mouse' : 'touch');
        await Promise.all(frames.map((frame, i) =>
            assertMpPlayableAfterReset(frame, `P${i + 1} after Done`, { pointerType })
        ));
        log('SUCCESS: Players can play after post-game Done.');
    }
}

async function runBananagramsMpMobilePostGame2p(page1, page2, opts = {}) {
    const HOST_UID = opts.hostUid || 'u_banana_host';
    const GUEST_UID = opts.guestUid || 'u_banana_guest';
    const frame1 = opts.frame1 || await getGameFrame(page1);
    const frame2 = opts.frame2 || await getGameFrame(page2);
    const ox = await frame1.evaluate(() => window.game.ORIGIN);

    await runBananagramsMpMobilePostGame(
        [page1, page2],
        [frame1, frame2],
        [
            { uid: HOST_UID, prefix: 'h', originX: ox, originY: 0 },
            { uid: GUEST_UID, prefix: 'g', originX: ox + 320, originY: 0 }
        ],
        opts
    );
}

const setup = require('../../fixtures/review-mobile-setup');
const mechanics = require('../../lib/review-mobile-mechanics');
module.exports = {
    runBananagramsMpMobilePostGame,
    runBananagramsMpMobilePostGame2p,
    ...setup,
    ...mechanics,
    ...reviewMobile
};
