#!/usr/bin/env node
/**
 * CI: registry capabilities must match shared/games/sync-contracts.js.
 *
 *   npm run check:sync
 */
const GameRegistry = require('../shared/games/registry');
const { validateRegistryAlignment } = require('../shared/games/sync-contracts');

function main() {
    const errors = validateRegistryAlignment(GameRegistry);
    if (!errors.length) {
        console.log('[check:sync] OK — registry matches sync-contracts for all MP modes');
        process.exit(0);
    }
    console.error('[check:sync] FAILED:\n');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
}

if (require.main === module) {
    main();
}

module.exports = { validateRegistryAlignment };
