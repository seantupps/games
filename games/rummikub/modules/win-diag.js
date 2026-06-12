/** Win detection — spatial meld rules (touch clusters must each be valid melds). */
(function (global) {
    const G = global.RummikubGame;
    const WL = global.RummikubWinLog;
    if (!G) throw new Error('RummikubGame must be defined before win-diag.js');
    if (!WL) throw new Error('win-log.js must load before win-diag.js');

    const COLOR_ORDER = ['B', 'R', 'U', 'O'];

    function tilesVerifyTouch(a, b) {
        if (a.gridX != null && a.gridY != null && b.gridX != null && b.gridY != null) {
            return Math.abs(a.gridX - b.gridX) === 1 && a.gridY === b.gridY;
        }
        return RummikubGrid.tilesTouchHorizontal(a, b);
    }

    /** Touch clusters for verify — grid adjacency when aligned, else pixel edge-touch. */
    function extractVerifyClusters(tiles) {
        const list = (tiles || []).filter(Boolean);
        const seen = new Set();
        const clusters = [];
        for (const seed of list) {
            if (seen.has(seed.id)) continue;
            const cluster = [];
            const stack = [seed];
            seen.add(seed.id);
            while (stack.length) {
                const cur = stack.pop();
                cluster.push(cur);
                for (const other of list) {
                    if (seen.has(other.id)) continue;
                    if (tilesVerifyTouch(cur, other)) {
                        seen.add(other.id);
                        stack.push(other);
                    }
                }
            }
            clusters.push(cluster);
        }
        return clusters;
    }

    function clusterKindForCluster(cluster, coreTileFn) {
        const Core = RummikubCore;
        if (!Core?.isValidMeld || cluster.length < 3) return null;
        const toCore = (t) => coreTileFn(t);
        const byX = [...cluster].sort((a, b) => a.x - b.x || a.y - b.y);
        if (Core.isValidMeld({ kind: 'run', tiles: byX.map(toCore) })) return 'run';
        const byY = [...cluster].sort((a, b) => a.y - b.y || a.x - b.x);
        if (Core.isValidMeld({ kind: 'run', tiles: byY.map(toCore) })) return 'run';
        const byColor = [...cluster].sort((a, b) => {
            const ac = a.kind === 'joker' ? 'Z' : (a.color || 'Z');
            const bc = b.kind === 'joker' ? 'Z' : (b.color || 'Z');
            return COLOR_ORDER.indexOf(ac) - COLOR_ORDER.indexOf(bc);
        });
        if (Core.isValidMeld({ kind: 'group', tiles: byColor.map(toCore) })) return 'group';
        return null;
    }

    function sameGridRow(a, b) {
        if (a.gridY != null && b.gridY != null) return a.gridY === b.gridY;
        return Math.abs(a.y - b.y) <= 8;
    }

    function sameGridCol(a, b) {
        if (a.gridX != null && b.gridX != null) return a.gridX === b.gridX;
        return Math.abs(a.x - b.x) <= 8;
    }

    function sortByColor(tiles) {
        return [...tiles].sort((a, b) => {
            const ac = a.kind === 'joker' ? 'Z' : (a.color || 'Z');
            const bc = b.kind === 'joker' ? 'Z' : (b.color || 'Z');
            return COLOR_ORDER.indexOf(ac) - COLOR_ORDER.indexOf(bc);
        });
    }

    function contiguousChainContaining(tile, lineTiles, horizontal) {
        const sorted = [...lineTiles].sort((a, b) => {
            if (horizontal) {
                if (a.gridX != null && b.gridX != null) return a.gridX - b.gridX;
                return a.x - b.x;
            }
            if (a.gridY != null && b.gridY != null) return a.gridY - b.gridY;
            return a.y - b.y;
        });
        const idx = sorted.findIndex((t) => t.id === tile.id);
        if (idx < 0) return [];
        let left = idx;
        let right = idx;
        while (left > 0 && tilesVerifyTouch(sorted[left - 1], sorted[left])) left--;
        while (right < sorted.length - 1 && tilesVerifyTouch(sorted[right], sorted[right + 1])) right++;
        return sorted.slice(left, right + 1);
    }

    function longestValidRunContaining(tile, cluster, coreTileFn, horizontal) {
        const Core = RummikubCore;
        if (!Core?.isValidMeld) return null;
        const toCore = (t) => coreTileFn(t);
        const linePeers = cluster.filter((t) => (horizontal ? sameGridRow(t, tile) : sameGridCol(t, tile)));
        const chain = contiguousChainContaining(tile, linePeers, horizontal);
        if (chain.length < 3) return null;

        const tileIdx = chain.findIndex((t) => t.id === tile.id);
        let best = null;
        for (let i = 0; i <= tileIdx; i++) {
            for (let j = tileIdx; j < chain.length; j++) {
                const slice = chain.slice(i, j + 1);
                if (slice.length < 3) continue;
                if (Core.isValidMeld({ kind: 'run', tiles: slice.map(toCore) })) {
                    if (!best || slice.length > best.length) best = slice;
                }
            }
        }
        return best;
    }

    function validGroupContaining(tile, cluster, coreTileFn) {
        const Core = RummikubCore;
        if (!Core?.isValidMeld) return null;
        const toCore = (t) => coreTileFn(t);
        const tileValue = tile.value ?? tile.as?.value;
        if (tileValue == null && tile.kind !== 'joker') return null;

        const sameValue = cluster.filter((t) => {
            const v = t.value ?? t.as?.value;
            if (tile.kind === 'joker' || t.kind === 'joker') return v === tileValue || t.kind === 'joker' || tile.kind === 'joker';
            return v === tileValue;
        });
        if (sameValue.length < 3) return null;

        const rowChain = contiguousChainContaining(
            tile,
            sameValue.filter((t) => sameGridRow(t, tile)),
            true
        );
        if (rowChain.length >= 3 && rowChain.length <= 4) {
            const byColor = sortByColor(rowChain);
            if (Core.isValidMeld({ kind: 'group', tiles: byColor.map(toCore) })) return rowChain;
        }
        if (sameValue.length >= 3 && sameValue.length <= 4) {
            const byColor = sortByColor(sameValue);
            if (Core.isValidMeld({ kind: 'group', tiles: byColor.map(toCore) })) return sameValue;
        }
        return null;
    }

    function tileValue(t) {
        if (!t) return null;
        return t.value ?? t.as?.value ?? null;
    }

    function tileColor(t) {
        if (!t || t.kind === 'joker') return null;
        return t.color || null;
    }

    function isPartialRunSlice(slice) {
        if (!slice || slice.length < 2) return false;
        const nonJoker = slice.filter((t) => t.kind !== 'joker');
        if (!nonJoker.length) return slice.length >= 2;
        const colors = new Set(nonJoker.map(tileColor).filter(Boolean));
        if (colors.size > 1) return false;
        const sorted = [...slice].sort((a, b) => {
            if (a.gridX != null && b.gridX != null) return a.gridX - b.gridX;
            if (a.gridY != null && b.gridY != null && a.gridY !== b.gridY) return a.gridY - b.gridY;
            return (tileValue(a) || 0) - (tileValue(b) || 0);
        });
        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const cur = sorted[i];
            if (prev.kind === 'joker' || cur.kind === 'joker') continue;
            const pv = tileValue(prev);
            const cv = tileValue(cur);
            if (pv == null || cv == null || cv !== pv + 1) return false;
        }
        return true;
    }

    function isPartialGroupPair(slice) {
        if (!slice || slice.length !== 2) return false;
        const [a, b] = slice;
        if (a.kind !== 'joker' && b.kind !== 'joker') {
            const va = tileValue(a);
            const vb = tileValue(b);
            if (va == null || va !== vb) return false;
            const ca = tileColor(a);
            const cb = tileColor(b);
            return !!(ca && cb && ca !== cb);
        }
        const va = tileValue(a);
        const vb = tileValue(b);
        return va == null || vb == null || va === vb;
    }

    function longestPartialRunContaining(tile, cluster, coreTileFn, horizontal) {
        const Core = RummikubCore;
        const toCore = (t) => coreTileFn(t);
        const linePeers = cluster.filter((t) => (horizontal ? sameGridRow(t, tile) : sameGridCol(t, tile)));
        const chain = contiguousChainContaining(tile, linePeers, horizontal);
        if (chain.length < 2) return null;

        const tileIdx = chain.findIndex((t) => t.id === tile.id);
        let best = null;
        for (let i = 0; i <= tileIdx; i++) {
            for (let j = tileIdx; j < chain.length; j++) {
                const slice = chain.slice(i, j + 1);
                if (slice.length < 2) continue;
                if (slice.length >= 3 && Core?.isValidMeld?.({ kind: 'run', tiles: slice.map(toCore) })) continue;
                if (!isPartialRunSlice(slice)) continue;
                if (!best || slice.length > best.length) best = slice;
            }
        }
        return best;
    }

    function partialGroupContaining(tile, cluster) {
        const v = tileValue(tile);
        if (v == null && tile.kind !== 'joker') return null;

        const sameValue = cluster.filter((t) => {
            const tv = tileValue(t);
            if (tile.kind === 'joker' || t.kind === 'joker') {
                return tv === v || t.kind === 'joker' || tile.kind === 'joker';
            }
            return tv === v;
        });
        if (sameValue.length < 2) return null;

        const rowChain = contiguousChainContaining(
            tile,
            sameValue.filter((t) => sameGridRow(t, tile)),
            true
        );
        if (rowChain.length !== 2) return null;
        return isPartialGroupPair(rowChain) ? rowChain : null;
    }

    function bestValidMeldContaining(tile, cluster, coreTileFn) {
        let best = null;
        const consider = (meldTiles) => {
            if (!meldTiles || meldTiles.length < 3) return;
            if (!meldTiles.some((t) => t.id === tile.id)) return;
            if (!best || meldTiles.length > best.length) best = meldTiles;
        };

        if (clusterKindForCluster(cluster, coreTileFn)) consider(cluster);
        consider(longestValidRunContaining(tile, cluster, coreTileFn, true));
        consider(longestValidRunContaining(tile, cluster, coreTileFn, false));
        consider(validGroupContaining(tile, cluster, coreTileFn));
        return best;
    }

    /** Full melds (3+) or valid partial pairs (same-color run or same-number group). */
    function bestSelectGroupContaining(tile, cluster, coreTileFn) {
        const meld = bestValidMeldContaining(tile, cluster, coreTileFn);
        if (meld) return meld;

        let best = null;
        const consider = (tiles) => {
            if (!tiles || tiles.length < 2) return;
            if (!tiles.some((t) => t.id === tile.id)) return;
            if (!best || tiles.length > best.length) best = tiles;
        };

        consider(longestPartialRunContaining(tile, cluster, coreTileFn, true));
        consider(longestPartialRunContaining(tile, cluster, coreTileFn, false));
        consider(partialGroupContaining(tile, cluster));
        return best;
    }

    /** Tile ids in the valid meld containing `tile`, even when melds share an edge. Same zone only. */
    function validMeldIdsForTile(tiles, tile, coreTileFn) {
        if (!tile?.zone) return null;
        const zonePeers = (tiles || []).filter((t) => t?.zone === tile.zone);
        for (const cluster of extractVerifyClusters(zonePeers)) {
            if (!cluster.some((t) => t.id === tile.id)) continue;
            const group = bestSelectGroupContaining(tile, cluster, coreTileFn);
            if (group) return group.map((t) => t.id);
        }
        return null;
    }

    Object.assign(G.prototype, {
        _validMeldIdsForTile(tile) {
            return validMeldIdsForTile(this.tiles, tile, (t) => this._coreTile(t));
        },
        _storeWinDiag(diag) {
            this._lastWinDiag = diag;
            if (typeof window !== 'undefined') {
                window.__lastRummikubWinCheck = diag;
            }
        },

        _corePoolFromTiles(tiles) {
            return (tiles || []).map((t) => this._coreTile(t));
        },

        /**
         * Rules check: every in-play tile in a touch-cluster that is a valid run or group.
         * Rack vs table is only spawn zone — same matching rules for all tiles.
         */
        _verifySpatial(tiles) {
            const fail = (reason, extra = {}) => ({
                solved: false,
                remaining: tiles?.length || 0,
                melded: 0,
                meldCount: 0,
                elapsedMs: 0,
                method: 'spatial',
                reason,
                clusters: [],
                invalidClusters: [],
                meldLabels: [],
                unmatchedTiles: [],
                unmatchedTileBriefs: [],
                ...extra
            });

            if (!tiles?.length) return fail('no-tiles');

            const t0 = Date.now();
            const clusters = extractVerifyClusters(tiles);
            const pool = this._corePoolFromTiles(tiles);
            const invalidClusters = [];
            const meldLabels = [];
            const unmatchedTiles = [];
            let melded = 0;
            const coreTileFn = (t) => this._coreTile(t);

            WL.log('verify', `spatial check (${tiles.length} tiles, ${clusters.length} cluster(s))`, {
                histogram: WL.poolHistogram(pool)
            }, { minLevel: 2 });

            clusters.forEach((cluster, idx) => {
                const briefs = cluster.map((t) => WL.tileBrief(coreTileFn(t)));
                if (cluster.length < 3) {
                    invalidClusters.push({
                        index: idx,
                        size: cluster.length,
                        tiles: briefs,
                        reason: 'too-small'
                    });
                    unmatchedTiles.push(...cluster);
                    return;
                }
                const kind = clusterKindForCluster(cluster, coreTileFn);
                if (!kind) {
                    invalidClusters.push({
                        index: idx,
                        size: cluster.length,
                        tiles: briefs,
                        reason: 'invalid-meld'
                    });
                    unmatchedTiles.push(...cluster);
                    return;
                }
                melded += cluster.length;
                meldLabels.push(`${kind.toUpperCase()}[${briefs.join(' ')}]`);
            });

            const remaining = tiles.length - melded;
            const unmatchedTileBriefs = unmatchedTiles.map((t) => WL.tileBrief(this._coreTile(t)));
            const solved = remaining === 0 && invalidClusters.length === 0 && tiles.length > 0;
            const out = {
                solved,
                remaining,
                melded,
                meldCount: meldLabels.length,
                elapsedMs: Date.now() - t0,
                method: 'spatial',
                reason: solved
                    ? 'all-clusters-valid'
                    : (invalidClusters.length ? 'invalid-clusters' : 'orphan-tiles'),
                clusters: clusters.length,
                invalidClusters,
                meldLabels,
                orphanTiles: invalidClusters.flatMap((c) => c.tiles),
                unmatchedTiles,
                unmatchedTileBriefs
            };

            WL.log(solved ? 'win' : 'verify', solved ? 'spatial OK' : 'spatial FAIL', {
                clusters: out.clusters,
                melds: out.meldCount,
                melded: out.melded,
                remaining: out.remaining,
                invalid: invalidClusters,
                meldLabels: meldLabels.slice(0, 6)
            }, { minLevel: 1 });

            return out;
        },

        _verifyTableSpatial(table) {
            return this._verifySpatial(table);
        },

        _verifyTablePartition(table, deadlineMs) {
            return this._verifySpatial(table);
        },

        _partitionTableWithDiag(table) {
            return this._verifySpatial(table);
        },

        _partitionTableTiles(table) {
            const diag = this._verifySpatial(table);
            return diag.solved ? diag : null;
        },

        _zoneMismatchTiles(tiles) {
            const origin = { x: this.ORIGIN, y: this.ORIGIN };
            const { startY } = RummikubRules.rackOrigin(origin, tiles.length);
            const rackLine = startY - RummikubRules.TILE_H * 0.5;
            return (tiles || []).filter((t) => {
                const onRackVisually = t.y >= rackLine;
                return (t.zone === 'rack' && !onRackVisually) || (t.zone === 'table' && onRackVisually);
            }).map((t) => ({
                id: t.id,
                zone: t.zone,
                y: Math.round(t.y),
                visual: t.y >= rackLine ? 'rack' : 'table',
                tile: WL.tileBrief(this._coreTile(t))
            }));
        },

        _evaluateWinCondition(trigger = 'check') {
            const tiles = this.tiles || [];
            const rackTiles = tiles.filter((t) => t.zone === 'rack');
            const tableTiles = tiles.filter((t) => t.zone === 'table');
            const pool = this._corePoolFromTiles(tiles);
            const diag = {
                trigger,
                at: Date.now(),
                canMutate: !!this.canMutatePlayingBoard?.(),
                isOver: !!this.isOver,
                postGameReview: !!this._postGameReview,
                totalTiles: tiles.length,
                rackCount: rackTiles.length,
                tableCount: tableTiles.length,
                blockedReason: null,
                zoneMismatches: this._zoneMismatchTiles(tiles),
                overlaps: RummikubGrid?.handHasOverlaps?.(tiles) || false,
                poolHistogram: pool,
                partition: null,
                wouldWin: false,
                won: false
            };

            WL.logCheckStart(trigger, diag);

            if (!diag.canMutate) {
                diag.blockedReason = diag.postGameReview ? 'in-review' : (diag.isOver ? 'game-over' : 'cannot-mutate');
                this._storeWinDiag(diag);
                WL.logCheckEnd(diag);
                return diag;
            }

            if (!diag.totalTiles) {
                diag.blockedReason = 'no-tiles';
                this._storeWinDiag(diag);
                WL.logCheckEnd(diag);
                return diag;
            }

            diag.partition = this._verifySpatial(tiles);

            if (diag.overlaps) {
                diag.blockedReason = 'tiles-overlap';
                diag.wouldWin = false;
                this._storeWinDiag(diag);
                WL.logCheckEnd(diag);
                return diag;
            }

            diag.wouldWin = !!diag.partition?.solved;

            if (!diag.wouldWin) {
                diag.blockedReason = `spatial-${diag.partition?.reason || 'failed'}`;
            }

            this._storeWinDiag(diag);
            WL.logCheckEnd(diag);
            return diag;
        },

        _checkWin(trigger = 'drag') {
            this._refineTableAlignment?.();
            const diag = this._evaluateWinCondition(trigger);
            if (diag.wouldWin && !diag.isOver && !diag.postGameReview) {
                this._refineTableAlignment?.();
                this._syncAllTileElements?.();
                diag.won = true;
                this._storeWinDiag(diag);
                WL.log('win', `victory triggered (${trigger})`, {
                    melds: diag.partition?.meldCount,
                    labels: diag.partition?.meldLabels
                });
                this._finishVictory();
            }
            return diag;
        }
    });
})(typeof window !== 'undefined' ? window : global);
