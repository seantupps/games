const { runMultiplayerAudit } = require('../../shared/infra/multiplayer_base');
const { mpConfig } = require('../../shared/platform/capability-audit');

const config = mpConfig('piles', { gameMode: 'classic' });

if (require.main === module) {
    runMultiplayerAudit('piles', config);
}

module.exports = config;
