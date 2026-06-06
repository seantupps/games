/**
 * Rich MP failure snapshot — attach to runner catch blocks for faster debugging.
 */
const { captureAuditFailure } = require('./test-logger');

/**
 * @param {import('playwright').Page} page
 * @param {string} tag
 */
async function captureMpClientFailureDiag(page, tag) {
    try {
        return await page.evaluate(({ t }) => {
            const frame = document.getElementById('game-frame');
            const g = frame?.contentWindow?.game;
            const doc = frame?.contentDocument;
            const room = g?.roomData;
            const board = (typeof RtdbSchema !== 'undefined' && room)
                ? RtdbSchema.readBoardFromRoom(room)
                : room?.global?.board;
            const me = g?._myUid?.() || null;
            const owned = board?.tilesOwnedByPlayer || board?.hands || {};
            const ownedCounts = {};
            Object.entries(owned).forEach(([uid, list]) => {
                ownedCounts[uid] = Array.isArray(list) ? list.length : 0;
            });
            const visibleButtons = [];
            if (doc) {
                doc.querySelectorAll('button').forEach((btn) => {
                    if (btn.offsetParent == null) return;
                    const label = (btn.id || btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
                    if (label) visibleButtons.push(label);
                });
            }
            const hubDone = document.querySelector(
                'button#done-button,[data-action="done"],.done-button,#global-win-banner button'
            );
            return {
                tag: t,
                role: g?.playerRole ?? null,
                uid: me,
                phase: board?.phase ?? null,
                tiles: g?.tiles?.length ?? 0,
                pool: g?._tilePool?.length ?? -1,
                boardPool: Array.isArray(board?.pool) ? board.pool.length : -1,
                boardSeq: board?.seq ?? null,
                peelSeq: board?.peelSeq ?? null,
                dumpSeq: board?.dumpSeq ?? null,
                ownedCounts,
                visibleButtons,
                doneVisible: !!(hubDone && hubDone.offsetParent !== null),
                winnerUid: board?.winnerUid ?? g?._winnerUid ?? null,
                gameStarted: !!g?.gameStarted,
                isOver: !!g?.isOver,
                resetCount: g?.lastResetCount ?? room?.global?.resetCount ?? null
            };
        }, { t: tag });
    } catch (err) {
        return { tag, error: String(err?.message || err) };
    }
}

/**
 * @param {object} opts
 * @param {import('playwright').Page} [opts.page1]
 * @param {import('playwright').Page} [opts.page2]
 * @param {boolean} [opts.mobile]
 * @param {string} [opts.topology]
 * @param {string} [opts.scenario]
 * @param {string} [opts.testName]
 * @param {string} [opts.gameId]
 */
async function captureMpFailureSnapshot(opts = {}) {
    const {
        page1 = null,
        page2 = null,
        mobile = false,
        topology = null,
        scenario = null,
        testName = null,
        gameId = null
    } = opts;

    let resolvedScenario = scenario;
    let resolvedTopology = topology;
    try {
        const { getActiveRunConfig } = require('./run-config');
        const cfg = getActiveRunConfig();
        if (!resolvedScenario && cfg?.scenario) resolvedScenario = cfg.scenario;
        if (!resolvedTopology && cfg?.topology) resolvedTopology = cfg.topology;
    } catch (_) { /* optional */ }

    const platform = mobile || resolvedTopology === 'mobile' ? 'mobile' : 'desktop';
    const viewports = {};
    if (page1) {
        const vp = page1.viewportSize();
        viewports.host = vp || null;
    }
    if (page2) {
        const vp = page2.viewportSize();
        viewports.guest = vp || null;
    }

    const [host, guest] = await Promise.all([
        page1 ? captureMpClientFailureDiag(page1, 'host') : null,
        page2 ? captureMpClientFailureDiag(page2, 'guest') : null
    ]);

    return {
        platform,
        topology: resolvedTopology || platform,
        scenario: resolvedScenario || 'default',
        testName: testName || null,
        gameId: gameId || null,
        viewport: viewports,
        host,
        guest,
        capturedAt: new Date().toISOString()
    };
}

/**
 * @param {Error} err
 * @param {object} snapshotOpts
 * @returns {Promise<{ error: string, details: string|null, stack: string|null, snapshot?: object }>}
 */
async function captureAuditFailureWithMpSnapshot(err, snapshotOpts = {}) {
    const base = captureAuditFailure(err);
    let snapshot = null;
    try {
        snapshot = await captureMpFailureSnapshot(snapshotOpts);
    } catch (snapErr) {
        snapshot = { snapshotError: String(snapErr?.message || snapErr) };
    }

    const chunks = [];
    if (base.details) chunks.push(base.details);
    chunks.push('--- failure snapshot ---');
    chunks.push(JSON.stringify(snapshot, null, 2));

    return {
        ...base,
        snapshot,
        details: chunks.join('\n\n')
    };
}

module.exports = {
    captureMpClientFailureDiag,
    captureMpFailureSnapshot,
    captureAuditFailureWithMpSnapshot
};
