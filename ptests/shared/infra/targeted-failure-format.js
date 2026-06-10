/**
 * Format assertion failures that carry a targetedDiag bundle (concise, info-rich).
 */
const { drainMpDiagRing } = require('./mp-console-ring');

/**
 * @param {import('playwright').Page[]} pages
 * @param {number} [maxLines]
 */
function captureRecentConsoleDiag(pages, maxLines = 6) {
    const lines = [];
    for (const page of pages || []) {
        const ring = drainMpDiagRing(page);
        ring.slice(-maxLines).forEach((entry) => {
            const text = String(entry.text || '').replace(/\s+/g, ' ').trim();
            if (text) lines.push(text.length > 220 ? `${text.slice(0, 217)}…` : text);
        });
    }
    return lines.slice(-maxLines);
}

/**
 * @param {object} details — err.details from assertOk
 * @param {{ pages?: import('playwright').Page[] }} [opts]
 * @returns {string|null}
 */
function formatTargetedAssertionFailure(details, opts = {}) {
    if (!details || typeof details !== 'object') return null;
    const targeted = details.targetedDiag;
    const targetedText = details.targetedText;
    if (!targeted && !targetedText) return null;

    const chunks = [];
    if (targetedText) chunks.push(targetedText);

    if (targeted && !targetedText) {
        chunks.push(JSON.stringify(targeted, null, 2));
    }

    const consoleLines = captureRecentConsoleDiag(opts.pages);
    if (consoleLines.length) {
        chunks.push('Recent console:');
        consoleLines.forEach((line) => chunks.push(`  ${line}`));
    }

    return chunks.filter(Boolean).join('\n');
}

/**
 * Slim sync supplement when a targeted diag already explains the failure.
 * @param {object|null} snapshot — normalized captureMpFailureSnapshot output
 */
function formatSlimSyncContext(snapshot) {
    if (!snapshot) return null;
    const pick = (client, label) => {
        if (!client?.summary) return null;
        const s = client.summary;
        const c = client.coherence;
        return {
            label,
            phase: s.phase,
            tiles: s.tiles,
            boardRevision: s.boardRevision,
            appliedRevision: s.appliedRevision,
            localBoardSeq: client.seq?.lifecycle?.localBoardSeq ?? client.deep?.localBoardSeq ?? null,
            boardSeq: client.seq?.lifecycle?.boardSeq ?? null,
            coherenceFailed: c?.failed || s.coherenceFailed || [],
            guestAuthorityReady: client.deep?.guestAuthorityReady ?? null
        };
    };
    const host = pick(snapshot.host, 'host');
    const guest = pick(snapshot.guest, 'guest');
    if (!host && !guest) return null;
    return JSON.stringify({ host, guest }, null, 2);
}

module.exports = {
    formatTargetedAssertionFailure,
    formatSlimSyncContext,
    captureRecentConsoleDiag
};
