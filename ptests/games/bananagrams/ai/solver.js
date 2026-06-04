/** Placement search — mirrors build/bananagrams/ai/banana/solver.py */

const { Board } = require('./grid');

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
        for (const [ch, childIdx] of Object.entries(node.children)) {
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

module.exports = {
    wordsFromCounts,
    coordsForWord,
    findBestPlacement,
    applyPlacement
};
