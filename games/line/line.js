// Early theme capture to prevent race conditions
const params = new URLSearchParams(window.location.search);
if (params.has('theme')) { document.documentElement.style.setProperty('--theme-color', params.get('theme')); }
if (params.has('opp')) { document.documentElement.style.setProperty('--opponent-color', params.get('opp')); }

class LineGame extends BaseGame {
    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get('mode') || 'classic';

        this.nodes = []; this.endpoints = []; this.path = []; this.lines = [];
        this.draggingId = null; this.opponentPreview = null; this.lastSyncTime = 0;
        this.aiTable = null;
        this.BOARD_SIZE = 800; this.GRID_COUNT = 4; this.MARGIN = 100;
        this.localSize = 800;

        this.initGrid();
        this.initAISolver();
        this.loadAITable();

        const originalOnIdentitySynced = this.onIdentitySynced;
        this.onIdentitySynced = () => {
            if (originalOnIdentitySynced) originalOnIdentitySynced();
            this.updateTurnIndicator();
            this.requestRender();
        };

        this.initIdentity('line', this.mode);
        this.requestRender();
        window.game = this;
    }

    async loadAITable() {
        if (this.isMultiplayer) return;
        const tablePath = '../../tests/line/line_ai_table.bin.gz';
        try {
            console.log(`[AI] Attempting to load table: ${tablePath}`);
            const response = await fetch(`${tablePath}?t=${Date.now()}`);
            if (response.ok) {
                const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
                const buffer = await new Response(stream).arrayBuffer();
                const view = new DataView(buffer);
                const count = view.getUint32(0, true);

                this.aiTable = { count, buffer, view };
                console.log(`[AI] SUCCESS: Loaded "${tablePath}" (${count.toLocaleString()} states)`);
            } else {
                console.error(`[AI] FAILED to load ${tablePath}: Status ${response.status}`);
            }
        } catch (e) {
            console.error(`[AI] ERROR loading AI Table:`, e);
        }
    }

    initAISolver() {
        if (this.isMultiplayer) return;
        const GRID_SIZE = this.GRID_COUNT, NODES = GRID_SIZE * GRID_SIZE;
        const getCoord = (i) => ({ x: i % GRID_SIZE, y: Math.floor(i / GRID_SIZE) });
        const getId = (x, y) => y * GRID_SIZE + x;

        this.segToIdx = {}; this.atomicSegments = [];
        for (let i = 0; i < NODES; i++) {
            for (let j = i + 1; j < NODES; j++) {
                if (this.getNodesOnSegment(i, j).length === 0) {
                    const s = [i, j].sort((a, b) => a - b).join(',');
                    this.segToIdx[s] = this.atomicSegments.length; this.atomicSegments.push({ a: i, b: j });
                }
            }
        }

        const getTransformations = () => {
            const transforms = [];
            const ops = [
                (x, y) => [x, y], (x, y) => [3 - y, x], (x, y) => [3 - x, 3 - y], (x, y) => [y, 3 - x],
                (x, y) => [3 - x, y], (x, y) => [x, 3 - y], (x, y) => [y, x], (x, y) => [3 - y, 3 - x]
            ];
            ops.forEach(op => {
                const m = [];
                for (let i = 0; i < NODES; i++) {
                    const c = getCoord(i); const [nx, ny] = op(c.x, c.y); m.push(getId(nx, ny));
                }
                transforms.push(m);
            });
            return transforms;
        };

        this.transforms = getTransformations();
        this.symmetryLut = this.transforms.map((tNodes) => {
            const mapping = this.atomicSegments.map(s => {
                const [nu, nv] = [tNodes[s.a], tNodes[s.b]].sort((a, b) => a - b);
                return this.segToIdx[nu + ',' + nv];
            });
            const lut = Array.from({ length: 11 }, () => new Array(256).fill(0n));
            for (let chunk = 0; chunk < 11; chunk++) {
                for (let val = 0; val < 256; val++) {
                    let res = 0n;
                    for (let bit = 0; bit < 8; bit++) {
                        const idx = chunk * 8 + bit;
                        if (idx < this.atomicSegments.length && (val & (1 << bit))) res |= (1n << BigInt(mapping[idx]));
                    }
                    lut[chunk][val] = res;
                }
            }
            return { lut };
        });

        this.getCanonicalState = (mask) => {
            let bestMask = mask, bestIdx = 0;
            for (let i = 1; i < 8; i++) {
                const { lut } = this.symmetryLut[i];
                let newMask = 0n, temp = mask;
                for (let chunk = 0; chunk < 11; chunk++) {
                    const v = Number(temp & 0xFFn); if (v) newMask |= lut[chunk][v]; temp >>= 8n;
                }
                if (newMask < bestMask) { bestMask = newMask; bestIdx = i; }
            }
            return { mask: bestMask, sIdx: bestIdx };
        };
    }

    lookupState(targetMask) {
        if (!this.aiTable) return null;
        let low = 0, high = this.aiTable.count - 1;
        const view = this.aiTable.view;
        while (low <= high) {
            const mid = (low + high) >>> 1;
            const offset = 4 + (mid * 12);
            const hiPart = (BigInt(view.getUint8(offset)) << 16n) | BigInt(view.getUint16(offset + 1, false));
            const loPart = view.getBigUint64(offset + 3, false);
            const mFull = (hiPart << 64n) | loPart;

            if (mFull < targetMask) low = mid + 1;
            else if (mFull === targetMask) return view.getInt8(offset + 11);
            else high = mid - 1;
        }
        return null;
    }

    getCurrentBitmaskState() {
        let mask = 0n;
        this.lines.forEach(line => mask |= (1n << BigInt(this.segToIdx[[line.a, line.b].sort((a, b) => a - b).join(',')])));
        return { mask };
    }

    ccw(A, B, C) { return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x); }
    intersect(A, B, C, D) {
        if (A === C || A === D || B === C || B === D) return false;
        const p1 = this.nodes[A].center, p2 = this.nodes[B].center, p3 = this.nodes[C].center, p4 = this.nodes[D].center;
        return this.ccw(p1, p3, p4) !== this.ccw(p2, p3, p4) && this.ccw(p1, p2, p3) !== this.ccw(p1, p2, p4);
    }

    isValidMove(arg1, arg2) {
        let a, b;
        if (typeof arg1 === 'object' && arg1 !== null) {
            a = arg1.a; b = arg1.b;
        } else {
            a = arg1; b = arg2;
        }
        if (!window.GameLogic || !this.nodes || this.nodes.length === 0) return true;
        const state = {
            path: this.path,
            endpoints: this.endpoints,
            lines: this.lines,
            usedNodes: this.nodes.map(n => n.used || false),
            turn: this.turn,
            isOver: this.isOver
        };
        return GameLogic.line.isValidMove(state, { a, b });
    }



    makeMove(a, b) {
        if (!this.isValidMove(a, b)) return;
        this.submitMove({ a, b });
    }

    checkWinCondition() {
        if (this.lines.length === 0 && this.path.length === 0) return false;
        return this.getValidMoves().length === 0;
    }

    async onAITurn() {
        if (this.isMultiplayer) return;
        if (this.path.length === 0) {
            const openings = [[0, 15], [2, 14], [3, 15], [5, 8], [1, 3], [1, 9], [6, 7]];
            const [a, b] = openings[Math.floor(Math.random() * openings.length)];
            this.makeMove(a, b); return;
        }

        const validMoves = this.getValidMoves();
        if (validMoves.length === 0) return;

        const { mask: currentMask } = this.getCurrentBitmaskState();
        const wins = [], losses = [];

        validMoves.forEach(mv => {
            const mid = this.getNodesOnSegment(mv.a, mv.b);
            const fullLine = [mv.a, ...mid, mv.b].sort((a, b) => a - b);
            let nextMask = currentMask;
            for (let i = 0; i < fullLine.length - 1; i++) {
                const s = [fullLine[i], fullLine[i + 1]].join(',');
                nextMask |= (1n << BigInt(this.segToIdx[s]));
            }
            const { mask: cMask } = this.getCanonicalState(nextMask);
            const val = this.lookupState(cMask);
            if (val !== null) {
                if (val < 0) wins.push({ mv, depth: Math.abs(val) - 1 });
                else losses.push({ mv, depth: val - 1 });
            }
        });

        if (wins.length > 0) {
            wins.sort((a, b) => a.depth - b.depth);
            const bestDepth = wins[0].depth;
            const choices = wins.filter(w => w.depth === bestDepth);
            const final = choices[Math.floor(Math.random() * choices.length)];
            this.makeMove(final.mv.a, final.mv.b);
        } else if (losses.length > 0) {
            const longLosses = losses.filter(l => l.depth > 5);
            if (longLosses.length > 0) {
                // Pick randomly from ANYTHING that is 6+
                const final = longLosses[Math.floor(Math.random() * longLosses.length)];
                this.makeMove(final.mv.a, final.mv.b);
            } else {
                // If only shallow losses, pick the longest one for max resistance
                losses.sort((a, b) => b.depth - a.depth);
                const bestDepth = losses[0].depth;
                const choices = losses.filter(c => c.depth === bestDepth);
                const final = choices[Math.floor(Math.random() * choices.length)];
                this.makeMove(final.mv.a, final.mv.b);
            }
        } else {
            const m = validMoves[Math.floor(Math.random() * validMoves.length)];
            this.makeMove(m.a, m.b);
        }
    }

    initGrid() {
        const container = document.getElementById('nodes-container');
        const spacing = (800 - 200) / 3;
        for (let i = 0; i < 16; i++) {
            const x = 100 + (i % 4 * spacing), y = 100 + (Math.floor(i / 4) * spacing);
            const node = { id: i, used: false, center: { x, y }, el: document.createElement('div') };
            node.el.className = 'node'; node.el.dataset.id = i; node.el.style.left = `${x}px`; node.el.style.top = `${y}px`;
            node.el.onmousedown = (e) => this.startDrag(i, e);
            container.appendChild(node.el); this.nodes.push(node);
        }
    }

    startDrag(id, e) {
        if (this.isOver || (this.path.length > 0 && !this.endpoints.includes(id))) return;
        if (!this.isMyTurn()) return;

        this.draggingId = id; this.nodes[id].el.classList.add('selected');
        const mouseMove = (me) => this.dragLine(me);
        const mouseUp = (ue) => this.endDrag(ue);
        window.addEventListener('mousemove', mouseMove);
        window.addEventListener('mouseup', mouseUp, { once: true });
        this.mouseMoveRef = mouseMove;
    }

    dragLine(e) {
        if (this.draggingId === null) return;
        const world = this.toWorld(e.clientX, e.clientY);
        this.localPreview = { x: world.x, y: world.y };

        if (this.isMultiplayer) {
            const now = Date.now();
            if (!this.lastPreviewTime || now - this.lastPreviewTime > 30) {
                this.lastPreviewTime = now;
                const myUid = this.uid || localStorage.getItem('game_uid');
                this.broadcast(`previews/${myUid}`, {
                    start: this.draggingId,
                    nx: world.x,
                    ny: world.y
                });
            }
        }

        this.requestRender();
    }

    endDrag(e) {
        window.removeEventListener('mousemove', this.mouseMoveRef);
        const world = this.toWorld(e.clientX, e.clientY);
        const svgX = world.x;
        const svgY = world.y;

        if (this.isMultiplayer) {
            const myUid = this.uid || localStorage.getItem('game_uid');
            this.broadcast(`previews/${myUid}`, null);
        }

        let closestId = null, minDist = Infinity;
        this.nodes.forEach(node => {
            const dist = Math.sqrt((node.center.x - svgX) ** 2 + (node.center.y - svgY) ** 2);
            if (dist < 60 && dist < minDist) { minDist = dist; closestId = node.id; }
        });
        const startId = this.draggingId;
        this.draggingId = null;
        this.localPreview = null;

        if (closestId !== null && closestId !== startId && this.isValidMove(startId, closestId)) {
            this.makeMove(startId, closestId);
        }
        this.requestRender();
    }

    getNodesOnSegment(aId, bId) {
        const a = this.nodes[aId].center, b = this.nodes[bId].center, middle = [];
        this.nodes.forEach(node => {
            if (node.id === aId || node.id === bId) return;
            const c = node.center;
            if (Math.abs((c.y - a.y) * (b.x - a.x) - (c.x - a.x) * (b.y - a.y)) > 0.1) return;
            const dot = (c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y);
            if (dot < 0 || dot > (b.x - a.x) ** 2 + (b.y - a.y) ** 2) return;
            middle.push(node.id);
        });
        middle.sort((n1, n2) => ((this.nodes[n1].center.x - a.x) ** 2 + (this.nodes[n1].center.y - a.y) ** 2) - ((this.nodes[n2].center.x - a.x) ** 2 + (this.nodes[n2].center.y - a.y) ** 2));
        return middle;
    }

    getValidMoves() {
        const moves = [], unusedNodes = this.nodes.filter(n => !n.used).map(n => n.id);
        if (this.path.length === 0) { for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) moves.push({ a: i, b: j }); }
        else { this.endpoints.forEach(ep => unusedNodes.forEach(un => { if (this.isValidMove(ep, un)) moves.push({ a: ep, b: un }); })); }
        return moves;
    }

    _render() {
        this.nodes.forEach(node => {
            node.el.className = 'node'; if (node.used) node.el.classList.add('used');
            if (this.endpoints.includes(node.id)) node.el.classList.add('endpoint');
            if (this.draggingId === node.id) node.el.classList.add('selected');
        });
        const svg = document.getElementById('line-canvas'); svg.innerHTML = '';
        this.lines.forEach(line => {
            const start = this.nodes[line.a].center, end = this.nodes[line.b].center;
            const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l.setAttribute('x1', start.x); l.setAttribute('y1', start.y);
            l.setAttribute('x2', end.x); l.setAttribute('y2', end.y);
            const isMine = line.player === this.playerRole;
            const assignedClass = isMine ? 'mine' : 'opponent';
            l.classList.add(assignedClass);
            svg.appendChild(l);
        });

        // Draw Local Preview
        if (this.draggingId !== null && this.localPreview) {
            const start = this.nodes[this.draggingId].center;
            const svgX = this.localPreview.x;
            const svgY = this.localPreview.y;
            const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l.setAttribute('x1', start.x); l.setAttribute('y1', start.y);
            l.setAttribute('x2', svgX); l.setAttribute('y2', svgY);
            l.classList.add('preview', 'mine');
            svg.appendChild(l);
        }

        // Draw Opponent Preview
        if (this.opponentPreview && this.opponentPreview.start !== undefined && this.opponentPreview.start !== null) {
            const oppStart = this.nodes[this.opponentPreview.start].center;
            const svgX = this.opponentPreview.nx;
            const svgY = this.opponentPreview.ny;
            const oppL = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            oppL.setAttribute('x1', oppStart.x); oppL.setAttribute('y1', oppStart.y);
            oppL.setAttribute('x2', svgX); oppL.setAttribute('y2', svgY);
            oppL.classList.add('preview-opponent');
            oppL.style.stroke = 'var(--opponent-color)';
            oppL.style.strokeDasharray = '5,5';
            oppL.style.opacity = '0.5';
            svg.appendChild(oppL);
        }
    }

    onGameReset() {
        this.path = [];
        this.lines = [];
        this.endpoints = [];
        this.nodes.forEach(n => n.used = false);
        this.draggingId = null;
        this.opponentPreview = null;
        this.requestRender();
    }

    getBoardState() {
        return { lines: this.lines, path: this.path, endpoints: this.endpoints };
    }

    applyState(board) {
        this.lines = board.lines || [];
        this.path = board.path || [];
        this.endpoints = board.endpoints || [];

        // Update node "used" states based on lines
        this.nodes.forEach(n => n.used = false);
        this.lines.forEach(l => {
            if (this.nodes[l.a]) this.nodes[l.a].used = true;
            if (this.nodes[l.b]) this.nodes[l.b].used = true;
        });
        this.requestRender();
    }

    processAction(actionData) {
        if (actionData.type === 'makeMove') {
            const { a, b } = actionData.payload;
            if (this.turn === 'P2') {
                this.makeMove(a, b);
            }
        }
    }

}
const game = new LineGame();
