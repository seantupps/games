/**
 * Universal audit logging — every runner path uses this for steps, progress, and failures.
 *
 * Verbosity:
 *   [TEST] steps       — always on unless FIVE_RUNNER_QUIET=1
 *   [MP] move progress — off when FIVE_MP_QUIET=1 (default in `fast` profile)
 *   [TEST:debug]       — on when FIVE_LOG_VERBOSE=1 or FIVE_PROFILE=full
 *   browser console    — gated separately in audit_base / multiplayer_base
 */

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

function isRunnerSilent() {
    return process.env.FIVE_RUNNER_QUIET === '1';
}

/** Suppress move-loop chatter and browser console relay — not [TEST] steps. */
function isMpChatterSuppressed() {
    return process.env.FIVE_MP_QUIET === '1';
}

function isLogVerbose() {
    return process.env.FIVE_LOG_VERBOSE === '1'
        || String(process.env.FIVE_PROFILE || '').toLowerCase() === 'full';
}

/**
 * @param {Record<string, unknown>} [ctx]
 * @returns {string}
 */
function formatContext(ctx = {}) {
    const bits = [];
    if (ctx.gameId) bits.push(`game=${ctx.gameId}`);
    if (ctx.gameMode) bits.push(`mode=${ctx.gameMode}`);
    if (ctx.roomId) bits.push(`room=${ctx.roomId}`);
    if (ctx.scenario) bits.push(`scenario=${ctx.scenario}`);
    if (ctx.testName) bits.push(`test=${ctx.testName}`);
    if (ctx.moveCount != null) bits.push(`move=${ctx.moveCount}`);
    if (ctx.step) bits.push(`step=${ctx.step}`);
    if (ctx.role) bits.push(`role=${ctx.role}`);
    return bits.length ? `[${bits.join(' ')}]` : '';
}

/**
 * @param {unknown} details
 * @returns {string|null}
 */
function normalizeErrorDetails(details) {
    if (details == null) return null;
    if (typeof details === 'string') return details;
    try {
        return JSON.stringify(details, null, 2);
    } catch (_) {
        return String(details);
    }
}

/**
 * @param {unknown} details
 * @returns {string}
 */
function stringifyDetails(details) {
    return normalizeErrorDetails(details) || '';
}

/**
 * @param {Error & { details?: string, cause?: Error }} err
 * @returns {string}
 */
function formatAuditError(err) {
    if (!err) return 'Unknown error';
    const parts = [];
    if (err.message) parts.push(err.message);
    const detailText = normalizeErrorDetails(err.details);
    if (detailText) parts.push(detailText);
    const cause = err.cause;
    const causeDetails = normalizeErrorDetails(cause?.details);
    if (causeDetails && causeDetails !== detailText) {
        parts.push(causeDetails);
    }
    const head = parts.join('\n\n');
    if (err.stack && !head.includes(err.stack.split('\n')[1] || '')) {
        parts.push(err.stack);
    }
    return parts.filter(Boolean).join('\n\n');
}

class TestLogger {
    /**
     * @param {Record<string, unknown>} [ctx]
     */
    constructor(ctx = {}) {
        this.ctx = ctx;
    }

    /**
     * @param {Record<string, unknown>} extra
     * @returns {TestLogger}
     */
    child(extra) {
        return new TestLogger({ ...this.ctx, ...extra });
    }

    /**
     * @param {string} label
     * @param {string} [detail]
     */
    step(label, detail) {
        if (isRunnerSilent()) return;
        const msg = detail != null && detail !== '' ? `${label}: ${detail}` : label;
        console.log(`[TEST] ${msg}`);
    }

    /**
     * @param {string} label
     * @param {string} [detail]
     */
    success(label, detail) {
        this.step(`SUCCESS: ${label}`, detail);
    }

    /**
     * @param {string} msg
     */
    debug(msg) {
        if (!isLogVerbose()) return;
        console.log(`[TEST:debug] ${msg}`);
    }

    /**
     * @param {string} msg
     */
    mpProgress(msg) {
        if (isMpChatterSuppressed()) return;
        console.log(`[MP] ${msg}`);
    }

    /**
     * @param {string} msg
     */
    runner(msg) {
        if (isRunnerSilent()) return;
        console.log(`\x1b[36m${msg}\x1b[0m`);
    }

    /**
     * Log then throw — never call process.exit from audit code.
     * @param {string} message
     * @param {unknown} [details]
     * @returns {never}
     */
    fail(message, details) {
        const ctxLine = formatContext(this.ctx);
        const err = new Error(ctxLine ? `${ctxLine} ${message}` : message);
        err.name = 'AuditFailure';
        const chunks = [];
        if (details != null) chunks.push(stringifyDetails(details));
        if (chunks.length) err.details = chunks.join('\n\n');
        throw err;
    }
}

/**
 * @param {Record<string, unknown>} [ctx]
 * @returns {TestLogger}
 */
function createTestLogger(ctx) {
    return new TestLogger(ctx || {});
}

/** Module default for logStep / lightweight callers. */
const defaultLogger = createTestLogger();

/**
 * Normalize caught audit errors for benchmark result rows.
 * @param {Error & { details?: string }} err
 */
function captureAuditFailure(err) {
    return {
        error: err?.message || String(err),
        details: normalizeErrorDetails(err?.details),
        stack: err?.stack || null
    };
}

module.exports = {
    TestLogger,
    createTestLogger,
    defaultLogger,
    formatAuditError,
    formatContext,
    stringifyDetails,
    normalizeErrorDetails,
    captureAuditFailure,
    isRunnerSilent,
    isMpChatterSuppressed,
    isLogVerbose
};
