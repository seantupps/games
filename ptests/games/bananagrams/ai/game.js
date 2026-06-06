/**
 * Game loop — mirrors build/bananagrams/ai/banana/game.py
 */

const { Board, validateFull, boardPlacements } = require('./grid');
const { findBestPlacement, applyPlacement } = require('./solver');
const { rebuild } = require('./reorg');
const {
    buildShuffledPool,
    verifyAllTiles,
    verifyHandFromPool
} = require('./rules');

class Game {
    constructor(dictionary, rng = null, { handSize = 4, log = null } = {}) {
        this.dictionary = dictionary;
        this.log = log;
        this.rng = rng || {
            randrange(n) {
                return Math.floor(Math.random() * n);
            },
            shuffle(arr) {
                for (let i = arr.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [arr[i], arr[j]] = [arr[j], arr[i]];
                }
            }
        };
        this.handSize = handSize;
        this.bunch = [];
        this.rack = [];
        this.board = new Board();
        this.dumps = 0;
        this.peels = 0;
        this.reorgs = 0;
        this.attempt = 0;
        this._deadline = null;
    }

    _draw(n) {
        const out = [];
        for (let i = 0; i < n && this.bunch.length; i++) {
            out.push(this.bunch.pop());
        }
        return out;
    }

    _timedOut() {
        return this._deadline != null && Date.now() >= this._deadline;
    }

    deal() {
        this.bunch = buildShuffledPool(this.rng);
        if (!verifyHandFromPool([], this.bunch)) {
            throw new Error('shuffled pool is not a valid 144-tile bag');
        }
        this.rack = this._draw(this.handSize);
        this.board = new Board();
        const onBoard = Object.values(this.board.cells);
        if (!verifyAllTiles(this.rack, this.bunch, onBoard)) {
            throw new Error('deal broke pool multiset');
        }
    }

    /** Start from an existing rack (browser hand) — no deal/shuffle. */
    loadRack(letters) {
        this.rack = letters.map((c) => c.toUpperCase());
        this.board = new Board();
        this.bunch = [];
    }

    _placeWords() {
        let n = 0;
        while (!this._timedOut()) {
            const hit = findBestPlacement(this.board, this.rack, this.dictionary);
            if (!hit) break;
            const [word, coords] = hit;
            const beforeB = this.board.clone();
            const beforeR = [...this.rack];
            const take = [];
            for (let i = 0; i < coords.length; i++) {
                const key = `${coords[i][0]},${coords[i][1]}`;
                if (!this.board.cells[key]) take.push(word[i]);
            }
            try {
                for (const ch of take) {
                    const idx = this.rack.indexOf(ch);
                    if (idx === -1) throw new Error('rack');
                    this.rack.splice(idx, 1);
                }
            } catch {
                this.board = beforeB;
                this.rack = beforeR;
                break;
            }
            applyPlacement(this.board, word, coords);
            if (!validateFull(this.board, this.dictionary).ok) {
                this.board = beforeB;
                this.rack = beforeR;
                break;
            }
            n += 1;
        }
        return n;
    }

    _reorganize() {
        const letters = [
            ...Object.values(this.board.cells),
            ...this.rack
        ];
        if (letters.length < 2) return false;
        const built = rebuild(letters, this.dictionary);
        if (!built) return false;
        const [newBoard, newRack] = built;
        if (
            newRack.length >= this.rack.length
            && Object.keys(newBoard.cells).length <= Object.keys(this.board.cells).length
        ) {
            return false;
        }
        this.board = newBoard;
        this.rack = newRack;
        this.reorgs += 1;
        return true;
    }

    /** Python _solve_attempt — returns [rackEmpty, boardChanged]. */
    solveAttempt() {
        const before = { ...this.board.cells };
        this._placeWords();

        if (!this.rack.length) {
            return [true, JSON.stringify(this.board.cells) !== JSON.stringify(before)];
        }

        // If we didn't clear the rack, try to reorganize.
        // We do this if either we are truly stuck (no placements)
        // OR if the placements we found didn't actually lead to changing the board (e.g. invalid board safety).
        const changed = JSON.stringify(this.board.cells) !== JSON.stringify(before);
        if (!changed || !findBestPlacement(this.board, this.rack, this.dictionary)) {
            if (this._reorganize()) {
                this._placeWords();
                if (!this.rack.length) {
                    return [true, true];
                }
            }
        }

        const finalChanged = JSON.stringify(this.board.cells) !== JSON.stringify(before);
        return [!this.rack.length, finalChanged];
    }

    _stuck() {
        return this.rack.length > 0
            && findBestPlacement(this.board, this.rack, this.dictionary) === null;
    }

    peel() {
        if (this.rack.length || !this.bunch.length) return null;
        const letter = this.bunch.pop();
        this.rack.push(letter);
        this.peels += 1;
        return letter;
    }

    dump() {
        if (!this.rack.length || this.bunch.length < 3) return null;
        const returned = this.rack.splice(this.rng.randrange(this.rack.length), 1)[0];
        this.bunch.unshift(returned);
        const drawn = this._draw(3);
        this.rack.push(...drawn);
        this.dumps += 1;
        return [returned, drawn];
    }

    /**
     * Full play.py loop: deal → solve attempts → peel / dump.
     * @param {{ maxTurns?: number|null, deadlineMs?: number|null }} opts
     */
    run(opts = {}) {
        const { maxTurns = null, deadlineMs = null } = opts;
        this._deadline = deadlineMs != null ? Date.now() + deadlineMs : null;
        this.deal();
        let turns = 0;
        while (true) {
            if (maxTurns != null && turns >= maxTurns) break;
            if (this._timedOut()) break;
            this.attempt += 1;
            const [cleared, changed] = this.solveAttempt();
            if (changed) {
                this.log?.board(this.board);
            }

            if (cleared) {
                if (!this.bunch.length) {
                    return { won: true, turns, peels: this.peels, dumps: this.dumps };
                }
                const peeled = this.peel();
                if (!peeled) break;
                turns += 1;
                continue;
            }

            if (this._stuck()) {
                const dumped = this.dump();
                if (!dumped) break;
                turns += 1;
            } else {
                break;
            }
        }
        return {
            won: false,
            turns,
            peels: this.peels,
            dumps: this.dumps,
            rackLeft: [...this.rack],
            board: boardPlacements(this.board)
        };
    }
}

module.exports = { Game };
