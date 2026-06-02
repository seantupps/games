/**
 * Bananagrams rules helpers (tile bag, deal, peel, dump). Not synced to Cloud Functions.
 */
(function (global) {
    /** Full game / multiplayer — 144 tiles. */
    const TILE_BAG = Object.freeze({
        A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2, L: 5,
        M: 3, N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3, W: 3, X: 2, Y: 3, Z: 2
    });

    /** Solo fast — 50 tiles (default; 21 dealt → 29 in bunch). */
    const SOLO_FAST_TILE_BAG = Object.freeze({
        A: 5, B: 1, C: 1, D: 2, E: 5, F: 1, G: 1, H: 1, I: 4, J: 1, K: 1, L: 2,
        M: 1, N: 3, O: 4, P: 1, Q: 1, R: 3, S: 2, T: 3, U: 2, V: 1, W: 1, X: 1, Y: 1, Z: 1
    });

    /** Solo classic — 72 tiles (21 dealt, 51 in bunch). */
    const SOLO_CLASSIC_TILE_BAG = Object.freeze({
        A: 7, B: 2, C: 2, D: 3, E: 9, F: 1, G: 2, H: 2, I: 6, J: 1, K: 1, L: 3,
        M: 1, N: 4, O: 6, P: 1, Q: 1, R: 5, S: 3, T: 4, U: 3, V: 1, W: 1, X: 1, Y: 1, Z: 1
    });

    /** Scrabble distribution — 100 tiles (used as MP default). */
    const SCRABBLE_TILE_BAG = Object.freeze({
        A: 10, B: 2, C: 2, D: 4, E: 13, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
        M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
        Y: 2, Z: 1
    });

    /** @deprecated alias — default solo bag is fast (50). */
    const SOLO_TILE_BAG = SOLO_FAST_TILE_BAG;

    const SOLO_HAND = 21;
    const STARTING_HAND = 21;
    const MP_BAG = SCRABBLE_TILE_BAG;

    /**
     * MP testing only — set to e.g. 4 to deal fewer tiles; null = official rules.
     * Or pass ?hand=4 on the game iframe URL.
     */ 
    const MP_HAND_OVERRIDE = 21;

    /** Official deal size by player count (rules.txt). */
    function startingHandSize(playerCount) {
        if (MP_HAND_OVERRIDE != null) return MP_HAND_OVERRIDE;
        const n = Math.max(2, Math.min(8, playerCount | 0));
        if (n <= 4) return 21;
        if (n <= 6) return 15;
        return 11;
    }
    const COLS = 7;
    const TILE_SIZE = 40;
    const TILE_GAP = TILE_SIZE;
    /** World Y offset from board origin — rack sits in lower viewport (not vertically centered). */
    const HAND_BELOW_CENTER = 200;
    /**
     * Mobile default viewport only: subtract from focal Y (world px) so the rack sits
     * lower on screen. Increase to push rack south; decrease toward 0 to center more.
     */
    const MOBILE_RACK_FOCAL_BIAS = 150;
    /** Inset from viewport edges when placing peel/dump tiles (world px). */
    const SPAWN_VIEWPORT_PAD = 16;
    /**
     * Peel/dump tiles spawn at least this many tile gaps outside the crossword bbox.
     * Increase for farther spawns (e.g. 4–6); 0 allows adjacent cells.
     */
    const SPAWN_MIN_GAP_FROM_ANCHOR = 3;
    /** Random pick among this many farthest valid candidates (after min-gap filter). */
    const SPAWN_FAR_CANDIDATE_POOL = 32;

    function buildShuffledPool(bag = TILE_BAG, maxTiles = null) {
        const pool = [];
        Object.entries(bag).forEach(([letter, count]) => {
            for (let i = 0; i < count; i++) pool.push(letter);
        });
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const cap = maxTiles != null ? Number(maxTiles) : NaN;
        if (Number.isFinite(cap) && cap > 0 && cap < pool.length) {
            return pool.slice(0, cap);
        }
        return pool;
    }

    /**
     * URL overrides for testing: ?bag=classic|fast|multiplayer, ?bunch=80 (cap pool after shuffle).
     */
    function resolveBagConfig(params) {
        const src = params || new URLSearchParams(
            typeof window !== 'undefined' ? window.location.search : ''
        );
        const bagLabel = String(src.get('bag') || '').toLowerCase();
        let soloVariant = 'fast';
        if (bagLabel === 'classic' || bagLabel === '72' || bagLabel === 'solo-classic') {
            soloVariant = 'classic';
        } else if (bagLabel === 'fast' || bagLabel === '50' || bagLabel === 'solo-fast') {
            soloVariant = 'fast';
        }

        let bunchCount = null;
        const tilesRaw = src.get('tiles');
        if (tilesRaw != null && tilesRaw !== '') {
            const n = parseInt(tilesRaw, 10);
            if (Number.isFinite(n) && n > 0) bunchCount = n;
        } else {
            const bunchRaw = src.get('bunch');
            if (bunchRaw != null && /^\d+$/.test(String(bunchRaw))) {
                const n = parseInt(bunchRaw, 10);
                if (Number.isFinite(n) && n > 0) bunchCount = n;
            }
        }
        return { soloVariant, bunchCount };
    }

    function dealSoloHand(pool, origin, handSize = SOLO_HAND, nextId = 0) {
        const hand = pool.splice(0, handSize);
        const startX = origin.x - ((COLS - 1) * TILE_GAP + TILE_SIZE) / 2;
        const startY = origin.y + HAND_BELOW_CENTER;
        return hand.map((letter, idx) => {
            const col = idx % COLS;
            const row = Math.floor(idx / COLS);
            return {
                id: `t-${nextId + idx}`,
                letter,
                x: startX + col * TILE_GAP,
                y: startY + row * TILE_GAP,
                faceUp: false
            };
        });
    }

    function drawFromPool(pool, count = 1) {
        return pool.splice(0, count);
    }

    function dumpTile(pool, letter, drawCount = 3) {
        pool.push(letter);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return drawFromPool(pool, drawCount);
    }

    function getTileBag(mode, config = {}) {
        if (mode === 'multiplayer') return MP_BAG;
        const variant = config.soloVariant || 'fast';
        return variant === 'classic' ? SOLO_CLASSIC_TILE_BAG : SOLO_FAST_TILE_BAG;
    }

    function dealPlayerHand(pool, origin, handSize, nextId = 0) {
        return dealSoloHand(pool, origin, handSize, nextId);
    }

    function originDefaults() {
        return { x: 2400, y: 2400 };
    }

    function cellOccupied(x, y, existingTiles, size = TILE_SIZE) {
        const gx = Math.round(x / size);
        const gy = Math.round(y / size);
        return existingTiles.some((t) => {
            const tx = Math.round(t.x / size);
            const ty = Math.round(t.y / size);
            return tx === gx && ty === gy;
        });
    }

    function tilesOverlap(ax, ay, bx, by, size = TILE_SIZE) {
        return ax < bx + size && ax + size > bx && ay < by + size && ay + size > by;
    }

    function tileCellKey(x, y, size = TILE_SIZE) {
        return `${Math.round(x / size)},${Math.round(y / size)}`;
    }

    function spawnViewportPad() {
        return TILE_GAP / 2 + SPAWN_VIEWPORT_PAD;
    }

    function tilesEdgeAdjacent(a, b, gap = TILE_GAP) {
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        return (dx === gap && dy === 0) || (dx === 0 && dy === gap);
    }

    /** Largest edge-connected crossword cluster, or the whole hand if none. */
    function spawnAnchorTiles(existingTiles, gap = TILE_GAP) {
        const tiles = existingTiles || [];
        if (tiles.length <= 1) return tiles;

        const used = new Set();
        const components = [];
        for (const start of tiles) {
            if (used.has(start.id)) continue;
            const stack = [start];
            const component = [];
            used.add(start.id);
            while (stack.length) {
                const t = stack.pop();
                component.push(t);
                for (const other of tiles) {
                    if (used.has(other.id)) continue;
                    if (tilesEdgeAdjacent(t, other, gap)) {
                        used.add(other.id);
                        stack.push(other);
                    }
                }
            }
            if (component.length >= 2) components.push(component);
        }
        if (!components.length) return tiles;
        components.sort((a, b) => b.length - a.length);
        return components[0];
    }

    function spawnAnchorCentroid(anchorTiles, size = TILE_SIZE) {
        if (!anchorTiles?.length) return null;
        let sx = 0;
        let sy = 0;
        anchorTiles.forEach((t) => {
            sx += t.x + size / 2;
            sy += t.y + size / 2;
        });
        const n = anchorTiles.length;
        return { x: sx / n, y: sy / n };
    }

    function spawnAnchorBBox(anchorTiles, size = TILE_SIZE) {
        if (!anchorTiles?.length) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        anchorTiles.forEach((t) => {
            minX = Math.min(minX, t.x);
            minY = Math.min(minY, t.y);
            maxX = Math.max(maxX, t.x + size);
            maxY = Math.max(maxY, t.y + size);
        });
        return { minX, minY, maxX, maxY };
    }

    /** Squared distance from a point to the outside of a rect (0 if inside). */
    function distSqPointToRect(px, py, rect) {
        if (!rect) return 0;
        const dx = px < rect.minX ? rect.minX - px : px > rect.maxX ? px - rect.maxX : 0;
        const dy = py < rect.minY ? rect.minY - py : py > rect.maxY ? py - rect.maxY : 0;
        return dx * dx + dy * dy;
    }

    function intersectBounds(a, b) {
        return {
            left: Math.max(a.left, b.left),
            top: Math.max(a.top, b.top),
            right: Math.min(a.right, b.right),
            bottom: Math.min(a.bottom, b.bottom)
        };
    }

    /** World rect around existing tiles (for spawn when viewport is elsewhere). */
    function spawnClusterBounds(existingTiles, marginRows = 6, size = TILE_SIZE, gap = TILE_GAP) {
        const margin = gap * marginRows;
        if (!existingTiles?.length) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        existingTiles.forEach((t) => {
            minX = Math.min(minX, t.x);
            minY = Math.min(minY, t.y);
            maxX = Math.max(maxX, t.x + size);
            maxY = Math.max(maxY, t.y + size);
        });
        return {
            left: minX - margin,
            top: minY - margin,
            right: maxX + margin,
            bottom: maxY + margin
        };
    }

    /**
     * Prefer visible viewport, but keep search near the crossword when the two overlap little.
     */
    function spawnEffectiveBounds(existingTiles, viewportBounds, options = {}) {
        const size = TILE_SIZE;
        const gap = TILE_GAP;
        const minGapTiles = options.minGapFromAnchor ?? SPAWN_MIN_GAP_FROM_ANCHOR;
        const cluster = spawnClusterBounds(
            existingTiles,
            options.marginRows ?? 6,
            size,
            gap
        );
        if (!cluster) return viewportBounds;
        const inter = intersectBounds(cluster, viewportBounds);
        const wideEnough = inter.right - inter.left >= size * 2;
        const tallEnough = inter.bottom - inter.top >= size * 2;
        if (!wideEnough || !tallEnough) return cluster;
        const interW = inter.right - inter.left;
        const interH = inter.bottom - inter.top;
        const clusterW = cluster.right - cluster.left;
        const clusterH = cluster.bottom - cluster.top;
        const minMargin = Math.max(size * 2, minGapTiles * gap * 2 + size);
        if (interW < clusterW + minMargin || interH < clusterH + minMargin) {
            return cluster;
        }
        return inter;
    }

    /**
     * Place peel/dump tiles on visible cells, preferring spots away from the crossword.
     * Returns null if any letter cannot be placed.
     */
    function spawnAllocateSlots(existingTiles, letters, bounds, options = {}) {
        const gap = TILE_GAP;
        const size = TILE_SIZE;
        const n = letters?.length ?? 0;
        if (!n) return [];

        const pad = options.pad ?? spawnViewportPad();
        const poolSize = options.candidatePool ?? SPAWN_FAR_CANDIDATE_POOL;
        const minGapTiles = options.minGapFromAnchor ?? SPAWN_MIN_GAP_FROM_ANCHOR;
        const visibilityBounds = options.visibilityBounds ?? bounds;
        const searchBounds = options.visibilityBounds
            ? intersectBounds(bounds, visibilityBounds)
            : bounds;
        const left = searchBounds.left + pad;
        const top = searchBounds.top + pad;
        const right = searchBounds.right - pad - size;
        const bottom = searchBounds.bottom - pad - size;
        const minGX = Math.ceil(left / gap) * gap;
        const maxGX = Math.floor(right / gap) * gap;
        const minGY = Math.ceil(top / gap) * gap;
        const maxGY = Math.floor(bottom / gap) * gap;

        const occupied = new Set();
        const allTiles = [];
        (existingTiles || []).forEach((t) => {
            occupied.add(tileCellKey(t.x, t.y, size));
            allTiles.push(t);
        });

        const anchor = spawnAnchorTiles(allTiles, gap);
        const anchorBox = spawnAnchorBBox(anchor, size);

        const tileVisible = (x, y) => (
            x >= visibilityBounds.left + pad
            && y >= visibilityBounds.top + pad
            && x + size <= visibilityBounds.right - pad
            && y + size <= visibilityBounds.bottom - pad
        );

        const canPlace = (x, y) => {
            if (!tileVisible(x, y)) return false;
            if (occupied.has(tileCellKey(x, y, size))) return false;
            for (const t of allTiles) {
                if (tilesOverlap(x, y, t.x, t.y, size)) return false;
            }
            return true;
        };

        const collectCandidates = (minGap) => {
            const minEdge = Math.max(0, minGap) * gap;
            const minScore = minEdge * minEdge;
            const candidates = [];
            for (let y = minGY; y <= maxGY; y += gap) {
                for (let x = minGX; x <= maxGX; x += gap) {
                    if (!canPlace(x, y)) continue;
                    const px = x + size / 2;
                    const py = y + size / 2;
                    const score = distSqPointToRect(px, py, anchorBox);
                    if (score < minScore) continue;
                    candidates.push({ x, y, score });
                }
            }
            candidates.sort((a, b) => b.score - a.score);
            return candidates;
        };

        const pickCandidate = (candidates) => {
            if (!candidates.length) return null;
            const band = Math.min(candidates.length, poolSize);
            return candidates[Math.floor(Math.random() * band)];
        };

        const placed = [];
        for (let i = 0; i < n; i++) {
            let candidates = collectCandidates(minGapTiles);
            if (!candidates.length && minGapTiles > 0) {
                candidates = collectCandidates(0);
            }
            const spot = pickCandidate(candidates);
            if (!spot) return null;
            placed.push({ letter: letters[i], x: spot.x, y: spot.y });
            occupied.add(tileCellKey(spot.x, spot.y, size));
            allTiles.push({
                id: `__spawn_${i}`,
                letter: letters[i],
                x: spot.x,
                y: spot.y,
                faceUp: true
            });
        }
        return placed;
    }

    /** @see spawnAllocateSlots */
    function spawnDrawnInViewport(existingTiles, letters, bounds) {
        const slots = spawnAllocateSlots(existingTiles, letters, bounds);
        return slots || [];
    }

    /** @deprecated — use spawnDrawnInViewport with visible world bounds */
    function spawnDrawnAtCenter(existingTiles, letters, center) {
        const c = center || originDefaults();
        const span = Math.max(letters.length, 1) * TILE_GAP + TILE_SIZE * 2;
        return spawnDrawnInViewport(existingTiles, letters, {
            left: c.x - span,
            top: c.y - span * 2,
            right: c.x + span,
            bottom: c.y + HAND_BELOW_CENTER + TILE_SIZE
        });
    }

    /** @deprecated — MP peel inventory is applied in game.js; clients spawn layout locally. */
    function peelAllPlayersSplit(pool, ownedByUid, _positionsByUid, uids) {
        const drawn = {};
        uids.forEach((uid) => {
            const letters = drawFromPool(pool, 1);
            if (!letters.length) return;
            drawn[uid] = letters[0];
            if (!ownedByUid[uid]) ownedByUid[uid] = [];
            const id = `t-peel-${uid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            ownedByUid[uid].push({ id, letter: letters[0], faceUp: true });
        });
        return drawn;
    }

    /** Legacy — full tile objects in handsByUid (solo / tests). */
    function peelAllPlayers(pool, handsByUid, uids, origin) {
        const o = origin || originDefaults();
        const drawn = {};
        uids.forEach((uid) => {
            const letters = drawFromPool(pool, 1);
            if (letters.length) {
                drawn[uid] = letters[0];
                if (!handsByUid[uid]) handsByUid[uid] = [];
                const hand = handsByUid[uid];
                const [spot] = spawnDrawnAtCenter(hand, letters, o);
                hand.push({
                    id: `t-peel-${uid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    letter: letters[0],
                    x: spot.x,
                    y: spot.y,
                    faceUp: true
                });
            }
        });
        return drawn;
    }

    function poolTotal(bag) {
        return Object.values(bag).reduce((sum, n) => sum + n, 0);
    }

    const SCRABBLE_TILE_TOTAL = poolTotal(SCRABBLE_TILE_BAG);
    if (SCRABBLE_TILE_TOTAL !== 100) {
        throw new Error(`SCRABBLE_TILE_BAG must total 100, got ${SCRABBLE_TILE_TOTAL}`);
    }

    const BananaRules = {
        TILE_BAG,
        SOLO_TILE_BAG,
        SOLO_FAST_TILE_BAG,
        SOLO_CLASSIC_TILE_BAG,
        SCRABBLE_TILE_BAG,
        SOLO_HAND,
        resolveBagConfig,
        STARTING_HAND,
        COLS,
        TILE_SIZE,
        TILE_GAP,
        HAND_BELOW_CENTER,
        MOBILE_RACK_FOCAL_BIAS,
        SPAWN_VIEWPORT_PAD,
        SPAWN_MIN_GAP_FROM_ANCHOR,
        SPAWN_FAR_CANDIDATE_POOL,
        spawnViewportPad,
        spawnAnchorTiles,
        spawnAnchorCentroid,
        spawnAnchorBBox,
        distSqPointToRect,
        spawnClusterBounds,
        spawnEffectiveBounds,
        intersectBounds,
        spawnAllocateSlots,
        tileCellKey,
        MP_BAG,
        MP_HAND_OVERRIDE,
        getTileBag,
        startingHandSize,
        poolTotal,
        buildShuffledPool,
        dealSoloHand,
        dealPlayerHand,
        drawFromPool,
        dumpTile,
        peelAllPlayers,
        peelAllPlayersSplit,
        originDefaults,
        spawnDrawnAtCenter,
        spawnDrawnInViewport,
        tilesOverlap,
        cellOccupied
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BananaRules;
    } else {
        global.BananaRules = BananaRules;
    }
})(typeof window !== 'undefined' ? window : global);
