/**
 * Hub chat command helpers for dev board-solve scenarios.
 */
const { STEP_MS } = require('../infra/timeouts');

const TIMEOUT_MS = STEP_MS;

/**
 * @param {import('playwright').Page} page
 */
async function runChatCommand(page, text) {
    await page.click('body').catch(() => {});
    await page.keyboard.press('t');
    await page.fill('#chat-input', text);
    await page.keyboard.press('Enter');
}

/**
 * @param {import('playwright').Page} page
 * @param {boolean} [expectOk=true]
 */
async function waitForSolveReceipt(page, expectOk = true) {
    const prevSeq = await page.evaluate(() => (
        document.getElementById('game-frame')?.contentWindow?.__lastBoardSolveReceipt?.solveSeq ?? 0
    ));
    await page.waitForFunction((args) => {
        const wantOk = args[0];
        const seq = args[1];
        const win = document.getElementById('game-frame')?.contentWindow;
        const r = win?.__lastBoardSolveReceipt;
        return !!r && r.ok === wantOk && (r.solveSeq ?? 0) > seq;
    }, [expectOk, prevSeq], { timeout: TIMEOUT_MS });
    return page.evaluate(() => document.getElementById('game-frame')?.contentWindow?.__lastBoardSolveReceipt);
}

/**
 * @param {import('playwright').Page} page
 */
async function getSystemLineCount(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('#chat-messages .chat-msg')).length);
}

/**
 * @param {import('playwright').Page} page
 * @param {string} needle
 * @param {number} previousCount
 */
async function waitForSystemLineContaining(page, needle, previousCount) {
    await page.waitForFunction(({ prev, text }) => {
        const lines = Array.from(document.querySelectorAll('#chat-messages .chat-msg'))
            .map((el) => (el.textContent || '').trim());
        return lines.length > prev && lines.some((t) => t.includes(text));
    }, { prev: previousCount, text: needle }, { timeout: TIMEOUT_MS });
}

module.exports = {
    TIMEOUT_MS,
    runChatCommand,
    waitForSolveReceipt,
    getSystemLineCount,
    waitForSystemLineContaining
};
