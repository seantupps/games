const MIN_WORD_LEN = 2;

class Board {
    constructor() {
        this.cells = {};
        this.byLetter = {};
    }

    clone() {
        const b = new Board();
        b.cells = { ...this.cells };
        b.byLetter = {};
        for (const [ch, keys] of Object.entries(this.byLetter)) {
            b.byLetter[ch] = new Set(keys);
        }
        return b;
    }

    setCell(x, y, letter) {
        const key = `${x},${y}`;
        const L = letter.toUpperCase();
        if (this.cells[key]) {
            return this.cells[key] === L;
        }
        this.cells[key] = L;
        if (!this.byLetter[L]) this.byLetter[L] = new Set();
        this.byLetter[L].add(key);
        return true;
    }

    readRun(x, y, horizontal) {
        let curX = x;
        let curY = y;
        if (horizontal) {
            while (this.cells[`${curX - 1},${y}`]) curX -= 1;
            const chars = [];
            while (this.cells[`${curX},${y}`]) {
                chars.push(this.cells[`${curX},${y}`]);
                curX += 1;
            }
            return chars.join('');
        }
        while (this.cells[`${x},${curY - 1}`]) curY -= 1;
        const chars = [];
        while (this.cells[`${x},${curY}`]) {
            chars.push(this.cells[`${x},${curY}`]);
            curY += 1;
        }
        return chars.join('');
    }

    wordsThrough(coords) {
        const coordList = coords.map((c) => (Array.isArray(c) ? c : [c.gx ?? c.x, c.gy ?? c.y]));
        const seen = new Set();
        const out = [];
        for (const [x, y] of coordList) {
            for (const horiz of [true, false]) {
                const w = this.readRun(x, y, horiz);
                if (w.length >= MIN_WORD_LEN && !seen.has(w)) {
                    seen.add(w);
                    out.push(w);
                }
            }
        }
        return out;
    }

    isConnectedWith(newCoords) {
        const keys = newCoords instanceof Set
            ? newCoords
            : new Set(
                [...newCoords].map((c) => (typeof c === 'string' ? c : `${c[0]},${c[1]}`))
            );
        if (keys.size === 0) return false;
        if (Object.keys(this.cells).length === 0) {
            return this._isBlobConnected(keys);
        }

        let touchesOld = false;
        for (const key of keys) {
            const [x, y] = key.split(',').map(Number);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (this.cells[`${x + dx},${y + dy}`]) {
                    touchesOld = true;
                    break;
                }
            }
            if (touchesOld) break;
        }
        return touchesOld && this._isBlobConnected(keys);
    }

    _isBlobConnected(keys) {
        if (keys.size <= 1) return true;
        const start = keys.values().next().value;
        const seen = new Set([start]);
        const stack = [start];
        while (stack.length) {
            const key = stack.pop();
            const [x, y] = key.split(',').map(Number);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const n = `${x + dx},${y + dy}`;
                if (keys.has(n) && !seen.has(n)) {
                    seen.add(n);
                    stack.push(n);
                }
            }
        }
        return seen.size === keys.size;
    }
}

function validateFull(board, dictionary) {
    const keys = Object.keys(board.cells);
    if (!keys.length) return { ok: false, reason: 'empty' };
    const coords = keys.map((k) => k.split(',').map(Number));
    const words = board.wordsThrough(coords);
    for (const w of words) {
        if (!dictionary.isWord(w)) {
            return { ok: false, reason: 'invalid-word', word: w };
        }
    }
    return { ok: true, words };
}

function rackCountsKey(rack) {
    const counts = Array(26).fill(0);
    for (const ch of rack) {
        const o = ch.toUpperCase().charCodeAt(0) - 65;
        if (o >= 0 && o < 26) counts[o] += 1;
    }
    return counts;
}

function boardPlacements(board) {
    return Object.entries(board.cells).map(([key, letter]) => {
        const [gx, gy] = key.split(',').map(Number);
        return { gx, gy, letter };
    });
}

module.exports = {
    Board,
    MIN_WORD_LEN,
    validateFull,
    rackCountsKey,
    boardPlacements
};
