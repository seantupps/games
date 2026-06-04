/**
 * Template MP audit — copy when the game supports 2p multiplayer.
 * mpConfig() runs capability checks + resetCount sync at join.
 * multiplayer_base verifies rematch resetCount after victory auto-reset.
 *
 * Pick sync style before implementing MP — see games/_template/README.md Step 0.
 */
const { runMultiplayerAudit } = require('../../shared/infra/multiplayer_base');
const { mpConfig } = require('../../shared/platform/capability-audit');

const config = mpConfig('YOUR_GAME_ID', {
    gameMode: 'classic'
    // extra: [async (page1, page2, ctx) => { /* one regression */ }],
});

if (require.main === module) {
    runMultiplayerAudit('YOUR_GAME_ID', config);
}

module.exports = config;
