class ColorPileGame extends BaseGame {
    constructor() {
        super();
        this.piles = {
            'B': [0, 1, 2, 3, 4].map(idx => ({ id: `B-${idx}`, type: 'B' })),
            'R': [0, 1, 2, 3, 4].map(idx => ({ id: `R-${idx}`, type: idx === 4 ? 'Y' : 'R' })),
            'G': [0, 1, 2, 3, 4].map(idx => ({ id: `G-${idx}`, type: 'G' }))
        };
        this.memo = new Map();
    }

    isValidMove(pileKey, piecesToRemove) {
        if (!this.piles[pileKey]) return false;

        const count = piecesToRemove.length;
        if (count < 1 || count > 3) return false;

        const itemsToRemove = piecesToRemove.map(p => p.type);

        // Yellow rule
        if (itemsToRemove.includes('Y')) {
            if (this.piles['B'].length > 0 || this.piles['G'].length > 0) return false;
            // Check if removing these pieces would empty the R pile
            if (this.piles['R'].length > count) return false;
        }

        return true;
    }

    makeMove(pileKey, piecesToRemove) {
        if (!this.isValidMove(pileKey, piecesToRemove)) return false;

        const idsToRemove = piecesToRemove.map(p => p.id);
        this.piles[pileKey] = this.piles[pileKey].filter(p => !idsToRemove.includes(p.id));

        if (this.checkWinCondition()) {
            this.setGameOver(this.turn);
        }
        return true;
    }

    checkWinCondition() {
        return !this.piles['R'].some(p => p.type === 'Y');
    }

    getPerfectMove() {
        // Current counts
        const b = this.piles['B'].length;
        const g = this.piles['G'].length;
        const r_items = this.piles['R'].filter(p => p.type === 'R').length;
        const y_exists = this.piles['R'].some(p => p.type === 'Y');

        const solveState = (b_c, g_c, r_c, y_e) => {
            const key = `${b_c},${g_c},${r_c},${y_e}`;
            if (this.memo.has(key)) return this.memo.get(key);

            if (!y_e) return { win: false };

            const possibleMoves = [];
            // Standard moves from B, G, R
            for (let i = 1; i <= 3; i++) {
                if (b_c >= i) possibleMoves.push({ type: 'standard', pk: 'B', count: i, next: [b_c - i, g_c, r_c, y_e] });
                if (g_c >= i) possibleMoves.push({ type: 'standard', pk: 'G', count: i, next: [b_c, g_c - i, r_c, y_e] });
                if (r_c >= i) possibleMoves.push({ type: 'standard', pk: 'R', count: i, next: [b_c, g_c, r_c - i, y_e] });
            }
            // Yellow rule move: must take ALL remaining R pieces + Y
            if (b_c === 0 && g_c === 0 && (r_c + 1) <= 3) {
                possibleMoves.push({ type: 'yellow', pk: 'R', count: r_c + 1, next: [0, 0, 0, false] });
            }

            for (const move of possibleMoves) {
                const outcome = solveState(...move.next);
                if (!outcome.win) {
                    const res = { win: true, type: move.type, pk: move.pk, count: move.count };
                    this.memo.set(key, res);
                    return res;
                }
            }

            const res = { win: false };
            this.memo.set(key, res);
            return res;
        };

        const result = solveState(b, g, r_items, y_exists);
        console.log(`AI Analysis for state B:${b} G:${g} R:${r_items} Y:${y_exists} ->`, result);

        if (result.win) {
            let pieces;
            if (result.type === 'yellow') {
                // Take ALL remaining pieces in the R pile
                pieces = [...this.piles[result.pk]];
            } else {
                // Standard move: take ONLY pieces of the intended type
                const targetType = result.pk;
                pieces = this.piles[result.pk]
                    .filter(p => p.type === targetType)
                    .slice(0, result.count);
            }
            return { pk: result.pk, pieces: pieces };
        }
        return null;
    }
}

const game = new ColorPileGame();
let selectedIds = [];
let selectedPile = null;

// Persistence Logic
let piecePositions = JSON.parse(localStorage.getItem('piecePositions') || '{}');

function savePositions() {
    localStorage.setItem('piecePositions', JSON.stringify(piecePositions));
}

function getInitialPosition(id, pk, idx) {
    const pileOffsets = { 'B': 25, 'R': 50, 'G': 75 };
    const left = pileOffsets[pk];
    const idIdx = parseInt(id.split('-')[1]);
    const bottom = 100 + idIdx * 75;
    return { left: `${left}%`, top: `calc(100% - ${bottom}px - 60px)` };
}

function render() {
    const container = document.getElementById('game-container');
    container.innerHTML = '';

    ['B', 'R', 'G'].forEach(pk => {
        game.piles[pk].forEach((piece, idx) => {
            const id = piece.id;
            const el = document.createElement('div');
            el.className = `piece ${piece.type}`;
            el.id = id;
            el.dataset.id = id;
            el.dataset.pile = pk;

            const pos = piecePositions[id] || getInitialPosition(id, pk, idx);
            el.style.left = pos.left;
            el.style.top = pos.top;

            if (selectedPile === pk && selectedIds.includes(id)) {
                el.classList.add('selected');
            }

            BaseGame.setupDragging(el, (isDragging, draggedEl, e) => {
                if (!isDragging) {
                    const pk = draggedEl.dataset.pile;
                    const id = draggedEl.dataset.id;
                    handlePieceClick(id, pk);
                } else {
                    piecePositions[draggedEl.id] = { left: draggedEl.style.left, top: draggedEl.style.top };
                    savePositions();
                }
            }, game);
            container.appendChild(el);
        });
    });
}

function handlePieceClick(id, pk) {
    if (game.turn !== 'P1' || game.isOver) return;

    if (selectedPile && selectedPile !== pk) {
        selectedPile = pk;
        selectedIds = [id];
    } else {
        selectedPile = pk;
        const eIdx = selectedIds.indexOf(id);
        if (eIdx > -1) {
            selectedIds.splice(eIdx, 1);
        } else {
            if (selectedIds.length < 3) {
                selectedIds.push(id);
            }
        }
    }
    render();
}

async function handleKeyDown(e) {
    if (game.isOver && e.key.toLowerCase() !== 'r') return;

    if (e.key === 'Enter' && game.turn === 'P1') {
        const piecesToTake = selectedIds.map(id => {
            return game.piles[selectedPile]?.find(p => p.id === id);
        }).filter(Boolean);

        if (selectedPile && game.isValidMove(selectedPile, piecesToTake)) {
            game.makeMove(selectedPile, piecesToTake);
            selectedIds = [];
            selectedPile = null;
            render();

            if (!game.isOver) {
                game.turn = 'P2';
                await aiTurn();
            }
        } else if (selectedIds.length > 0) {
            // Flash red for failure
            selectedIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.classList.add('flash-invalid');
                    setTimeout(() => el.classList.remove('flash-invalid'), 500);
                }
            });
        }
    } else if (e.key.toLowerCase() === 'r') {
        resetGame();
    }
}

function resetGame() {
    const newGame = new ColorPileGame();
    game.piles = newGame.piles;
    game.turn = newGame.turn;
    game.isOver = false;
    game.winner = null;
    game.memo = newGame.memo;

    selectedIds = [];
    selectedPile = null;

    game.clearWinOverlay();
    render();
}

async function aiTurn() {
    await new Promise(r => setTimeout(r, 600));
    const move = game.getPerfectMove();
    let success = false;

    if (move) {
        success = game.makeMove(move.pk, move.pieces);
        if (!success) console.error("AI perfect move failed:", move);
    } else {
        const fallback = game.getFallbackMove();
        if (fallback) {
            success = game.makeMove(fallback.pk, fallback.pieces);
            if (!success) console.error("AI fallback move failed:", fallback);
        }
    }

    if (success) {
        if (!game.isOver) {
            game.turn = 'P1';
        }
    } else {
        console.warn("AI failed to make any move. Remaining in AI turn.");
    }
    render();
}

ColorPileGame.prototype.getFallbackMove = function () {
    const pks = Object.keys(this.piles).filter(k => this.piles[k].length > 0);
    for (const pk of pks) {
        for (let i = 1; i <= Math.min(3, this.piles[pk].length); i++) {
            const pieces = this.piles[pk].slice(0, i);
            if (this.isValidMove(pk, pieces)) return { pk, pieces };
        }
    }
    return null;
}

window.addEventListener('keydown', handleKeyDown);
render();
