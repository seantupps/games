const { failWithSnapshot } = require('../core/format-failure');
const { assertOk } = require('../core/assert-ok');

/** N-player MP scoreboard assertions (viewer-first row + opponent colors).
 */

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
}

async function readScoreboard(frame) {
    return frame.evaluate(() => {
        const sb = document.querySelector('.scoreboard');
        if (!sb?.classList.contains('show')) return { visible: false };
        const spans = [...sb.querySelectorAll('span')].filter(
            (s) => s.classList.contains('score-user') || s.classList.contains('score-ai')
        );
        return {
            visible: true,
            scores: spans.map((s) => s.textContent),
            colors: spans.map((s) => s.style.color || null),
            classes: spans.map((s) => s.className),
            text: sb.textContent.replace(/\s+/g, ' ').trim()
        };
    });
}

/**
 * @param {string} viewerUid
 * @param {Record<string, number>} scoresByUid
 * @param {{ uid: string, color?: string }[]} playerDefs
 */
function expectedScoreboardRows(viewerUid, scoresByUid, playerDefs) {
    const others = playerDefs.filter((p) => p.uid !== viewerUid)
        .sort((a, b) => a.uid.localeCompare(b.uid));
    const rows = [{ uid: viewerUid, isMe: true }, ...others.map((p) => ({ ...p, isMe: false }))];
    return rows.map((row) => ({
        score: String(scoresByUid[row.uid] ?? 0),
        isMe: row.isMe,
        color: row.isMe ? null : row.color
    }));
}

/**
 * @param {import('playwright').Frame} frame
 * @param {string} viewerUid
 * @param {Record<string, number>} scoresByUid
 * @param {string} label
 * @param {{ uid: string, name?: string, color?: string }[]} playerDefs
 */
async function assertScoreboard(frame, viewerUid, scoresByUid, label, playerDefs) {
    const sb = await readScoreboard(frame);
    if (!sb.visible) failWithSnapshot('assertion', [`${label}: scoreboard not visible (${JSON.stringify(sb)})`], {});
    const expected = expectedScoreboardRows(viewerUid, scoresByUid, playerDefs);
    if (sb.scores.length !== expected.length) {
        failWithSnapshot('assertion', [`${label}: score count ${sb.scores.length} !== ${expected.length} (${JSON.stringify(sb)})`], {});
    }
    for (let i = 0; i < expected.length; i++) {
        const exp = expected[i];
        if (sb.scores[i] !== exp.score) {
            failWithSnapshot('assertion', [`${label}: score[${i}] ${sb.scores[i]} !== ${exp.score} (${JSON.stringify(sb)})`], {});
        }
        if (exp.isMe && sb.classes[i] !== 'score-user') {
            failWithSnapshot('assertion', [`${label}: row[${i}] should be score-user (${JSON.stringify(sb)})`], {});
        }
        if (!exp.isMe && sb.classes[i] !== 'score-ai') {
            failWithSnapshot('assertion', [`${label}: row[${i}] should be score-ai (${JSON.stringify(sb)})`], {});
        }
        if (!exp.isMe && exp.color) {
            const got = (sb.colors[i] || '').toLowerCase();
            const wantHex = exp.color.toLowerCase();
            const wantRgb = hexToRgb(exp.color).toLowerCase();
            if (got !== wantHex && got !== wantRgb) {
                failWithSnapshot('assertion', [`${label}: opponent color[${i}] ${got} !== ${wantHex} (${JSON.stringify(sb)})`], {});
            }
        }
    }
    const joined = sb.scores.join(' - ');
    const wantJoined = expected.map((r) => r.score).join(' - ');
    if (joined !== wantJoined) {
        failWithSnapshot('assertion', [`${label}: joined scores "${joined}" !== "${wantJoined}"`], {});
    }
}

/**
 * Assert scoreboard on every client.
 * @param {import('playwright').Frame[]} frames
 * @param {{ uid: string, name?: string, color?: string }[]} playerDefs
 * @param {Record<string, number>} scoresByUid
 * @param {string} [labelPrefix]
 */
async function assertAllPlayersScoreboard(frames, playerDefs, scoresByUid, labelPrefix = 'scoreboard') {
    for (let i = 0; i < frames.length; i++) {
        const def = playerDefs[i];
        await assertScoreboard(
            frames[i],
            def.uid,
            scoresByUid,
            `${labelPrefix} ${def.name || def.role || `P${i + 1}`}`,
            playerDefs
        );
    }
}

module.exports = {
    hexToRgb,
    readScoreboard,
    expectedScoreboardRows,
    assertScoreboard,
    assertAllPlayersScoreboard
};
