/**
 * Shared assertion failure helper — every invariant uses this pattern.
 * @param {boolean} condition
 * @param {string} message
 * @param {object} [details]
 */
function assertOk(condition, message, details = {}) {
    if (!condition) {
        const err = new Error(message);
        err.details = details;
        throw err;
    }
}

module.exports = { assertOk };
