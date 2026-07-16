/**
 * Quoridor rules engine (browser + worker).
 * Matches build/quoridor/game (Python) / ref/quoridor-ai jumps.
 */
(function (root) {
    "use strict";

    const SIZE = 9;
    const WALL_N = 8;
    const INF = 9999;
    const UP = [-1, 0];
    const DOWN = [1, 0];
    const LEFT = [0, -1];
    const RIGHT = [0, 1];
    const ORTHO = [UP, DOWN, LEFT, RIGHT];

    function zeros2(rows, cols, fill) {
        const a = [];
        for (let i = 0; i < rows; i++) {
            const row = [];
            for (let j = 0; j < cols; j++) row.push(fill);
            a.push(row);
        }
        return a;
    }

    function clone2(arr) {
        return arr.map((r) => r.slice());
    }

    class Pawn {
        constructor(index) {
            this.index = index;
            if (index === 0) {
                this.row = 8;
                this.col = 4;
                this.goalRow = 0;
            } else {
                this.row = 0;
                this.col = 4;
                this.goalRow = 8;
            }
            this.wallsLeft = 10;
        }
        clone() {
            const p = new Pawn(this.index);
            p.row = this.row;
            p.col = this.col;
            p.wallsLeft = this.wallsLeft;
            return p;
        }
    }

    function shortestPathLength(upDown, leftRight, sr, sc, goalRow) {
        if (sr === goalRow) return 0;
        const dist = zeros2(SIZE, SIZE, -1);
        const qr = new Int16Array(SIZE * SIZE);
        const qc = new Int16Array(SIZE * SIZE);
        let head = 0;
        let tail = 0;
        dist[sr][sc] = 0;
        qr[tail] = sr;
        qc[tail] = sc;
        tail++;
        while (head < tail) {
            const r = qr[head];
            const c = qc[head];
            head++;
            const d = dist[r][c] + 1;
            if (r > 0 && upDown[r - 1][c] && dist[r - 1][c] < 0) {
                dist[r - 1][c] = d;
                if (r - 1 === goalRow) return d;
                qr[tail] = r - 1;
                qc[tail] = c;
                tail++;
            }
            if (r < 8 && upDown[r][c] && dist[r + 1][c] < 0) {
                dist[r + 1][c] = d;
                if (r + 1 === goalRow) return d;
                qr[tail] = r + 1;
                qc[tail] = c;
                tail++;
            }
            if (c > 0 && leftRight[r][c - 1] && dist[r][c - 1] < 0) {
                dist[r][c - 1] = d;
                if (r === goalRow) return d;
                qr[tail] = r;
                qc[tail] = c - 1;
                tail++;
            }
            if (c < 8 && leftRight[r][c] && dist[r][c + 1] < 0) {
                dist[r][c + 1] = d;
                if (r === goalRow) return d;
                qr[tail] = r;
                qc[tail] = c + 1;
                tail++;
            }
        }
        return INF;
    }

    class Engine {
        constructor() {
            this.pawns = [new Pawn(0), new Pawn(1)];
            // null = empty; 0 = P1 owner; 1 = P2 owner
            this.wallsH = zeros2(WALL_N, WALL_N, null);
            this.wallsV = zeros2(WALL_N, WALL_N, null);
            this.upDown = zeros2(WALL_N, SIZE, true);
            this.leftRight = zeros2(SIZE, WALL_N, true);
            this.validH = zeros2(WALL_N, WALL_N, true);
            this.validV = zeros2(WALL_N, WALL_N, true);
            this.turn = 0;
            this.winner = null;
            this._movesCache = null;
        }

        get pawnOfTurn() {
            return this.pawns[this.turn % 2];
        }
        get pawnOfNotTurn() {
            return this.pawns[(this.turn + 1) % 2];
        }

        invalidate() {
            this._movesCache = null;
        }

        clone() {
            const g = new Engine();
            g.pawns = this.pawns.map((p) => p.clone());
            g.wallsH = clone2(this.wallsH);
            g.wallsV = clone2(this.wallsV);
            g.upDown = clone2(this.upDown);
            g.leftRight = clone2(this.leftRight);
            g.validH = clone2(this.validH);
            g.validV = clone2(this.validV);
            g.turn = this.turn;
            g.winner = this.winner == null ? null : g.pawns[this.winner.index];
            return g;
        }

        toJSON() {
            return {
                pawns: this.pawns.map((p) => ({
                    index: p.index,
                    row: p.row,
                    col: p.col,
                    goalRow: p.goalRow,
                    wallsLeft: p.wallsLeft,
                })),
                wallsH: this.wallsH,
                wallsV: this.wallsV,
                upDown: this.upDown,
                leftRight: this.leftRight,
                validH: this.validH,
                validV: this.validV,
                turn: this.turn,
                winner: this.winner ? this.winner.index : null,
            };
        }

        static fromJSON(data) {
            const g = new Engine();
            g.pawns = data.pawns.map((pd) => {
                const p = new Pawn(pd.index);
                p.row = pd.row;
                p.col = pd.col;
                p.goalRow = pd.goalRow;
                p.wallsLeft = pd.wallsLeft;
                return p;
            });
            g.wallsH = data.wallsH.map((row) =>
                row.map((v) => (v === true ? 0 : v === false ? null : v))
            );
            g.wallsV = data.wallsV.map((row) =>
                row.map((v) => (v === true ? 0 : v === false ? null : v))
            );
            g.upDown = clone2(data.upDown);
            g.leftRight = clone2(data.leftRight);
            g.validH = clone2(data.validH);
            g.validV = clone2(data.validV);
            g.turn = data.turn;
            g.winner = data.winner == null ? null : g.pawns[data.winner];
            return g;
        }

        isOpenWay(row, col, move) {
            const [dr, dc] = move;
            if (dr === -1 && dc === 0) return row > 0 && this.upDown[row - 1][col];
            if (dr === 1 && dc === 0) return row < 8 && this.upDown[row][col];
            if (dr === 0 && dc === -1) return col > 0 && this.leftRight[row][col - 1];
            if (dr === 0 && dc === 1) return col < 8 && this.leftRight[row][col];
            return false;
        }

        validNextPositions() {
            if (this._movesCache) return this._movesCache;
            const grid = zeros2(SIZE, SIZE, false);
            const me = this.pawnOfTurn;
            const them = this.pawnOfNotTurn;
            const tryToward = (main, sub1, sub2) => {
                if (!this.isOpenWay(me.row, me.col, main)) return;
                const r1 = me.row + main[0];
                const c1 = me.col + main[1];
                if (r1 === them.row && c1 === them.col) {
                    if (this.isOpenWay(r1, c1, main)) {
                        grid[r1 + main[0]][c1 + main[1]] = true;
                    } else {
                        if (this.isOpenWay(r1, c1, sub1)) {
                            grid[r1 + sub1[0]][c1 + sub1[1]] = true;
                        }
                        if (this.isOpenWay(r1, c1, sub2)) {
                            grid[r1 + sub2[0]][c1 + sub2[1]] = true;
                        }
                    }
                } else {
                    grid[r1][c1] = true;
                }
            };
            tryToward(UP, LEFT, RIGHT);
            tryToward(DOWN, LEFT, RIGHT);
            tryToward(LEFT, UP, DOWN);
            tryToward(RIGHT, UP, DOWN);
            this._movesCache = grid;
            return grid;
        }

        pathLength(pawn) {
            return shortestPathLength(
                this.upDown,
                this.leftRight,
                pawn.row,
                pawn.col,
                pawn.goalRow
            );
        }

        pathExists(pawn) {
            return this.pathLength(pawn) < INF;
        }

        bothPathsExist() {
            return this.pathExists(this.pawnOfTurn) && this.pathExists(this.pawnOfNotTurn);
        }

        canPlaceH(row, col) {
            if (this.pawnOfTurn.wallsLeft <= 0 || !this.validH[row][col]) return false;
            this.upDown[row][col] = false;
            this.upDown[row][col + 1] = false;
            const ok = this.bothPathsExist();
            this.upDown[row][col] = true;
            this.upDown[row][col + 1] = true;
            return ok;
        }

        canPlaceV(row, col) {
            if (this.pawnOfTurn.wallsLeft <= 0 || !this.validV[row][col]) return false;
            this.leftRight[row][col] = false;
            this.leftRight[row + 1][col] = false;
            const ok = this.bothPathsExist();
            this.leftRight[row][col] = true;
            this.leftRight[row + 1][col] = true;
            return ok;
        }

        listLegalMoves() {
            const moves = [];
            const grid = this.validNextPositions();
            for (let r = 0; r < SIZE; r++) {
                for (let c = 0; c < SIZE; c++) {
                    if (grid[r][c]) moves.push({ type: "move", row: r, col: c });
                }
            }
            if (this.pawnOfTurn.wallsLeft > 0) {
                for (let r = 0; r < WALL_N; r++) {
                    for (let c = 0; c < WALL_N; c++) {
                        if (this.canPlaceH(r, c)) moves.push({ type: "H", row: r, col: c });
                        if (this.canPlaceV(r, c)) moves.push({ type: "V", row: r, col: c });
                    }
                }
            }
            return moves;
        }

        applyMove(move) {
            if (!move) return false;
            if (move.type === "move") {
                const grid = this.validNextPositions();
                if (!grid[move.row][move.col]) return false;
                const p = this.pawnOfTurn;
                p.row = move.row;
                p.col = move.col;
                if (p.row === p.goalRow) this.winner = p;
                this.turn++;
                this.invalidate();
                return true;
            }
            if (move.type === "H") {
                if (!this.canPlaceH(move.row, move.col)) return false;
                this.upDown[move.row][move.col] = false;
                this.upDown[move.row][move.col + 1] = false;
                this.validV[move.row][move.col] = false;
                this.validH[move.row][move.col] = false;
                if (move.col > 0) this.validH[move.row][move.col - 1] = false;
                if (move.col < 7) this.validH[move.row][move.col + 1] = false;
                this.wallsH[move.row][move.col] = this.pawnOfTurn.index;
                this.pawnOfTurn.wallsLeft--;
                this.turn++;
                this.invalidate();
                return true;
            }
            if (move.type === "V") {
                if (!this.canPlaceV(move.row, move.col)) return false;
                this.leftRight[move.row][move.col] = false;
                this.leftRight[move.row + 1][move.col] = false;
                this.validH[move.row][move.col] = false;
                this.validV[move.row][move.col] = false;
                if (move.row > 0) this.validV[move.row - 1][move.col] = false;
                if (move.row < 7) this.validV[move.row + 1][move.col] = false;
                this.wallsV[move.row][move.col] = this.pawnOfTurn.index;
                this.pawnOfTurn.wallsLeft--;
                this.turn++;
                this.invalidate();
                return true;
            }
            return false;
        }

        scoreForPlayer(playerIndex) {
            const me = this.pawns[playerIndex];
            const opp = this.pawns[1 - playerIndex];
            const myD = this.pathLength(me);
            const oppD = this.pathLength(opp);
            if (myD >= INF) return -INF;
            if (oppD >= INF) return INF;
            return oppD - myD;
        }
    }

    function chooseGreedy(engine) {
        const legal = engine.listLegalMoves();
        if (!legal.length) return null;
        const me = engine.pawnOfTurn.index;
        let best = -INF * 2;
        let picks = [];
        for (let i = 0; i < legal.length; i++) {
            const mv = legal[i];
            const child = engine.clone();
            if (!child.applyMove(mv)) continue;
            if (child.winner && child.winner.index === me) return mv;
            const sc = child.scoreForPlayer(me);
            if (sc > best) {
                best = sc;
                picks = [mv];
            } else if (sc === best) {
                picks.push(mv);
            }
        }
        if (!picks.length) return legal[0];
        return picks[Math.floor(Math.random() * picks.length)];
    }

    const api = { SIZE, WALL_N, INF, Engine, chooseGreedy, shortestPathLength };
    root.QuoridorEngine = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof self !== "undefined" ? self : this);
