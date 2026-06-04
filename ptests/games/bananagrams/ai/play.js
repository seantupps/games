#!/usr/bin/env node
/**
 * JS play.py — same CLI and transcript as build/bananagrams/ai/play.py
 *
 *   node ptests/games/bananagrams/ai/play.js --seed 42 --hand 21
 *   node build/bananagrams/ai/play.js --seed 42 --hand 21
 */

const path = require('path');
const { getDictionary } = require('./dictionary');
const { Game } = require('./game');
const { Transcript } = require('./transcript');
const { makeRng } = require('./rules');

const DEFAULT_HAND_SIZE = 4;

function parseArgs(argv) {
    const out = {
        seed: null,
        hand: DEFAULT_HAND_SIZE,
        turns: null,
        timeout: 5.0,
        dict: null
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--seed' && argv[i + 1]) {
            out.seed = parseInt(argv[++i], 10);
        } else if (a === '--hand' && argv[i + 1]) {
            out.hand = parseInt(argv[++i], 10);
        } else if (a === '--turns' && argv[i + 1]) {
            out.turns = parseInt(argv[++i], 10);
        } else if (a === '--timeout' && argv[i + 1]) {
            out.timeout = parseFloat(argv[++i]);
        } else if (a === '--dict' && argv[i + 1]) {
            out.dict = path.resolve(argv[++i]);
        } else if (a === '--help' || a === '-h') {
            out.help = true;
        }
    }
    return out;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(`Usage: node play.js [--seed N] [--hand N] [--turns N] [--timeout sec] [--dict path]
  DEFAULT_HAND_SIZE=${DEFAULT_HAND_SIZE} (solo = 21)`);
        process.exit(0);
    }

    const seed = args.seed != null ? args.seed : Math.floor(Math.random() * 1_000_001);
    if (args.hand < 1) {
        console.error('error: --hand must be at least 1');
        process.exit(1);
    }

    process.env.BANANA_AI_QUIET = '1';
    const dict = getDictionary(args.dict);
    const log = new Transcript();
    const game = new Game(dict, makeRng(seed), { handSize: args.hand, log });

    const dictLabel = path.basename(args.dict || 'enable.bin.gz') + ' (ENABLE)';
    console.log(`[play] seed=${seed}  hand=${args.hand}  dict=${dictLabel}`);

    const deadlineMs = args.timeout > 0 ? args.timeout * 1000 : null;
    game.run({ maxTurns: args.turns, deadlineMs });

    return 0;
}

if (require.main === module) {
    process.exit(main());
}

module.exports = { main, DEFAULT_HAND_SIZE };
