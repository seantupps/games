/**
 * Dev chat only — /solve N.
 * N = tiles left on the rack; remaining tiles partition into valid table melds.
 */
(function (global) {
    const G = global.RummikubGame;
    if (!G) throw new Error('RummikubGame must be defined before dev/board-solve.js');

    function poolFromTiles(game) {
        return (game.tiles || []).map((t) => {
            const core = game._coreTile(t);
            const out = { ...core, id: t.id };
            if (t.display) out.display = t.display;
            if (t.as) out.as = { ...t.as };
            return out;
        });
    }

    function poolMatchesMelds(pool, melds) {
        const poolIds = new Set(pool.map((t) => t.id));
        const meldTiles = (melds || []).flatMap((m) => m.tiles);
        if (meldTiles.length !== pool.length) return false;
        return meldTiles.every((t) => poolIds.has(t.id));
    }

    function meldsForBoard(originalMelds, boardTiles) {
        const boardIds = new Set(boardTiles.map((t) => t.id));
        const Core = RummikubCore;
        return (originalMelds || [])
            .map((m) => ({ kind: m.kind, tiles: m.tiles.filter((t) => boardIds.has(t.id)) }))
            .filter((m) => m.tiles.length >= 3 && Core.isValidMeld(m));
    }

    /** Use puzzle step-1 melds when the live pool is still the full dealt set. */
    function tryKnownSolution(pool, n, rng, originalMelds) {
        if (!originalMelds?.length || !poolMatchesMelds(pool, originalMelds)) return null;
        const Core = RummikubCore;

        if (n === 0) {
            return {
                ok: true,
                grid: Core.meldsToGrid(originalMelds),
                rack: [],
                attempts: 0,
                method: 'known-melds'
            };
        }

        for (let attempt = 0; attempt < 150; attempt++) {
            const shuffled = [...pool];
            rng.shuffle(shuffled);
            const rack = shuffled.slice(0, n);
            const rackIds = new Set(rack.map((t) => t.id));
            const boardTiles = pool.filter((t) => !rackIds.has(t.id));
            const melds = meldsForBoard(originalMelds, boardTiles);
            const covered = new Set(melds.flatMap((m) => m.tiles.map((t) => t.id)));
            if (covered.size !== boardTiles.length) continue;
            return {
                ok: true,
                grid: Core.meldsToGrid(melds),
                rack: Core.sortRack(rack),
                attempts: attempt + 1,
                method: 'known-melds-pick'
            };
        }
        return null;
    }

    function solvePoolWithStragglers(pool, n, rng, deadlineMs, originalMelds) {
        const Core = RummikubCore;
        const known = tryKnownSolution(pool, n, rng, originalMelds);
        if (known) return known;

        console.warn('[rummikub:solve] known layout miss — falling back to partition search', {
            pool: pool.length,
            n,
            hasOriginal: !!originalMelds?.length,
            matchesOriginal: poolMatchesMelds(pool, originalMelds)
        });

        if (n === 0) {
            const { result, grid, attempts } = Core.partitionBoardTiles(pool, rng, deadlineMs, { originalMelds });
            if (!Core.partitionIsSolved(result)) {
                return { ok: false, reason: 'partition-failed', attempts, remaining: result.remaining.length };
            }
            return { ok: true, grid, rack: [], attempts, method: 'partition' };
        }

        let attempts = 0;
        while (Date.now() < deadlineMs && attempts < 80) {
            attempts += 1;
            const shuffled = [...pool];
            rng.shuffle(shuffled);
            const rack = shuffled.slice(0, n);
            const boardPool = shuffled.slice(n);
            const part = Core.partitionBoardTiles(boardPool, rng, deadlineMs, { originalMelds });
            if (Core.partitionIsSolved(part.result)) {
                return {
                    ok: true,
                    grid: part.grid,
                    rack: Core.sortRack(rack),
                    attempts: attempts + part.attempts,
                    method: 'partition-pick'
                };
            }
        }
        return { ok: false, reason: 'no-straggler-partition', attempts };
    }

    Object.assign(G.prototype, {
        _applySolvedLayout(grid, rackCore) {
            const origin = { x: this.ORIGIN, y: this.ORIGIN };
            const byId = new Map((this.tiles || []).map((t) => [t.id, t]));
            const tableTiles = RummikubGrid.tilesFromCoreGrid(grid, origin).map((t) => {
                const prev = byId.get(t.id);
                return prev ? { ...prev, ...t } : t;
            });
            const rackTiles = RummikubGrid.layoutRack(
                rackCore.map((t) => {
                    const prev = byId.get(t.id);
                    return prev ? { ...prev, ...t } : { ...t };
                }),
                origin
            );
            this.tiles = [...tableTiles, ...rackTiles];
            this._ensurePlayStartedFromBoardActivity?.();
            this.requestRender();
        },

        applyDevBoardSolve(stragglerCount) {
            const n = Number(stragglerCount);
            const resultType = typeof HubProtocol !== 'undefined'
                ? (HubProtocol.MSG?.BOARD_SOLVE_RESULT || 'board-solve-result')
                : 'board-solve-result';

            const post = (ok, message, extra = {}) => {
                const seq = (window.__boardSolveSeq = (window.__boardSolveSeq || 0) + 1);
                const receipt = {
                    type: resultType,
                    ok,
                    message,
                    phase: this._postGameReview ? 'review' : 'playing',
                    solveSeq: seq,
                    ...extra
                };
                if (typeof window !== 'undefined') {
                    window.__lastBoardSolveReceipt = receipt;
                }
                window.parent.postMessage(receipt, '*');
                return receipt;
            };

            if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
                post(false, 'Usage: /solve N — N must be a non-negative integer (tiles left on the rack).');
                return;
            }
            if (!this.canMutatePlayingBoard?.()) {
                post(false, 'Cannot solve after win or during review. Click Done/reset first.');
                return;
            }
            const Core = RummikubCore;
            if (!Core?.partitionBoardTiles) {
                post(false, 'Solver is not loaded.');
                return;
            }

            const pool = poolFromTiles(this);
            if (!pool.length) {
                post(false, 'No tiles to solve.');
                return;
            }
            if (n >= pool.length) {
                post(false, `Cannot leave ${n} rack tile(s) — only ${pool.length} tile(s) in play.`);
                return;
            }

            const deadlineMs = Date.now() + (RummikubRules.SOLVE_DEADLINE_MS || 2000);
            const rng = Core.makeRng(Date.now() >>> 0);
            const solved = solvePoolWithStragglers(
                pool,
                n,
                rng,
                deadlineMs,
                this._originalMelds
            );

            if (!solved.ok) {
                const msg = `Cannot solve ${pool.length} tile(s) with ${n} on the rack (${solved.reason || 'failed'}).`;
                console.warn('[rummikub:solve] FAIL', msg, {
                    attempts: solved.attempts,
                    remaining: solved.remaining,
                    pool: global.RummikubWinLog?.histogramLine?.(pool) || pool.length
                });
                post(false, msg, {
                    lines: [
                        `Pool (${pool.length}): ${global.RummikubWinLog?.histogramLine?.(pool) || '?'}`,
                        `Attempts: ${solved.attempts ?? '?'}`,
                        `Reason: ${solved.reason || 'failed'}`
                    ]
                });
                return;
            }

            this._applySolvedLayout(solved.grid, solved.rack);
            const spatial = this._verifyTableSpatial?.(this.tiles.filter((t) => t.zone === 'table'));
            console.info('[rummikub:solve] OK', {
                method: solved.method,
                pool: pool.length,
                rack: n,
                onTable: pool.length - n,
                attempts: solved.attempts,
                histogram: global.RummikubWinLog?.histogramLine?.(pool),
                spatialOk: spatial?.solved,
                melds: spatial?.meldLabels
            });
            const onTable = pool.length - n;
            const lines = [
                `${onTable} tile(s) on the table in valid melds`,
                `${n} tile(s) on the rack`
            ];
            post(true, `Solved ${pool.length} tile(s) with ${n} on the rack.`, { lines });

            if (n === 0) {
                queueMicrotask(() => this._checkWin?.('solve'));
            }
        }
    });
})(typeof window !== 'undefined' ? window : global);
