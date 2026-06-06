/**
 * Desktop MP: Piles (classic + freestyle) + Line — slim smoke bundle (~10s).
 * Full MP audits: npm run test:mp or node ptests/run.js mp --game=piles,line
 */
require('../../shared/infra/bootstrap');
const { setActiveRunConfig, createDefaultRunConfig } = require('../../shared/infra/run-config');
setActiveRunConfig({ ...createDefaultRunConfig(), mode: 'mp', slimAudit: true });

const { runMpAuditBundle } = require('../../shared/infra/mp-bundle-runner');
const { buildMultiplayerAudits } = require('../../shared/infra/test-manifest');
const { filterAuditsByGame } = require('../../shared/infra/run-spec');

async function main(options = {}) {
    const summarize = options.summarize !== false;
    const tests = filterAuditsByGame(buildMultiplayerAudits({ players: 2, topology: 'desktop' }), 'piles,line');
    if (tests.length < 3) {
        const msg = `[RUNNER] Expected at least 3 piles+line audits, got ${tests.length}: ${tests.map((t) => t.name).join(', ')}`;
        if (require.main === module) {
            console.error(msg);
            process.exit(1);
        }
        throw new Error(msg);
    }

    const { allPassed, results } = await runMpAuditBundle({
        title: 'MP PILES (classic + freestyle) + LINE',
        tests,
        targetSeconds: 10,
        skipRefresh: true,
        postVictoryOnLastOnly: true,
        summarize
    });
    if (require.main === module) {
        process.exit(allPassed ? 0 : 1);
    }
    return { allPassed, results };
}

module.exports = { main };

if (require.main === module) {
    main();
}
