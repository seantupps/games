/** Shim — real module lives in play/game.js */
const gops = require("./play/game.js");
module.exports = gops;

if (require.main === module) {
  const opts = gops.parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.error("Usage: node build/gops/game.js <N> [--seed S]");
    process.exit(opts.error ? 1 : 0);
  }
  gops.play(opts);
}
