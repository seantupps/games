class LineGame extends BaseGame {
    constructor() {
        super();
        this.nodes = [];
        this.endpoints = []; // Array of 2 node indices
        this.path = []; // Sequence of node indices
        this.lines = [];
        this.path = [];
        this.endpoints = [];
        this.draggingId = null;
        this.opponentPreview = null;
        this.lastSyncTime = 0;

        this.initNodes();
        this.initNetwork();
        this.render();
    }

    initNetwork() {
        window.addEventListener('message', (e) => {
            if (e.data.type === 'network-update') {
                const data = e.data.payload;
                if (!data) return;

                // Handle opponent drag preview
                if (data.previews) {
                    const myId = this.turn === 'P1' ? 'P1' : 'P2';
                    const oppId = myId === 'P1' ? 'P2' : 'P1';
                    if (data.previews[oppId]) {
                        this.opponentPreview = data.previews[oppId];
                    } else {
                        this.opponentPreview = null;
                    }
                    this.render();
                }

                // Handle moves
                if (data.lastMove && data.lastMove.player !== this.turn) {
                    // Prevent duplicate moves
                    const alreadyMade = this.lines.some(l =>
                        l.a === data.lastMove.a && l.b === data.lastMove.b
                    );
                    if (!alreadyMade) {
                        this.makeMove(data.lastMove.a, data.lastMove.b, true);
                    }
                }
            }
        });
    }

    initGrid() {
        const container = document.getElementById('nodes-container');
        for (let i = 0; i < 16; i++) {
            const node = {
                id: i,
                used: false,
                center: { x: 0, y: 0 },
                el: document.createElement('div')
            };
            node.el.className = 'node';
            node.el.dataset.id = i;

            // Interaction: Start dragging
            node.el.onmousedown = (e) => this.startDrag(i, e);

            container.appendChild(node.el);
            this.nodes.push(node);
        }
        // Small delay to ensure layout is done
        setTimeout(() => this.updateNodeCenters(), 100);
    }

    updateNodeCenters() {
        const containerRect = document.getElementById('game-container').getBoundingClientRect();
        this.nodes.forEach(node => {
            const rect = node.el.getBoundingClientRect();
            node.center = {
                x: (rect.left + rect.width / 2) - containerRect.left,
                y: (rect.top + rect.height / 2) - containerRect.top
            };
        });
    }

    startDrag(id, e) {
        if (this.turn !== 'P1' || this.isOver) return;
        e.preventDefault(); // Prevent text selection and default drag icons

        // Path rules: must start from an endpoint if path exists
        if (this.path.length > 0 && !this.endpoints.includes(id)) return;

        this.draggingId = id;
        this.nodes[id].el.classList.add('selected');

        const mouseMove = (me) => this.dragLine(me);
        const mouseUp = (ue) => this.endDrag(ue);

        window.addEventListener('mousemove', mouseMove);
        window.addEventListener('mouseup', mouseUp, { once: true });

        this.mouseMoveRef = mouseMove;
    }

    // Helper for intersection
    ccw(A, B, C) {
        return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
    }

    intersect(A, B, C, D) {
        // Exclude lines sharing an endpoint
        if (A === C || A === D || B === C || B === D) return false;

        const p1 = this.nodes[A].center;
        const p2 = this.nodes[B].center;
        const p3 = this.nodes[C].center;
        const p4 = this.nodes[D].center;

        return this.ccw(p1, p3, p4) !== this.ccw(p2, p3, p4) &&
            this.ccw(p1, p2, p3) !== this.ccw(p1, p2, p4);
    }

    dragLine(e) {
        const containerRect = document.getElementById('game-container').getBoundingClientRect();
        const mouseX = e.clientX - containerRect.left;
        const mouseY = e.clientY - containerRect.top;

        this.render(); // Clear and redraw static lines

        // Draw preview line
        const svg = document.getElementById('line-canvas');
        const start = this.nodes[this.draggingId].center;

        const preview = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        preview.setAttribute('x1', start.x);
        preview.setAttribute('y1', start.y);
        preview.setAttribute('x2', mouseX);
        preview.setAttribute('y2', mouseY);
        preview.classList.add('preview');
        svg.appendChild(preview);

        // SYNC: Send throttled preview to hub
        const now = Date.now();
        if (now - this.lastSyncTime > 30) {
            this.lastSyncTime = now;
            window.parent.postMessage({
                type: 'network-send',
                path: `previews/${this.turn}`,
                payload: { x1: start.x, y1: start.y, x2: mouseX, y2: mouseY }
            }, '*');
        }
    }

    endDrag(e) {
        window.removeEventListener('mousemove', this.mouseMoveRef);

        // Clear my preview on network
        window.parent.postMessage({
            type: 'network-send',
            path: `previews/${this.turn}`,
            payload: null
        }, '*');

        const containerRect = document.getElementById('game-container').getBoundingClientRect();
        const mouseX = e.clientX - containerRect.left;
        const mouseY = e.clientY - containerRect.top;

        // Find closest node
        let closestId = null;
        let minDist = Infinity;
        this.nodes.forEach(node => {
            const dx = node.center.x - mouseX;
            const dy = node.center.y - mouseY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 60 && dist < minDist) { // Snapping radius
                minDist = dist;
                closestId = node.id;
            }
        });

        const startId = this.draggingId;
        this.draggingId = null;

        if (closestId !== null && closestId !== startId) {
            // Check move validity
            const isValid = this.isValidMove(startId, closestId);
            if (isValid) {
                this.makeMove(startId, closestId);
            }
        }

        this.render();
    }

    getNodesOnSegment(aId, bId) {
        const a = this.nodes[aId].center;
        const b = this.nodes[bId].center;
        const middle = [];

        this.nodes.forEach(node => {
            if (node.id === aId || node.id === bId) return;
            const c = node.center;

            // Colinearity check with cross product
            const crossProduct = (c.y - a.y) * (b.x - a.x) - (c.x - a.x) * (b.y - a.y);
            if (Math.abs(crossProduct) > 0.1) return;

            // Dot product check to ensure C is BETWEEN A and B
            const dotProduct = (c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y);
            if (dotProduct < 0) return;

            const squaredLengthAB = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
            if (dotProduct > squaredLengthAB) return;

            middle.push(node.id);
        });

        // Sort by distance from a
        middle.sort((n1, n2) => {
            const d1 = (this.nodes[n1].center.x - a.x) ** 2 + (this.nodes[n1].center.y - a.y) ** 2;
            const d2 = (this.nodes[n2].center.x - a.x) ** 2 + (this.nodes[n2].center.y - a.y) ** 2;
            return d1 - d2;
        });

        return middle;
    }

    isValidMove(a, b) {
        if (a === b) return false;

        // Connectivity rules
        const isStartEndpoint = this.path.length === 0 || this.endpoints.includes(a);
        if (!isStartEndpoint) return false;

        // Intersection check for the DIRECT segment
        for (const line of this.lines) {
            if (this.intersect(a, b, line.a, line.b)) return false;
        }

        // Intermediate nodes check
        const intermediate = this.getNodesOnSegment(a, b);
        for (const id of intermediate) {
            if (this.nodes[id].used) return false;
        }

        // Destination check
        if (this.nodes[b].used) return false;

        return true;
    }

    makeMove(a, b, isNetworkMove = false) {
        const intermediate = this.getNodesOnSegment(a, b);
        const fullStep = [a, ...intermediate, b];

        // BROADCAST: Send move to network if it's local
        if (!isNetworkMove) {
            window.parent.postMessage({
                type: 'network-send',
                path: 'lastMove',
                payload: { a, b, player: this.turn }
            }, '*');
        }

        if (this.path.length === 0) {
            this.path = [...fullStep];
            this.endpoints = [fullStep[0], fullStep[fullStep.length - 1]];
        } else {
            // Must have started from one of the endpoints
            if (this.endpoints[0] === a) {
                // Prepend the new nodes in reverse order
                const toAdd = [...intermediate, b].reverse();
                this.path = [...toAdd, ...this.path];
                this.endpoints[0] = b;
            } else {
                // Append the new nodes
                const toAdd = [...intermediate, b];
                this.path = [...this.path, ...toAdd];
                this.endpoints[1] = b;
            }
        }

        // Mark all as used
        fullStep.forEach(id => this.nodes[id].used = true);

        // Record lines for rendering/intersection
        for (let i = 0; i < fullStep.length - 1; i++) {
            this.lines.push({ a: fullStep[i], b: fullStep[i + 1], player: this.turn });
        }

        // Check for game over
        const possibleMoves = this.getValidMoves();
        if (possibleMoves.length === 0) {
            const winner = this.turn === 'P1' ? 'P2' : 'P1';
            this.setGameOver(winner);
        } else {
            this.turn = this.turn === 'P1' ? 'P2' : 'P1';
            // Only trigger AI if it's local single player mode (could add check here)
            if (this.turn === 'P2' && !isNetworkMove && !window.location.search.includes('room')) {
                setTimeout(() => this.aiTurn(), 800);
            }
        }
        this.render();
    }

    getValidMoves() {
        const moves = [];
        const unusedNodes = this.nodes.filter(n => !n.used).map(n => n.id);

        if (this.path.length === 0) {
            // Any two distinct nodes
            for (let i = 0; i < 16; i++) {
                for (let j = i + 1; j < 16; j++) {
                    moves.push({ a: i, b: j });
                }
            }
        } else {
            // Connect endpoint to unused node, checking for intersections via isValidMove
            this.endpoints.forEach(ep => {
                unusedNodes.forEach(un => {
                    if (this.isValidMove(ep, un)) {
                        moves.push({ a: ep, b: un });
                    }
                });
            });
        }
        return moves;
    }

    aiTurn() {
        if (this.isOver) return;
        const moves = this.getValidMoves();
        if (moves.length > 0) {
            const move = moves[Math.floor(Math.random() * moves.length)];
            this.makeMove(move.a, move.b);
        }
    }

    render() {
        // Update nodes
        this.nodes.forEach(node => {
            node.el.className = 'node';
            if (node.used) node.el.classList.add('used');
            if (this.endpoints.includes(node.id)) node.el.classList.add('endpoint');
            if (this.draggingId === node.id) node.el.classList.add('selected');
        });

        // Draw SVG lines
        const svg = document.getElementById('line-canvas');
        svg.innerHTML = '';
        this.lines.forEach(line => {
            const start = this.nodes[line.a].center;
            const end = this.nodes[line.b].center;

            const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l.setAttribute('x1', start.x1 || start.x);
            l.setAttribute('y1', start.y1 || start.y);
            l.setAttribute('x2', end.x2 || end.x);
            l.setAttribute('y2', end.y2 || end.y);
            l.classList.add(line.player === 'P1' ? 'p1' : 'p2');
            svg.appendChild(l);
        });

        // Draw opponent's real-time ghost line
        if (this.opponentPreview) {
            const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            ghost.setAttribute('x1', this.opponentPreview.x1);
            ghost.setAttribute('y1', this.opponentPreview.y1);
            ghost.setAttribute('x2', this.opponentPreview.x2);
            ghost.setAttribute('y2', this.opponentPreview.y2);
            ghost.classList.add('preview');
            ghost.style.stroke = this.turn === 'P1' ? 'var(--green-color)' : 'var(--blue-color)';
            ghost.style.opacity = '0.3';
            svg.appendChild(ghost);
        }
    }

    resetGame() {
        this.nodes.forEach(n => n.used = false);
        this.endpoints = [];
        this.path = [];
        this.lines = [];
        this.isOver = false;
        this.winner = null;
        this.turn = 'P1';
        this.draggingId = null;
        this.clearWinOverlay();
        this.render();
    }
}

const game = new LineGame();
game.render();

window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'r') {
        game.resetGame();
    }
});
