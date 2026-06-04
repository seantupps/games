/**
 * Bananagrams multiplayer — mobile audit config (registry / test:mobile:mp).
 */
const {
    beforeLoop,
    skipBootstrap,
    skipGameLoop,
    skipScoreVerify
} = require('../desktop-mp/index');

module.exports = {
    beforeLoop,
    skipBootstrap: true,
    deferBootstrapWait: true,
    skipGameLoop: true,
    skipScoreVerify: true,
    gameMode: 'multiplayer'
};
