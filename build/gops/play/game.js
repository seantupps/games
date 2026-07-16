/**
 * GOPS — Game of Pure Strategy. Terminal human vs random AI.
 * Core logic is browser-friendly; only I/O uses Node readline.
 *
 * Usage:
 *   node build/gops/play/game.js <N> [--seed S]
 *   gops <N> [--seed S]          # global shim (D:\Development\bin)
 */

const readline = require("readline");

const ALL_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const RANK_VALUE = Object.fromEntries(ALL_RANKS.map((r, i) => [r, i + 1]));
const RULE = "────────────────";

const ALIASES = {
  ACE: "A",
  1: "A",
  T: "10",
  JACK: "J",
  QUEEN: "Q",
  KING: "K",
};

function ranksForN(n) {
  if (!Number.isInteger(n) || n < 1 || n > ALL_RANKS.length) {
    throw new Error(`N must be an integer 1..${ALL_RANKS.length}`);
  }
  return ALL_RANKS.slice(0, n);
}

function pad(label) {
  return label.padEnd(7);
}

function parseBid(raw, allowed = null) {
  let s = String(raw).trim().toUpperCase();
  s = ALIASES[s] || s;
  if (RANK_VALUE[s] == null) return null;
  if (allowed && !allowed.includes(s)) return null;
  return s;
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Mulberry32 — optional seeded RNG for reproducible runs. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

class GopsGame {
  constructor({ n = 13, seed = null } = {}) {
    this.n = n;
    this.ranks = ranksForN(n);
    this.rng = seed == null ? Math.random : mulberry32(seed);
    this.playerHand = this.ranks.slice();
    this.aiHand = this.ranks.slice();
    this.prizePile = shuffle(this.ranks, this.rng);
    this.pendingPrizes = [];
    this.playerScore = 0;
    this.aiScore = 0;
  }

  formatHand(hand) {
    return hand.join(",");
  }

  pendingValue() {
    return this.pendingPrizes.reduce((sum, c) => sum + RANK_VALUE[c], 0);
  }

  formatPrize() {
    if (this.pendingPrizes.length === 1) return this.pendingPrizes[0];
    return this.pendingPrizes.join("+");
  }

  revealNextPrize() {
    if (this.prizePile.length === 0) return false;
    this.pendingPrizes.push(this.prizePile.shift());
    return true;
  }

  getAiBid() {
    const i = Math.floor(this.rng() * this.aiHand.length);
    return this.aiHand[i];
  }

  /** Apply bids. Returns { winner, stake, prize }. */
  resolveRound(playerBid, aiBid) {
    const prize = this.formatPrize();
    const stake = this.pendingValue();

    this.playerHand = this.playerHand.filter((c) => c !== playerBid);
    this.aiHand = this.aiHand.filter((c) => c !== aiBid);

    const pv = RANK_VALUE[playerBid];
    const av = RANK_VALUE[aiBid];

    let winner = "tie";
    if (pv > av) {
      this.playerScore += stake;
      this.pendingPrizes = [];
      winner = "player";
    } else if (av > pv) {
      this.aiScore += stake;
      this.pendingPrizes = [];
      winner = "ai";
    }

    return { winner, stake, prize, aiBid };
  }

  prepareNextPrize() {
    if (this.playerHand.length === 0) return false;
    if (this.pendingPrizes.length > 0) {
      if (this.prizePile.length > 0) this.revealNextPrize();
      return this.pendingPrizes.length > 0;
    }
    return this.revealNextPrize();
  }
}

function outcomeLine(winner, prize, stake) {
  if (winner === "player") return `You take ${prize} (+${stake})`;
  if (winner === "ai") return `AI takes ${prize} (+${stake})`;
  return "Tie — prizes roll over";
}

/** Rewrite the You: line with the canonical (uppercase) bid. */
function echoYouBid(bid) {
  if (process.stdin.isTTY) {
    process.stdout.write(`\x1b[1A\r${pad("You:")}${bid}\x1b[K\n`);
  } else {
    process.stdout.write(`${bid}\n`);
  }
}

async function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

async function getPlayerBid(rl, hand) {
  const hint = hand.join(",");
  for (;;) {
    const raw = await ask(rl, pad("You:"));
    const bid = parseBid(raw, hand);
    if (bid == null) {
      console.log(`Enter a card from your hand (${hint}).`);
      continue;
    }
    if (!hand.includes(bid)) {
      console.log(`You don't have ${bid}.`);
      continue;
    }
    return bid;
  }
}

async function play({ n = 13, seed = null } = {}) {
  const game = new GopsGame({ n, seed });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`GOPS — Game of Pure Strategy (N=${n})`);
  console.log(`You vs AI (random). Cards: ${game.ranks.join(",")}. Ace is low.`);
  console.log();

  try {
    if (!game.revealNextPrize()) return;

    while (game.playerHand.length > 0) {
      console.log(`${pad("Prize")}${game.formatPrize()}`);
      console.log();
      console.log(`${pad("Hand")}${game.formatHand(game.playerHand)}`);

      const playerBid = await getPlayerBid(rl, game.playerHand);
      echoYouBid(playerBid);

      const aiBid = game.getAiBid();
      const { winner, stake, prize } = game.resolveRound(playerBid, aiBid);

      console.log(`${pad("AI:")}${aiBid}`);
      console.log();
      console.log(outcomeLine(winner, prize, stake));
      console.log(`${pad("Score")}${game.playerScore}-${game.aiScore}`);

      if (game.playerHand.length === 0) break;
      if (!game.prepareNextPrize()) break;

      console.log(RULE);
    }

    if (game.pendingPrizes.length > 0) {
      console.log();
      console.log(`Unclaimed ${game.formatPrize()} (final tie)`);
      game.pendingPrizes = [];
    }

    console.log();
    if (game.playerScore > game.aiScore) {
      console.log(`You win!  ${game.playerScore}-${game.aiScore}`);
    } else if (game.aiScore > game.playerScore) {
      console.log(`AI wins.  ${game.playerScore}-${game.aiScore}`);
    } else {
      console.log(`Draw.     ${game.playerScore}-${game.aiScore}`);
    }
  } finally {
    rl.close();
  }
}

function parseArgs(argv) {
  let n = null;
  let k = null;
  let seed = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--N" || a === "-n") {
      n = Number(argv[++i]);
      continue;
    }
    if (a === "--K" || a === "-k") {
      k = Number(argv[++i]);
      continue;
    }
    if (a === "--seed" || a === "-s") {
      seed = Number(argv[++i]);
      continue;
    }
    if (a === "--help" || a === "-h") {
      return { help: true };
    }
    const m = /^(n|N|k|K|seed)=(\d+)$/.exec(a);
    if (m) {
      const key = m[1].toLowerCase();
      const val = Number(m[2]);
      if (key === "n") n = val;
      else if (key === "k") k = val;
      else seed = val;
      continue;
    }
    if (/^\d+$/.test(a)) {
      if (n == null) n = Number(a);
      else if (seed == null) seed = Number(a);
      continue;
    }
    console.error(`Unknown argument: ${a}`);
    return { help: true, error: true };
  }
  if (n == null) n = 13;
  if (k == null) k = 2;
  if (!Number.isInteger(n) || n < 1 || n > ALL_RANKS.length) {
    console.error(`N must be an integer 1..${ALL_RANKS.length}`);
    return { help: true, error: true };
  }
  if (!Number.isInteger(k) || k < 2 || k > ALL_RANKS.length) {
    console.error(`K must be an integer 2..${ALL_RANKS.length}`);
    return { help: true, error: true };
  }
  if (seed != null && Number.isNaN(seed)) {
    console.error("seed must be a number");
    return { help: true, error: true };
  }
  return { n, k, seed };
}

function printUsage() {
  console.error("Usage: gops n=<N> k=<K> [--seed S]");
  console.error("       node build/gops/play/game.js n=<N> (random AI)");
  console.error(`N = 1..${ALL_RANKS.length}, K = endgame cutoff (default 3).`);
}

module.exports = {
  ALL_RANKS,
  RANKS: ALL_RANKS, // back-compat
  RANK_VALUE,
  ranksForN,
  parseBid,
  shuffle,
  GopsGame,
  play,
  parseArgs,
};

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    process.exit(opts.error ? 1 : 0);
  }
  play(opts);
}
