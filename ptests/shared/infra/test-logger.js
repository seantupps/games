/**
 * Universal audit logging — every runner path uses this for steps, progress, and failures.
 *
 * Verbosity:
 *   [TEST] steps       — always on unless FIVE_RUNNER_QUIET=1
 *   [MP] move progress — off when FIVE_MP_QUIET=1 (default in `fast` profile)
 *   [TEST:debug]       — on when FIVE_LOG_VERBOSE=1 or FIVE_PROFILE=full
 *   [TEST:spawn]       — always on for spawn/dump failures (logDumpSpawnFailure)
 *   FIVE_MP_SPAWN_DEBUG=1 — pipeline summaries at repro steps (same as verbose spawn)
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
 * Format assertion error.details (object or string) for runner stderr output.
 * @param {Error & { details?: unknown }} err
 * @param {{ skipProblemsInMessage?: boolean }} [options]
 * @returns {string}
 */
function formatAssertionDetails(err, options = {}) {
    const d = err?.details;
    if (d == null) return '';
    if (typeof d === 'string') return d;
    if (typeof d !== 'object') return String(d);

    const lines = [];
    const obj = /** @type {Record<string, unknown>} */ (d);
    const msg = err?.message || '';
    if (Array.isArray(obj.problems) && obj.problems.length) {
        const skipProblems = options.skipProblemsInMessage !== false
            && obj.problems.every((p) => msg.includes(String(p)));
        if (!skipProblems) {
            lines.push('problems:');
            obj.problems.forEach((p) => lines.push(`  - ${p}`));
        }
    }
    if (obj.pipeline != null) {
        lines.push('pipeline:');
        lines.push(stringifyDetails(obj.pipeline));
    }
    if (obj.snap != null) {
        lines.push('snap:');
        lines.push(stringifyDetails(obj.snap));
    }
    if (obj.result != null) {
        lines.push('result:');
        lines.push(stringifyDetails(obj.result));
    }
    if (obj.targetedText) {
        lines.push(obj.targetedText);
    } else if (obj.snapshot != null && obj.snapshot !== obj.snap) {
        lines.push('snapshot:');
        lines.push(stringifyDetails(obj.snapshot));
    }
    const rest = { ...obj };
    delete rest.problems;
    delete rest.pipeline;
    delete rest.snap;
    delete rest.result;
    delete rest.snapshot;
    if (obj.snapshot != null && typeof obj.snapshot === 'object' && !Array.isArray(obj.snapshot)) {
        for (const k of Object.keys(/** @type {Record<string, unknown>} */ (obj.snapshot))) {
            delete rest[k];
        }
    }
    if (Object.keys(rest).length) {
        lines.push(stringifyDetails(rest));
    }
    return lines.join('\n');
}

function isSpawnDebugEnabled() {
    return isLogVerbose() || process.env.FIVE_MP_SPAWN_DEBUG === '1';
}

/**
 * Always-on spawn/dump repro line — never gated by FIVE_RUNNER_QUIET.
 * @param {string} label
 * @param {unknown} [data]
 */
function spawnDiag(label, data) {
    const payload = data != null && typeof data === 'object' && !Array.isArray(data)
        ? /** @type {Record<string, unknown>} */ (data)
        : null;
    const snap = payload?.snap ?? payload?.pipeline ?? null;
    if (snap && typeof snap === 'object' && !Array.isArray(snap.spawnDetails)) {
        console.error(`${RED}[TEST:spawn]${RESET} ${formatSpawnSeqLine(label, snap)}`);
    } else if (snap && typeof snap === 'object' && Array.isArray(snap.spawnDetails)) {
        const p = /** @type {Record<string, unknown>} */ (snap);
        const spawnIds = Array.isArray(p.spawnIds) ? p.spawnIds.join(',') : '?';
        const renderOk = p.spawnDetails.filter((d) => d.inRender).length;
        const domOk = p.spawnDetails.filter((d) => d.domVisible).length;
        console.error(`${RED}[TEST:spawn]${RESET} ${label} | hand=${p.handCount ?? '?'}/${p.expectedHandCount ?? '?'} spawns=[${spawnIds}] render=${renderOk}/${p.spawnDetails.length} dom=${domOk}/${p.spawnDetails.length}`);
    } else {
        console.error(`${RED}[TEST:spawn]${RESET} ${label}`);
    }
    if (data != null) {
        console.error(stringifyDetails(data));
    }
}

/**
 * Verbose spawn pipeline (FIVE_LOG_VERBOSE=1 or FIVE_MP_SPAWN_DEBUG=1).
 * @param {string} label
 * @param {unknown} [data]
 */
function spawnDebug(label, data) {
    if (!isSpawnDebugEnabled()) return;
    const body = data == null ? '' : `: ${typeof data === 'string' ? data : stringifyDetails(data)}`;
    console.log(`[TEST:debug] ${label}${body}`);
}

/**
 * One-line client seq state (always-on via spawnDiag when used from logDumpSpawnFailure).
 * @param {string} label
 * @param {object} snap
 * @returns {string}
 */
function formatSpawnSeqLine(label, snap) {
    if (!snap || typeof snap !== 'object') return `${label}: (no seq snap)`;
    const s = /** @type {Record<string, unknown>} */ (snap);
    const parts = [
        `hand=${s.handCount ?? '?'}`,
        `lastPeel=${s.lastPeelSeq ?? '?'}`,
        `lastDump=${s.lastDumpSeq ?? '?'}`,
        `boardPeel=${s.boardPeelSeq ?? '?'}`,
        `boardDump=${s.boardDumpSeq ?? '?'}`,
        `inv=${s.localInventorySeq ?? '?'}/${s.boardInventorySeq ?? '?'}`,
        `reset=${s.roomResetCount ?? s.mpAppliedResetCount ?? '?'}`
    ];
    if (s.guestDumpPendingTileId) parts.push(`dumpPending=${s.guestDumpPendingTileId}`);
    if (s.layoutEpochMismatch) parts.push(`layoutEpochMismatch=${s.layoutEpoch}`);
    if (s.mpAwaitReset) parts.push('mpAwaitReset');
    return `${label} | ${parts.join(' ')}`;
}

/**
 * Always-on seq summary on stderr (spawn failures and key repro checkpoints).
 * @param {string} label
 * @param {object} snap
 */
function spawnSeqSummary(label, snap) {
    console.error(`${RED}[TEST:spawn]${RESET} ${formatSpawnSeqLine(label, snap)}`);
}

/**
 * One-line spawn pipeline summary for quick scanning.
 * @param {string} label
 * @param {object} pipeline
 */
function spawnPipelineSummary(label, pipeline) {
    if (!pipeline || typeof pipeline !== 'object') return;
    const p = /** @type {Record<string, unknown>} */ (pipeline);
    const spawnIds = Array.isArray(p.spawnIds) ? p.spawnIds.join(',') : '?';
    const parts = [
        `hand=${p.handCount ?? '?'}/${p.expectedHandCount ?? '?'}`,
        `spawns=[${spawnIds}]`,
        `lastPeel=${p.lastPeelSeq ?? '?'}`,
        `lastDump=${p.lastDumpSeq ?? '?'}`,
        `boardPeel=${p.boardPeelSeq ?? '?'}`,
        `boardDump=${p.boardDumpSeq ?? '?'}`
    ];
    if (p.dumpPendingTileId) parts.push(`dumpPending=${p.dumpPendingTileId}`);
    if (Array.isArray(p.spawnDetails)) {
        const renderOk = p.spawnDetails.filter((d) => d.inRender).length;
        const domOk = p.spawnDetails.filter((d) => d.domVisible).length;
        parts.push(`render=${renderOk}/${p.spawnDetails.length}`, `dom=${domOk}/${p.spawnDetails.length}`);
    }
    spawnDebug(`${label} | ${parts.join(' ')}`);
    if (isSpawnDebugEnabled() && p.spawnDetails) {
        spawnDebug(`${label} spawnDetails`, p.spawnDetails);
    }
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
 * @returns {string}
 */
function stringifyDetails(details) {
    if (details == null) return '';
    if (typeof details === 'string') return details;
    try {
        return JSON.stringify(details, null, 2);
    } catch (_) {
        return String(details);
    }
}

/** Drop inline waitForDiag blocks — rich snapshot belongs in details once. */
function stripEmbeddedDiagBlocks(message) {
    if (typeof message !== 'string') return message;
    let out = message;
    for (const marker of ['\n--- state ---\n', '\n--- cause ---\n']) {
        const idx = out.indexOf(marker);
        if (idx !== -1) out = out.slice(0, idx);
    }
    return out.trimEnd();
}

/** @deprecated use stripEmbeddedDiagBlocks */
function stripEmbeddedWaitState(message) {
    return stripEmbeddedDiagBlocks(message);
}

/** Stack frames only — omit Error line and embedded state/cause from err.message. */
function extractStackFrames(stack) {
    if (!stack || typeof stack !== 'string') return [];
    return stack.split('\n').filter((line) => /^\s*at /.test(line));
}

/**
 * @param {Error & { details?: string, cause?: Error }} err
 * @returns {string}
 */
function formatAuditError(err) {
    if (!err) return 'Unknown error';
    const parts = [];
    const preformatted = typeof err?.details === 'string' ? err.details : null;
    const hasFailureSnapshot = preformatted?.includes('--- failure snapshot ---') === true;

    let message = err.message || '';
    if (hasFailureSnapshot || message.includes('--- state ---')) {
        message = stripEmbeddedDiagBlocks(message);
    }
    if (message) parts.push(message);

    if (preformatted) {
        parts.push(preformatted);
    } else if (typeof err?.details === 'object' && err.details != null) {
        const assertionBlock = formatAssertionDetails(err);
        if (assertionBlock) {
            parts.push(assertionBlock);
        } else {
            parts.push(stringifyDetails(err.details));
        }
    } else if (err.details != null && typeof err.details !== 'string') {
        parts.push(stringifyDetails(err.details));
    }

    const cause = err.cause;
    if (cause?.details && cause.details !== err.details) {
        parts.push(String(cause.details));
    }

    const frames = extractStackFrames(err.stack);
    if (frames.length) {
        const head = parts.join('\n\n');
        const novel = frames.filter((line) => !head.includes(line.trim()));
        if (novel.length) parts.push(novel.join('\n'));
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
        details: err?.details || null,
        stack: err?.stack || null
    };
}

module.exports = {
    TestLogger,
    createTestLogger,
    defaultLogger,
    formatAuditError,
    formatAssertionDetails,
    formatContext,
    stringifyDetails,
    stripEmbeddedDiagBlocks,
    stripEmbeddedWaitState,
    extractStackFrames,
    captureAuditFailure,
    isRunnerSilent,
    isMpChatterSuppressed,
    isLogVerbose,
    isSpawnDebugEnabled,
    formatSpawnSeqLine,
    spawnDiag,
    spawnDebug,
    spawnSeqSummary,
    spawnPipelineSummary
};
