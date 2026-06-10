/** Bananagrams — immutable tile letters + letter trace (prototype mixin). */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-canonical.js');
    Object.assign(G.prototype, {
            _mpCanonicalReset() {
                this._mpCanonicalById = {};
                this._mpFirstLetterCorruption = null;
                this._mpTileTimeline = {};
                this._mpLastGoodById = {};
                this._mpTraceTick = 0;
                this._mpIdPoolActive = false;
                this._mpFinalAuthoritySnapshot = null;
            },

            /** MP pool holds tile ids (not bare letters) after _mpMaterializeDeck. */
            _mpPoolUsesTileIds() {
                return this._mpPoolIsIdBased?.() ?? !!this._mpIdPoolActive;
            },

            /** True when pool entries are epoch-scoped tile ids (even if flag lagged). */
            _mpPoolIsIdBased() {
                if (this._mpIdPoolActive) return true;
                return Array.isArray(this._tilePool)
                    && this._tilePool.some((entry) => this._mpParseTileId?.(entry));
            },

            _mpEnsureIdPoolModeFromPool() {
                if (this._mpPoolIsIdBased()) this._mpIdPoolActive = true;
            },

            /**
             * Host: board.pool must not reintroduce owned or duplicate ids into authority pool.
             * Stale RTDB echoes can otherwise break partition before the next peel/dump.
             */
            _mpSanitizeBoardPoolForHost(pool, context = 'pool-sanitize') {
                if (!this.isHost?.() || !Array.isArray(pool)) return [];
                const owned = this._mpGlobalOwnedIdSet?.() || new Set();
                const seen = new Set();
                const out = [];
                const dropped = [];
                pool.forEach((id) => {
                    if (!id) return;
                    if (owned.has(id)) {
                        dropped.push({ id, reason: 'owned' });
                        return;
                    }
                    if (seen.has(id)) {
                        dropped.push({ id, reason: 'duplicate' });
                        return;
                    }
                    seen.add(id);
                    out.push(id);
                });
                if (dropped.length) {
                    console.error('[Bananagrams] host pool sanitize rejected entries', {
                        context,
                        dropped: dropped.slice(0, 8),
                        before: pool.length,
                        after: out.length
                    });
                }
                return out;
            },

            /** Host: drop owned/duplicate ids from live pool — pool authority follows membership. */
            _mpRepairHostPoolPartition(context = 'pool-repair') {
                if (!this.isHost?.() || !this._mpPoolIsIdBased?.()) return true;
                const before = this._tilePool?.length ?? 0;
                const sanitized = this._mpSanitizeBoardPoolForHost(this._tilePool, context);
                if (sanitized.length !== before) {
                    this._tilePool = sanitized;
                    this._syncHostPoolOnRoomCaches?.();
                }
                return true;
            },

            /** MP peel/dump/deal: id-pool only — legacy letter-pool must not run. */
            _mpAssertIdPoolForMutation(context = 'mutation') {
                if (!this._isMultiplayerMode?.()) return true;
                this._mpEnsureIdPoolModeFromPool?.();
                if (this._mpPoolIsIdBased?.()) return true;
                console.error('[Bananagrams] MP requires id-pool for mutation', {
                    context,
                    poolLen: this._tilePool?.length ?? 0,
                    poolSample: (this._tilePool || []).slice(0, 4)
                });
                return false;
            },

            /** Canonical ids for the active deal epoch only. */
            _mpCanonicalIdsForDeal() {
                const canon = this._mpCanonicalById || {};
                const epoch = this._mpDealEpoch();
                return Object.keys(canon).filter((id) => {
                    const parsed = this._mpParseTileId(id);
                    if (!parsed) return true;
                    if (parsed.epoch === null) return true;
                    return parsed.epoch === epoch;
                });
            },

            /** Resolve letter: canonical id lookup, else single-letter legacy string. */
            _mpLetter(idOrLetter) {
                if (!idOrLetter) return '';
                const canon = this._mpCanonicalById?.[idOrLetter];
                if (canon) return canon;
                if (this._mpParseTileId(idOrLetter)) return '';
                const norm = this._mpNormLetter(idOrLetter);
                return /^[A-Z]$/.test(norm) ? norm : '';
            },

            _mpPoolEntryLetter(entry) {
                if (this._mpIdPoolActive && this._mpParseTileId(entry)) {
                    return this._mpLetter(entry);
                }
                return this._mpNormLetter(entry);
            },

            _mpLetterSigFromPool(pool) {
                return this._mpLetterSigFromLetters(
                    (pool || []).map((entry) => this._mpPoolEntryLetter(entry))
                );
            },

            _mpOwnedEntriesFromIds(ids, faceUp = false) {
                return (ids || []).map((id) => ({ id, faceUp: !!faceUp }));
            },

            /** Membership entry: id + faceUp only — letters live in canonical. */
            _mpStripOwnedEntry(entry, faceUpDefault = false) {
                if (typeof entry === 'string') {
                    return { id: entry, faceUp: !!faceUpDefault };
                }
                if (!entry?.id) return null;
                return {
                    id: entry.id,
                    faceUp: entry.faceUp !== undefined ? !!entry.faceUp : !!faceUpDefault
                };
            },

            /** Normalize board/wire owned to id + faceUp (letters from canonical at projection). */
            _mpNormalizeBoardOwned(raw, faceUpDefault = false) {
                if (!raw?.length) return [];
                const seen = new Set();
                const out = [];
                raw.forEach((entry) => {
                    const norm = this._mpStripOwnedEntry(entry, faceUpDefault);
                    if (!norm?.id || seen.has(norm.id)) return;
                    seen.add(norm.id);
                    out.push(norm);
                });
                return out;
            },

            /** Resolve tile letters from canonical before merge/render. */
            _mpHydrateTiles(tiles) {
                if (!this._isMultiplayerMode?.() || !Array.isArray(tiles)) return tiles;
                if (!this._mpPoolUsesTileIds?.()) return tiles;
                return tiles.map((t) => {
                    if (!t?.id) return t;
                    const letter = this._mpLetter(t.id);
                    if (!letter) return t;
                    return letter !== t.letter ? { ...t, letter } : t;
                });
            },

            /** Merge board.canonical into local map — shared by pre-inventory ingest and lifecycle apply. */
            _mpMergeCanonicalFromBoard(board, options = {}) {
                if (options.hostSkipCanonical || !board?.canonical || typeof board.canonical !== 'object') {
                    return;
                }
                this._mpEnsureCanonicalMap();
                const entries = Object.entries(board.canonical);
                if (this.isHost?.()) {
                    if (!this._hostMayIngestBoardToAuthority?.(board, options)) {
                        return;
                    }
                    entries.forEach(([id, letter]) => {
                        if (!this._mpCanonicalEntryForCurrentDeal?.(id)) return;
                        const norm = this._mpNormLetter?.(letter) || letter;
                        const existing = this._mpCanonicalById[id];
                        if (existing && existing !== norm) {
                            console.error('[Bananagrams][canonical] host ingress letter drift — overwriting', {
                                id,
                                existing,
                                incoming: norm
                            });
                        }
                        this._mpCanonicalById[id] = norm;
                    });
                    return;
                }
                entries.forEach(([id, letter]) => {
                    this._mpCanonicalById[id] = this._mpNormLetter?.(letter) || letter;
                });
            },

            _mpEnsureIdPoolModeFromBoard(board) {
                if (!board) return;
                if (board.poolUsesTileIds
                    || (Array.isArray(board.pool)
                        && board.pool.some((e) => this._mpParseTileId?.(e)))) {
                    this._mpIdPoolActive = true;
                }
                this._mpEnsureIdPoolModeFromPool?.();
            },

            /**
             * Board apply: canonical map (+ host room-cache sync) before inventory merge.
             * Pool projection is _applyPoolFromBoardAuthority only.
             */
            _mpIngestBoardBeforeInventory(board) {
                if (!board) return;
                this._mpEnsureIdPoolModeFromBoard(board);
                this._mpMergeCanonicalFromBoard(board);
                if (!this.isHost?.() || !Array.isArray(board.pool)) return;
                const inReviewEarly = this._boardPhase?.(board) === BananagramsGame.MP_PHASE.REVIEW;
                const winActiveEarly = inReviewEarly
                    || !!(board.winnerUid || this._winnerUid || this._victoryRegistered);
                if (winActiveEarly) return;
                const local = this._tilePool?.length ?? 0;
                const boardPool = this._mpBoardPoolForCurrentDeal?.(board);
                const hostAuthoritative = this.gameStarted && !this._winnerUid;
                const remoteLen = boardPool?.length ?? 0;
                if (hostAuthoritative && local === 0 && remoteLen > 0
                    && (this._peelSeq || board.peelSeq || board.dumpSeq)) {
                    this._syncHostPoolOnRoomCaches?.();
                }
            },

            /** Host: freeze pool + owned ids + canonical before win clears live authority. */
            _mpFreezeFinalAuthoritySnapshot() {
                if (!this.isHost?.()) return null;
                const hasOwned = Object.values(this._mpOwned || {}).some((list) => list?.length);
                if (!this._mpIdPoolActive && !hasOwned) return null;
                const canonical = { ...(this._mpCanonicalById || {}) };
                const pool = [...(this._tilePool || [])];
                const ownedByPlayer = {};
                Object.entries(this._mpOwned || {}).forEach(([uid, list]) => {
                    ownedByPlayer[uid] = (list || []).map((t) => t.id);
                });
                const positionsByPlayer = {};
                Object.entries(this._mpPlayerLayouts || {}).forEach(([uid, layout]) => {
                    positionsByPlayer[uid] = Object.entries(layout || {}).map(([id, p]) => ({
                        id,
                        x: p.x,
                        y: p.y
                    }));
                });
                this._mpFinalAuthoritySnapshot = {
                    canonical,
                    pool,
                    ownedByPlayer,
                    positionsByPlayer
                };
                return this._mpFinalAuthoritySnapshot;
            },

            /**
             * Host MP deal: build all bag tiles as epoch-scoped ids + canonical letters.
             * Returns shuffled id[] — caller deals by splicing from pool ref.
             */
            _mpMaterializeDeck() {
                if (typeof BananaRules === 'undefined') return null;
                this._mpEnsureCanonicalMap();
                this._mpCanonicalReset();

                const cfg = typeof this._bagConfig === 'function'
                    ? this._bagConfig()
                    : { bunchCount: null };
                const playerCount = typeof this._getPlayerUids === 'function'
                    ? this._getPlayerUids().length
                    : 2;
                const bag = BananaRules.getTileBag('multiplayer', cfg, playerCount);
                const letters = BananaRules.buildShuffledPool(bag, cfg.bunchCount);
                const ids = letters.map((letter, i) => {
                    const id = this._mpMakeTileId(i);
                    this._mpCanonicalById[id] = this._mpNormLetter(letter);
                    return id;
                });
                this._mpIdPoolActive = true;
                this._nextTileId = ids.length;
                return ids;
            },

            /** Deal handSize tile ids from pool (mutates pool), with rack layout positions. */
            _mpDealTilesFromPoolIds(poolRef, origin, count) {
                if (typeof BananaRules === 'undefined' || !poolRef?.length) return [];
                const gap = BananaRules.TILE_GAP;
                const cols = BananaRules.COLS;
                const size = BananaRules.TILE_SIZE;
                const startX = origin.x - ((cols - 1) * gap + size) / 2;
                const startY = origin.y + BananaRules.HAND_BELOW_CENTER;
                const dealtIds = poolRef.splice(0, count);
                return dealtIds.map((id, idx) => {
                    const col = idx % cols;
                    const row = Math.floor(idx / cols);
                    return {
                        id,
                        x: startX + col * gap,
                        y: startY + row * gap,
                        faceUp: false
                    };
                });
            },

            /** Draw tile ids from id-pool (mutates pool). Host rejects draws already owned. */
            _mpDrawIdsFromPool(pool, count = 1) {
                if (!Array.isArray(pool) || count < 1 || pool.length < count) return [];
                const peek = pool.slice(0, count);
                if (this.isHost?.()) {
                    const owned = this._mpGlobalOwnedIdSet?.() || new Set();
                    for (const id of peek) {
                        this._mpAssertIdDealEpoch?.(id, 'draw-pool');
                        if (owned.has(id)) {
                            console.error('[Bananagrams] pool draw partition violation — id already owned', {
                                id,
                                context: 'draw-pool'
                            });
                            return [];
                        }
                    }
                }
                return pool.splice(0, count);
            },

            /**
             * Return dumped tile id to pool, shuffle, draw drawCount ids (mutates pool copy).
             * Rejects when the returned id is already in pool or draws overlap current hand.
             */
            _mpDumpTileIdToPool(pool, tileId, drawCount = 3, opts = {}) {
                if (!Array.isArray(pool) || pool.length < drawCount || !tileId) return [];
                this._mpAssertIdDealEpoch?.(tileId, 'dump-return');
                const handAfterRemove = opts.handAfterRemove instanceof Set
                    ? opts.handAfterRemove
                    : new Set(opts.handAfterRemove || []);
                // Membership authority: strip stale pool copies before return-to-pool shuffle.
                for (let i = pool.length - 1; i >= 0; i--) {
                    if (pool[i] === tileId) pool.splice(i, 1);
                }
                pool.push(tileId);
                for (let i = pool.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [pool[i], pool[j]] = [pool[j], pool[i]];
                }
                const drawn = pool.splice(0, drawCount);
                if (drawn.length !== drawCount) return [];
                if (new Set(drawn).size !== drawn.length) {
                    console.error('[Bananagrams] dump draw batch has duplicate ids', { drawn, tileId });
                    return [];
                }
                for (const id of drawn) {
                    if (handAfterRemove.has(id)) {
                        console.error('[Bananagrams] dump draw overlaps hand — partition broken', {
                            id,
                            tileId,
                            handSize: handAfterRemove.size
                        });
                        return [];
                    }
                }
                return drawn;
            },

            /** Active deal epoch = room resetCount (single authority). */
            _mpReadResetCount() {
                const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
                const fromRoom = S?.readResetCount?.(this.roomData)
                    ?? this.roomData?.global?.resetCount;
                if (typeof fromRoom === 'number' && fromRoom >= 0) return fromRoom;
                if (typeof this.lastResetCount === 'number' && this.lastResetCount >= 0) {
                    return this.lastResetCount;
                }
                return 0;
            },

            _mpDealEpoch() {
                return this._mpReadResetCount?.() ?? 0;
            },

            _mpMakeTileId(n) {
                return `${this._mpDealEpoch()}:t-${n}`;
            },

            _mpParseTileId(id) {
                const s = String(id || '');
                const scoped = s.match(/^(\d+):t-(\d+)$/);
                if (scoped) {
                    return { epoch: parseInt(scoped[1], 10), n: parseInt(scoped[2], 10) };
                }
                const legacy = s.match(/^t-(\d+)$/);
                if (legacy) return { epoch: null, n: parseInt(legacy[1], 10) };
                return null;
            },

            _mpIdMatchesDealEpoch(id) {
                const parsed = this._mpParseTileId(id);
                if (!parsed) return false;
                if (parsed.epoch === null) return true;
                return parsed.epoch === this._mpDealEpoch();
            },

            /** Pool ids from board only when dealEpoch and id epochs match this hand. */
            _mpBoardPoolForCurrentDeal(board) {
                if (!Array.isArray(board?.pool) || !board.pool.length) return null;
                const epoch = this._mpDealEpoch();
                if (board.dealEpoch != null && board.dealEpoch !== epoch) return null;
                for (const id of board.pool) {
                    const parsed = this._mpParseTileId(id);
                    if (parsed?.epoch != null && parsed.epoch !== epoch) return null;
                }
                return board.pool;
            },

            _mpCanonicalEntryForCurrentDeal(id) {
                if (!id) return false;
                const parsed = this._mpParseTileId(id);
                if (!parsed || parsed.epoch === null) return true;
                return parsed.epoch === this._mpDealEpoch();
            },

            _mpAssertIdDealEpoch(id, context = 'membership') {
                if (!id || !this.isHost?.() || !this._mpIdPoolActive) return;
                const parsed = this._mpParseTileId(id);
                if (!parsed || parsed.epoch === null) return;
                if (this._mpIdMatchesDealEpoch(id)) return;
                throw new Error(`[MP] wrong epoch id ${id} at ${context} `
                    + `(deal=${this._mpDealEpoch()}, idEpoch=${parsed.epoch})`);
            },

            /** Host reset/deal boundary: canon + pool + owned are exactly this epoch's 100 ids. */
            _mpAssertDealEpochMembership(context = 'epoch-check') {
                if (!this.isHost?.() || !this._mpPoolIsIdBased?.()) return true;
                const epoch = this._mpDealEpoch();
                const canon = this._mpCanonicalById || {};
                const expectedIds = this._mpCanonicalIdsForDeal?.() || [];
                const wrongCanon = Object.keys(canon).filter((id) => {
                    const parsed = this._mpParseTileId(id);
                    return parsed && parsed.epoch !== null && parsed.epoch !== epoch;
                });
                const seen = new Set();
                (this._tilePool || []).forEach((id) => {
                    this._mpAssertIdDealEpoch?.(id, `${context}:pool`);
                    seen.add(id);
                });
                Object.values(this._mpOwned || {}).forEach((list) => {
                    (list || []).forEach((t) => {
                        if (!t?.id) return;
                        this._mpAssertIdDealEpoch?.(t.id, `${context}:owned`);
                        seen.add(t.id);
                    });
                });
                const missing = expectedIds.filter((id) => !seen.has(id));
                const extra = [...seen].filter((id) => !canon[id]);
                if (wrongCanon.length || missing.length || extra.length || seen.size !== expectedIds.length) {
                    const payload = {
                        context,
                        epoch,
                        expected: expectedIds.length,
                        seen: seen.size,
                        wrongCanon: wrongCanon.slice(0, 8),
                        missing: missing.slice(0, 8),
                        extra: extra.slice(0, 8)
                    };
                    throw new Error(`[MP] deal epoch membership failed ${JSON.stringify(payload)}`);
                }
                return true;
            },

            /** Host ingress: membership ids only — ignore client letters; dedupe ids. */
            _mpIngressNormalizeOwned(owned, context = 'ingress', meta = {}) {
                const source = meta.source || context;
                const playerId = meta.playerId ?? null;
                const seen = new Set();
                const out = [];
                (owned || []).forEach((t) => {
                    if (!t?.id || seen.has(t.id)) return;
                    seen.add(t.id);
                    if (this.isHost?.() && this._mpIdPoolActive) {
                        this._mpAssertIdDealEpoch?.(t.id, `${context}:${source}`);
                    }
                    const observed = this._mpNormLetter(t.letter);
                    const canon = this._mpCanonicalById?.[t.id];
                    if (this.isHost?.() && canon && observed && /^[A-Z]$/.test(observed) && observed !== canon) {
                        this._mpLogLetterIdConflict?.({
                            ctx: 'ingress',
                            id: t.id,
                            kept: canon,
                            incoming: observed,
                            source,
                            owner: playerId
                        });
                    }
                    if (t.letter && !canon && meta.registerIfMissing === true) {
                        this._mpCanonicalRegister(t.id, t.letter, context);
                    }
                    out.push({ id: t.id, faceUp: !!t.faceUp });
                });
                if (this.isHost?.() && seen.size !== (owned || []).filter((t) => t?.id).length) {
                    console.error('[Bananagrams][ingress] duplicate owned ids dropped', {
                        context,
                        source,
                        playerId,
                        before: (owned || []).length,
                        after: out.length
                    });
                }
                return out;
            },

            _mpEnsureCanonicalMap() {
                if (!this._mpCanonicalById) this._mpCanonicalById = {};
                if (!this._mpTileTimeline) this._mpTileTimeline = {};
                if (!this._mpLastGoodById) this._mpLastGoodById = {};
            },

            _mpNormLetter(letter) {
                return String(letter || '').toUpperCase();
            },

            _mpTraceRound() {
                return this._peelSeq || this._dumpSeq || 0;
            },

            _mpTraceActionFromSource(source = '') {
                const s = String(source || '');
                if (s === 'dump-snapshot') return 'dump';
                if (s === 'peel-snapshot' || s === 'bananas-snapshot') return 'peel';
                if (s === 'rtdb' || s.includes('sync')) return 'sync';
                if (s.includes('review')) return 'review';
                if (s.includes('merge')) return 'merge';
                if (s === 'deal') return 'deal';
                return null;
            },

            _mpTraceParseAction(context = '') {
                const ctx = String(context || '');
                if (ctx.includes('dump')) return 'dump';
                if (ctx.includes('peel')) return 'peel';
                if (ctx.includes('review') || ctx.includes('victory')) return 'review';
                if (ctx.includes('sync') || ctx.includes('rtdb') || ctx.includes('mirror')) return 'sync';
                if (ctx.includes('merge')) return 'merge';
                if (ctx.includes('deal')) return 'deal';
                return 'other';
            },

            _mpLetterSigFromLetters(letters) {
                const counts = {};
                (letters || []).forEach((l) => {
                    const ch = this._mpNormLetter(l);
                    if (!/^[A-Z]$/.test(ch)) return;
                    counts[ch] = (counts[ch] || 0) + 1;
                });
                return Object.keys(counts).sort().map((k) => `${k}${counts[k]}`).join('');
            },

            _mpLetterSigFromTiles(tiles) {
                return this._mpLetterSigFromLetters((tiles || []).map((t) => t?.letter));
            },

            _mpCombinedOwnedSig() {
                const letters = [];
                Object.values(this._mpOwned || {}).forEach((list) => {
                    (list || []).forEach((t) => {
                        letters.push(this._mpIdPoolActive
                            ? this._mpLetter(t?.id)
                            : t?.letter);
                    });
                });
                return this._mpLetterSigFromLetters(letters);
            },

            /** Id-pool invariant: every deal id in exactly one of pool or a single player's owned. */
            _mpIdPoolInvariantCheck(context = 'unknown') {
                if (!this.isHost?.() || !this._mpPoolIsIdBased?.()) return true;
                this._mpEnsureIdPoolModeFromPool?.();
                const canon = this._mpCanonicalById || {};
                const expectedIds = this._mpCanonicalIdsForDeal?.() || Object.keys(canon);
                const expected = expectedIds.length;
                const expectedSet = new Set(expectedIds);
                const seen = new Set();
                const poolCounts = {};
                const ownerOf = {};
                const partitionErrors = [];

                const claim = (id, where) => {
                    if (!id) return;
                    seen.add(id);
                    if (where === 'pool') {
                        poolCounts[id] = (poolCounts[id] || 0) + 1;
                        if (poolCounts[id] > 1) {
                            partitionErrors.push({ id, reason: 'duplicate-in-pool' });
                        }
                        if (ownerOf[id]) {
                            partitionErrors.push({ id, reason: 'pool-and-owned', owner: ownerOf[id] });
                        }
                        return;
                    }
                    if (ownerOf[id] && ownerOf[id] !== where) {
                        partitionErrors.push({ id, reason: 'multi-owner', owners: [ownerOf[id], where] });
                    }
                    ownerOf[id] = where;
                    if (poolCounts[id]) {
                        partitionErrors.push({ id, reason: 'pool-and-owned', owner: where });
                    }
                };

                (this._tilePool || []).forEach((id) => claim(id, 'pool'));
                Object.entries(this._mpOwned || {}).forEach(([uid, list]) => {
                    const seenInPlayer = new Set();
                    (list || []).forEach((t) => {
                        if (!t?.id) return;
                        if (seenInPlayer.has(t.id)) {
                            partitionErrors.push({ id: t.id, reason: 'duplicate-in-owned', owner: uid });
                        }
                        seenInPlayer.add(t.id);
                        claim(t.id, uid);
                    });
                });

                const myUid = this._myUid?.();
                if (myUid && Array.isArray(this.tiles)) {
                    const ownedIds = new Set((this._mpOwned?.[myUid] || []).map((t) => t.id));
                    this.tiles.forEach((t) => {
                        if (t?.id && !ownedIds.has(t.id)) {
                            partitionErrors.push({ id: t.id, reason: 'runtime-not-owned', owner: myUid });
                        }
                    });
                }

                const counts = {};
                const add = (letter) => {
                    const ch = this._mpNormLetter(letter);
                    if (!/^[A-Z]$/.test(ch)) return;
                    counts[ch] = (counts[ch] || 0) + 1;
                };
                seen.forEach((id) => add(canon[id]));
                const playerCount = typeof this._getPlayerUids === 'function'
                    ? this._getPlayerUids().length
                    : 2;
                const bag = typeof BananaRules !== 'undefined'
                    ? BananaRules.getMpBag(playerCount)
                    : {};
                const mismatches = [];
                const letters = new Set([...Object.keys(bag), ...Object.keys(counts)]);
                for (const letter of letters) {
                    const got = counts[letter] || 0;
                    const want = bag[letter] || 0;
                    if (got !== want) mismatches.push({ letter, got, want });
                }
                const total = seen.size;
                const missing = expectedIds.filter((id) => !seen.has(id));
                const extra = [...seen].filter((id) => !expectedSet.has(id) && !canon[id]);
                const wrongEpoch = [...seen].filter((id) => canon[id] && !expectedSet.has(id));
                if (mismatches.length || total !== expected || missing.length || extra.length
                    || wrongEpoch.length || partitionErrors.length) {
                    this._mpLogSnapshotSourceCompare?.();
                    const payload = {
                        context,
                        dealEpoch: this._mpDealEpoch?.(),
                        total,
                        expected,
                        missing: missing.slice(0, 6),
                        extra: extra.slice(0, 6),
                        wrongEpoch: wrongEpoch.slice(0, 6),
                        partitionErrors: partitionErrors.slice(0, 8),
                        mismatches: mismatches.slice(0, 12),
                        firstLetterCorruption: this._mpFirstLetterCorruption || null
                    };
                    console.error('[Bananagrams] MP id-pool invariant failed', payload);
                    this._lastMpDistCheck = payload;
                    return false;
                }
                this._mpLetterIntegrityCheck?.(context);
                this._lastMpDistCheck = {
                    context,
                    ok: true,
                    total,
                    expected,
                    mismatches: [],
                    partitionErrors: [],
                    firstLetterCorruption: this._mpFirstLetterCorruption || null
                };
                return true;
            },

            /** Record one tile-letter observation; timeline only, console on conflict. */
            traceTileLetter(opts = {}) {
                if (!this._isMultiplayerMode?.()) return;
                const tileId = opts.tileId;
                if (!tileId) return;
                this._mpEnsureCanonicalMap();
                const observed = this._mpNormLetter(opts.observedLetter);
                if (!/^[A-Z]$/.test(observed)) return;
                const canonical = opts.canonicalLetter !== undefined
                    ? this._mpNormLetter(opts.canonicalLetter)
                    : this._mpCanonicalById[tileId];
                const tick = opts.tick ?? (++this._mpTraceTick);
                const round = opts.round ?? this._mpTraceRound();
                const ctx = opts.ctx || opts.source || 'observe';
                const entry = {
                    ctx,
                    playerId: opts.playerId || null,
                    tileId,
                    observed,
                    canonical: canonical || null,
                    source: opts.source || 'unknown',
                    tick,
                    round
                };
                const timeline = this._mpTileTimeline[tileId] || (this._mpTileTimeline[tileId] = []);
                timeline.push(entry);
                if (timeline.length > 10) timeline.shift();

                const canonKnown = canonical && /^[A-Z]$/.test(canonical);
                const isBad = canonKnown && observed !== canonical;
                if (!isBad) {
                    this._mpLastGoodById[tileId] = entry;
                    return;
                }
                this._mpLogLetterIdConflict({
                    ctx,
                    id: tileId,
                    kept: canonical,
                    incoming: observed,
                    source: entry.source,
                    owner: entry.playerId
                });
                this._mpLogFirstLetterCorruption(ctx, tileId, canonical, observed, entry);
            },

            _mpLogLetterIdConflict({ ctx, id, kept, incoming, source, owner }) {
                console.error('[LETTER_ID_CONFLICT]', {
                    ctx,
                    id,
                    kept,
                    incoming,
                    source,
                    owner: owner ? String(owner).slice(-14) : null
                });
            },

            _mpLogFirstLetterCorruption(context, id, canonical, observed, traceEntry = null) {
                if (this._mpFirstLetterCorruption) return;
                const lastGood = this._mpLastGoodById?.[id];
                const action = this._mpTraceActionFromSource(traceEntry?.source)
                    || this._mpTraceParseAction(context);
                this._mpFirstLetterCorruption = {
                    id,
                    canonical,
                    observed,
                    previousOwner: lastGood?.playerId || null,
                    currentOwner: traceEntry?.playerId || null,
                    previousSource: lastGood?.source || null,
                    currentSource: traceEntry?.source || null,
                    lastGoodContext: lastGood?.ctx || null,
                    firstBadContext: context,
                    round: traceEntry?.round ?? this._mpTraceRound(),
                    action,
                    playerId: traceEntry?.playerId || null,
                    context
                };
                console.error('[FIRST_CORRUPT]', this._mpFirstLetterCorruption);
                this._mpPrintDistTrace(id);
            },

            _mpPrintDistTrace(id) {
                const timeline = (this._mpTileTimeline?.[id] || []).slice(-5);
                console.error(`[DIST_TRACE] ${id}`);
                timeline.forEach((e) => {
                    const bad = e.canonical && e.observed !== e.canonical;
                    const owner = e.playerId ? ` owner=${String(e.playerId).slice(-12)}` : '';
                    const mark = bad ? ' <-- first bad' : '';
                    console.error(`  ${e.ctx}: ${e.observed}${mark}${owner}`);
                });
            },

            _mpPoolAudit(action, detail = {}) {
                if (!this.isHost?.()) return;
                console.error(`[POOL] ${action}`, {
                    before: detail.beforePoolSig,
                    returned: detail.returnedTile,
                    drawn: detail.drawnTiles,
                    after: detail.afterPoolSig,
                    owned: detail.ownedSig,
                    combined: detail.combinedSig
                });
            },

            _mpLogSnapshotSourceCompare() {
                if (!this.isHost?.()) return;
                this._mpEnsureCanonicalMap();
                const canon = this._mpCanonicalById || {};
                const canonIds = Object.keys(canon);
                if (!canonIds.length) return;

                const drift = (tiles, label) => {
                    const out = [];
                    (tiles || []).forEach((t) => {
                        if (!t?.id) return;
                        const want = canon[t.id];
                        if (!want) return;
                        const got = this._mpNormLetter(t.letter);
                        if (got !== want) out.push({ id: t.id, want, got, src: label });
                    });
                    return out;
                };

                const hostUid = this._myUid();
                const guestUid = (this._getPlayerUids?.() || []).find((u) => u !== hostUid);
                const board = this._mpBoardFromRoom?.(this.roomData) || {};
                const rtdbOwned = [
                    ...(board.tilesOwnedByPlayer?.[hostUid] || []),
                    ...(guestUid ? (board.tilesOwnedByPlayer?.[guestUid] || []) : [])
                ];
                const reviewOrig = guestUid
                    ? [
                        ...(this._reviewLayouts?.[hostUid] || []),
                        ...(this._reviewLayouts?.[guestUid] || [])
                    ]
                    : (this._reviewLayouts?.[hostUid] || []);

                const pack = (list) => list.slice(0, 6).map((d) => `${d.id}:${d.got}≠${d.want}`);
                console.error('[DIST_SRC]', {
                    hostOwned: pack(drift(this._mpOwned?.[hostUid], 'host-owned')),
                    guestOwned: pack(drift(guestUid ? this._mpOwned?.[guestUid] : [], 'guest-owned')),
                    hostRuntime: pack(drift(this.tiles, 'host-runtime')),
                    rtdb: pack(drift(rtdbOwned, 'rtdb')),
                    reviewOrig: pack(drift(reviewOrig, 'review-orig'))
                });
            },

            /** Register a new tile id or return existing canonical letter (immutable). */
            _mpCanonicalRegister(id, letter, context = 'register') {
                if (!id || !letter) return this._mpNormLetter(letter);
                if (this._mpIdPoolActive && this._mpParseTileId(id)
                    && !this._mpIdMatchesDealEpoch(id)) {
                    return this._mpNormLetter(letter);
                }
                this._mpEnsureCanonicalMap();
                const canon = this._mpNormLetter(letter);
                const prev = this._mpCanonicalById[id];
                if (prev === undefined) {
                    this._mpCanonicalById[id] = canon;
                    this.traceTileLetter({
                        ctx: context,
                        playerId: this._myUid?.(),
                        tileId: id,
                        observedLetter: canon,
                        canonicalLetter: canon,
                        source: context.includes('deal') ? 'deal' : 'register',
                        round: this._mpTraceRound()
                    });
                    return canon;
                }
                if (prev !== canon) {
                    this.traceTileLetter({
                        ctx: context,
                        tileId: id,
                        observedLetter: canon,
                        canonicalLetter: prev,
                        source: 'register',
                        round: this._mpTraceRound()
                    });
                    return prev;
                }
                return canon;
            },

            _mpCanonicalLetter(id, fallback, context = 'resolve', options = {}) {
                if (!id) return this._mpNormLetter(fallback);
                this._mpEnsureCanonicalMap();
                const prev = this._mpCanonicalById[id];
                const fb = this._mpNormLetter(fallback);
                if (prev === undefined) {
                    if (options.registerIfMissing && fallback) {
                        this._mpCanonicalById[id] = fb;
                    }
                    return fb;
                }
                if (fallback && fb !== prev) {
                    this.traceTileLetter({
                        ctx: context,
                        tileId: id,
                        observedLetter: fb,
                        canonicalLetter: prev,
                        source: options.source || context,
                        playerId: options.playerId,
                        round: this._mpTraceRound()
                    });
                }
                return prev;
            },

            _mpCanonicalRepairOwned(owned, context = 'repair-owned', meta = {}) {
                return (owned || []).map((t) => this._mpStripOwnedEntry(t)).filter(Boolean);
            },

            /** Guest canonical comes from board.canonical only — never seed from owned letters. */
            _mpCanonicalSeedFromOwned(_owned, _context = 'seed-owned', _playerId = null) {
            },

            _mpCanonicalRegisterDrawn(ownedEntries, context = 'draw', playerId = null) {
                (ownedEntries || []).forEach((t) => {
                    if (!t?.id) return;
                    const letter = this._mpLetter(t.id);
                    if (!letter) return;
                    this._mpCanonicalRegister(t.id, letter, context);
                    this.traceTileLetter({
                        ctx: context,
                        playerId: playerId || this._myUid?.(),
                        tileId: t.id,
                        observedLetter: letter,
                        canonicalLetter: letter,
                        source: context.includes('peel') ? 'peel-merge' : 'draw',
                        round: this._mpTraceRound()
                    });
                });
            },

            _mpGuestOwnedSnapshot(context = 'guest-owned-snapshot') {
                const me = this._myUid?.();
                const boardOwned = this._mpBoardFromRoom?.(this.roomData)?.tilesOwnedByPlayer?.[me] || [];
                const boardLetterById = new Map(
                    boardOwned.map((o) => [o.id, this._mpNormLetter(o.letter)])
                );
                return (this.tiles || []).map((t) => {
                    const boardLetter = boardLetterById.get(t.id);
                    const letter = boardLetter || this._mpNormLetter(t.letter);
                    if (boardLetter && boardLetter !== this._mpNormLetter(t.letter)) {
                        this.traceTileLetter({
                            ctx: context,
                            playerId: me,
                            tileId: t.id,
                            observedLetter: t.letter,
                            canonicalLetter: boardLetter,
                            source: 'dump-snapshot',
                            round: this._mpTraceRound()
                        });
                    }
                    return { id: t.id, letter, faceUp: !!t.faceUp };
                });
            },

            _mpLetterIntegrityCheck(context = 'letter-integrity') {
                if (!this._isMultiplayerMode?.()) return true;
                this._mpEnsureCanonicalMap();
                const seen = [];
                const addTile = (t, source, playerId) => {
                    if (!t?.id) return;
                    this.traceTileLetter({
                        ctx: `${context}:${source}`,
                        playerId,
                        tileId: t.id,
                        observedLetter: t.letter,
                        canonicalLetter: this._mpCanonicalById[t.id],
                        source,
                        round: this._mpTraceRound()
                    });
                    const observed = this._mpNormLetter(t.letter);
                    const canonical = this._mpCanonicalById[t.id];
                    if (canonical === undefined) {
                        if (this._mpIdPoolActive) return;
                        const trusted = source === 'rtdb' || source === 'deal' || source.includes('seed')
                            || source.includes('register') || source.includes('draw')
                            || (this.isHost?.() && String(source).includes('owned'));
                        if (trusted) {
                            this._mpCanonicalRegister(t.id, observed, `${context}:${source}`);
                        }
                        return;
                    }
                    if (canonical !== observed) seen.push({ id: t.id, canonical, observed, source });
                };
                if (this.isHost?.()) {
                    Object.entries(this._mpOwned || {}).forEach(([uid, list]) => {
                        (list || []).forEach((t) => addTile(t, 'host-owned', uid));
                    });
                }
                (this.tiles || []).forEach((t) => {
                    addTile(t, this.isHost?.() ? 'host-runtime' : 'guest-runtime', this._myUid?.());
                });
                return seen.length === 0;
            }
    });
})(typeof window !== 'undefined' ? window : global);
