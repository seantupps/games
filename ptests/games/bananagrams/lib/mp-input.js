/**
 * MP input mechanics — drag, split, dump (no pass/fail verdicts except missing tile).
 */
const mpWaits = require('../../../shared/platform/mp-waits');
const { mpPollMs } = require('../../../shared/infra/speed-profiles');
const { flushHostBananaInteractions } = require('../../../shared/adapters/mp-client');

const { WAIT_MS } = mpWaits;

async function splitViaDrag(frame, { mobile = false } = {}) {
    const pointerType = mobile ? 'touch' : 'mouse';
    return frame.evaluate(async ({ pointerType }) => {
        const g = window.game;
        const tile = document.querySelector('.tile');
        if (!tile) return { ok: false, reason: 'no-tile' };
        const r = tile.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        tile.dispatchEvent(mk('pointerdown', cx, cy));
        tile.dispatchEvent(mk('pointermove', cx + 24, cy + 24));
        tile.dispatchEvent(mk('pointerup', cx + 24, cy + 24));
        await new Promise((res) => requestAnimationFrame(res));
        await new Promise((res) => requestAnimationFrame(res));
        const faceUp = !document.querySelector('.tile')?.classList.contains('is-face-down');
        return {
            ok: g.gameStarted && faceUp,
            gameStarted: g.gameStarted,
            faceUp,
            hasTimer: !!document.getElementById('banana-timer')
        };
    }, { pointerType });
}

async function rightClickDump(frame, tileIndex = -1) {
    return frame.evaluate((idx) => {
        const g = window.game;
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx < 0 ? nodes.length + idx : idx];
        if (!node) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const before = g.tiles.length;
        const beforeIds = [...g.tiles.map((t) => t.id)];
        const dumpedTileId = tile.id;
        const ok = g._handleDump(tile);
        return { ok, before, beforeIds, dumpedTileId };
    }, tileIndex);
}

async function holdDump(frame, tileIndex = -1, holdMs = 450, hostPage = null, options = {}) {
    const syncAuthority = options.syncAuthority !== false;
    const triggered = await frame.evaluate(async ({ idx, holdMs: hold }) => {
        const g = window.game;
        g.beginGame?.();
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx < 0 ? nodes.length + idx : idx];
        if (!node) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const before = g.tiles.length;
        const beforeIds = [...g.tiles.map((t) => t.id)];
        const dumpedTileId = tile.id;
        const seqBefore = g.roomData?.global?.board?.dumpSeq || 0;
        // Synthetic pointerdown on the tile does not invoke surface capture listeners
        // (dispatchEvent skips capture). Arm hold-dump through the game API instead.
        if (typeof g._armHoldDump === 'function') {
            g._armHoldDump(
                { button: 0, pointerId: 1, pointerType: 'touch' },
                node,
                () => tile,
                hold
            );
            await new Promise((res) => setTimeout(res, hold + 50));
            g._releaseHoldDumpPointer?.(1);
        } else {
            const r = node.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const mk = (type) => new PointerEvent(type, {
                clientX: cx,
                clientY: cy,
                bubbles: true,
                pointerId: 1,
                pointerType: 'touch',
                button: 0,
                buttons: type === 'pointerup' ? 0 : 1
            });
            node.dispatchEvent(mk('pointerdown'));
            await new Promise((res) => setTimeout(res, hold));
            node.dispatchEvent(mk('pointerup'));
        }
        await new Promise((res) => requestAnimationFrame(res));
        const guestMp = g._isMultiplayerMode?.() && !g.isHost?.();
        const optimistic = guestMp && g._guestDumpPendingTileId === dumpedTileId;
        const seqAfter = g.roomData?.global?.board?.dumpSeq || 0;
        const hostApplied = !guestMp && g.tiles.length === beforeIds.length + 2;
        const handUniqueAfter = new Set((g.tiles || []).map((t) => t.id)).size;
        const handUniqueBefore = new Set(beforeIds).size;
        const authorityApplied = handUniqueAfter === handUniqueBefore + 2;
        return {
            ok: optimistic || hostApplied || seqAfter > seqBefore || authorityApplied,
            before,
            beforeIds,
            dumpedTileId,
            after: g.tiles.length,
            guestMp,
            optimistic,
            hostApplied,
            authorityApplied
        };
    }, { idx: tileIndex, holdMs });
    if (!triggered.ok && !triggered.guestMp) return triggered;
    if (!triggered.guestMp) {
        if (!syncAuthority) {
            return { ...triggered, ok: !!triggered.hostApplied };
        }
        return triggered;
    }
    if (!syncAuthority) {
        return {
            ...triggered,
            ok: triggered.ok || triggered.optimistic || triggered.authorityApplied
        };
    }

    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        if (hostPage) await flushHostBananaInteractions(hostPage);
        const ready = await frame.evaluate(({ idList }) => {
            const g = window.game;
            const beforeUnique = new Set(idList).size;
            const handUnique = new Set((g?.tiles || []).map((t) => t.id)).size;
            return handUnique === beforeUnique + 2;
        }, { idList: triggered.beforeIds });
        if (ready) {
            return {
                ok: true,
                before: triggered.before,
                beforeIds: triggered.beforeIds,
                dumpedTileId: triggered.dumpedTileId,
                after: triggered.beforeIds.length + 2
            };
        }
        await frame.waitForTimeout(mpPollMs());
    }
    const after = await frame.evaluate(() => window.game?.tiles?.length ?? 0);
    return { ok: false, before: triggered.before, beforeIds: triggered.beforeIds, after };
}

async function dumpTile(frame, tileIndex = -1, { mobile = false, hostPage = null, syncAuthority = true } = {}) {
    if (mobile) return holdDump(frame, tileIndex, 450, hostPage, { syncAuthority });
    return rightClickDump(frame, tileIndex);
}

async function naturalDrag(page, frame, tileId, targetWorldX, targetWorldY) {
    const startPos = await frame.evaluate((id) => {
        const node = document.querySelector(`.tile[data-tile-id="${id}"]`);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, tileId);
    if (!startPos) throw new Error(`Could not find tile ${tileId} for drag`);

    const endPos = await frame.evaluate(({ tx, ty }) => {
        const g = window.game;
        const vp = window.GameViewport;
        return vp.worldToClient(g, tx, ty);
    }, { tx: targetWorldX, ty: targetWorldY });

    const frameHandle = await page.$('#game-frame');
    const frameBox = await frameHandle.boundingBox();
    await page.mouse.move(frameBox.x + startPos.x, frameBox.y + startPos.y);
    await page.mouse.down();
    await page.mouse.move(frameBox.x + endPos.x, frameBox.y + endPos.y, { steps: 5 });
    await page.mouse.up();
}

async function dragTileByIndex(frame, tileIndex, dx, dy, { mobile = false } = {}) {
    const pointerType = mobile ? 'touch' : 'mouse';
    return frame.evaluate(({ idx, dx, dy, pointerType }) => {
        const g = window.game;
        const nodes = [...document.querySelectorAll('.tile')];
        const node = nodes[idx];
        if (!node || !g) return { ok: false, reason: 'no-tile' };
        const tile = g.tiles.find((t) => t.id === node.dataset.tileId);
        if (!tile) return { ok: false, reason: 'no-model' };
        const r = node.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        const mk = (type, x, y) => new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            pointerId: 1,
            pointerType,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
        });
        node.dispatchEvent(mk('pointerdown', x0, y0));
        node.dispatchEvent(mk('pointermove', x0 + dx, y0 + dy));
        node.dispatchEvent(mk('pointerup', x0 + dx, y0 + dy));
        g.requestRender();
        return { ok: true, id: tile.id, x: tile.x, y: tile.y };
    }, { idx: tileIndex, dx, dy, pointerType });
}

module.exports = {
    splitViaDrag,
    rightClickDump,
    holdDump,
    dumpTile,
    naturalDrag,
    dragTileByIndex
};
