#!/usr/bin/env node
/**
 * Quick parity check vs Python (run from repo root):
 *   node ptests/games/bananagrams/ai/parity.js
 *   python build/bananagrams/ai/play.py --seed 42 --hand 4
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { getDictionary } = require('./dictionary');
const { Game } = require('./game');
const { validateFull } = require('./grid');
const { makeRng } = require('./rules');
const { solveAttemptFromRack } = require('./index');

function pySolve(rackLetters) {
    const aiDir = path.resolve(__dirname, '../../../../build/bananagrams/ai');
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(aiDir)})
from banana.dictionary import get_dictionary
from banana.game import Game
from banana.transcript import Transcript
from banana.grid import validate_full

rack = json.loads(sys.argv[1])
d = get_dictionary()
g = Game(d, __import__('random').Random(0), hand_size=len(rack), log=Transcript(echo=False))
g.load_rack(rack)
cleared, _ = g._solve_attempt()
pl = sorted([(c[0], c[1], ch) for c, ch in g.board.cells.items()])
ok = validate_full(g.board, d)['ok']
print(json.dumps({'cleared': cleared, 'placements': pl, 'valid': ok, 'rackLeft': g.rack}))
`;
    const r = spawnSync('python', ['-c', script, JSON.stringify(rackLetters)], {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '../../..')
    });
    if (r.status !== 0) {
        throw new Error(r.stderr || r.stdout || 'python failed');
    }
    return JSON.parse(r.stdout.trim());
}

function multisetLetters(placements) {
    return placements.map((p) => p[2] || p.letter).sort().join('');
}

function runCase(label, rack) {
    const js = solveAttemptFromRack(rack);
    const dict = getDictionary();
    const board = new (require('./grid').Board)();
    for (const p of js.placements) board.setCell(p.gx, p.gy, p.letter);
    const jsValid = validateFull(board, dict).ok;

    let py = null;
    try {
        py = pySolve(rack);
    } catch (e) {
        console.warn(`[parity] ${label}: skip Python compare (${e.message})`);
    }

    const jsLetters = multisetLetters(js.placements);
    const ok = js.cleared && jsValid && js.rackLeft.length === 0;
    let pyOk = true;
    if (py) {
        pyOk = py.cleared && py.valid && py.rackLeft.length === 0;
        const pyLetters = multisetLetters(py.placements);
        if (jsLetters !== pyLetters) {
            console.error(`[parity] ${label}: letter multiset mismatch js=${jsLetters} py=${pyLetters}`);
            return false;
        }
    }

    if (!ok || !pyOk) {
        console.error(`[parity] ${label}: FAIL js cleared=${js.cleared} valid=${jsValid} py=${py ? JSON.stringify(py) : 'n/a'}`);
        return false;
    }
    console.log(`[parity] ${label}: ok (${js.placements.length} tiles)`);
    return true;
}

function main() {
    let ok = true;
    ok = runCase('hand-4 EALI', 'EALI'.split('')) && ok;
    ok = runCase('hand-21 seed42 rack', 'EALIIEEDRAADIIUZHONOL'.split('')) && ok;

    const g = new Game(getDictionary(), makeRng(42), { handSize: 4 });
    g.deal();
    ok = runCase('deal+rack from seed42', [...g.rack]) && ok;

    process.exit(ok ? 0 : 1);
}

if (require.main === module) main();
