/**
 * Preload AI dictionary for MP playthrough scenarios.
 */
const { getDictionary } = require('../ai');

function preloadAiDictionary() {
    if (process.env.BANANA_AI_QUIET !== '0') process.env.BANANA_AI_QUIET = '1';
    getDictionary();
}

module.exports = { preloadAiDictionary };
