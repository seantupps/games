class ColorPileGame extends BaseGame {
    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get('mode') || 'classic';
        this.initIdentity('piles', this.mode);
        this.colorVariableMap = { 'B': '--blue-color', 'R': '--red-color', 'G': '--green-color', 'Y': '--yellow-color' };
        // Multiplayer: board and freestyle colors are server-authoritative; never seed locally.
        if (!this.isMultiplayer) {
            this.initPiles();
            this.loadColors();
        } else {
            this.piles = { 'B': [], 'G': [], 'R': [] };
        }
        window.game = this;
        this.onIdentitySynced = () => {
            const key = `piecePositions_${this.gameName}_${this.mode}`;
            this.piecePositions = JSON.parse(localStorage.getItem(key) || '{}');
            this.updateTurnIndicator();
            this.hasInitialBoard = false;
            this.identitySynced = true;
            this.applyServerPileColors();
            if (this.isMultiplayer) return;
            const hasPieces = this.piles && Object.values(this.piles).some((arr) => arr && arr.length > 0);
            if (hasPieces) return;
            this.initPiles();
        };
    }

    hasServerBoard() {
        const board = this.roomData?.global?.board;
        if (!board) return false;
        return Object.values(board).flat().filter(Boolean).length > 0;
    }

    applyServerPileColors() {
        if (this.mode !== 'freestyle') return false;
        const pileColors = this.roomData?.global?.pileColors;
        if (!pileColors || typeof pileColors !== 'object') return false;
        const types = ['B', 'R', 'G', 'Y'];
        if (!types.every(t => typeof pileColors[t] === 'string')) return false;
        types.forEach(type => {
            document.documentElement.style.setProperty(this.colorVariableMap[type], pileColors[type]);
        });
        return true;
    }

    initPiles(force = false) {
        if (this.mode === 'classic') {
            this.piles = {
                'B': [0, 1, 2, 3, 4].map(idx => ({ id: `B-${idx}`, type: 'B', slot: idx })),
                'R': [0, 1, 2, 3, 4].map(idx => ({ id: `R-${idx}`, type: idx === 1 ? 'Y' : 'R', slot: idx })),
                'G': [0, 1, 2, 3, 4].map(idx => ({ id: `G-${idx}`, type: 'G', slot: idx }))
            };
        } else {
            if (this.isMultiplayer) {
                if (!this.isHost()) {
                    this.piles = { 'B': [], 'G': [], 'R': [] };
                    return;
                }
                // During warmup, wait for server board; on rematch always roll a new layout.
                if (!force && this.hasServerBoard()) return;
            }
            this.initFreestyle();
        }
    }

    initFreestyle(providedPiles = null) {
        if (providedPiles) {
            this.piles = providedPiles;
            this.requestRender();
            return;
        }

        // Host/Solo logic — fresh random layout each time (mode only is persisted in the hub, not the board)
        let b, g, r;
        let attempts = 0;

        while (attempts < 1000) {
            b = Math.floor(Math.random() * 8) + 1;
            g = Math.floor(Math.random() * 8) + 1;
            r = Math.floor(Math.random() * 8) + 1;
            const sum = b + g + r;
            if (sum >= 14 && sum <= 20) {
                if (!this.isLosingState(b, g, r, true)) break;
            }
            attempts++;
        }

        const allItems = [];
        allItems.push({ type: 'Y', pk: 'R', slot: r });
        for (let i = 0; i < r; i++) allItems.push({ type: 'R', pk: 'R', slot: i });
        const otherPileKeys = ['B', 'G'].sort(() => Math.random() - 0.5);
        otherPileKeys.forEach(pk => {
            const count = pk === 'B' ? b : g;
            for (let i = 0; i < count; i++) allItems.push({ type: pk, pk: pk, slot: i });
        });

        this.piles = { 'B': [], 'G': [], 'R': [] };
        allItems.forEach((item, idx) => {
            const piece = { id: `${item.pk}-${item.slot}`, type: item.type, slot: item.slot, gridIdx: idx };
            this.piles[item.pk].push(piece);
        });

        this.requestRender();
    }


    randomizeColors() {
        const randomHex = () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');

        // Generate enough distinct colors
        const colors = [];
        while (colors.length < 4) {
            const c = randomHex();
            // Just a simple check for enough contrast/difference (could be improved)
            if (!colors.includes(c)) colors.push(c);
        }

        const varMap = { 'B': '--blue-color', 'R': '--red-color', 'G': '--green-color', 'Y': '--yellow-color' };
        const types = ['B', 'R', 'G', 'Y'];
        const colorMap = {};
        types.forEach((type, i) => {
            document.documentElement.style.setProperty(varMap[type], colors[i]);
            colorMap[type] = colors[i];
        });
        if (this.mode === 'freestyle') {
            const colorKey = `pile_colors_${this.gameName}_${this.mode}`;
            localStorage.setItem(colorKey, JSON.stringify(colorMap));
        }
    }

    /**
     * Exact retrograde minimax solver for Piles Freestyle.
     * Evaluates whether a state is losing for the current player.
     * Guaranteed to perfectly match all optimal game theoretic play.
     */
    isLosingState(b, g, r, y_exists) {
        const memo = {};
        const solve = (b_c, g_c, r_c, y_e) => {
            const key = `${b_c},${g_c},${r_c},${y_e}`;
            if (key in memo) return memo[key];
            if (!y_e) return false;

            // Try Blue moves (1-3)
            for (let i = 1; i <= 3; i++) {
                if (b_c >= i) {
                    if (!solve(b_c - i, g_c, r_c, y_e)) {
                        memo[key] = true;
                        return true;
                    }
                }
            }
            // Try Green moves (1-3)
            for (let i = 1; i <= 3; i++) {
                if (g_c >= i) {
                    if (!solve(b_c, g_c - i, r_c, y_e)) {
                        memo[key] = true;
                        return true;
                    }
                }
            }
            // Try Red moves (1-3)
            for (let i = 1; i <= 3; i++) {
                if (r_c >= i) {
                    if (!solve(b_c, g_c, r_c - i, y_e)) {
                        memo[key] = true;
                        return true;
                    }
                }
            }
            // Try Yellow move (empties red pile and takes Y)
            if (b_c === 0 && g_c === 0 && (r_c + 1) <= 3) {
                if (!solve(0, 0, 0, false)) {
                    memo[key] = true;
                    return true;
                }
            }

            memo[key] = false;
            return false;
        };

        return !solve(b, g, r, y_exists);
    }



    loadColors() {
        const key = `pile_colors_${this.gameName}_${this.mode}`;
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        Object.entries(saved).forEach(([type, color]) => {
            const varName = this.colorVariableMap[type];
            if (varName) document.documentElement.style.setProperty(varName, color);
        });

        // Restore defaults if switching back to classic and no save exists
        if (this.mode === 'classic' && (!saved || Object.keys(saved).length === 0)) {
            const defaults = { '--blue-color': '#3b82f6', '--red-color': '#ef4444', '--green-color': '#22c55e', '--yellow-color': '#eab308' };
            Object.entries(defaults).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
        }
    }

    isValidMove(pileKey, piecesToRemove) {
        if (!window.GameLogic) return true;
        const state = { piles: this.piles, turn: this.turn, isOver: this.isOver };
        return GameLogic.piles.isValidMove(state, { pk: pileKey, ids: piecesToRemove.map(p => p.id) });
    }

    applyState(state) {
        this.piles = state.piles;
        this.requestRender();
    }

    getValidMoves() {
        const moves = [];
        const pks = ['B', 'G', 'R'];
        pks.forEach(pk => {
            const pile = this.piles[pk];
            if (!pile || pile.length === 0) return;
            
            // 1. Try taking non-Y pieces
            const nonYPieces = pile.filter(p => p.type !== 'Y');
            for (let count = 1; count <= Math.min(3, nonYPieces.length); count++) {
                const pieces = nonYPieces.slice(0, count);
                if (this.isValidMove(pk, pieces)) {
                    moves.push({ pk, ids: pieces.map(p => p.id) });
                }
            }
            
            // 2. Try taking the entire pile (which could contain Y)
            if (this.isValidMove(pk, pile)) {
                moves.push({ pk, ids: pile.map(p => p.id) });
            }
        });
        return moves;
    }

    makeMove(pileKey, piecesToRemove) {
        if (!this.isValidMove(pileKey, piecesToRemove)) return false;

        const idsToRemove = piecesToRemove.map(p => p.id);
        this.submitMove({ pk: pileKey, ids: idsToRemove });
        return true;
    }

    checkWinCondition() {
        if (!this.piles['R']) return false;
        return !this.piles['R'].some(p => p.type === 'Y');
    }



    getPerfectMove() {
        const b = this.piles['B'].length;
        const g = this.piles['G'].length;
        const r_items = this.piles['R'].filter(p => p.type === 'R').length;
        const y_exists = this.piles['R'].some(p => p.type === 'Y');

        const shuffle = (arr) => {
            const result = [...arr];
            for (let i = result.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [result[i], result[j]] = [result[j], result[i]];
            }
            return result;
        };

        const moves = [];
        for (let i = 1; i <= 3; i++) {
            if (b >= i) moves.push({ type: 'standard', pk: 'B', count: i, next: [b - i, g, r_items, y_exists] });
            if (g >= i) moves.push({ type: 'standard', pk: 'G', count: i, next: [b, g - i, r_items, y_exists] });
            if (r_items >= i) moves.push({ type: 'standard', pk: 'R', count: i, next: [b, g, r_items - i, y_exists] });
        }
        if (b === 0 && g === 0 && (r_items + 1) <= 3 && y_exists) {
            moves.push({ type: 'yellow', pk: 'R', count: r_items + 1, next: [0, 0, 0, false] });
        }

        if (moves.length === 0) return null;

        // A move leads to victory if the resulting state is a losing state for the opponent
        const winningMoves = moves.filter(m => this.isLosingState(...m.next));
        const pool = shuffle(winningMoves.length > 0 ? winningMoves : moves);
        const result = pool[Math.floor(Math.random() * pool.length)];

        let pieces;
        if (result.type === 'yellow') {
            pieces = [...this.piles[result.pk]];
        } else {
            // Filter by color type instead of pile key, to avoid matching 'Y' piece since its pile key is 'R'
            const available = this.piles[result.pk].filter(p => p.type === result.pk);
            pieces = shuffle(available).slice(0, result.count);
        }
        return { pk: result.pk, pieces: pieces };
    }

    onEnter() {
        if (!this.isMyTurn()) return;
        if (!this.selection.pk || this.selection.ids.length === 0) return;

        const piecesToTake = this.selection.ids.map(id => this.piles[this.selection.pk]?.find(p => p.id === id)).filter(Boolean);
        if (this.isValidMove(this.selection.pk, piecesToTake)) {
            this.makeMove(this.selection.pk, piecesToTake);
            this.selection = { pk: null, ids: [] };
            this.broadcastSelection();
            this.requestRender();
        } else {
            this.triggerInvalidFlash(this.selection.ids);
            if (this.isMultiplayer) this.broadcastInvalidMove(this.selection.ids);
        }
    }

    onResetRequest() {
        this.resetGame();
    }

    onGameReset() {
        this.resetPositions();
        this.initPiles(true);

        if (this.mode === 'classic') {
            // Remove custom colors key from localStorage
            const colorKey = `pile_colors_${this.gameName}_${this.mode}`;
            localStorage.removeItem(colorKey);
            
            // Restore classic defaults
            const defaults = { '--blue-color': '#3b82f6', '--red-color': '#ef4444', '--green-color': '#22c55e', '--yellow-color': '#eab308' };
            Object.entries(defaults).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
            
            // If multiplayer host, clear the remote custom colors too
            if (this.isMultiplayer && this.isHost()) {
                this.broadcast('global/pileColors', null);
            }
        } else if (!this.isMultiplayer || this.isHost()) {
            this.randomizeColors();
        }
        this.requestRender();
    }

    onNetworkUpdate(data) {
        // Sync player data (names, colors) - legacy metadata sync
        if (data && data.playerData) {
            const myUid = this.uid || localStorage.getItem('game_uid');
            const oppUid = Object.keys(data.playerData).find(uid => uid !== myUid);
            if (oppUid && data.playerData[oppUid].name) {
                this.opponentName = data.playerData[oppUid].name;
                this.updateTurnIndicator();
            }
        }
    }
}

const game = new ColorPileGame();

// Standard piece loading

function savePositions() {
    const key = `piecePositions_${game.gameName}_${game.mode}`;
    localStorage.setItem(key, JSON.stringify(game.piecePositions));
}

function getInitialPosition(id, pk, idx) {
    const centers = { 'B': -250, 'R': 0, 'G': 250 }; // Fixed pixel spacing from center
    const centerXOffset = centers[pk];

    const gap = 70;
    const vgap = 70;

    let offsetX, offsetY;
    if (idx < 3) {
        // Bottom Row (3 pieces)
        offsetX = centerXOffset + (idx - 1) * gap;
        offsetY = 0; // Below center
    } else {
        // Top Row (2 pieces)
        offsetX = centerXOffset + (idx === 3 ? -gap / 2 : gap / 2);
        offsetY = -vgap;
    }

    return { offsetX, offsetY };
}


function getSpiralCoords(n) {
    if (n === 0) return { x: 0, y: 0 };
    let x = 0, y = 0;
    let step = 1;
    let count = 0;
    while (count < n) {
        // Right
        for (let i = 0; i < step && count < n; i++) { x++; count++; }
        if (count === n) break;
        // Up
        for (let i = 0; i < step && count < n; i++) { y--; count++; }
        if (count === n) break;
        step++;
        // Left
        for (let i = 0; i < step && count < n; i++) { x--; count++; }
        if (count === n) break;
        // Down
        for (let i = 0; i < step && count < n; i++) { y++; count++; }
        if (count === n) break;
        step++;
    }
    return { x, y };
}

game._render = function () {
    const container = document.getElementById('game-container');
    if (!container) return;

    const validIds = new Set();
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    Object.keys(game.piles).forEach(pk => {
        game.piles[pk].forEach((piece, idx) => {
            validIds.add(piece.id);
            const defaultPos = (game.mode === 'classic')
                ? getInitialPosition(piece.id, pk, piece.slot)
                : (function () {
                    const spiral = getSpiralCoords(piece.gridIdx);
                    return { offsetX: spiral.x * 75, offsetY: spiral.y * 75 };
                })();

            renderPiece(piece, pk, defaultPos, container, centerX, centerY);
        });
    });

    // Cleanup: Remove DOM nodes for pieces no longer in data
    Array.from(container.children).forEach(child => {
        if (child.classList.contains('piece') && !validIds.has(child.id)) {
            container.removeChild(child);
        }
    });
};

function renderPiece(piece, pk, defaultPos, container, centerX, centerY) {
    const id = piece.id;
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.onmouseenter = () => { game.hoveredType = piece.type; };
        el.onmouseleave = () => { if (game.hoveredType === piece.type) game.hoveredType = null; };
        el.onmousedown = (e) => {
            if (e.button === 0) handlePieceClick(piece.id, pk);
        };
    }
    el.className = `piece ${pk} ${piece.type}`;
    el.dataset.id = id; el.dataset.pile = pk;

    const style = game.getPieceStyle(id, pk, 500 + (defaultPos.offsetX || 0), 500 + (defaultPos.offsetY || 0));
    el.style.left = style.left;
    el.style.top = style.top;
    el.style.width = "";
    el.style.height = "";

    el.className = `piece ${pk} ${piece.type} ${style.classList.join(' ')}`;

    if (el.parentNode !== container) container.appendChild(el);
}

function handlePieceClick(id, pk) {
    if (!game.isMyTurn()) return;

    if (game.selection.pk && game.selection.pk !== pk) {
        game.selection.pk = pk;
        game.selection.ids = [id];
    } else {
        game.selection.pk = pk;
        const eIdx = game.selection.ids.indexOf(id);
        if (eIdx > -1) game.selection.ids.splice(eIdx, 1);
        else if (game.selection.ids.length < 3) game.selection.ids.push(id);
    }

    game.broadcastSelection();
    game.requestRender();
}




// Removed redundant resetGame - now in BaseGame

game.onAITurn = async function () {
    const move = this.getPerfectMove();
    if (move) {
        this.makeMove(move.pk, move.pieces);
    }
};

window.game = game;

// Standardized Network Handler
game.requestRender();
