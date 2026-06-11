/**
 * RTDB readiness — avoids SDK .once() hanging when rtdbUrl proxy is not connected yet.
 */
const { STEP_MS } = require('./timeouts');

/**
 * @param {import('playwright').Page} page
 * @param {string} label
 */
async function waitForDbConnected(page, label) {
    await page.waitForFunction(async () => {
        const db = window.NetworkEngine?.db;
        if (!db) return false;
        try {
            const snap = await Promise.race([
                db.ref('.info/connected').once('value'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), STEP_MS))
            ]);
            return snap.val() === true;
        } catch (_) {
            return false;
        }
    }, { timeout: STEP_MS }).catch(() => {
        throw new Error(`${label}: Firebase not connected (check rtdbUrl / static proxy on :8000)`);
    });
}

module.exports = { waitForDbConnected };
