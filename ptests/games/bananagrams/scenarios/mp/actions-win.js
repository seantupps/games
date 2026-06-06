/**
 * MP actions / play-to-win scenario — re-exports AI playthrough entry.
 */
const {
    runMpAiPlaythrough,
    resetMpForAiPlaythrough,
    resolveSessionRounds,
    resolveSessionPause,
    advanceActionsRoundAfterReview,
    finishPausedReviewSession,
    exitReviewAfterActionsSession
} = require('../../desktop-mp/audit/mp-ai-playthrough');

module.exports = {
    runMpAiPlaythrough,
    resetMpForAiPlaythrough,
    resolveSessionRounds,
    resolveSessionPause,
    advanceActionsRoundAfterReview,
    finishPausedReviewSession,
    exitReviewAfterActionsSession
};
