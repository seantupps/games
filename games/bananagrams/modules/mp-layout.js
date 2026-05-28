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

            _clearLocalLayout() {
                try {
                    localStorage.removeItem(this.getLayoutPersistKey());
                } catch (_) { /* ignore */ }
            },

            _layoutFromTiles(tiles) {
                const layout = {};
                (tiles || []).forEach((t) => {
                    layout[t.id] = { x: Math.round(t.x), y: Math.round(t.y) };
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
                if (!this.isHost()) return;
                this._hostEnsureMpStores();
                if (!this._mpPlayerLayouts) this._mpPlayerLayouts = {};
                this._mpPlayerLayouts[uid] = layout;
            },

            _pruneLayout(layout, owned) {
                const ids = new Set((owned || []).map((o) => o.id));
                const pruned = {};
                Object.entries(layout || {}).forEach(([id, p]) => {
                    if (ids.has(id) && p && typeof p.x === 'number' && typeof p.y === 'number') {
                        pruned[id] = { x: p.x, y: p.y };
                    }
                });
                return pruned;
            },

            _layoutMapForPlayer(board, uid, owned) {
                if (uid === this._myUid() && !this.isHost()) {
                    const local = this._pruneLayout(this._loadLocalLayout(), owned);
                    if (Object.keys(local).length) return local;
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
                    letter: o.letter,
                    faceUp: !!o.faceUp,
                    x: startX + (idx % cols) * gap,
                    y: startY + Math.floor(idx / cols) * gap
                }));
            }
    });
})(typeof window !== 'undefined' ? window : global);
