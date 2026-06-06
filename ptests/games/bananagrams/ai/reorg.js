/** Pick up all tiles and rebuild — mirrors build/bananagrams/ai/banana/reorg.py */

const { Board, validateFull } = require('./grid');
const { coordsForWord, findBestPlacement, applyPlacement } = require('./solver');

function rebuild(letters, dictionary, maxOpeners = 24, maxPlaces = 64, shouldAbort = null) {
    if (letters.length < 2 || letters.length > 144) return null;

    const openers = dictionary.rackWords(letters, maxOpeners + 4).slice(0, maxOpeners);
    if (!openers.length) return null;

    let bestBoard = null;
    let bestRack = null;
    let bestLeft = 999;

    for (const opener of openers) {
        if (shouldAbort?.()) break;
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
            if (shouldAbort?.()) break;
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

module.exports = { rebuild };
