/**
 * review — last-bunch pool drain + /b solve 2 win + review/Done lifecycle.
 *
 *   node ptests/run.js mp --game=bananagrams --scenario=review
 *   `last-bunch` is kept as a registry alias.
 */
const { defineMpScenario } = require('./contract');
const { parseWinSideArgv } = require('../registry');
const {
    resolveSessionRounds,
    resolveSessionPause
} = require('../../runners/mp-audit/mp-ai-playthrough');
const {
    runReviewScenarioAudit,
    runLastBunchPeelSyncAudit,
    runSolveToWinReviewTests,
    assertBothPlayersReviewBoardsOnEveryClient
} = require('./review-run');

async function runReviewScenario(ctx) {
    const { page1, page2, roomId, mobile, options = {} } = ctx;
    return runReviewScenarioAudit(page1, page2, {
        ...options,
        roomId,
        mobile,
        winSide: options.winSide ?? parseWinSideArgv(),
        rounds: resolveSessionRounds(options),
        pause: resolveSessionPause(options)
    });
}

const scenario = defineMpScenario({
    id: 'review',
    kind: 'real-gameplay',
    description: 'Last-bunch peel sync, dev solve-2 win, multi-board review, Done reset',
    platforms: ['desktop', 'mobile'],
    playerCounts: [2, 3],
    joinMode: 'invite',
    requiresFreshRoom: true,
    mutatesAuthority: true,
    assertions: [
        'mp-review',
        'mp-distribution',
        'mp-review-solve2',
        'mp-sync-guest-banner',
        'last-bunch',
        'sp-review'
    ]
}, runReviewScenario);

module.exports = {
    ...scenario,
    runReviewScenarioAudit,
    runLastBunchPeelSyncAudit,
    runSolveToWinReviewTests,
    assertBothPlayersReviewBoardsOnEveryClient
};
