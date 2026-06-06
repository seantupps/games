/**
 * Dev chat only — /b solve N.
 * N = total tiles remaining in the shared bunch; each player keeps 1 on-board straggler when N > 0.
 */
(function (global) {
    const G = global.BananagramsGame;
    const Dev = global.BananaDev = global.BananaDev || {};
    if (!G) throw new Error('BananagramsGame must be defined before dev/board-solve.js');

    const boardSolveMethods = {
        _devSolveUsesIdPool() {
            return !!(this._isMultiplayerMode?.()
                && (this._mpPoolIsIdBased?.() || this._mpPoolUsesTileIds?.()));
        },

        _devSolveEntryLetter(entry) {
            if (typeof entry === 'string') {
                if (this._devSolveUsesIdPool()) {
                    const fromCanon = this._mpLetter?.(entry);
                    return fromCanon ? String(fromCanon).toUpperCase() : '';
                }
                const ch = entry.toUpperCase();
                return /^[A-Z]$/.test(ch) ? ch : '';
            }
            if (entry?.id) {
                const fromCanon = this._mpLetter?.(entry.id)
                    || this._mpCanonicalById?.[entry.id];
                if (fromCanon) return String(fromCanon).toUpperCase();
            }
            const ch = String(entry?.letter || '').toUpperCase();
            return /^[A-Z]$/.test(ch) ? ch : '';
        },

        _devSolveDictionary() {
            if (!this._dictReady || !this._checker || !this._dictNodes) return null;
            if (typeof BananaAi === 'undefined') return null;
            return BananaAi.createDictionary(this._checker, this._dictNodes, this._dictHeader || {});
        },

        _devSolveActiveUids() {
            if (!this._isMultiplayerMode()) {
                return [this._myUid?.() || this.uid || 'solo'];
            }
            if (!this.isHost()) return [];
            this._hostEnsureMpStores?.();
            const uids = this._peelPartyUids?.(this._myUid()) || this._getPlayerUids() || [];
            return [...new Set(uids.filter(Boolean))];
        },

        _devSolveCellSize() {
            if (typeof BananaGrid !== 'undefined' && BananaGrid.TILE_SIZE) return BananaGrid.TILE_SIZE;
            if (typeof BananaRules !== 'undefined' && BananaRules.TILE_GAP) return BananaRules.TILE_GAP;
            return 40;
        },

        _devSolvePlacementBounds(placements) {
            let minGx = Infinity;
            let maxGx = -Infinity;
            let minGy = Infinity;
            let maxGy = -Infinity;
            (placements || []).forEach((p) => {
                minGx = Math.min(minGx, p.gx);
                maxGx = Math.max(maxGx, p.gx);
                minGy = Math.min(minGy, p.gy);
                maxGy = Math.max(maxGy, p.gy);
            });
            return { minGx, maxGx, minGy, maxGy };
        },

        _devSolvePlaceStragglers(stragglers, placements, gap, origin) {
            const bounds = this._devSolvePlacementBounds(placements);
            const occupied = new Set();
            (placements || []).forEach((p) => {
                occupied.add(`${p.gx},${p.gy}`);
            });

            const touchesBlob = (gx, gy) => {
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (!dx && !dy) continue;
                        if (occupied.has(`${gx + dx},${gy + dy}`)) return true;
                    }
                }
                return false;
            };

            const midGy = Math.round((bounds.minGy + bounds.maxGy) / 2);
            const candidatesForIndex = (index) => [
                [bounds.maxGx + 4, midGy + index * 2],
                [bounds.minGx - 4, midGy + index * 2],
                [bounds.maxGx + 4, bounds.maxGy + 4 + index],
                [bounds.minGx - 4, bounds.minGy - 4 - index]
            ];

            for (let si = 0; si < stragglers.length; si++) {
                const tile = stragglers[si];
                let placed = false;
                for (const [gx, gy] of candidatesForIndex(si)) {
                    if (occupied.has(`${gx},${gy}`) || touchesBlob(gx, gy)) continue;
                    tile.x = origin + gx * gap;
                    tile.y = origin + gy * gap;
                    tile.faceUp = true;
                    occupied.add(`${gx},${gy}`);
                    placed = true;
                    break;
                }
                if (!placed) return { ok: false, reason: 'no-isolated-cell' };
            }
            return { ok: true };
        },

        _devSolveApplyLayout(crosswordEntries, stragglerEntry, solveResult) {
            const gap = this._devSolveCellSize();
            const origin = this.ORIGIN;
            const placements = solveResult.placements || [];
            const idQueues = {};
            (crosswordEntries || []).forEach((e) => {
                const L = String(e.letter || '').toUpperCase();
                if (!idQueues[L]) idQueues[L] = [];
                idQueues[L].push(e.id);
            });

            const tilesById = {};
            (crosswordEntries || []).forEach((e) => {
                tilesById[e.id] = {
                    id: e.id,
                    letter: String(e.letter || '').toUpperCase(),
                    faceUp: true
                };
            });
            if (stragglerEntry?.id) {
                tilesById[stragglerEntry.id] = {
                    id: stragglerEntry.id,
                    letter: String(stragglerEntry.letter || '').toUpperCase(),
                    faceUp: true
                };
            }

            let placedCount = 0;
            for (const p of placements) {
                const want = String(p.letter).toUpperCase();
                const queue = idQueues[want];
                if (!queue?.length) {
                    return { ok: false, reason: `missing-tile-id-${want}` };
                }
                const id = queue.shift();
                const tile = tilesById[id];
                if (!tile) return { ok: false, reason: `unknown-tile-id-${id}` };
                tile.x = origin + p.gx * gap;
                tile.y = origin + p.gy * gap;
                placedCount += 1;
            }

            const working = Object.values(tilesById);
            if (stragglerEntry?.id) {
                const placedTiles = working.filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
                const stragglers = working.filter((t) => t.id === stragglerEntry.id);
                const placed = this._devSolvePlaceStragglers(stragglers, placements, gap, origin);
                if (!placed.ok) return placed;
            }

            return {
                ok: true,
                tiles: working,
                placed: placedCount,
                stragglers: stragglerEntry ? 1 : 0
            };
        },

        _devSolveBagTotal() {
            if (typeof BananaRules === 'undefined') return null;
            const cfg = this._bagConfig?.() || { soloVariant: 'fast', bunchCount: null };
            const mode = this._tileBagMode?.() || (this._isMultiplayerMode() ? 'multiplayer' : 'solo');
            const playerCount = this._getPlayerUids?.().length || 2;
            const bag = BananaRules.getTileBag(mode, cfg, playerCount);
            return BananaRules.poolTotal(bag);
        },

        _devSolveCollectAllEntries(uids) {
            const entries = [];
            if (this._isMultiplayerMode()) {
                uids.forEach((uid) => {
                    (this._mpOwned?.[uid] || []).forEach((t) => {
                        if (!t?.id) return;
                        entries.push({
                            id: t.id,
                            letter: this._devSolveEntryLetter(t),
                            uid
                        });
                    });
                });
            } else {
                (this.tiles || []).forEach((t) => {
                    entries.push({
                        id: t.id,
                        letter: this._devSolveEntryLetter(t),
                        uid: this._myUid?.() || 'solo'
                    });
                });
            }
            (this._tilePool || []).forEach((entry, i) => {
                if (this._devSolveUsesIdPool()) {
                    const id = String(entry);
                    entries.push({
                        id,
                        letter: this._devSolveEntryLetter({ id }),
                        uid: null
                    });
                } else {
                    entries.push({
                        id: `__pool_${i}_${entry}`,
                        letter: String(entry).toUpperCase(),
                        uid: null
                    });
                }
            });
            entries.sort((a, b) => String(a.id).localeCompare(String(b.id)));
            return entries;
        },

        _devSolveShuffleEntries(entries, uids, n) {
            const out = [...entries];
            let seed = 0;
            const key = `${(uids || []).join(',')}|${n}|${out.length}`;
            for (let i = 0; i < key.length; i++) {
                seed = ((seed << 5) - seed + key.charCodeAt(i)) | 0;
            }
            for (let i = out.length - 1; i > 0; i--) {
                seed = (seed * 1103515245 + 12345) | 0;
                const j = (seed >>> 0) % (i + 1);
                [out[i], out[j]] = [out[j], out[i]];
            }
            return out;
        },

        /**
         * N = total shared bunch size after solve.
         * Each player: crossword + (N > 0 ? 1 visible straggler : 0).
         */
        _devSolvePartitionEntries(entries, uids, n) {
            const P = uids.length;
            const T = entries.length;
            const poolTotal = n;
            const stragglersPerPlayer = n > 0 ? 1 : 0;
            const boardTotal = T - poolTotal;
            if (boardTotal < P * (stragglersPerPlayer || 1)) {
                return { ok: false, reason: 'bad-partition', T, P, n, boardTotal };
            }
            const perPlayerBoard = boardTotal / P;
            const crosswordSize = perPlayerBoard - stragglersPerPlayer;
            if (!Number.isInteger(perPlayerBoard) || !Number.isInteger(crosswordSize)
                || crosswordSize < (n === 0 ? 2 : 1)) {
                return { ok: false, reason: 'bad-partition', T, P, n, perPlayerBoard, crosswordSize };
            }

            const poolEntries = entries.slice(0, poolTotal);
            const boardEntries = entries.slice(poolTotal);
            const partitions = {};
            for (let i = 0; i < uids.length; i++) {
                const uid = uids[i];
                const slice = boardEntries.slice(i * perPlayerBoard, (i + 1) * perPlayerBoard);
                const stragglerEntry = stragglersPerPlayer ? slice.pop() : null;
                const crosswordEntries = slice;
                if (crosswordEntries.length !== crosswordSize) {
                    return { ok: false, reason: 'slice-size', uid, expected: crosswordSize, got: crosswordEntries.length };
                }
                partitions[uid] = { crosswordEntries, stragglerEntry };
            }

            return {
                ok: true,
                partitions,
                poolEntries,
                poolIds: poolEntries.map((e) => e.id),
                poolLetters: poolEntries.map((e) => e.letter),
                poolTotal,
                crosswordSize,
                stragglersPerPlayer,
                totalTiles: T,
                playerCount: P
            };
        },

        _devSolveVerifyDisconnected(tiles, stragglersOnBoard) {
            const onBoard = (tiles || []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
            if (!onBoard.length) return stragglersOnBoard === 0;
            const { disconnected } = BananaGrid.largestComponentTiles(onBoard);
            if (disconnected !== stragglersOnBoard) return false;
            if (stragglersOnBoard === 0) return true;
            const singles = BananaGrid.boardIslandSizes(onBoard).filter((s) => s === 1).length;
            return singles === stragglersOnBoard;
        },

        _devSolveApplyToLocalHand(tiles) {
            const mapped = tiles.map((t) => ({
                id: t.id,
                letter: this._devSolveEntryLetter(t) || t.letter,
                x: t.x,
                y: t.y,
                faceUp: !!t.faceUp
            }));
            this.tiles = this._mpHydrateTiles?.(mapped) || mapped;
            this.started = this.tiles.length > 0;
            this._persistMpLayout?.();
            if (!this._isMultiplayerMode()) this.persistState?.();
            this.requestRender?.();
        },

        _devSolveApplyHostPlayer(uid, appliedTiles) {
            const hydrated = (appliedTiles || []).map((t) => ({
                id: t.id,
                letter: this._devSolveEntryLetter(t) || t.letter,
                x: t.x,
                y: t.y,
                faceUp: !!t.faceUp
            }));
            if (typeof this._hostSetPlayerTiles === 'function') {
                this._hostSetPlayerTiles(uid, hydrated, true, {
                    allowTilesToOwned: true,
                    source: 'dev-solve'
                });
                return;
            }
            this._hostEnsureMpStores?.();
            this._mpOwned[uid] = hydrated.map((t) => ({ id: t.id, faceUp: !!t.faceUp }));
            if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
            this._mpPlayerLayouts[uid] = this._positionsMapFromList?.(
                hydrated.map((t) => ({ id: t.id, x: t.x, y: t.y }))
            ) || Object.fromEntries(
                hydrated.map((t) => [t.id, { x: t.x, y: t.y }])
            );
            if (uid === this._myUid()) {
                this._devSolveApplyToLocalHand(hydrated);
            }
        },

        _devSolveSnapshotState() {
            const clone = (val) => (val == null ? val : JSON.parse(JSON.stringify(val)));
            return {
                tiles: clone(this.tiles),
                tilePool: [...(this._tilePool || [])],
                mpOwned: clone(this._mpOwned),
                mpPlayerLayouts: clone(this._mpPlayerLayouts),
                mpInventorySeq: clone(this._mpInventorySeq),
                mpCanonicalById: clone(this._mpCanonicalById),
                devSolveSeq: this._devSolveSeq || 0,
                boardSeq: this._boardSeq ?? 0,
                gameStarted: !!this.gameStarted,
                started: !!this.started,
                gamePhase: this._gamePhase || null,
                winnerUid: this._winnerUid || null,
                victoryRegistered: !!this._victoryRegistered,
                isOver: !!this.isOver,
                postGameReview: !!this._postGameReview,
                hostReviewTransitionActive: !!this._hostReviewTransitionActive
            };
        },

        _devSolveRestoreState(snapshot) {
            if (!snapshot) return;
            const tiles = snapshot.tiles || [];
            this.tiles = this._mpHydrateTiles?.(tiles) || tiles.map((t) => ({ ...t }));
            this._tilePool = [...(snapshot.tilePool || [])];
            if (snapshot.mpOwned) {
                this._mpOwned = JSON.parse(JSON.stringify(snapshot.mpOwned));
            }
            if (snapshot.mpPlayerLayouts) {
                this._mpPlayerLayouts = JSON.parse(JSON.stringify(snapshot.mpPlayerLayouts));
            }
            if (snapshot.mpInventorySeq) {
                this._mpInventorySeq = JSON.parse(JSON.stringify(snapshot.mpInventorySeq));
            }
            if (snapshot.mpCanonicalById) {
                this._mpCanonicalById = JSON.parse(JSON.stringify(snapshot.mpCanonicalById));
            }
            this._devSolveSeq = snapshot.devSolveSeq || 0;
            this._boardSeq = snapshot.boardSeq ?? this._boardSeq;
            this.gameStarted = snapshot.gameStarted;
            this.started = snapshot.started;
            if (snapshot.gamePhase != null) this._gamePhase = snapshot.gamePhase;
            this._winnerUid = snapshot.winnerUid || null;
            this._victoryRegistered = !!snapshot.victoryRegistered;
            this.isOver = !!snapshot.isOver;
            this._postGameReview = !!snapshot.postGameReview;
            this._hostReviewTransitionActive = !!snapshot.hostReviewTransitionActive;
            this.requestRender?.();
        },

        _devSolveProjectCommit(uids, pendingByUid, poolIds) {
            this._hostEnsureMpStores?.();
            if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
            if (!this._mpInventorySeq) this._mpInventorySeq = {};

            uids.forEach((uid) => {
                const raw = pendingByUid[uid] || [];
                const hydrated = raw.map((t) => ({
                    id: t.id,
                    letter: this._devSolveEntryLetter(t) || t.letter,
                    x: t.x,
                    y: t.y,
                    faceUp: !!t.faceUp
                }));
                this._mpOwned[uid] = hydrated.map((t) => ({ id: t.id, faceUp: !!t.faceUp }));
                this._mpPlayerLayouts[uid] = this._positionsMapFromList?.(hydrated)
                    || Object.fromEntries(
                        hydrated
                            .filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y))
                            .map((t) => [t.id, { x: t.x, y: t.y }])
                    );
                this._mpInventorySeq[uid] = (this._mpInventorySeq[uid] || 0) + 1;
                if (uid === this._myUid?.()) {
                    this.tiles = this._mpHydrateTiles?.(hydrated) || hydrated;
                }
            });

            if (this._devSolveUsesIdPool()) {
                this._tilePool = [...poolIds];
            } else {
                this._tilePool = poolIds.map((id) => this._devSolveEntryLetter({ id }) || id);
            }
            this.started = uids.some((uid) => (pendingByUid[uid]?.length || 0) > 0);
            this._persistMpLayout?.();
            this.requestRender?.();
        },

        _devSolvePublishRollbackBoard(snapshot) {
            if (!this._isMultiplayerMode?.() || !this.isHost?.() || !snapshot) return false;
            if (typeof this._hostPublishBoard !== 'function') return false;
            const PLAYING = (typeof BananagramsGame !== 'undefined' && BananagramsGame.MP_PHASE)
                ? BananagramsGame.MP_PHASE.PLAYING
                : 'playing';
            const tilesOwnedByPlayer = snapshot.mpOwned || {};
            const tilePositionsByPlayer = {};
            Object.entries(snapshot.mpPlayerLayouts || {}).forEach(([uid, layout]) => {
                const list = Object.entries(layout || {})
                    .filter(([, p]) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
                    .map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y) }));
                if (list.length) tilePositionsByPlayer[uid] = list;
            });
            const board = this._cleanBoardPayload?.(this.serializeBoard?.()) || {};
            board.seq = snapshot.boardSeq ?? board.seq ?? 0;
            board.phase = PLAYING;
            board.pool = [...(snapshot.tilePool || [])];
            board.tilesOwnedByPlayer = JSON.parse(JSON.stringify(tilesOwnedByPlayer));
            board.tilePositionsByPlayer = tilePositionsByPlayer;
            board.inventorySeq = JSON.parse(JSON.stringify(snapshot.mpInventorySeq || {}));
            board.devSolveSeq = snapshot.devSolveSeq || 0;
            board.winnerUid = null;
            this._hostPublishBoard(board, 'dev-solve-rollback', {
                _traceCaller: 'dev-solve-rollback'
            });
            return true;
        },

        _devSolveAuthorityFailure(context, message, snapshot, post) {
            this._devSolveRestoreState(snapshot);
            this._devBoardSolveSkipViewport = false;
            if (this._isMultiplayerMode?.() && this.isHost?.()) {
                Dev.revertSolveSeq?.(this, snapshot?.devSolveSeq ?? 0);
                this._devSolvePublishRollbackBoard(snapshot);
            }
            const receipt = post(false, message, { reason: context });
            Dev.failAuthorityCommit?.(context, { message, receipt, phase: this.gamePhaseSnapshot?.() });
            return receipt;
        },

        applyDevBoardSolve(bunchRemaining) {
            const n = Number(bunchRemaining);
            const resultType = typeof HubProtocol !== 'undefined'
                ? (HubProtocol.MSG?.BOARD_SOLVE_RESULT || 'board-solve-result')
                : 'board-solve-result';

            const post = (ok, message, extra = {}) => {
                const receipt = {
                    type: resultType,
                    ok,
                    message,
                    phase: this.deriveGamePhase?.(),
                    boardSeq: this._boardSeq ?? 0,
                    devSolveSeq: this._devSolveSeq ?? 0,
                    ...extra
                };
                if (typeof window !== 'undefined') {
                    window.__lastBoardSolveReceipt = receipt;
                }
                window.parent.postMessage(receipt, '*');
                return receipt;
            };

            if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
                post(false, 'Usage: /b solve N — N must be a non-negative integer (total bunch remaining; 1 straggler per player when N > 0).');
                return;
            }
            if (!this.canMutatePlayingBoard?.()) {
                post(false, 'Cannot solve after win or during review. Click Done/reset first.');
                return;
            }
            if (!this._dictReady || !this._checker) {
                post(false, 'Dictionary is not loaded yet.');
                return;
            }
            if (typeof BananaAi === 'undefined' || typeof Dev.solveDevCrossword !== 'function') {
                post(false, 'AI solver is not loaded.');
                return;
            }
            const dictionary = this._devSolveDictionary();
            if (!dictionary) {
                post(false, 'AI dictionary adapter failed.');
                return;
            }
            if (this._isMultiplayerMode() && !this.isHost()) {
                post(false, 'Only the host can run /b solve in multiplayer.');
                return;
            }

            const uids = this._devSolveActiveUids();
            if (!uids.length) {
                post(false, 'No active players to solve.');
                return;
            }

            this._devBoardSolveSkipViewport = true;
            const bagTotal = this._devSolveBagTotal();
            const allEntries = this._devSolveCollectAllEntries(uids);
            if (bagTotal != null && allEntries.length !== bagTotal) {
                post(false, `Tile count mismatch: expected ${bagTotal} in bag+hands, got ${allEntries.length}.`);
                return;
            }
            const missingLetters = allEntries.filter((e) => !/^[A-Z]$/.test(e.letter || ''));
            if (missingLetters.length) {
                post(false, `Missing canonical letters for ${missingLetters.length} tile(s) (id-pool).`);
                return;
            }

            let plan = null;
            const solvesByUid = {};
            for (let attempt = 0; attempt < 4; attempt++) {
                const shuffled = this._devSolveShuffleEntries(allEntries, uids, n + attempt);
                const candidate = this._devSolvePartitionEntries(shuffled, uids, n);
                if (!candidate.ok) continue;

                const solves = {};
                let allSolved = true;
                for (const uid of uids) {
                    const letters = candidate.partitions[uid].crosswordEntries.map((e) => e.letter);
                    if (!letters.length && n === 0) continue;
                    const rackSolve = Dev.solveDevCrossword(letters, dictionary);
                    if (!rackSolve.cleared) {
                        allSolved = false;
                        break;
                    }
                    solves[uid] = rackSolve;
                }
                if (!allSolved) continue;
                plan = candidate;
                Object.assign(solvesByUid, solves);
                break;
            }

            if (!plan?.ok) {
                this._devBoardSolveSkipViewport = false;
                const reason = plan?.reason || 'no-solvable-partition';
                post(false, `Cannot solve ${allEntries.length} tile(s) for ${uids.length} player(s) with bunch=${n} (${reason}).`);
                return;
            }

            const stragglersOnBoard = plan.stragglersPerPlayer;
            const summaries = [];
            const pendingByUid = {};
            const mpHostCommit = this._isMultiplayerMode() && this.isHost?.();

            for (const uid of uids) {
                const part = plan.partitions[uid];
                if (!part?.crosswordEntries?.length && n === 0) {
                    summaries.push(`${uid}: no tiles`);
                    pendingByUid[uid] = [];
                    continue;
                }
                const rackSolve = solvesByUid[uid];
                if (!rackSolve?.cleared) {
                    post(false, `AI could not solve ${uid} crossword (${part.crosswordEntries.length} letters, bunch=${n}).`);
                    return;
                }

                const applied = this._devSolveApplyLayout(
                    part.crosswordEntries,
                    part.stragglerEntry,
                    rackSolve
                );
                if (!applied.ok) {
                    this._devBoardSolveSkipViewport = false;
                    post(false, `Apply failed for ${uid}: ${applied.reason}`);
                    return;
                }
                if (!this._devSolveVerifyDisconnected(applied.tiles, stragglersOnBoard)) {
                    this._devBoardSolveSkipViewport = false;
                    post(false, `Layout verify failed for ${uid} (expected ${stragglersOnBoard} on-board straggler(s)).`);
                    return;
                }

                const onBoard = applied.tiles.filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
                const gridCheck = stragglersOnBoard === 0
                    ? BananaGrid.validateGrid(onBoard, this._checker)
                    : BananaGrid.validateGridWithStragglers(onBoard, this._checker, stragglersOnBoard);
                if (!gridCheck.ok) {
                    this._devBoardSolveSkipViewport = false;
                    post(false, `Layout verify failed for ${uid}: grid-${gridCheck.reason}`);
                    return;
                }

                pendingByUid[uid] = applied.tiles;
                summaries.push(
                    `${uid}: ${applied.placed} in crossword`
                    + (stragglersOnBoard ? ', 1 straggler' : ' (fully connected)')
                    + (n ? ` (bunch=${n} total)` : '')
                );
            }

            const poolIds = plan.poolIds;
            const authoritySnapshot = mpHostCommit ? this._devSolveSnapshotState() : null;

            if (mpHostCommit) {
                this._devSolveProjectCommit(uids, pendingByUid, poolIds);
                this._ensurePlayStartedFromBoardActivity?.();
                Dev.bumpSolveSeq?.(this);
                const wrote = this._hostWriteBoard?.('playing', { immediate: true });
                if (wrote === false) {
                    return this._devSolveAuthorityFailure(
                        'dev-solve-write-blocked',
                        'Board write blocked by post-win state.',
                        authoritySnapshot,
                        post
                    );
                }
                const distOk = this._mpDistributionInvariantCheck?.('dev-solve');
                if (distOk === false) {
                    return this._devSolveAuthorityFailure(
                        'dev-solve-invariant',
                        'Tile distribution invariant failed after dev solve.',
                        authoritySnapshot,
                        post
                    );
                }
            } else {
                const soloUid = uids[0];
                const soloTiles = pendingByUid[soloUid];
                if (soloTiles) this._devSolveApplyToLocalHand(soloTiles);
                if (this._devSolveUsesIdPool()) {
                    this._tilePool = [...poolIds];
                } else {
                    this._tilePool = [...plan.poolLetters];
                }
                this._ensurePlayStartedFromBoardActivity?.();
            }

            this._devBoardSolveSkipViewport = false;
            post(true, `Solved ${uids.length} player(s) with ${n} tile(s) remaining in bunch.`, { lines: summaries });
            try {
                this._syncViewportAfterLayout?.();
            } catch (err) {
                console.error('[Bananagrams dev-solve] viewport sync failed after commit', err);
            }
        }
    };

    Dev.boardSolveMethods = boardSolveMethods;
})(typeof window !== 'undefined' ? window : global);
