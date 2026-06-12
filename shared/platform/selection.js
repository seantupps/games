/**
 * Marquee selection — right-drag on desktop; hold empty board + drag on mobile.
 */
(function (global) {
    const THRESHOLD = 4;
    /** Mobile: hold still this long before move → marquee; immediate drag → pan. */
    const MARQUEE_HOLD_MS = 200;

    function rectsIntersect(a, b) {
        return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    }

    function createMarqueeOverlay(overlayHost) {
        const overlay = document.createElement('div');
        overlay.className = 'selection-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        const box = document.createElement('div');
        box.className = 'selection-marquee';
        overlay.appendChild(box);
        overlayHost.appendChild(overlay);
        return { overlay, box };
    }

    function bindMarqueeGestures(surfaceEl, game, opts, config) {
        const { overlay, box } = config.ui;
        const hostRectOf = () => config.overlayHost.getBoundingClientRect();

        let start = null;
        let active = false;
        const activePointers = new Set();

        const clearMobileHoldFlags = () => {
            if (!game || !config.trackMobileMarquee) return;
            game._mobileMarqueeActive = false;
            game._mobileMarqueeHoldPending = false;
            game._mobileMarqueeHoldArmed = false;
            game._mobileMarqueeHoldAt = 0;
        };

        const resetStart = () => {
            if (start?.holdTimer) clearTimeout(start.holdTimer);
            start = null;
            active = false;
            clearBox();
            overlay.classList.remove('is-selecting');
            clearMobileHoldFlags();
        };

        const releasePointer = (pointerId) => {
            if (pointerId != null) activePointers.delete(pointerId);
        };

        const armMarquee = (e) => {
            if (!start || active) return;
            active = true;
            if (game && config.trackMobileMarquee) {
                game._mobileMarqueeActive = true;
                game._mobileMarqueeHoldPending = false;
                game._mobileMarqueeHoldArmed = false;
                game._bgGestureWasMarquee = true;
                if (typeof game._cancelViewportPan === 'function') game._cancelViewportPan();
            }
            try {
                if (e.pointerId != null) surfaceEl.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        };

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
            if (!config.acceptPointerDown(e)) return;
            if (config.shouldIgnoreTarget?.(e.target)) return;
            if (config.shouldDeferToPan?.()) return;
            if (game?._pinchActive) return;

            if (config.trackMobileMarquee) {
                activePointers.add(e.pointerId);
                if (activePointers.size > 1) {
                    resetStart();
                    return;
                }
            }

            const hostRect = hostRectOf();
            const holdMs = config.holdBeforeDragMs ?? 0;
            start = {
                x: e.clientX - hostRect.left,
                y: e.clientY - hostRect.top,
                clientX: e.clientX,
                clientY: e.clientY,
                pointerId: e.pointerId,
                downAt: Date.now(),
                holdArmed: holdMs <= 0
            };
            active = false;
            clearBox();
            overlay.classList.add('is-selecting');
            if (holdMs > 0) {
                start.holdTimer = setTimeout(() => {
                    if (!start) return;
                    start.holdArmed = true;
                    if (game && config.trackMobileMarquee) {
                        game._mobileMarqueeHoldArmed = true;
                    }
                }, holdMs);
                if (game && config.trackMobileMarquee) {
                    game._mobileMarqueeHoldPending = true;
                    game._mobileMarqueeHoldArmed = false;
                    game._mobileMarqueeHoldAt = start.downAt;
                    game._bgGestureWasMarquee = false;
                }
            } else if (config.preventDefaultOnDown !== false) {
                e.preventDefault();
                try {
                    if (e.pointerId != null) surfaceEl.setPointerCapture(e.pointerId);
                } catch (_) { /* ignore */ }
            }
        };

        const onPointerMove = (e) => {
            if (game?._pinchActive) {
                resetStart();
                return;
            }
            if (!start || (e.pointerId != null && start.pointerId != null && e.pointerId !== start.pointerId)) {
                return;
            }
            if (config.trackMobileMarquee && activePointers.size > 1) {
                resetStart();
                return;
            }
            const hostRect = hostRectOf();
            const cx = e.clientX - hostRect.left;
            const cy = e.clientY - hostRect.top;
            const dx = e.clientX - start.clientX;
            const dy = e.clientY - start.clientY;
            if (!active && Math.hypot(dx, dy) < THRESHOLD) return;

            const holdMs = config.holdBeforeDragMs ?? 0;
            if (!active && holdMs > 0) {
                const elapsed = Date.now() - start.downAt;
                const holdReady = start.holdArmed || elapsed >= holdMs;
                if (!holdReady) {
                    resetStart();
                    return;
                }
                armMarquee(e);
            } else if (!active) {
                active = true;
                if (game && config.trackMobileMarquee) {
                    game._mobileMarqueeActive = true;
                    if (typeof game._cancelViewportPan === 'function') game._cancelViewportPan();
                }
            }

            if (config.stopPropagationWhenActive && active) {
                e.stopPropagation();
                e.stopImmediatePropagation?.();
            }
            updateBox(start.x, start.y, cx, cy);
        };

        const endPointer = (e) => {
            releasePointer(e.pointerId);
            if (!start) return;
            if (active) {
                const x0 = start.clientX;
                const y0 = start.clientY;
                const x1 = e.clientX;
                const y1 = e.clientY;
                finishSelection({
                    left: Math.min(x0, x1),
                    top: Math.min(y0, y1),
                    right: Math.max(x0, x1),
                    bottom: Math.max(y0, y1)
                });
                markMarqueeGesture();
            } else if (typeof config.onTapWithoutDrag === 'function') {
                config.onTapWithoutDrag(e);
            }
            resetStart();
            try {
                if (e.pointerId != null) surfaceEl.releasePointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        };

        const onHostPointerEnd = (e) => {
            releasePointer(e.pointerId);
            if (start && e.pointerId != null && start.pointerId === e.pointerId) {
                if (!active && typeof config.onTapWithoutDrag === 'function') {
                    config.onTapWithoutDrag(e);
                }
                resetStart();
            }
        };

        surfaceEl.addEventListener('pointerdown', onPointerDown);
        surfaceEl.addEventListener('pointermove', onPointerMove, true);
        surfaceEl.addEventListener('pointerup', endPointer);
        surfaceEl.addEventListener('pointercancel', endPointer);
        if (config.trackMobileMarquee) {
            config.overlayHost.addEventListener('pointerup', onHostPointerEnd);
            config.overlayHost.addEventListener('pointercancel', onHostPointerEnd);
        }
    }

    /**
     * @param {HTMLElement} overlayHost - full viewport overlay (e.g. #game-container)
     * @param {HTMLElement} surfaceEl - board surface to start marquee on
     * @param {object} game
     * @param {{ getSelectableElements: () => HTMLElement[], onSelectionChange: (ids: string[]) => void, isSelectableTarget?: (el: HTMLElement) => boolean }} opts
     */
    function setupMarquee(overlayHost, surfaceEl, game, opts) {
        if (!overlayHost || !surfaceEl || !opts?.getSelectableElements || !opts.onSelectionChange) return;
        bindMarqueeGestures(surfaceEl, game, opts, {
            overlayHost,
            ui: createMarqueeOverlay(overlayHost),
            acceptPointerDown: (e) => e.button === 2,
            shouldIgnoreTarget: null,
            stopPropagationWhenActive: false,
            trackMobileMarquee: false,
            onTapWithoutDrag: null
        });
        overlayHost.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.tile, .piece')) return;
            e.preventDefault();
        });
    }

    /**
     * Mobile: hold empty board, then drag to marquee-select tiles.
     * Immediate background drag (no hold) is left to viewport pan.
     * @param {HTMLElement} overlayHost
     * @param {HTMLElement} surfaceEl
     * @param {object} game
     * @param {{ getSelectableElements: () => HTMLElement[], onSelectionChange: (ids: string[]) => void, onClearSelection?: () => void, isSelectableTarget?: (el: HTMLElement) => boolean }} opts
     */
    function setupMobileMarquee(overlayHost, surfaceEl, game, opts) {
        if (!overlayHost || !surfaceEl || !opts?.getSelectableElements || !opts.onSelectionChange) {
            return;
        }
        if (game) game._mobileMarqueeHoldMs = MARQUEE_HOLD_MS;
        bindMarqueeGestures(surfaceEl, game, opts, {
            overlayHost,
            ui: createMarqueeOverlay(overlayHost),
            acceptPointerDown: (e) => e.button === 0,
            shouldIgnoreTarget: (target) => !!target.closest?.('.tile, .piece'),
            shouldDeferToPan: null,
            holdBeforeDragMs: MARQUEE_HOLD_MS,
            preventDefaultOnDown: false,
            stopPropagationWhenActive: true,
            trackMobileMarquee: true,
            onTapWithoutDrag: () => opts.onClearSelection?.()
        });
    }

    const GameSelection = { setupMarquee, setupMobileMarquee };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameSelection;
    } else {
        global.GameSelection = GameSelection;
    }
})(typeof window !== 'undefined' ? window : global);
