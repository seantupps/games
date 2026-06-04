/**
 * Line drag for emulated mobile — strict preview vs game.toWorld (no fixed coords).
 */
const { withTimeout, DEFAULT_MS } = require('./mobile-timeouts');
const { waitForLinePathInFrame, waitForLinePreview } = require('./mobile-waits');

const MAX_PREVIEW_ERR_PX = 10;

async function assertLineDragTracksPointer(page, fromId = '1', toId = '5', steps = 6, { release = true, ms = DEFAULT_MS } = {}) {
    await page.evaluate(({ fromId }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        const nodeFrom = doc?.querySelector(`.node[data-id="${fromId}"]`);
        if (!nodeFrom) return;
        const r0 = nodeFrom.getBoundingClientRect();
        const cx = r0.left + r0.width / 2;
        const cy = r0.top + r0.height / 2;
        nodeFrom.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: cx,
            clientY: cy,
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: 'touch',
            button: 0,
            buttons: 1
        }));
        win.dispatchEvent(new PointerEvent('pointermove', {
            clientX: cx,
            clientY: cy,
            bubbles: true,
            pointerId: 1,
            pointerType: 'touch',
            buttons: 1
        }));
    }, { fromId });

    await waitForLinePreview(page);

    const result = await withTimeout(
        page.evaluate(async ({ fromId, toId, steps, maxErr, release }) => {
            const win = document.getElementById('game-frame')?.contentWindow;
            const g = win?.game;
            const doc = win?.document;
            if (!g?.toWorld || !doc) return { ok: false, reason: 'no game/toWorld' };

            const nodeFrom = doc.querySelector(`.node[data-id="${fromId}"]`);
            const nodeTo = doc.querySelector(`.node[data-id="${toId}"]`);
            if (!nodeFrom || !nodeTo) return { ok: false, reason: 'nodes missing' };

            const r0 = nodeFrom.getBoundingClientRect();
            const r1 = nodeTo.getBoundingClientRect();
            const x0 = r0.left + r0.width / 2;
            const y0 = r0.top + r0.height / 2;
            const xEnd = r1.left + r1.width / 2;
            const yEnd = r1.top + r1.height / 2;

            const errors = [];
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const cx = x0 + (xEnd - x0) * t;
                const cy = y0 + (yEnd - y0) * t;
                win.dispatchEvent(new PointerEvent('pointermove', {
                    clientX: cx,
                    clientY: cy,
                    bubbles: true,
                    pointerId: 1,
                    pointerType: 'touch',
                    buttons: 1
                }));
                await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

                const expected = g.toWorld(cx, cy);
                const line = doc.querySelector('line.preview');
                if (!line) {
                    errors.push({ step: i, reason: 'no preview line' });
                    continue;
                }
                const x2 = parseFloat(line.getAttribute('x2'));
                const y2 = parseFloat(line.getAttribute('y2'));
                const err = Math.hypot(x2 - expected.x, y2 - expected.y);
                if (err > maxErr) {
                    errors.push({
                        step: i,
                        client: { cx, cy },
                        expected,
                        actual: { x2, y2 },
                        err: Math.round(err * 10) / 10
                    });
                }
            }

            if (release) {
                win.dispatchEvent(new PointerEvent('pointerup', {
                    clientX: xEnd,
                    clientY: yEnd,
                    bubbles: true,
                    pointerId: 1,
                    pointerType: 'touch'
                }));
            }

            return { ok: errors.length === 0, errors, zoom: g.zoom, targetZoom: g.targetZoom };
        }, { fromId, toId, steps, maxErr: MAX_PREVIEW_ERR_PX, release }),
        ms,
        'line drag track pointer'
    );

    if (!result.ok) {
        throw new Error(`Line drag preview did not track finger: ${JSON.stringify(result)}`);
    }
    return result;
}

async function assertDragPreviewAtHalfway(page) {
    return assertLineDragTracksPointer(page, '1', '5', 8);
}

/** Keep P1 drag + MP preview broadcast alive while P2 syncs (call before finishLineDrag). */
async function sustainLineDragPreview(page, fromId = '1', toId = '5', pulses = 10) {
    await page.evaluate(async ({ fromId, toId, pulses }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const g = win?.game;
        const doc = win?.document;
        if (!g?.dragLine || !doc) return;
        const nodeFrom = doc.querySelector(`.node[data-id="${fromId}"]`);
        const nodeTo = doc.querySelector(`.node[data-id="${toId}"]`);
        if (!nodeFrom || !nodeTo) return;
        const r0 = nodeFrom.getBoundingClientRect();
        const r1 = nodeTo.getBoundingClientRect();
        const x0 = r0.left + r0.width / 2;
        const y0 = r0.top + r0.height / 2;
        const x1 = r1.left + r1.width / 2;
        const y1 = r1.top + r1.height / 2;
        for (let i = 0; i < pulses; i++) {
            const t = (i + 1) / (pulses + 1);
            const cx = x0 + (x1 - x0) * t;
            const cy = y0 + (y1 - y0) * t;
            g.dragLine({ clientX: cx, clientY: cy, buttons: 1 });
            await new Promise((r) => setTimeout(r, 80));
        }
    }, { fromId, toId, pulses });
}

async function finishLineDragInIframe(page, toId = '5') {
    await page.evaluate(({ toId }) => {
        const win = document.getElementById('game-frame')?.contentWindow;
        const doc = win?.document;
        const nodeTo = doc?.querySelector(`.node[data-id="${toId}"]`);
        if (!nodeTo) return;
        const r1 = nodeTo.getBoundingClientRect();
        const xEnd = r1.left + r1.width / 2;
        const yEnd = r1.top + r1.height / 2;
        win.dispatchEvent(new PointerEvent('pointermove', {
            clientX: xEnd,
            clientY: yEnd,
            bubbles: true,
            pointerId: 1,
            pointerType: 'touch',
            buttons: 1
        }));
        win.dispatchEvent(new PointerEvent('pointerup', {
            clientX: xEnd,
            clientY: yEnd,
            bubbles: true,
            pointerId: 1,
            pointerType: 'touch'
        }));
    }, { toId });

    await waitForLinePathInFrame(page, 1);
    const pathLen = await page.evaluate(() =>
        document.getElementById('game-frame')?.contentWindow?.game?.path?.length || 0
    );
    return { ok: true, pathLen };
}

module.exports = {
    assertDragPreviewAtHalfway,
    assertLineDragTracksPointer,
    sustainLineDragPreview,
    finishLineDragInIframe
};
