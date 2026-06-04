/** Terminal transcript — mirrors build/bananagrams/ai/banana/transcript.py */

function asciiBoard(board) {
    const keys = Object.keys(board.cells);
    if (!keys.length) {
        return ['. . . . . . . .'];
    }
    const xs = [];
    const ys = [];
    for (const key of keys) {
        const [x, y] = key.split(',').map(Number);
        xs.push(x);
        ys.push(y);
    }
    const minX = Math.min(...xs) - 1;
    const maxX = Math.max(...xs) + 1;
    const minY = Math.min(...ys) - 1;
    const maxY = Math.max(...ys) + 1;
    const lines = [];
    for (let gy = minY; gy <= maxY; gy++) {
        const row = [];
        for (let gx = minX; gx <= maxX; gx++) {
            const ch = board.cells[`${gx},${gy}`];
            row.push(ch || '.');
        }
        lines.push(row.join(' '));
    }
    return lines;
}

class Transcript {
    constructor({ echo = true } = {}) {
        this.echo = echo;
        this.lines = [];
    }

    _out(...parts) {
        for (const part of parts) {
            this.lines.push(part);
            if (this.echo) {
                console.log(part);
            }
        }
    }

    separator() {
        this._out('--------------');
    }

    start(board) {
        this._out('Start');
        this._out(...asciiBoard(board));
    }

    attempt(n) {
        this._out(`Attempt: ${n}`);
    }

    falseAttempt(n) {
        this._out(`[FALSE] Attempt: ${n}`);
    }

    board(board) {
        this._out(...asciiBoard(board));
    }

    peel(letter) {
        this._out(`Peel -> ${letter.toUpperCase()}`);
    }

    dump(returned, drawn) {
        const drawnS = drawn.map((c) => c.toUpperCase()).join('');
        this._out(`Dump ${returned.toUpperCase()} -> ${drawnS}`);
    }
}

module.exports = { Transcript, asciiBoard };
