/**
 * Hub chat dictionary commands (/w, /state, /solve N) while Bananagrams is loaded.
 */
const { runSpBoardSolveScenarios } = require('./sp/solve');
const { STEP_MS } = require('../../../shared/infra/timeouts');
const TIMEOUT_MS = STEP_MS;

async function waitForDictReady(page) {
    await page.waitForFunction(() => {
        const frame = document.getElementById('game-frame');
        const g = frame?.contentWindow?.game;
        return g?.gameName === 'bananagrams' && !!g?._dictReady && !!g?._checker;
    }, { timeout: TIMEOUT_MS });
}

async function waitForSystemLineContaining(page, needle, previousCount) {
    await page.waitForFunction(({ prev, text }) => {
        const lines = Array.from(document.querySelectorAll('#chat-messages .chat-msg'))
            .map((el) => (el.textContent || '').trim());
        return lines.length > prev && lines.some((t) => t.includes(text));
    }, { prev: previousCount, text: needle }, { timeout: TIMEOUT_MS });
}

async function getSystemLineCount(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('#chat-messages .chat-msg')).length);
}

async function runCommand(page, text) {
    await page.keyboard.press('t');
    await page.fill('#chat-input', text);
    await page.keyboard.press('Enter');
}

async function checkerHasWord(page, word) {
    return page.evaluate(({ w }) => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return !!g?._checker?.isWord?.(w);
    }, { w: word });
}

async function runDictCommandScenarios(page) {
    await page.evaluate(() => {
        if (typeof setGame === 'function') setGame('bananagrams');
    });
    await waitForDictReady(page);

    let lines = await getSystemLineCount(page);
    await runCommand(page, '/w -zas');
    await waitForSystemLineContaining(page, 'Removed zas', lines);
    if (await checkerHasWord(page, 'zas')) {
        throw new Error('Expected "zas" absent after /w -zas');
    }

    lines = await getSystemLineCount(page);
    await runCommand(page, '/w zas');
    await waitForSystemLineContaining(page, 'Added zas', lines);
    if (!(await checkerHasWord(page, 'zas'))) {
        throw new Error('Expected "zas" present after /w zas');
    }

    lines = await getSystemLineCount(page);
    await runCommand(page, '/w -zas');
    await waitForSystemLineContaining(page, 'Removed zas', lines);
    if (await checkerHasWord(page, 'zas')) {
        throw new Error('Expected "zas" absent after second /w -zas');
    }

    lines = await getSystemLineCount(page);
    await runCommand(page, '/state');
    await waitForSystemLineContaining(page, 'starting rack', lines);

    await runSpBoardSolveScenarios(page);
}

module.exports = { runDictCommandScenarios, runSpBoardSolveScenarios };
