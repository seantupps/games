/**
 * Solo Bananagrams actions — full playthrough (--scenario=actions) or unit slices (placement|dump|peel).
 */
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const { getGameFrame } = require('../../../../shared/adapters/desktop-input');
const { solveAttemptFromBrowserState } = require('../../ai');
const { playwrightSlowMo } = require('../../../../shared/infra/env-defaults');
const { assertTileDistributionInReview } = require('../../assertions/mp-distribution');
const {
    attachSnapshotTileIds,
    rackLettersFromSnap,
    applyPinnedPlacementsInFrame
} = require('../../lib/ai-snapshot-apply');
const {
    clickDone,
    waitSoloFaceDownHand,
    waitSoloPostGameReview
} = require('../../assertions/sp-review');

const ACTION_SLICES = ['placement', 'dump', 'peel'];

/** @param {import('playwright').Page} page */
async function prepareSoloUiSession(page) {
    await page.evaluate(() => {
        localStorage.setItem('bananagrams_mode', 'multiplayer');
    });

    console.log('[TEST] Waiting for Bananagrams solo UI...');
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && g.started && g.tiles && g.tiles.length >= 21;
    }, { timeout: STEP_MS });

    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && g._dictReady && g._checker;
    }, { timeout: STEP_MS });

    const gameFrame = await getGameFrame(page);

    console.log('[TEST] Resetting to fresh solo hand...');
    await gameFrame.evaluate(() => {
        window.localStorage.clear();
        window.game.onGameReset();
    });
    await page.waitForFunction(() => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return g && g.started && g.tiles.length >= 21 && !g.gameStarted;
    }, { timeout: STEP_MS });

    return { page, gameFrame };
}

/** @param {import('playwright').Frame} gameFrame */
async function runPlacementChecks(gameFrame) {
    console.log('[TEST] Tile snap on adjacent edge...');
    const snapResult = await gameFrame.evaluate(() => {
        const g = window.game;
        g.beginGame();
        let tileA = g.tiles.find((t) => t.letter === 'A');
        let tileT = g.tiles.find((t) => t.letter === 'T');
        if (!tileA || !tileT) {
            tileA = { id: 'snap-a', letter: 'A', x: 2400, y: 2500, faceUp: true };
            tileT = { id: 'snap-t', letter: 'T', x: 2434, y: 2503, faceUp: true };
        } else {
            tileA.x = 2400;
            tileA.y = 2500;
            tileT.x = 2434;
            tileT.y = 2503;
        }
        const snapped = BananaGrid.snapTilePosition(tileT, [tileA]);
        tileT.x = snapped.x;
        tileT.y = snapped.y;
        const shares = BananaGrid.tilesShareCell(tileA, tileT);
        return {
            ok: snapped.snapped && tileT.x === 2440 && tileT.y === 2500 && !shares,
            snapped,
            shares,
            pos: { x: tileT.x, y: tileT.y }
        };
    });
    if (!snapResult.ok) throw new Error(`Snap failed (${JSON.stringify(snapResult)})`);
    console.log('[TEST] SUCCESS: Adjacent tile snap (no overlap).');

    console.log('[TEST] Dropping on a tile snaps to a side, never stacks...');
    const noStackSnap = await gameFrame.evaluate(() => {
        const tileA = { id: 'stack-a', letter: 'A', x: 2400, y: 2500, faceUp: true };
        const tileB = { id: 'stack-b', letter: 'B', x: 2405, y: 2505, faceUp: true };
        const snap = BananaGrid.snapTilePosition(tileB, [tileA]);
        tileB.x = snap.x;
        tileB.y = snap.y;
        const shares = BananaGrid.tilesShareCell(tileA, tileB);
        const adjacent = (tileB.x === 2440 && tileB.y === 2500)
            || (tileB.x === 2360 && tileB.y === 2500)
            || (tileB.x === 2400 && tileB.y === 2460)
            || (tileB.x === 2400 && tileB.y === 2540);
        return { ok: !shares && adjacent, shares, pos: { x: tileB.x, y: tileB.y } };
    });
    if (!noStackSnap.ok) throw new Error(`Stack snap failed (${JSON.stringify(noStackSnap)})`);
    console.log('[TEST] SUCCESS: Snap picks a free side (no stacking).');

    console.log('[TEST] Far from other tiles — drop stays put (no grid snap)...');
    const freeDrop = await gameFrame.evaluate(() => {
        const tile = { id: 'free-x', letter: 'X', x: 2050, y: 2100 };
        const snap = BananaGrid.snapTilePosition(tile, []);
        return {
            ok: !snap.snapped && snap.x === 2050 && snap.y === 2100,
            snap
        };
    });
    if (!freeDrop.ok) throw new Error(`Free drop should not snap (${JSON.stringify(freeDrop)})`);
    console.log('[TEST] SUCCESS: Isolated drop keeps position.');
}

/** @param {import('playwright').Frame} gameFrame */
async function runDumpChecks(gameFrame) {
    console.log('[TEST] Holding right-click does not dump (only full click)...');
    const holdNoDump = await gameFrame.evaluate(() => {
        const g = window.game;
        g.beginGame();
        const before = g.tiles.length;
        const poolBefore = g._tilePool.length;
        const tile = document.querySelector('[data-tile-id="t-0"]');
        const r = tile.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type, x, y, button) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 2,
            pointerType: 'mouse',
            button,
            buttons: button === 2 ? 2 : 0
        });
        tile.dispatchEvent(mk('pointerdown', cx, cy, 2));
        return {
            ok: g.tiles.length === before && g._tilePool.length === poolBefore,
            count: g.tiles.length,
            pool: g._tilePool.length
        };
    });
    if (!holdNoDump.ok) throw new Error(`RMB hold should not dump (${JSON.stringify(holdNoDump)})`);
    console.log('[TEST] SUCCESS: Hold right-click does not dump.');

    console.log('[TEST] Right-click dump: -1 tile, +3 (not snapped to rack)...');
    const dumpResult = await gameFrame.evaluate(() => {
        const g = window.game;
        const beforeIds = new Set(g.tiles.map((t) => t.id));
        const poolBefore = g._tilePool.length;
        const tileEl = document.querySelector('[data-tile-id="t-0"]');
        const r = tileEl.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        tileEl.dispatchEvent(new PointerEvent('pointerup', {
            clientX: cx,
            clientY: cy,
            bubbles: true,
            pointerId: 2,
            pointerType: 'mouse',
            button: 2,
            buttons: 0
        }));
        tileEl.dispatchEvent(new MouseEvent('contextmenu', {
            clientX: cx,
            clientY: cy,
            bubbles: true,
            button: 2,
            buttons: 0
        }));
        const drawnOnly = g.tiles.filter((t) => !beforeIds.has(t.id));
        const old = g.tiles.filter((t) => beforeIds.has(t.id));
        const isolatedFromOld = drawnOnly.every((nt) => !BananaGrid.wouldSnapAt(nt.x, nt.y, old));
        return {
            ok: g.tiles.length === beforeIds.size + 2
                && g._tilePool.length === poolBefore - 2
                && drawnOnly.length === 3
                && isolatedFromOld,
            afterCount: g.tiles.length,
            isolatedFromOld
        };
    });
    if (!dumpResult.ok) throw new Error(`Dump failed (${JSON.stringify(dumpResult)})`);
    console.log('[TEST] SUCCESS: Right-click dump exchanged 1 for 3.');
}

/** @param {import('playwright').Frame} gameFrame */
async function runPeelChecks(gameFrame) {
    console.log('[TEST] No peel while tiles remain on the rack...');
    const noPeelOnRack = await gameFrame.evaluate(() => {
        const g = window.game;
        g.beginGame();
        g._bannerText = '';
        g._bannerUntil = 0;
        g.setupNewHand();
        g.beginGame();
        g._checkPeel();
        return {
            ok: g._bannerText === '' && g.tiles.length === 21,
            banner: g._bannerText,
            count: g.tiles.length
        };
    });
    if (!noPeelOnRack.ok) throw new Error(`Should not peel with rack tiles (${JSON.stringify(noPeelOnRack)})`);
    console.log('[TEST] SUCCESS: No peel while rack has tiles.');

    console.log('[TEST] Peel when every tile on board is a valid crossword...');
    process.env.BANANA_AI_QUIET = '1';
    const ai = require('../../ai');

    const MAX_SOLVE_TRIES = 8;
    let solved = null;
    let peelState = null;

    for (let tryNum = 0; tryNum < MAX_SOLVE_TRIES; tryNum++) {
        peelState = await gameFrame.evaluate(() => {
            const g = window.game;
            g._bannerText = '';
            g._bannerUntil = 0;
            g.setupNewHand();
            g.beginGame();
            return {
                rack: g.tiles.map((t) => t.letter),
                origin: g.ORIGIN,
                gap: BananaRules.TILE_GAP
            };
        });
        solved = ai.solveAttemptFromRack(peelState.rack);
        if (solved.cleared) break;
    }

    if (!solved?.cleared) {
        throw new Error(
            `AI did not clear rack after ${MAX_SOLVE_TRIES} deals `
            + `(last left: ${solved?.rackLeft?.join('') || '?'})`
        );
    }

    const finalPeelResult = await gameFrame.evaluate(({ placements, origin, gap }) => {
        const g = window.game;
        const used = new Set();
        for (const p of placements) {
            const tile = g.tiles.find(
                (t) => !used.has(t.id) && t.letter.toUpperCase() === p.letter.toUpperCase()
            );
            if (!tile) {
                return { ok: false, reason: 'missing-tile', letter: p.letter };
            }
            used.add(tile.id);
            tile.x = origin + p.gx * gap;
            tile.y = origin + p.gy * gap;
            tile.faceUp = true;
        }
        if (used.size !== g.tiles.length) {
            return { ok: false, reason: 'unplaced-tiles', placed: used.size, total: g.tiles.length };
        }
        if (typeof g.requestRender === 'function') g.requestRender();

        const validBefore = BananaGrid.validateGrid(g.tiles, g._checker);
        const placedOnBoard = g._allTilesPlaced?.() ?? BananaGrid.allTilesPlacedInGrid(
            g.tiles,
            { x: g.ORIGIN, y: g.ORIGIN },
            {
                cols: BananaRules.COLS,
                gap: BananaRules.TILE_GAP,
                tileSize: BananaRules.TILE_SIZE,
                handBelowCenter: BananaRules.HAND_BELOW_CENTER,
                handSize: BananaRules.SOLO_HAND
            }
        );

        const poolBefore = g._tilePool.length;
        const peeled = g._checkPeel();
        const banner = document.getElementById('banana-banner')?.textContent || g._bannerText || '';

        return {
            ok: peeled
                && (g._bannerText === 'Peel!' || banner.includes('Peel'))
                && validBefore.ok
                && placedOnBoard,
            banner,
            gridValid: validBefore.ok,
            gridReason: validBefore.reason,
            words: validBefore.words,
            placed: used.size,
            poolBefore,
            poolAfter: g._tilePool.length,
            tileCountAfter: g.tiles.length
        };
    }, { placements: solved.placements, origin: peelState.origin, gap: peelState.gap });

    if (!finalPeelResult.ok) {
        throw new Error(
            `AI peel failed. placed=${finalPeelResult.placed} valid=${finalPeelResult.gridValid} `
            + `(${finalPeelResult.gridReason}) banner="${finalPeelResult.banner}" `
            + `pool ${finalPeelResult.poolBefore}->${finalPeelResult.poolAfter} tiles=${finalPeelResult.tileCountAfter}`
        );
    }
    console.log(`[TEST] SUCCESS: AI placed ${finalPeelResult.placed} tiles, valid crossword, peel (pool ${finalPeelResult.poolBefore}->${finalPeelResult.poolAfter}).`);

    console.log('[TEST] Invalid full grid — silent (no Nope banner)...');
    const invalidSilent = await gameFrame.evaluate(() => {
        const g = window.game;
        g._bannerText = '';
        g._bannerUntil = 0;
        const opts = {
            cols: BananaRules.COLS,
            gap: BananaRules.TILE_GAP,
            tileSize: BananaRules.TILE_SIZE,
            handBelowCenter: BananaRules.HAND_BELOW_CENTER,
            handSize: 21
        };
        const tiles = [];
        for (let i = 0; i < 21; i++) {
            tiles.push({
                id: `bad-${i}`,
                letter: 'X',
                x: 2200 + (i % 7) * 40,
                y: 2200 + Math.floor(i / 7) * 40,
                faceUp: true
            });
        }
        g.tiles = tiles;
        const placed = BananaGrid.allTilesPlacedInGrid(g.tiles, { x: g.ORIGIN, y: g.ORIGIN }, opts);
        if (!placed) return { ok: false, reason: 'not-all-placed' };
        const poolBefore = g._tilePool.length;
        g._checkPeel();
        return {
            ok: g._bannerText === '' && g._tilePool.length === poolBefore,
            banner: g._bannerText
        };
    });
    if (!invalidSilent.ok) throw new Error(`Invalid grid should not show banner (${JSON.stringify(invalidSilent)})`);
    console.log('[TEST] SUCCESS: Invalid grid does not peel or show Nope.');
}

const SLICE_RUNNERS = {
    placement: runPlacementChecks,
    dump: runDumpChecks,
    peel: runPeelChecks
};

/**
 * @param {import('playwright').Page} page
 * @param {string[]} [slices]
 */
async function runSoloActionsAudit(page, slices = ACTION_SLICES) {
    const order = slices.filter((s) => ACTION_SLICES.includes(s));
    if (!order.length) {
        throw new Error(`No action slices to run (got: ${slices.join(', ') || '(empty)'})`);
    }
    console.log(`[TEST] Action slices: ${order.join(', ')}`);
    const { gameFrame } = await prepareSoloUiSession(page);
    for (const name of order) {
        console.log(`\x1b[36m[TEST] --- ${name} ---\x1b[0m`);
        await SLICE_RUNNERS[name](gameFrame);
    }
}

function snapshotBrowserState() {
    return () => {
        const g = window.game;
        const won = !!(
            g._winnerUid
            || g._victoryRegistered
            || g.isOver
            || g._inReviewExperience?.()
            || (typeof g._isBoardInReview === 'function' && g._isBoardInReview())
        );
        const origin = g.ORIGIN;
        const gap = BananaRules.TILE_GAP;
        const opts = g._rackLayoutOptions();
        const rackBounds = BananaGrid.getRackBounds(
            { x: origin, y: origin },
            opts.cols,
            opts.gap,
            opts.tileSize,
            opts.handBelowCenter
        );
        const originPt = { x: origin, y: origin };
        if (BananaGrid.isStartingRack(g.tiles, originPt, opts)) {
            return {
                rack: g.tiles.map((t) => ({ id: t.id, letter: t.letter })),
                boardCells: [],
                poolLen: g._tilePool.length,
                tileCount: g.tiles.length,
                gameStarted: !!g.gameStarted,
                origin,
                gap,
                winner: won,
                allPlaced: false,
                gridOk: false
            };
        }

        const toCell = (t) => ({
            gx: Math.round((t.x - origin) / gap),
            gy: Math.round((t.y - origin) / gap)
        });
        const visited = new Set();
        let largest = [];
        for (const seed of g.tiles) {
            if (visited.has(seed.id)) continue;
            const component = [];
            const queue = [seed];
            visited.add(seed.id);
            while (queue.length) {
                const cur = queue.pop();
                component.push(cur);
                const { gx, gy } = toCell(cur);
                for (const other of g.tiles) {
                    if (visited.has(other.id)) continue;
                    const { gx: ox, gy: oy } = toCell(other);
                    if (Math.abs(ox - gx) + Math.abs(oy - gy) === 1) {
                        visited.add(other.id);
                        queue.push(other);
                    }
                }
            }
            if (component.length > largest.length) largest = component;
        }
        const boardIds = new Set(largest.map((t) => t.id));
        const rack = [];
        const boardCells = [];
        for (const t of g.tiles) {
            if (boardIds.has(t.id)) {
                const { gx, gy } = toCell(t);
                boardCells.push({ gx, gy, letter: t.letter, id: t.id });
            } else {
                rack.push({ id: t.id, letter: t.letter });
            }
        }
        const allPlaced = typeof g._allTilesPlaced === 'function' ? g._allTilesPlaced() : false;
        const gridCheck = BananaGrid.validateGrid(g.tiles, g._checker);
        return {
            rack,
            boardCells,
            poolLen: g._tilePool.length,
            tileCount: g.tiles.length,
            gameStarted: !!g.gameStarted,
            origin,
            gap,
            winner: won,
            allPlaced,
            gridOk: gridCheck.ok
        };
    };
}

/** Full solo session: 50-tile fast bag, AI placement, peel, dump when stuck. */
async function runSoloFullGameAudit(page, options = {}) {
    process.env.BANANA_AI_QUIET = '1';
    const maxTurns = Number(process.env.FIVE_BANANA_MAX_TURNS || 80);
    let gameFrame;
    if (options.skipPrepare) {
        gameFrame = options.gameFrame || await getGameFrame(page);
    } else {
        ({ gameFrame } = await prepareSoloUiSession(page));
    }

    const bag = await gameFrame.evaluate(() => {
        const g = window.game;
        const fastTotal = BananaRules.poolTotal(BananaRules.SOLO_FAST_TILE_BAG);
        const hand = BananaRules.SOLO_HAND;
        const expectedBunch = fastTotal - hand;
        return {
            fastTotal,
            hand,
            expectedBunch,
            poolLen: g._tilePool.length,
            tileCount: g.tiles.length,
            bagMode: g.serializeBoard?.()?.bagMode,
            bagLabel: g._soloBagLabel?.()
        };
    });
    if (bag.fastTotal !== 50 || bag.hand !== 21 || bag.expectedBunch !== 29) {
        throw new Error(`Expected solo fast bag 50/21/29, got ${JSON.stringify(bag)}`);
    }
    if (bag.poolLen !== bag.expectedBunch || bag.tileCount !== bag.hand) {
        throw new Error(`Deal mismatch (pool/tiles): ${JSON.stringify(bag)}`);
    }
    if (bag.bagMode !== 'solo-fast') {
        throw new Error(`Expected bagMode solo-fast, got ${bag.bagMode}`);
    }
    console.log(`[TEST] Solo fast bag: ${bag.fastTotal} tiles, ${bag.hand} dealt, ${bag.expectedBunch} in bunch.`);

    await gameFrame.evaluate(() => {
        const g = window.game;
        g.beginGame();
        g.tiles.forEach((t) => { t.faceUp = true; });
        if (typeof g.requestRender === 'function') g.requestRender();
    });

    // Inject snapshot + id-pinned apply for in-frame merged calls
    await gameFrame.evaluate(({ snapFn, applySrc }) => {
        const outer = new Function('return ' + snapFn)();
        window.snapshotBrowserState = outer();
        // eslint-disable-next-line no-eval
        eval(`window.applyPinnedPlacementsInFrame = ${applySrc}`);
    }, {
        snapFn: snapshotBrowserState.toString(),
        applySrc: applyPinnedPlacementsInFrame.toString()
    });

    let snap = await gameFrame.evaluate(snapshotBrowserState());
    let peels = 0;
    let dumps = 0;
    const slowMo = playwrightSlowMo();
    if (slowMo > 0) console.log(`[TEST] Applied slow-mo: ${slowMo}ms per turn.`);

    for (let turn = 1; turn <= maxTurns; turn++) {
        if (slowMo > 0) {
            await page.waitForTimeout(slowMo);
        }

        // Every 3rd turn, force a dump if there are tiles on the rack and plenty in the pool
        // We check for poolLen >= 15 to ensure we don't empty the pool too early via forced dumps
        if (turn % 3 === 0 && snap.poolLen >= 15 && snap.rack.length > 0) {
            const dumpResult = await gameFrame.evaluate(() => {
                const g = window.game;
                const origin = g.ORIGIN;
                const opts = g._rackLayoutOptions();
                const rackBounds = BananaGrid.getRackBounds(
                    { x: origin, y: origin },
                    opts.cols,
                    opts.gap,
                    opts.tileSize,
                    opts.handBelowCenter
                );
                const rackTiles = g.tiles.filter((t) => BananaGrid.isTileInRack(t, rackBounds, opts.tileSize));
                const tile = rackTiles[0] || g.tiles[0];
                if (!tile) return { ok: false, reason: 'no-tiles-at-all' };
                const poolBefore = g._tilePool.length;
                const ok = g._handleDump(tile);
                return {
                    ok,
                    poolBefore,
                    poolAfter: g._tilePool.length,
                    tileCount: g.tiles.length,
                    nextSnap: window.snapshotBrowserState()
                };
            });
            if (dumpResult.ok) {
                dumps += 1;
                console.log(`[TEST] Turn ${turn}: Forced dump (every 3rd turn, pool ${dumpResult.poolBefore}→${dumpResult.poolAfter}).`);
                snap = dumpResult.nextSnap;
                continue;
            }
        }

        if (snap.winner) {
            console.log(`[TEST] Win after ${turn - 1} turns (peels=${peels}, dumps=${dumps}).`);
            await finishSoloAiWinWithDistributionCheck(gameFrame);
            return;
        }
        if (snap.poolLen === 0 && snap.allPlaced && snap.gridOk) {
            const won = await gameFrame.evaluate(() => {
                const g = window.game;
                const isWin = () => !!(
                    g._winnerUid
                    || g._victoryRegistered
                    || g.isOver
                    || g._inReviewExperience?.()
                    || (typeof g._isBoardInReview === 'function' && g._isBoardInReview())
                );
                if (isWin()) return true;
                g._bannerText = '';
                g._bannerUntil = 0;
                g._checkPeel();
                return isWin();
            });
            if (won) {
                console.log(`[TEST] Win (bunch empty, turn ${turn}, peels=${peels}, dumps=${dumps}).`);
                await finishSoloAiWinWithDistributionCheck(gameFrame);
                return;
            }
        }

        if (!snap.rack.length && snap.boardCells.length && snap.allPlaced && snap.gridOk) {
            const peelResult = await gameFrame.evaluate(() => {
                const g = window.game;
                g._bannerText = '';
                g._bannerUntil = 0;
                const poolBefore = g._tilePool.length;
                const peeled = g._checkPeel();
                return {
                    peeled,
                    poolBefore,
                    poolAfter: g._tilePool.length,
                    winner: !!(
                        g._winnerUid
                        || g._victoryRegistered
                        || g.isOver
                        || g._inReviewExperience?.()
                    )
                };
            });
            if (peelResult.winner) {
                console.log(`[TEST] Win on peel (turn ${turn}, peels=${peels + 1}, dumps=${dumps}).`);
                await finishSoloAiWinWithDistributionCheck(gameFrame);
                return;
            }
            if (peelResult.peeled) {
                peels += 1;
                console.log(`[TEST] Turn ${turn}: peel (pool ${peelResult.poolBefore}→${peelResult.poolAfter}).`);
                continue;
            }
        }

        const solved = solveAttemptFromBrowserState({
            boardCells: snap.boardCells,
            rackLetters: rackLettersFromSnap(snap)
        });

        if (solved.changed) {
            const pinnedPlacements = attachSnapshotTileIds(snap, solved.placements);
            const applied = await gameFrame.evaluate(({ placements, origin, gap, shouldPeel }) => {
                const base = window.applyPinnedPlacementsInFrame({ placements, origin, gap });
                if (!base.ok) return base;

                const g = window.game;
                let peeled = false;
                const poolBefore = g._tilePool.length;
                if (shouldPeel && g._allTilesPlaced?.()) {
                    g._bannerText = '';
                    peeled = g._checkPeel();
                }

                const nextSnap = window.snapshotBrowserState();
                return {
                    ok: true,
                    placed: base.placed,
                    peeled,
                    poolBefore,
                    poolAfter: g._tilePool.length,
                    nextSnap
                };
            }, {
                placements: pinnedPlacements,
                origin: snap.origin,
                gap: snap.gap,
                shouldPeel: solved.cleared
            });

            if (!applied.ok) {
                throw new Error(`Turn ${turn}: AI apply failed (${JSON.stringify(applied)})`);
            }

            if (applied.peeled) {
                peels += 1;
                console.log(
                    `[TEST] Turn ${turn}: AI place + peel `
                    + `(pool ${applied.poolBefore}→${applied.poolAfter}).`
                );
                snap = applied.nextSnap;
                continue;
            }

            const rackNote = solved.cleared ? 'rack cleared' : `rack left ${solved.rackLeft.join('')}`;
            console.log(`[TEST] Turn ${turn}: AI placed board (${rackNote}).`);
            snap = applied.nextSnap;
            continue;
        }

        if (!solved.changed && !solved.cleared && snap.poolLen >= 3) {
            console.log(`[TEST] Turn ${turn}: No progress, forcing fallback dump...`);
            solved.stuck = true;
        }

        if (solved.stuck) {
            const dumpResult = await gameFrame.evaluate(() => {
                const g = window.game;
                const origin = g.ORIGIN;
                const opts = g._rackLayoutOptions();
                const rackBounds = BananaGrid.getRackBounds(
                    { x: origin, y: origin },
                    opts.cols,
                    opts.gap,
                    opts.tileSize,
                    opts.handBelowCenter
                );
                const rackTiles = g.tiles.filter((t) => BananaGrid.isTileInRack(t, rackBounds, opts.tileSize));
                const tile = rackTiles[0] || g.tiles[0];
                if (!tile) return { ok: false, reason: 'no-tiles-at-all' };
                const poolBefore = g._tilePool.length;
                const ok = g._handleDump(tile);
                return {
                    ok,
                    poolBefore,
                    poolAfter: g._tilePool.length,
                    tileCount: g.tiles.length
                };
            });
            if (!dumpResult.ok) {
                throw new Error(`Dump failed turn ${turn}: ${JSON.stringify(dumpResult)}`);
            }
            dumps += 1;
            console.log(`[TEST] Turn ${turn}: dump (pool ${dumpResult.poolBefore}→${dumpResult.poolAfter}).`);

            // After dump, we should also snapshot the new state for the next turn
            snap = await gameFrame.evaluate(snapshotBrowserState());
            continue;
        }

        if (solved.cleared && !solved.changed && snap.rack.length) {
            console.log(`[TEST] Turn ${turn}: resync rack=${snap.rack.join('')} (pool=${snap.poolLen}).`);
            snap = await gameFrame.evaluate(snapshotBrowserState());
            continue;
        }

        if (solved.cleared && !solved.changed) {
            throw new Error(
                `Idle with empty rack but pool=${snap.poolLen} — cannot peel or place (turn ${turn})`
            );
        }

        throw new Error(
            `Stuck turn ${turn}: cleared=${solved.cleared} changed=${solved.changed} `
            + `rackLeft=${solved.rackLeft.join('')} browserRack=${snap.rack.join('')} reorgs=${solved.reorgs}`
        );
    }

    const end = await gameFrame.evaluate(snapshotBrowserState());
    throw new Error(
        `Full solo game did not finish in ${maxTurns} turns `
        + `(pool=${end.poolLen}, rack=${end.rack.length}, peels=${peels}, dumps=${dumps})`
    );
}

async function finishSoloAiWinWithDistributionCheck(gameFrame, label = 'solo-ai-win') {
    await gameFrame.waitForFunction(() => {
        const g = window.game;
        return !!(
            g?._postGameReview
            || g?._inReviewExperience?.()
            || g?.isOver
        );
    }, { timeout: STEP_MS });
    const dist = await assertTileDistributionInReview(gameFrame, `${label}-distribution`);
    console.log(
        `[TEST] SUCCESS: Tile distribution matches bag after AI win `
        + `(${dist.bagLabel}, ${dist.actualTotal} tiles: board=${dist.boardTiles}, pool=${dist.poolLen}).`
    );
}

function pauseTimeoutMs() {
    return Number(process.env.FIVE_PAUSE_TIMEOUT_MS || 3600000);
}

async function advanceSoloRoundAfterReview(page, gameFrame, roundLabel, { pause = false } = {}) {
    await waitSoloPostGameReview(gameFrame, STEP_MS);
    if (pause) {
        console.log(`[TEST] Paused in review after ${roundLabel} — press Done to continue...`);
        await waitSoloFaceDownHand(gameFrame, pauseTimeoutMs());
    } else {
        await clickDone(gameFrame);
        await waitSoloFaceDownHand(gameFrame, STEP_MS);
    }
    return { gameFrame: await getGameFrame(page) };
}

/** Solo play-to-win session (--scenario=actions or --rounds=N). */
async function runSoloActionsSession(page, options = {}) {
    const { getRounds, isPaused } = require('../../../../shared/infra/run-config');
    const rounds = Math.max(1, Number(options.rounds ?? getRounds()) || 1);
    const pause = options.pause ?? isPaused();
    let gameFrame = null;

    console.log(
        `[TEST] Solo actions: play-to-win (${rounds} round${rounds > 1 ? 's' : ''}`
        + `${pause ? ', pause in review' : ''})...`
    );

    for (let round = 1; round <= rounds; round++) {
        console.log(`[TEST] Solo actions round ${round}/${rounds}...`);
        await runSoloFullGameAudit(page, {
            skipPrepare: round > 1,
            gameFrame: gameFrame || options.gameFrame
        });
        gameFrame = await getGameFrame(page);
        console.log(`[TEST] SUCCESS: Solo actions round ${round}/${rounds} complete.`);

        if (round < rounds) {
            const next = await advanceSoloRoundAfterReview(page, gameFrame, `round ${round}`, { pause });
            gameFrame = next.gameFrame;
            continue;
        }

        if (pause) {
            await waitSoloPostGameReview(gameFrame, STEP_MS);
            console.log(
                `[TEST] SUCCESS: Solo actions complete (${rounds} round${rounds > 1 ? 's' : ''}, paused in review).`
            );
            return;
        }
    }

    await clickDone(gameFrame);
    await waitSoloFaceDownHand(gameFrame, STEP_MS);
    console.log(
        `[TEST] SUCCESS: Solo actions playthrough complete (${rounds} round${rounds > 1 ? 's' : ''}).`
    );
}

module.exports = {
    ACTION_SLICES,
    SLICE_RUNNERS,
    prepareSoloUiSession,
    runPlacementChecks,
    runDumpChecks,
    runPeelChecks,
    runSoloActionsAudit,
    runSoloFullGameAudit,
    runSoloActionsSession
};
