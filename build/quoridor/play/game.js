#!/usr/bin/env node
/** Shim: Quoridor play moved to Python. */
const { spawnSync } = require("child_process");
const path = require("path");
const PLAY = path.join(__dirname, "play.py");
const r = spawnSync("python", ["-u", PLAY, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: false,
});
process.exit(r.status == null ? 1 : r.status);
