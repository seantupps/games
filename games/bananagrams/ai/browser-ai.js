/**
 * Browser port of ptests/games/bananagrams/ai (solver + reorg).
 */
(function (global) {
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

/** Placement search — mirrors build/bananagrams/ai/banana/solver.py */



function wordsFromCounts(nodes, minLen, maxLen, counts, limit) {
    const found = [];
    const rackCounts = [...counts];

    function dfs(nodeIdx, path, depth) {
        if (found.length >= limit) return;
        const node = nodes[nodeIdx];
        if (depth >= minLen && node.terminal) {
            found.push(path.toUpperCase());
        }
        if (depth >= maxLen) return;
        for (const [ch, childIdx] of childEntries(node)) {
            const i = ch.charCodeAt(0) - 97;
            if (i >= 0 && i < 26 && rackCounts[i] > 0) {
                rackCounts[i] -= 1;
                dfs(childIdx, path + ch, depth + 1);
                rackCounts[i] += 1;
            }
        }
    }

    dfs(0, '', 0);
    found.sort((a, b) => b.length - a.length || a.localeCompare(b));
    return found;
}

function coordsForWord(word, ax, ay, anchorI, horizontal) {
    const out = [];
    const W = word.toUpperCase();
    for (let i = 0; i < W.length; i++) {
        if (horizontal) out.push([ax + i - anchorI, ay]);
        else out.push([ax, ay + i - anchorI]);
    }
    return out;
}

function tryPlace(board, word, coords, dictionary) {
    const W = word.toUpperCase();
    const newCoordsList = [];
    let used = 0;

    for (let i = 0; i < coords.length; i++) {
        const [x, y] = coords[i];
        const key = `${x},${y}`;
        const existing = board.cells[key];
        if (existing) {
            if (existing !== W[i]) return null;
        } else {
            newCoordsList.push([x, y]);
            used += 1;
        }
    }

    if (used === 0) return null;

    const newCoordsSet = new Set(newCoordsList.map(([x, y]) => `${x},${y}`));
    if (!board.isConnectedWith(newCoordsSet)) return null;

  // Trial placement (cells only — mirrors Python _try_place; no byLetter updates)
    const added = [];
    for (const [x, y] of newCoordsList) {
        const key = `${x},${y}`;
        const i = coords.findIndex(([cx, cy]) => cx === x && cy === y);
        board.cells[key] = W[i];
        added.push(key);
    }

    let ok = true;
    for (const w of board.wordsThrough(newCoordsList)) {
        if (!dictionary.isWord(w)) {
            ok = false;
            break;
        }
    }

    for (const key of added) {
        delete board.cells[key];
    }

    return ok ? used : null;
}

function findBestPlacement(board, rack, dictionary) {
    if (!rack || rack.length === 0) return null;

    const limit = rack.length <= 4 ? 60 : 100;
    const rackSet = new Set(rack.map((c) => c.toUpperCase()));
    let best = null;

    if (Object.keys(board.cells).length === 0) {
        const candidates = dictionary.rackWords(rack, limit);
        if (!candidates.length) return null;
        for (const word of candidates.slice(0, 24)) {
            for (const horizontal of [true, false]) {
                const coords = coordsForWord(word, 0, 0, 0, horizontal);
                const used = tryPlace(board, word, coords, dictionary);
                if (used !== null) {
                    const score = used * 100 + word.length;
                    if (!best || score > best.score) {
                        best = { word: word.toUpperCase(), coords, score };
                    }
                    if (used === rack.length) {
                        return [word.toUpperCase(), coords];
                    }
                }
            }
        }
        return best ? [best.word, best.coords] : null;
    }

    const candidates = dictionary.rackWords(rack, limit);
    if (candidates.length) {
        for (const word of candidates) {
            const w = word.toUpperCase();
            for (let anchorI = 0; anchorI < w.length; anchorI++) {
                const ch = w[anchorI];
                const anchors = board.byLetter[ch];
                if (!anchors) continue;
                for (const key of anchors) {
                    const [ax, ay] = key.split(',').map(Number);
                    for (const horizontal of [true, false]) {
                        const coords = coordsForWord(w, ax, ay, anchorI, horizontal);
                        const used = tryPlace(board, w, coords, dictionary);
                        if (used !== null) {
                            const score = used * 100 + w.length;
                            if (!best || score > best.score) {
                                best = { word: w, coords, score };
                            }
                            if (used === rack.length) {
                                return [w, coords];
                            }
                        }
                    }
                }
            }
        }
    }

    const minLen = dictionary.minLen;
    const maxLen = dictionary.maxLen;
    const rackCounts = Array(26).fill(0);
    for (const ch of rack) {
        const i = ch.toUpperCase().charCodeAt(0) - 65;
        if (i >= 0 && i < 26) rackCounts[i] += 1;
    }
    const rackLetters = [];
    for (let i = 0; i < 26; i++) {
        if (rackCounts[i] > 0) rackLetters.push(String.fromCharCode(65 + i));
    }

    if (rackLetters.length) {
        const adjEmpty = new Set();
        for (const key of Object.keys(board.cells)) {
            const [x, y] = key.split(',').map(Number);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx;
                const ny = y + dy;
                if (!board.cells[`${nx},${ny}`]) adjEmpty.add(`${nx},${ny}`);
            }
        }

        let adjEmptyList = [...adjEmpty];
        if (adjEmptyList.length > 48) {
            adjEmptyList.sort((a, b) => {
                const [ax, ay] = a.split(',').map(Number);
                let scoreA = 0;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (board.cells[`${ax + dx},${ay + dy}`]) scoreA += 1;
                }
                const [bx, by] = b.split(',').map(Number);
                let scoreB = 0;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (board.cells[`${bx + dx},${by + dy}`]) scoreB += 1;
                }
                return scoreB - scoreA;
            });
            adjEmptyList = adjEmptyList.slice(0, 48);
        }

        for (const cellKey of adjEmptyList) {
            const [newX, newY] = cellKey.split(',').map(Number);
            for (const rackCh of rackLetters) {
                for (const horizontal of [true, false]) {
                    if (horizontal) {
                        let leftMax = 0;
                        while (leftMax < maxLen - 1 && board.cells[`${newX - leftMax - 1},${newY}`]) {
                            leftMax += 1;
                        }
                        let rightMax = 0;
                        while (rightMax < maxLen - 1 && board.cells[`${newX + rightMax + 1},${newY}`]) {
                            rightMax += 1;
                        }
                        for (let le = 0; le <= leftMax; le++) {
                            const reMax = Math.min(rightMax, maxLen - 1 - le);
                            for (let re = 0; re <= reMax; re++) {
                                if (le + 1 + re < minLen) continue;
                                const wordChars = [];
                                let ok = true;
                                for (let x = newX - le; x <= newX + re; x++) {
                                    if (x === newX) wordChars.push(rackCh);
                                    else {
                                        const ch = board.cells[`${x},${newY}`];
                                        if (!ch) { ok = false; break; }
                                        wordChars.push(ch);
                                    }
                                }
                                if (!ok) continue;
                                const word = wordChars.join('').toUpperCase();
                                if (!dictionary.isWord(word)) continue;
                                const coords = [];
                                for (let x = newX - le; x <= newX + re; x++) coords.push([x, newY]);
                                const used = tryPlace(board, word, coords, dictionary);
                                if (used !== null) {
                                    const score = used * 100 + word.length;
                                    if (!best || score > best.score) {
                                        best = { word, coords, score };
                                    }
                                }
                            }
                        }
                    } else {
                        let upMax = 0;
                        while (upMax < maxLen - 1 && board.cells[`${newX},${newY - upMax - 1}`]) {
                            upMax += 1;
                        }
                        let downMax = 0;
                        while (downMax < maxLen - 1 && board.cells[`${newX},${newY + downMax + 1}`]) {
                            downMax += 1;
                        }
                        for (let ue = 0; ue <= upMax; ue++) {
                            const deMax = Math.min(downMax, maxLen - 1 - ue);
                            for (let de = 0; de <= deMax; de++) {
                                if (ue + 1 + de < minLen) continue;
                                const wordChars = [];
                                let ok = true;
                                for (let y = newY - ue; y <= newY + de; y++) {
                                    if (y === newY) wordChars.push(rackCh);
                                    else {
                                        const ch = board.cells[`${newX},${y}`];
                                        if (!ch) { ok = false; break; }
                                        wordChars.push(ch);
                                    }
                                }
                                if (!ok) continue;
                                const word = wordChars.join('').toUpperCase();
                                if (!dictionary.isWord(word)) continue;
                                const coords = [];
                                for (let y = newY - ue; y <= newY + de; y++) coords.push([newX, y]);
                                const used = tryPlace(board, word, coords, dictionary);
                                if (used !== null) {
                                    const score = used * 100 + word.length;
                                    if (!best || score > best.score) {
                                        best = { word, coords, score };
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return best ? [best.word, best.coords] : null;
}

function applyPlacement(board, word, coords) {
    const W = word.toUpperCase();
    for (let i = 0; i < coords.length; i++) {
        board.setCell(coords[i][0], coords[i][1], W[i]);
    }
}

/** Pick up all tiles and rebuild — mirrors build/bananagrams/ai/banana/reorg.py */




function rebuild(letters, dictionary, maxOpeners = 24, maxPlaces = 64) {
    if (letters.length < 2 || letters.length > 144) return null;

    const openers = dictionary.rackWords(letters, maxOpeners + 4).slice(0, maxOpeners);
    if (!openers.length) return null;

    let bestBoard = null;
    let bestRack = null;
    let bestLeft = 999;

    for (const opener of openers) {
        const board = new Board();
        let rack = letters.map((c) => c.toUpperCase());
        const w = opener.toUpperCase();
        let ok = true;
        for (const ch of w) {
            const idx = rack.indexOf(ch);
            if (idx === -1) { ok = false; break; }
            rack.splice(idx, 1);
        }
        if (!ok) continue;

        applyPlacement(board, w, coordsForWord(w, 0, 0, 0, true));

        for (let i = 0; i < maxPlaces; i++) {
            const hit = findBestPlacement(board, rack, dictionary);
            if (!hit) break;
            const [word, coords] = hit;
            const take = [];
            for (let j = 0; j < coords.length; j++) {
                const key = `${coords[j][0]},${coords[j][1]}`;
                if (!board.cells[key]) take.push(word[j]);
            }
            try {
                for (const ch of take) {
                    const idx = rack.indexOf(ch);
                    if (idx === -1) throw new Error('rack');
                    rack.splice(idx, 1);
                }
            } catch {
                break;
            }
            applyPlacement(board, word, coords);
        }

        if (!validateFull(board, dictionary).ok) continue;
        if (rack.length < bestLeft) {
            bestLeft = rack.length;
            bestBoard = board;
            bestRack = rack;
        }
        if (!rack.length) return [board, []];
    }

    if (!bestBoard) return null;
    return [bestBoard, bestRack || []];
}

function restoreBoard(board, snapshot) {
    board.cells = { ...snapshot.cells };
    board.byLetter = {};
    for (const [ch, keys] of Object.entries(snapshot.byLetter || {})) {
        board.byLetter[ch] = new Set(keys);
    }
}

/** Mirrors ptests/games/bananagrams/ai/game.js _placeWords */
function placeWords(board, rack, dictionary) {
    let n = 0;
    while (true) {
        const hit = findBestPlacement(board, rack, dictionary);
        if (!hit) break;
        const [word, coords] = hit;
        const beforeB = board.clone();
        const beforeR = [...rack];
        const take = [];
        for (let i = 0; i < coords.length; i++) {
            const key = `${coords[i][0]},${coords[i][1]}`;
            if (!board.cells[key]) take.push(word[i]);
        }
        try {
            for (const ch of take) {
                const idx = rack.indexOf(ch);
                if (idx === -1) throw new Error('rack');
                rack.splice(idx, 1);
            }
        } catch {
            restoreBoard(board, beforeB);
            rack.length = 0;
            rack.push(...beforeR);
            break;
        }
        applyPlacement(board, word, coords);
        if (!validateFull(board, dictionary).ok) {
            restoreBoard(board, beforeB);
            rack.length = 0;
            rack.push(...beforeR);
            break;
        }
        n += 1;
    }
    return n;
}

/** Mirrors ptests/games/bananagrams/ai/game.js _reorganize */
function reorganize(board, rack, dictionary) {
    const letters = [
        ...Object.values(board.cells),
        ...rack
    ];
    if (letters.length < 2) return false;
    const built = rebuild(letters, dictionary);
    if (!built) return false;
    const [newBoard, newRack] = built;
    if (
        newRack.length >= rack.length
        && Object.keys(newBoard.cells).length <= Object.keys(board.cells).length
    ) {
        return false;
    }
    restoreBoard(board, newBoard);
    rack.length = 0;
    rack.push(...newRack);
    return true;
}

/**
 * One solve attempt on a rack (empty board) — mirrors ptests solveAttemptFromRack / Game.solveAttempt.
 */
function solveAttemptFromRack(letters, dictionary) {
    const board = new Board();
    const rack = letters.map((c) => String(c).toUpperCase());
    const before = { ...board.cells };
    let reorgs = 0;

    placeWords(board, rack, dictionary);
    if (!rack.length) {
        return {
            cleared: true,
            placements: boardPlacements(board),
            rackLeft: [],
            reorgs
        };
    }

    const changed = JSON.stringify(board.cells) !== JSON.stringify(before);
    if (!changed || !findBestPlacement(board, rack, dictionary)) {
        if (reorganize(board, rack, dictionary)) {
            reorgs += 1;
            placeWords(board, rack, dictionary);
            if (!rack.length) {
                return {
                    cleared: true,
                    placements: boardPlacements(board),
                    rackLeft: [],
                    reorgs
                };
            }
        }
    }

    return {
        cleared: !rack.length,
        placements: boardPlacements(board),
        rackLeft: [...rack],
        reorgs
    };
}

    function childEntries(node) {
        const kids = node?.children;
        if (!kids) return [];
        if (Array.isArray(kids)) return kids.map((c) => [c.letter, c.child]);
        return Object.entries(kids);
    }

    function wordsFromCountsBrowser(nodes, minLen, maxLen, counts, limit) {
        const found = [];
        const rackCounts = [...counts];
        function dfs(nodeIdx, path, depth) {
            if (found.length >= limit) return;
            const node = nodes[nodeIdx];
            if (depth >= minLen && node.terminal) found.push(path.toUpperCase());
            if (depth >= maxLen) return;
            for (const [ch, childIdx] of childEntries(node)) {
                const i = ch.charCodeAt(0) - 97;
                if (i >= 0 && i < 26 && rackCounts[i] > 0) {
                    rackCounts[i] -= 1;
                    dfs(childIdx, path + ch, depth + 1);
                    rackCounts[i] += 1;
                }
            }
        }
        dfs(0, '', 0);
        found.sort((a, b) => b.length - a.length || a.localeCompare(b));
        return found;
    }

    function createDictionary(checker, nodes, header = {}) {
        const minLen = header.minLen ?? 2;
        const maxLen = header.maxLen ?? 15;
        const cache = new Map();
        return {
            minLen,
            maxLen,
            isWord(w) { return !!checker?.isWord?.(w); },
            rackWords(rack, limit = 40) {
                const counts = rackCountsKey(rack);
                const cap = Math.min(maxLen, counts.reduce((s, n) => s + n, 0));
                if (cap < minLen) return [];
                const key = counts.join(',') + '|' + cap + '|' + limit;
                if (cache.has(key)) return [...cache.get(key)];
                const hit = wordsFromCountsBrowser(nodes, minLen, cap, counts, limit);
                cache.set(key, hit);
                return hit;
            }
        };
    }

    function comb(n, k) {
        if (k < 0 || k > n) return 0;
        if (k === 0 || k === n) return 1;
        k = Math.min(k, n - k);
        let c = 1;
        for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
        return Math.round(c);
    }

    function chooseIndexSubsets(total, pick, maxOut) {
        if (pick === 0) return [[]];
        if (pick > total) return [];
        const out = [];
        const all = comb(total, pick);
        if (all <= maxOut) {
            const idx = Array.from({ length: pick }, (_, i) => i);
            while (true) {
                out.push(idx.slice());
                let i = pick - 1;
                while (i >= 0 && idx[i] === total - pick + i) i--;
                if (i < 0) break;
                idx[i]++;
                for (let j = i + 1; j < pick; j++) idx[j] = idx[j - 1] + 1;
            }
            return out;
        }
        const seen = new Set();
        while (out.length < maxOut) {
            const pickSet = new Set();
            while (pickSet.size < pick) pickSet.add(Math.floor(Math.random() * total));
            const key = [...pickSet].sort((a, b) => a - b).join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push([...pickSet].sort((a, b) => a - b));
        }
        return out;
    }

    function solveWithStragglers(letters, stragglerCount, dictionary, opts = {}) {
        const pool = letters.map((c) => String(c).toUpperCase());
        const n = Number(stragglerCount) | 0;
        if (!Number.isFinite(n) || n < 0 || n > pool.length) return null;

        if (n === 0) {
            const result = solveAttemptFromRack(pool, dictionary);
            if (!result.cleared) return null;
            return {
                placements: result.placements,
                stragglerIndices: []
            };
        }

        const maxSubsets = opts.dev ? 500 : 120;
        const subsets = chooseIndexSubsets(pool.length, n, maxSubsets);
        for (const indices of subsets) {
            const skip = new Set(indices);
            const remaining = pool.filter((_, i) => !skip.has(i));
            const result = solveAttemptFromRack(remaining, dictionary);
            if (!result.cleared) continue;
            return {
                placements: result.placements,
                stragglerIndices: indices.slice()
            };
        }
        return null;
    }

    global.BananaAi = {
        Board,
        rebuild,
        solveAttemptFromRack,
        solveWithStragglers,
        createDictionary,
        boardPlacements,
        validateFull
    };

})(typeof window !== 'undefined' ? window : global);
