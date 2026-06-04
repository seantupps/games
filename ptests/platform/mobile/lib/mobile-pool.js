/**
 * Run async tasks with a fixed worker pool (1 browser, bounded parallelism).
 */
async function runPool(tasks, workerCount) {
    const n = Math.max(1, Math.min(workerCount, tasks.length));
    const results = new Array(tasks.length);
    let next = 0;

    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= tasks.length) return;
            results[i] = await tasks[i]();
        }
    }

    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
}

module.exports = { runPool };
