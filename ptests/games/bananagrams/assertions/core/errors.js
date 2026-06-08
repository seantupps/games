const { failWithSnapshot } = require('./format-failure');

/**
 * @param {string} message
 * @param {object} [details]
 * @returns {Error}
 */
function assertionError(message, details = {}) {
    const err = new Error(message);
    err.details = details;
    return err;
}

/**
 * @param {string} label
 * @param {string[]} problems
 * @param {object} [details]
 */
function throwAssertion(label, problems, details = {}) {
    failWithSnapshot(label, problems, details);
}

module.exports = { assertionError, throwAssertion };
