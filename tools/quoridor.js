#!/usr/bin/env node
/**
 * Quoridor launcher — after `npm run link`:
 *   quoridor
 *   quoridor --seed 42
 *   quoridor --2p
 *   quoridor --ai random
 */
const { spawnSync } = require("child_process");
const path = require("path");

const PLAY = path.join(__dirname, "..", "build", "quoridor", "play", "play.py");

function printUsage() {
  console.error(`Usage:
  quoridor                 P1 (you) vs P2 greedy AI
  quoridor --seed S        seeded AI
  quoridor --ai random     P2 random (50/50 wall/pawn)
  quoridor --2p            two humans`);
}

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

const r = spawnSync("python", ["-u", PLAY, ...argv], {
  stdio: "inherit",
  shell: false,
});
process.exit(r.status == null ? 1 : r.status);
