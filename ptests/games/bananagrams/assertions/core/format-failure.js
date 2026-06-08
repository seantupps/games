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
    assertOk(false, message, { problems, snapshot, ...snapshot });
}

module.exports = { formatFailure, failWithSnapshot };
