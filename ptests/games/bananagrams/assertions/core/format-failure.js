/**
 * Standard assertion failure path — attach structured snapshots to errors.
 */
const { assertOk } = require('./assert-ok');

/**
 * @param {string} label
 * @param {string[]} problems
 * @param {object} [details]
 * @returns {{ message: string, problems: string[], details: object }}
 */
function formatFailure(label, problems, details = {}) {
    const message = problems.length === 1
        ? `${label}: ${problems[0]}`
        : `${label}: ${problems.join('; ')}`;
    return { message, problems, ...details };
}

/**
 * @param {string} label
 * @param {string[]} problems
 * @param {object} [snapshot]
 */
function failWithSnapshot(label, problems, snapshot = {}) {
    const { message } = formatFailure(label, problems, snapshot);
    assertOk(false, message, { problems, snapshot });
}

/**
 * Targeted failure — concise formatted diag replaces bloated generic snapshot.
 * @param {string} label
 * @param {string[]} problems
 * @param {object} targetedDiag
 * @param {string} targetedText
 */
function failWithTargetedDiag(label, problems, targetedDiag, targetedText) {
    const { message } = formatFailure(label, problems);
    assertOk(false, message, {
        problems,
        targeted: true,
        targetedDiag,
        targetedText
    });
}

module.exports = { formatFailure, failWithSnapshot, failWithTargetedDiag };
