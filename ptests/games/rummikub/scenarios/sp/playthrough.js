/**
 * Rummikub solo playthrough — default SP scenario (game logic only).
 * AI places one rack tile per step via snap commit; pass = rack empty + table spatially solved.
 */
const { runSpPlaythrough } = require('../../lib/ai-playthrough');

module.exports = { runSpPlaythrough };
