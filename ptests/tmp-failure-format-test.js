/**
 * Failure output + snapshot tier tests.
 * node ptests/tmp-failure-format-test.js
 */
const { formatAuditError } = require('./shared/infra/test-logger');
const {
    bloatedMpClientFixture,
    countJsonKeyOccurrences,
    findSnapshotFieldDupes,
    normalizeMpClientDiag,
    normalizeMpFailureSnapshot
} = require('./shared/infra/failure-snapshot-normalize');

function assertNoOutputDup(label, body) {
    const failures = [];
    const count = (needle) => (body.split(needle).length - 1);
    if (count('--- failure snapshot ---') > 1) failures.push('failure snapshot block repeated');
    if (count('--- state ---') > 0) failures.push('embedded state block should be stripped');
    if (count('--- cause ---') > 0) failures.push('embedded cause block should be stripped');
    if (count('timed out after 6000ms') > 1) failures.push('timeout message repeated');
    if (count('board reset on refresh') > 1) failures.push('assertion message repeated');
    if (body.includes('TimeoutError:') && body.includes('timed out after 6000ms\n')) {
        failures.push('stack error headline duplicates message');
    }
    if (failures.length) {
        console.error(`FAIL output ${label}:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
        return false;
    }
    console.log(`PASS output ${label}`);
    return true;
}

function testOutputFormatting() {
    const state = JSON.stringify({ label: 'wait', players: [{ tiles: 0 }] }, null, 2);
    const timeoutMsg = `AI reset host started timed out after 6000ms\n--- state ---\n${state}\n--- cause ---\npage.waitForFunction: Timeout 6000ms exceeded.`;
    const timeoutErr = new Error(timeoutMsg);
    timeoutErr.name = 'TimeoutError';
    timeoutErr.stack = [
        `TimeoutError: ${timeoutMsg}`,
        '    at timeoutError (mp-waits.js:90:17)',
        '    at waitForDiag (mp-waits.js:108:15)'
    ].join('\n');
    const failureSnap = '--- failure snapshot ---\n{"host":{"summary":{"tiles":21}},"guest":{"summary":{"tiles":0}}}';

    const timeoutBody = formatAuditError({
        message: 'AI reset host started timed out after 6000ms',
        details: failureSnap,
        stack: timeoutErr.stack
    });

    const assertBody = formatAuditError({
        message: 'P2 refresh: board reset on refresh',
        details: [
            'snapshot:',
            JSON.stringify({ before: { x: 1 }, after: { x: 2 } }, null, 2),
            failureSnap
        ].join('\n\n'),
        stack: [
            'Error: P2 refresh: board reset on refresh',
            '    at assertOk (assert-ok.js:9:21)',
            '    at failWithSnapshot (format-failure.js:26:5)'
        ].join('\n')
    });

    return assertNoOutputDup('timeout', timeoutBody)
        && assertNoOutputDup('assertion', assertBody);
}

function testSnapshotTiers() {
    const raw = bloatedMpClientFixture();
    const beforeBoardRev = countJsonKeyOccurrences(raw, 'boardRevision');
    const beforeApplied = countJsonKeyOccurrences(raw, 'appliedRevision');

    const normalized = normalizeMpClientDiag(raw);
    const dupes = findSnapshotFieldDupes(normalized);
    if (dupes.length) {
        console.error(`FAIL snapshot tiers:\n${dupes.map((d) => `  - ${d}`).join('\n')}`);
        return false;
    }

    if (!normalized.summary) {
        console.error('FAIL snapshot tiers: missing summary tier');
        return false;
    }
    if (!normalized.coherence) {
        console.error('FAIL snapshot tiers: missing coherence tier');
        return false;
    }
    if (!normalized.seq) {
        console.error('FAIL snapshot tiers: missing seq tier');
        return false;
    }
    if (normalized.coherence.seq) {
        console.error('FAIL snapshot tiers: coherence still embeds seq');
        return false;
    }

    const afterBoardRev = countJsonKeyOccurrences(normalized, 'boardRevision');
    const afterApplied = countJsonKeyOccurrences(normalized, 'appliedRevision');
    if (afterBoardRev >= beforeBoardRev) {
        console.error(`FAIL snapshot tiers: boardRevision not reduced (${beforeBoardRev} -> ${afterBoardRev})`);
        return false;
    }
    if (afterApplied >= beforeApplied) {
        console.error(`FAIL snapshot tiers: appliedRevision not reduced (${beforeApplied} -> ${afterApplied})`);
        return false;
    }

    const requiredSummary = [
        'phase', 'boardRevision', 'appliedRevision', 'boardInventorySeq', 'clientInventorySeq',
        'coherenceFailed', 'tiles', 'pool', 'coherenceOk', 'gameStarted', 'boardGameStarted'
    ];
    const missing = requiredSummary.filter((k) => normalized.summary[k] == null && k !== 'coherenceFailed');
    if (missing.length) {
        console.error(`FAIL snapshot tiers: summary missing ${missing.join(', ')}`);
        return false;
    }
    if (!Array.isArray(normalized.summary.coherenceFailed)) {
        console.error('FAIL snapshot tiers: summary.coherenceFailed must be an array');
        return false;
    }

    const full = normalizeMpFailureSnapshot({
        platform: 'desktop',
        host: raw,
        guest: { ...raw, tag: 'guest', role: 'P2', uid: 'u_banana_guest', tiles: 0, clientInventorySeq: 0 }
    });
    const guestDupes = findSnapshotFieldDupes(full.guest);
    if (guestDupes.length) {
        console.error(`FAIL snapshot tiers guest:\n${guestDupes.map((d) => `  - ${d}`).join('\n')}`);
        return false;
    }

    if (!normalized.summary.roomResetCount || normalized.summary.mpAppliedResetCount == null) {
        console.error('FAIL snapshot tiers: epoch drift fields missing from summary');
        return false;
    }
    if (!normalized.deep?.split?.authority || !normalized.deep?.gamePhase) {
        console.error('FAIL snapshot tiers: split/gamePhase missing from deep on split incoherence');
        return false;
    }
    if (!normalized.deep?.epoch?.lastResetCount) {
        console.error('FAIL snapshot tiers: epoch.lastResetCount missing from deep');
        return false;
    }

    console.log(`PASS snapshot tiers (boardRevision ${beforeBoardRev}->${afterBoardRev}, appliedRevision ${beforeApplied}->${afterApplied})`);
    return true;
}

const ok = testOutputFormatting() && testSnapshotTiers();
process.exit(ok ? 0 : 1);
