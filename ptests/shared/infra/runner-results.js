/**
 * Unified benchmark output for all ptests runners (SP / MP / mobile / hub).
 */

const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const { formatAuditError } = require('./test-logger');

/** Progress lines during a run (off when FIVE_RUNNER_QUIET=1). */
function isRunnerQuiet() {
    return process.env.FIVE_RUNNER_QUIET === '1';
}

function runnerLog(msg) {
    if (isRunnerQuiet()) return;
    console.log(`${CYAN}${msg}${RESET}`);
}

/**
 * @param {string} title
 * @param {string[]} [metaLines]
 */
function printSuiteHeader(title, metaLines = []) {
    console.log(`${MAGENTA}==================================================${RESET}`);
    console.log(`${MAGENTA}${title.padEnd(50)}${RESET}`);
    for (const line of metaLines) {
        console.log(`${MAGENTA}${line}${RESET}`);
    }
    console.log(`${MAGENTA}==================================================${RESET}\n`);
}

/**
 * @param {string|number|null|undefined} duration
 * @returns {string|null}
 */
function formatDuration(duration) {
    if (duration == null || duration === 'N/A') return null;
    const n = typeof duration === 'number' ? duration : parseFloat(duration);
    if (Number.isNaN(n)) return null;
    return n.toFixed(2);
}

/**
 * @typedef {{ name: string, success: boolean, duration?: string|number, subResults?: Array<{ id: string, ok: boolean, ms: number }>, error?: string }} BenchmarkResult
 */

/**
 * @param {object} opts
 * @param {BenchmarkResult[]} opts.results
 * @param {string|number} opts.totalDuration
 * @param {number|null} [opts.targetSeconds]
 * @param {number} [opts.namePad]
 * @param {string} [opts.title]
 * @returns {boolean} allPassed
 */
function printBenchmarkResults(opts) {
    const {
        results,
        totalDuration,
        targetSeconds = null,
        namePad = 16,
        title = 'BENCHMARK RESULTS'
    } = opts;

    console.log(`\n${MAGENTA}==================================================${RESET}`);
    console.log(`${MAGENTA}                ${title.padEnd(33)}${RESET}`);
    console.log(`${MAGENTA}==================================================${RESET}`);

    let allPassed = true;
    for (const res of results) {
        const statusColor = res.success ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
        const dur = formatDuration(res.duration);
        if (dur != null) {
            const timePart = targetSeconds != null
                ? `${parseFloat(dur) <= targetSeconds ? GREEN : YELLOW}${dur}s${RESET}`
                : `${dur}s`;
            console.log(`- ${res.name.padEnd(namePad)}: [${statusColor}] in ${timePart}`);
        } else {
            console.log(`- ${res.name.padEnd(namePad)}: [${statusColor}]`);
        }
        if (res.subResults?.length) {
            for (const sub of res.subResults) {
                const subColor = sub.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
                const subTime = (sub.ms / 1000).toFixed(2);
                console.log(`    ${sub.id.padEnd(16)} [${subColor}] ${subTime}s`);
            }
        }
        if (!res.success) {
            allPassed = false;
            if (res.error) {
                console.log(`${RED}Error output for ${res.name}:${RESET}\n${formatAuditError({ message: res.error, details: res.details, stack: res.stack })}\n`);
            }
        }
    }

    console.log(`${MAGENTA}--------------------------------------------------${RESET}`);
    const total = typeof totalDuration === 'number' ? totalDuration.toFixed(2) : String(totalDuration);
    if (targetSeconds != null) {
        const totalColor = parseFloat(total) <= targetSeconds ? GREEN : RED;
        console.log(`TOTAL RUNTIME   : ${totalColor}${total}s${RESET} (Target: <= ${targetSeconds}s)`);
    } else {
        console.log(`TOTAL RUNTIME   : ${total}s`);
    }
    console.log(`${MAGENTA}==================================================${RESET}\n`);

    return allPassed;
}

/**
 * @param {Array<{ id: string, ok: boolean, ms: number }>} hubSubResults
 */
function hubSubResultsToBenchmark(hubSubResults) {
    return hubSubResults.map((r) => ({ id: r.id, ok: r.ok, ms: r.ms }));
}

/**
 * @param {BenchmarkResult[]} results
 * @param {string} prefix
 */
function prefixResults(results, prefix) {
    return results.map((r) => ({ ...r, name: `${prefix} — ${r.name}` }));
}

module.exports = {
    isRunnerQuiet,
    runnerLog,
    printSuiteHeader,
    printBenchmarkResults,
    hubSubResultsToBenchmark,
    formatDuration,
    prefixResults,
    formatAuditError
};
