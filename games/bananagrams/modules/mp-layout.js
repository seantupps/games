/** Bananagrams — mp-layout (prototype mixin). Requires game.js class first. */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) throw new Error('BananagramsGame must be defined before mp-layout.js');
    Object.assign(G.prototype, {
            getPersistKey() {
                const uid = this._myUid() || 'local';
                return `bananagrams_solo_${uid}`;
            },

            getLayoutPersistKey() {
                let room = this.roomId;
                if (!room || room === 'lobby') {
                    try {
                        room = new URLSearchParams(window.location.search).get('room');
                    } catch (_) { /* ignore */ }
                }
                const uid = this._myUid() || 'local';
                return `bananagrams_layout_${room || 'lobby'}_${uid}`;
            },

            getHandPersistKey() {
                let room = this.roomId;
                if (!room || room === 'lobby') {
                    try {
                        room = new URLSearchParams(window.location.search).get('room');
                    } catch (_) { /* ignore */ }
                }
                const uid = this._myUid() || 'local';
                return `bananagrams_hand_${room || 'lobby'}_${uid}`;
            },

            /** MP clients cache their own layout locally so refresh preserves in-progress boards. */
            _loadLocalLayout() {
                if (!this._isMultiplayerMode()) return {};
                try {
                    return JSON.parse(localStorage.getItem(this.getLayoutPersistKey()) || '{}') || {};
                } catch (_) {
                    return {};
                }
            },

            _saveLocalLayout(layout) {
                if (!this._isMultiplayerMode()) return;
                try {
                    localStorage.setItem(this.getLayoutPersistKey(), JSON.stringify(layout || {}));
                } catch (_) { /* ignore */ }
            },

            _layoutEpoch() {
                return this._mpReadResetCount?.() ?? 0;
            },

            _loadLocalHandRecord() {
                if (!this._isMultiplayerMode()) return { resetCount: null, hand: [] };
                try {
                    const raw = JSON.parse(localStorage.getItem(this.getHandPersistKey()) || '[]');
                    if (Array.isArray(raw)) return { resetCount: null, hand: raw };
                    if (raw && Array.isArray(raw.hand)) {
                        return {
                            resetCount: Number.isFinite(raw.resetCount) ? raw.resetCount : null,
                            hand: raw.hand
                        };
                    }
                    return { resetCount: null, hand: [] };
                } catch (_) {
                    return { resetCount: null, hand: [] };
                }
            },

            _loadLocalHand() {
                return this._loadLocalHandRecord().hand;
            },

            _saveLocalHand(hand) {
                if (!this._isMultiplayerMode()) return;
                try {
                    localStorage.setItem(this.getHandPersistKey(), JSON.stringify({
                        resetCount: this._layoutEpoch(),
                        hand: (hand || []).map((t) => ({
                            id: t.id,
                            x: Number.isFinite(t.x) ? Math.round(t.x) : 0,
                            y: Number.isFinite(t.y) ? Math.round(t.y) : 0,
                            faceUp: !!t.faceUp
                        }))
                    }));
                } catch (_) { /* ignore */ }
            },

            _clearLocalLayout() {
                try {
                    localStorage.removeItem(this.getLayoutPersistKey());
                    localStorage.removeItem(this.getHandPersistKey());
                } catch (_) { /* ignore */ }
            },

            _purgeLocalLayoutIds(ids) {
                if (!ids?.length) return;
                const drop = new Set(ids);
                const layout = this._loadLocalLayout();
                let layoutChanged = false;
                drop.forEach((id) => {
                    if (layout[id]) {
                        delete layout[id];
                        layoutChanged = true;
                    }
                });
                if (layoutChanged) this._saveLocalLayout(layout);
                const stored = this._loadLocalHandRecord();
                const hand = (stored.hand || []).filter((h) => !drop.has(h.id));
                if (hand.length !== (stored.hand || []).length) {
                    this._saveLocalHand(hand);
                }
            },

            _layoutFromTiles(tiles) {
                const layout = {};
                (tiles || []).forEach((t) => {
                    if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
                        layout[t.id] = { x: Math.round(t.x), y: Math.round(t.y) };
                    }
                });
                return layout;
            },

            /** Cache local tile positions; host also stages them for the next board write. */
            _persistMpLayout() {
                if (!this._isMultiplayerMode()) return;
                const uid = this._myUid();
                if (!uid) return;
                const layout = this._layoutFromTiles(this.tiles);
                this._saveLocalLayout(layout);
                this._saveLocalHand((this.tiles || []).map((t) => ({
                    id: t.id,
                    faceUp: !!t.faceUp,
                    x: Number.isFinite(t.x) ? Math.round(t.x) : 0,
                    y: Number.isFinite(t.y) ? Math.round(t.y) : 0
                })));
                if (!this.isHost()) return;
                this._hostEnsureMpStores();
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                this._mpPlayerLayouts[uid] = layout;
            },

            _pruneLayout(layout, owned) {
                const ids = new Set((owned || []).map((o) => o.id));
                const pruned = {};
                Object.entries(layout || {}).forEach(([id, p]) => {
                    if (!ids.has(id)) return;
                    if (this._mpIdMatchesDealEpoch?.(id) === false) return;
                    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                        pruned[id] = { x: p.x, y: p.y };
                    }
                });
                return pruned;
            },

            _letterMultisetSig(letters) {
                return (letters || []).map((l) => String(l || '').toUpperCase()).sort().join('');
            },

            _localLayoutMatchesOwned(ownedList, localHand, localLayout) {
                if (!ownedList?.length) return false;
                const epoch = this._layoutEpoch();
                const stored = this._loadLocalHandRecord?.() || { resetCount: null, hand: localHand };
                if (stored.resetCount != null && epoch > 0 && stored.resetCount !== epoch) return false;
                const pruned = this._pruneLayout(localLayout, ownedList);
                if (!Object.keys(pruned).length) return false;
                const hand = (stored.hand?.length ? stored.hand : localHand) || [];
                const epochOk = (t) => this._mpIdMatchesDealEpoch?.(t?.id) !== false;
                const ownedIds = ownedList.map((o) => o.id).filter(epochOk).sort();
                if (!hand.length) {
                    return Object.keys(pruned).length === ownedIds.length;
                }
                const handIds = hand.map((t) => t.id).filter(epochOk).sort();
                if (handIds.length !== ownedIds.length) return false;
                return handIds.every((id, i) => id === ownedIds[i]);
            },

            _hasSavedLocalLayoutForOwned(ownedList) {
                if (!ownedList?.length) return false;
                const localHand = this._loadLocalHand?.() || [];
                const localLayout = this._loadLocalLayout();
                return this._localLayoutMatchesOwned(ownedList, localHand, localLayout);
            },

            _shouldPersistMpLayout(ownedList, appliedLayout) {
                if (!this._isMultiplayerMode() || !this._myUid()) return false;
                if (!ownedList?.length) return true;
                const appliedKeys = Object.keys(appliedLayout || {});
                if (appliedKeys.length) return true;
                return !this._hasSavedLocalLayoutForOwned(ownedList);
            },

            _layoutMapForPlayer(board, uid, owned, options = {}) {
                const ownedList = owned || [];
                const remoteList = board?.tilePositionsByPlayer?.[uid];
                if (options.preferBoardLayout && Array.isArray(remoteList) && remoteList.length) {
                    return this._pruneLayout(this._positionsMapFromList(remoteList), ownedList);
                }
                const devSolvePending = this._bananaDevHook('pendingSolveLayout', board) === true;
                const remoteSolveLayout = this._bananaDevHook(
                    'preferRemoteSolveLayout',
                    board,
                    uid,
                    ownedList,
                    remoteList
                );
                if (remoteSolveLayout) return remoteSolveLayout;
                // Dev /b solve: host publishes full crossword layouts — never prefer stale local rack cache.
                if (devSolvePending) {
                    if (Array.isArray(remoteList) && remoteList.length) {
                        return this._pruneLayout(this._positionsMapFromList(remoteList), ownedList);
                    }
                    return {};
                }
                // Prefer local cached layout for the current player (refresh / in-play).
                if (uid === this._myUid()) {
                    if (ownedList.length) {
                        const stored = this._loadLocalHandRecord?.() || { resetCount: null, hand: [] };
                        const epoch = this._layoutEpoch();
                        const epochOk = stored.resetCount == null
                            || epoch === 0
                            || stored.resetCount === epoch;
                        const localLayout = this._loadLocalLayout();
                        const pruned = this._pruneLayout(localLayout, ownedList);
                        if (epochOk && Object.keys(pruned).length === ownedList.length) {
                            return pruned;
                        }
                        const localHand = stored.hand?.length ? stored.hand : (this._loadLocalHand?.() || []);
                        if (this._localLayoutMatchesOwned(ownedList, localHand, localLayout)) {
                            return pruned;
                        }
                        // Partial local layout (e.g. +1 peel tile not cached yet) beats stale board echo.
                        if (epochOk && Object.keys(pruned).length > 0) {
                            const ownedIdSet = new Set(ownedList.map((o) => o.id));
                            if (Object.keys(pruned).every((id) => ownedIdSet.has(id))) {
                                return pruned;
                            }
                        }
                    }
                }
                const list = board?.tilePositionsByPlayer?.[uid];
                if (Array.isArray(list) && list.length) {
                    return this._pruneLayout(this._positionsMapFromList(list), owned);
                }
                return {};
            },

            _importBoardLayoutIfNeeded(board, uid, _layout) {
                return this._layoutMapForPlayer(board, uid, board?.tilesOwnedByPlayer?.[uid] || []);
            },

            _rackTilesFromOwned(owned) {
                if (!owned?.length || typeof BananaRules === 'undefined') return [];
                const gap = BananaRules.TILE_GAP;
                const cols = BananaRules.COLS;
                const size = BananaRules.TILE_SIZE;
                const origin = { x: this.ORIGIN, y: this.ORIGIN };
                const startX = origin.x - ((cols - 1) * gap + size) / 2;
                const startY = origin.y + BananaRules.HAND_BELOW_CENTER;
                return owned.map((o, idx) => ({
                    id: o.id,
                    letter: this._mpLetter?.(o.id) || '',
                    faceUp: !!o.faceUp,
                    x: startX + (idx % cols) * gap,
                    y: startY + Math.floor(idx / cols) * gap
                }));
            }
    });
})(typeof window !== 'undefined' ? window : global);
