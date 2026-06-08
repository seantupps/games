/** Extracted review assertion module. */
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const { captureReviewStateFromFrame, captureReviewState } = require('../core/capture');
const { compareReviewBoards } = require('../core/compare');
const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

function snapshotOrEmpty(o) { return o || {}; }

const TIMER_SAMPLE_MS = 200;
const REVIEW_VIEWPORT_MAX_PAN_DRIFT = 12;
const REVIEW_VIEWPORT_MAX_ZOOM_DRIFT = 0.04;
const REVIEW_VIEWPORT_MAX_FOCAL_DRIFT = 20;
async function assertTimerFrozenInReview(frame, label = 'review') {
    const before = await frame.evaluate(() => {
        const g = window.game;
        const timer = document.getElementById('banana-timer');
        return {
            text: timer?.textContent ?? null,
            elapsedMs: g?.elapsedMs ?? 0,
            timerFrozen: !!g?._timerFrozen,
            timerStart: g?._timerStart ?? null,
            timerRaf: g?._timerRaf ?? 0,
            inReview: g?.roomData?.global?.board?.phase === 'review'
                || g?.roomData?.global?.board?.reviewPhase === true
                || !!g?._postGameReview
        };
    });
    if (!before.inReview) {
        failWithSnapshot(label, ['expected to be in post-game review'], { before });
    }
    await frame.waitForTimeout(TIMER_SAMPLE_MS);
    const after = await frame.evaluate(() => {
        const g = window.game;
        const timer = document.getElementById('banana-timer');
        return {
            text: timer?.textContent ?? null,
            elapsedMs: g?.elapsedMs ?? 0,
            timerFrozen: !!g?._timerFrozen,
            timerStart: g?._timerStart ?? null
        };
    });
    const elapsedDrift = Math.abs((after.elapsedMs || 0) - (before.elapsedMs || 0));
    if (before.text !== after.text || elapsedDrift > 80) {
        failWithSnapshot(label, ['timer must stop during review'], { before, after, elapsedDrift });
    }
    if (!after.timerFrozen || after.timerStart != null) {
        failWithSnapshot(label, ['timer should stay frozen'], { before, after });
    }
}


module.exports = { assertTimerFrozenInReview, TIMER_SAMPLE_MS };
