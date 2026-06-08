/**
 * MP AI playthrough scenario — 2p/3p+ play-to-win flow (moved from runners/mp-audit).
 */
const playthrough2p = require('./playthrough-2p');
const playthroughN = require('./playthrough-n');

module.exports = {
    ...playthrough2p,
    ...playthroughN
};
