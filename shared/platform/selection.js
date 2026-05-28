/**
 * Right-drag marquee selection (Windows-style rubber band).
 */
(function (global) {
    const THRESHOLD = 4;

    function rectsIntersect(a, b) {
        return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    }

    /**
     * @param {HTMLElement} overlayHost - full viewport overlay (e.g. #game-container)
     * @param {HTMLElement} surfaceEl - board surface to start marquee on
     * @param {object} game
     * @param {{ getSelectableElements: () => HTMLElement[], onSelectionChange: (ids: string[]) => void, isSelectableTarget?: (el: HTMLElement) => boolean }} opts
     */
    function setupMarquee(overlayHost, surfaceEl, game, opts) {
        if (!overlayHost || !surfaceEl || !opts?.getSelectableElements || !opts.onSelectionChange) return;

        const overlay = document.createElement('div');
        overlay.className = 'selection-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        const box = document.createElement('div');
        box.className = 'selection-marquee';
        overlay.appendChild(box);
        overlayHost.appendChild(overlay);

        let start = null;
        let active = false;

        const clearBox = () => {
            box.style.display = 'none';
            box.style.left = '';
            box.style.top = '';
            box.style.width = '';
            box.style.height = '';
        };

        const updateBox = (x0, y0, x1, y1) => {
            const left = Math.min(x0, x1);
            const top = Math.min(y0, y1);
            box.style.display = 'block';
            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
            box.style.width = `${Math.abs(x1 - x0)}px`;
            box.style.height = `${Math.abs(y1 - y0)}px`;
        };

        const finishSelection = (rect) => {
            const hits = [];
            opts.getSelectableElements().forEach((el) => {
                if (opts.isSelectableTarget && !opts.isSelectableTarget(el)) return;
                const id = el.dataset?.tileId || el.dataset?.pieceId;
                if (!id) return;
                if (rectsIntersect(rect, el.getBoundingClientRect())) hits.push(id);
            });
            opts.onSelectionChange(hits);
        };

        const markMarqueeGesture = () => {
            if (!game) return;
            game._rmbMarqueeUsed = true;
            if (game._rmbMarqueeUsedTimer) clearTimeout(game._rmbMarqueeUsedTimer);
            game._rmbMarqueeUsedTimer = setTimeout(() => {
                game._rmbMarqueeUsed = false;
            }, 400);
        };

        const onPointerDown = (e) => {
            if (e.button !== 2) return;
            e.preventDefault();
            const hostRect = overlayHost.getBoundingClientRect();
            start = {
                x: e.clientX - hostRect.left,
                y: e.clientY - hostRect.top,
                clientX: e.clientX,
                clientY: e.clientY,
                pointerId: e.pointerId
            };
            active = false;
            clearBox();
            overlay.classList.add('is-selecting');
            try {
                if (e.pointerId != null) surfaceEl.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        };

        const onPointerMove = (e) => {
            if (!start || (e.pointerId != null && start.pointerId != null && e.pointerId !== start.pointerId)) return;
            const hostRect = overlayHost.getBoundingClientRect();
            const cx = e.clientX - hostRect.left;
            const cy = e.clientY - hostRect.top;
            const dx = e.clientX - start.clientX;
            const dy = e.clientY - start.clientY;
            if (!active && Math.hypot(dx, dy) < THRESHOLD) return;
            active = true;
            updateBox(start.x, start.y, cx, cy);
        };

        const onPointerUp = (e) => {
            if (!start) return;
            if (active) {
                const hostRect = overlayHost.getBoundingClientRect();
                const x0 = start.clientX;
                const y0 = start.clientY;
                const x1 = e.clientX;
                const y1 = e.clientY;
                const screenRect = {
                    left: Math.min(x0, x1),
                    top: Math.min(y0, y1),
                    right: Math.max(x0, x1),
                    bottom: Math.max(y0, y1)
                };
                finishSelection(screenRect);
                markMarqueeGesture();
            }
            start = null;
            active = false;
            clearBox();
            overlay.classList.remove('is-selecting');
            try {
                if (e.pointerId != null) surfaceEl.releasePointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        };

        surfaceEl.addEventListener('pointerdown', onPointerDown);
        surfaceEl.addEventListener('pointermove', onPointerMove);
        surfaceEl.addEventListener('pointerup', onPointerUp);
        surfaceEl.addEventListener('pointercancel', onPointerUp);
        overlayHost.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.tile, .piece')) return;
            e.preventDefault();
        });
    }

    const GameSelection = { setupMarquee };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameSelection;
    } else {
        global.GameSelection = GameSelection;
    }
})(typeof window !== 'undefined' ? window : global);
