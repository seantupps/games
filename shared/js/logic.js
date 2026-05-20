// Shared game logic for Piles and Line games
// Used by both frontend and Cloud Functions

const PilesLogic = {
    initialState(mode, seed = Date.now()) {
        if (mode === 'classic') {
            return {
                piles: {
                    'B': [0, 1, 2, 3, 4].map(idx => ({ id: `B-${idx}`, type: 'B', slot: idx })),
                    'R': [0, 1, 2, 3, 4].map(idx => ({ id: `R-${idx}`, type: idx === 1 ? 'Y' : 'R', slot: idx })),
                    'G': [0, 1, 2, 3, 4].map(idx => ({ id: `G-${idx}`, type: 'G', slot: idx }))
                },
                turn: 'P1',
                isOver: false,
                winner: null
            };
        }
        return { piles: { 'B': [], 'G': [], 'R': [] }, turn: 'P1', isOver: false, winner: null };
    },

    isValidMove(state, move) {
        const { pk, ids } = move;
        const pile = state.piles[pk];
        if (!pile) return false;
        if (ids.length < 1 || ids.length > 3) return false;
        const piecesToRemove = pile.filter(p => ids.includes(p.id));
        if (piecesToRemove.length !== ids.length) return false;
        const typesToRemove = piecesToRemove.map(p => p.type);
        if (typesToRemove.includes('Y')) {
            const bCount = (state.piles['B'] || []).length;
            const gCount = (state.piles['G'] || []).length;
            if (bCount > 0 || gCount > 0) return false;
            const rCount = (state.piles['R'] || []).length;
            if (rCount !== ids.length) return false;
        }
        return true;
    },

    applyMove(state, move) {
        if (!this.isValidMove(state, move)) return state;
        const newState = JSON.parse(JSON.stringify(state));
        newState.piles[move.pk] = newState.piles[move.pk].filter(p => !move.ids.includes(p.id));
        if (this.checkWin(newState)) {
            newState.isOver = true;
            newState.winner = state.turn;
        } else {
            newState.turn = state.turn === 'P1' ? 'P2' : 'P1';
        }
        return newState;
    },

    checkWin(state) {
        if (!state.piles['R']) return false;
        const hasY = state.piles['R'].some(p => p.type === 'Y');
        console.log(`[LOGIC] checkWin check: hasY=${hasY}, red_pile_size=${state.piles['R'].length}, returning=${!hasY}`);
        return !hasY;
    }
};

const LineLogic = {
    initialState() {
        return {
            path: [],
            endpoints: [],
            lines: [],
            usedNodes: new Array(16).fill(false),
            turn: 'P1',
            isOver: false,
            winner: null
        };
    },

    isValidMove(state, move) {
        const { a, b } = move;
        const nodes = [];
        const spacing = (800 - 200) / 3;
        for (let i = 0; i < 16; i++) {
            nodes.push({ x: 100 + (i % 4 * spacing), y: 100 + (Math.floor(i / 4) * spacing) });
        }
        const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
        const intersect = (A, B, C, D) => {
            if (A === C || A === D || B === C || B === D) return false;
            const p1 = nodes[A], p2 = nodes[B], p3 = nodes[C], p4 = nodes[D];
            return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
        };
        const getNodesOnSegment = (aId, bId) => {
            const a = nodes[aId], b = nodes[bId], middle = [];
            nodes.forEach((n, id) => {
                if (id === aId || id === bId) return;
                if (Math.abs((n.y - a.y) * (b.x - a.x) - (n.x - a.x) * (b.y - a.y)) > 0.1) return;
                const dot = (n.x - a.x) * (b.x - a.x) + (n.y - a.y) * (b.y - a.y);
                if (dot < 0 || dot > (b.x - a.x) ** 2 + (b.y - a.y) ** 2) return;
                middle.push(id);
            });
            middle.sort((n1, n2) => ((nodes[n1].x - a.x) ** 2 + (nodes[n1].y - a.y) ** 2) - ((nodes[n2].x - a.x) ** 2 + (nodes[n2].y - a.y) ** 2));
            return middle;
        };
        if (a === b || (state.path.length > 0 && !state.endpoints.includes(a))) return false;
        for (const line of state.lines) if (intersect(a, b, line.a, line.b)) return false;
        const intermediate = getNodesOnSegment(a, b);
        for (const id of intermediate) if (state.usedNodes[id]) return false;
        return !state.usedNodes[b];
    },

    getValidMoves(state) {
        const moves = [];
        const unusedNodes = [];
        state.usedNodes.forEach((used, id) => { if (!used) unusedNodes.push(id); });
        if (state.path.length === 0) {
            for (let i = 0; i < 16; i++) {
                for (let j = i + 1; j < 16; j++) { if (this.isValidMove(state, { a: i, b: j })) moves.push({ a: i, b: j }); }
            }
        } else {
            for (const ep of state.endpoints) {
                for (const un of unusedNodes) { if (this.isValidMove(state, { a: ep, b: un })) moves.push({ a: ep, b: un }); }
            }
        }
        return moves;
    },

    applyMove(state, move) {
        if (!this.isValidMove(state, move)) return state;
        const newState = JSON.parse(JSON.stringify(state));
        const { a, b } = move;

        const nodes = [];
        const spacing = (800 - 200) / 3;
        for (let i = 0; i < 16; i++) {
            nodes.push({ x: 100 + (i % 4 * spacing), y: 100 + (Math.floor(i / 4) * spacing) });
        }
        const getNodesOnSegment = (aId, bId) => {
            const a = nodes[aId], b = nodes[bId], middle = [];
            nodes.forEach((n, id) => {
                if (id === aId || id === bId) return;
                if (Math.abs((n.y - a.y) * (b.x - a.x) - (n.x - a.x) * (b.y - a.y)) > 0.1) return;
                const dot = (n.x - a.x) * (b.x - a.x) + (n.y - a.y) * (b.y - a.y);
                if (dot < 0 || dot > (b.x - a.x) ** 2 + (b.y - a.y) ** 2) return;
                middle.push(id);
            });
            middle.sort((n1, n2) => ((nodes[n1].x - a.x) ** 2 + (nodes[n1].y - a.y) ** 2) - ((nodes[n2].x - a.x) ** 2 + (nodes[n2].y - a.y) ** 2));
            return middle;
        };

        const intermediate = getNodesOnSegment(a, b);
        const fullStep = [a, ...intermediate, b];

        if (newState.path.length === 0) {
            newState.path = [...fullStep];
            newState.endpoints = [fullStep[0], fullStep[fullStep.length - 1]];
        } else {
            if (newState.endpoints[0] === a) {
                newState.path = [...intermediate, b].reverse().concat(newState.path);
                newState.endpoints[0] = b;
            } else {
                newState.path = newState.path.concat([...intermediate, b]);
                newState.endpoints[1] = b;
            }
        }

        fullStep.forEach(id => newState.usedNodes[id] = true);
        for (let i = 0; i < fullStep.length - 1; i++) {
            newState.lines.push({ a: fullStep[i], b: fullStep[i + 1], player: state.turn });
        }

        const validMoves = this.getValidMoves(newState);
        if (validMoves.length === 0) {
            newState.isOver = true;
            newState.winner = state.turn === 'P1' ? 'P2' : 'P1';
        } else {
            newState.turn = state.turn === 'P1' ? 'P2' : 'P1';
        }
        return newState;
    }
};

const Logic = {
    piles: PilesLogic,
    line: LineLogic,
    computeState(gameType, events = [], initialConfig = {}) {
        const logic = this[gameType];
        if (!logic) return null;
        let state = logic.initialState(initialConfig.mode, initialConfig.createdAt);
        if (initialConfig.firstPlayer) {
            state.turn = initialConfig.firstPlayer;
        }
        if (initialConfig.board) {
            if (gameType === 'piles') {
                state.piles = initialConfig.board.piles || initialConfig.board;
            } else {
                state = { ...state, ...initialConfig.board };
            }
        }
        const eventList = events || [];
        for (const event of eventList) { if (event.type === 'move') { state = logic.applyMove(state, event.payload); } }
        return state;
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Logic;
} else {
    window.GameLogic = Logic;
}
