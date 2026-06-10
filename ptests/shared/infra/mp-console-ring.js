/**
 * Ring buffer for Bananagrams / ENGINE MP diagnostic console lines during audits.
 * Attached per Playwright page in multiplayer_base.setupConsole.
 */

const MP_DIAG_PATTERNS = [
    '[Bananagrams][mp-diagnostic]',
    '[Bananagrams][inventory-projection]',
    '[Bananagrams][split]',
    '[FLAGS]',
    '[APPLY]'
];

const ENGINE_RESET_PATTERN = '[ENGINE]';
const RING_MAX = 32;

/**
 * @param {string} text
 * @returns {boolean}
 */
function isMpDiagConsoleLine(text) {
    if (!text || typeof text !== 'string') return false;
    if (MP_DIAG_PATTERNS.some((p) => text.includes(p))) return true;
    return text.includes(ENGINE_RESET_PATTERN) && text.includes('reset signal');
}

/**
 * @param {import('playwright').Page} page
 * @param {string} text
 */
function pushMpDiagLine(page, text) {
    if (!page || !isMpDiagConsoleLine(text)) return;
    if (!page.__mpDiagRing) page.__mpDiagRing = [];
    page.__mpDiagRing.push({ at: Date.now(), text });
    if (page.__mpDiagRing.length > RING_MAX) {
        page.__mpDiagRing.splice(0, page.__mpDiagRing.length - RING_MAX);
    }
}

/**
 * @param {import('playwright').Page} page
 * @returns {{ at: number, text: string }[]}
 */
function drainMpDiagRing(page) {
    if (!page?.__mpDiagRing?.length) return [];
    return [...page.__mpDiagRing];
}

module.exports = {
    isMpDiagConsoleLine,
    pushMpDiagLine,
    drainMpDiagRing,
    RING_MAX
};
