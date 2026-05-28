/**
 * Pointer drag helper for game pieces (used by BaseGame.enableDragging / setupDragging).
 */
(function (global) {
    const Viewport = () => global.GameViewport;

    function setupDragging(el, onDragEnd, context, onDragStart, onDrag, options) {
        options = options || {};
        const getGroup = options.getGroup;
        const useCursorAnchor = options.anchor === 'cursor';
        let startX, startY, isDragging = false;
        let members = [];
        let moveRaf = 0;
        let latestMe = null;
        const threshold = 5;
        el.style.touchAction = 'none';

        const getZoom = () => (context && context.zoom) || 1;

        const setDragging = (active, nodes) => {
            if (!context) return;
            context._pointerDragging = active;
            context.isDragging = active;
            (nodes || [el]).forEach((node) => {
                if (active) node.classList.add('is-dragging');
                else node.classList.remove('is-dragging');
            });
            if (active && useCursorAnchor) {
                context._dragCursorRefresh = refreshDrag;
            } else if (!active) {
                context._dragCursorRefresh = null;
            }
        };

        const clientToWorld = (clientX, clientY) => {
            if (typeof options.clientToWorld === 'function') {
                return options.clientToWorld(context, clientX, clientY);
            }
            const vp = Viewport();
            if (vp && context) return vp.clientToWorld(context, clientX, clientY);
            return { x: clientX, y: clientY };
        };

        const applyCursorAnchor = (clientX, clientY) => {
            const anchor = clientToWorld(clientX, clientY);
            members.forEach((m) => {
                const wx = anchor.x + m.offsetX;
                const wy = anchor.y + m.offsetY;
                if (typeof options.setWorldPosition === 'function') {
                    options.setWorldPosition(m, wx, wy);
                } else {
                    m.el.style.transform = '';
                    m.el.style.left = `${Math.round(wx)}px`;
                    m.el.style.top = `${Math.round(wy)}px`;
                }
                if (onDrag) onDrag(wx, wy, m.el);
            });
        };

        const applyDelta = (dx, dy) => {
            members.forEach((m) => {
                const nextLeft = m.left + dx;
                const nextTop = m.top + dy;
                if (context?.capabilities?.unboundedDrag) {
                    m.el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
                } else {
                    const parent = m.el.parentElement;
                    const pw = parent ? parent.clientWidth : 0;
                    const ph = parent ? parent.clientHeight : 0;
                    const w = m.el.offsetWidth;
                    const h = m.el.offsetHeight;
                    const cl = Math.max(0, Math.min(nextLeft, pw - w));
                    const ct = Math.max(0, Math.min(nextTop, ph - h));
                    m.el.style.transform = `translate3d(${cl - m.left}px, ${ct - m.top}px, 0)`;
                }
                if (onDrag) onDrag(nextLeft, nextTop, m.el);
            });
        };

        const refreshDrag = () => {
            if (!context?._pointerDragging) return;
            const cx = context?.mousePos?.x ?? latestMe?.clientX;
            const cy = context?.mousePos?.y ?? latestMe?.clientY;
            if (cx == null || cy == null) return;
            if (useCursorAnchor) applyCursorAnchor(cx, cy);
        };

        /** Turn-gated MP drag (line, piles); off for simultaneous games (bananagrams). */
        const mpDragBlockedByTurn = () => {
            if (!context?.isMultiplayer) return false;
            const turnGated = typeof context.hasCap === 'function'
                ? context.hasCap('supportsTurnIndicator')
                : true;
            if (!turnGated) return false;
            return context.turn !== context.playerRole;
        };

        const onPointerDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (context?._pinchActive) return;
            if (mpDragBlockedByTurn()) return;
            if (context && !context.isMultiplayer && !context.capabilities?.unboundedDrag
                && (context.turn !== 'P1' || context.isOver)) return;
            if (onDragStart && onDragStart(el) === false) return;

            startX = e.clientX;
            startY = e.clientY;
            latestMe = e;

            let group = [{ el, left: 0, top: 0 }];
            if (typeof getGroup === 'function') {
                const g = getGroup(el);
                if (g && g.length) group = g;
            }

            const anchor = useCursorAnchor ? clientToWorld(e.clientX, e.clientY) : null;

            members = group.map((m) => {
                const node = m.el || el;
                let worldX;
                let worldY;
                if (typeof options.getWorldPosition === 'function') {
                    const w = options.getWorldPosition(m);
                    worldX = w.x;
                    worldY = w.y;
                } else {
                    const left = parseFloat(node.style.left);
                    const top = parseFloat(node.style.top);
                    worldX = Number.isFinite(left) ? left : (m.left || 0);
                    worldY = Number.isFinite(top) ? top : (m.top || 0);
                }
                const left = parseFloat(node.style.left);
                const top = parseFloat(node.style.top);
                return {
                    el: node,
                    tile: m.tile,
                    left: Number.isFinite(left) ? left : worldX,
                    top: Number.isFinite(top) ? top : worldY,
                    worldX,
                    worldY,
                    startWorldX: worldX,
                    startWorldY: worldY,
                    offsetX: useCursorAnchor ? worldX - anchor.x : 0,
                    offsetY: useCursorAnchor ? worldY - anchor.y : 0
                };
            });

            members.forEach((m) => { m.el.style.transition = 'none'; });

            try {
                if (e.pointerId != null) el.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }

            const onPointerMove = (me) => {
                latestMe = me;
                if (context?._pinchActive) {
                    onPointerUp(me);
                    return;
                }
                if (context) context.mousePos = { x: me.clientX, y: me.clientY };
                if (!isDragging && (Math.abs(me.clientX - startX) > threshold || Math.abs(me.clientY - startY) > threshold)) {
                    isDragging = true;
                    setDragging(true, members.map((m) => m.el));
                    if (typeof context._cancelHoldDump === 'function') context._cancelHoldDump();
                }
                if (!isDragging) return;
                if (!moveRaf) {
                    moveRaf = requestAnimationFrame(() => {
                        moveRaf = 0;
                        if (!isDragging || !latestMe) return;
                        if (useCursorAnchor) {
                            applyCursorAnchor(latestMe.clientX, latestMe.clientY);
                        } else {
                            const z = getZoom();
                            const dx = (latestMe.clientX - startX) / z;
                            const dy = (latestMe.clientY - startY) / z;
                            applyDelta(dx, dy);
                        }
                    });
                }
            };

            const onPointerUp = (ue) => {
                document.removeEventListener('pointermove', onPointerMoveOnce);
                document.removeEventListener('pointerup', onPointerUpOnce);
                document.removeEventListener('pointercancel', onPointerUpOnce);
                el.removeEventListener('pointermove', onPointerMoveOnce);
                el.removeEventListener('pointerup', onPointerUpOnce);
                el.removeEventListener('pointercancel', onPointerUpOnce);
                if (moveRaf) cancelAnimationFrame(moveRaf);
                moveRaf = 0;
                try {
                    if (ue.pointerId != null) el.releasePointerCapture(ue.pointerId);
                } catch (_) { /* ignore */ }

                if (isDragging) {
                    latestMe = ue;
                    if (useCursorAnchor) {
                        applyCursorAnchor(ue.clientX, ue.clientY);
                    } else {
                        const z = getZoom();
                        const dx = (ue.clientX - startX) / z;
                        const dy = (ue.clientY - startY) / z;
                        members.forEach((m) => {
                            let nextLeft = m.left + dx;
                            let nextTop = m.top + dy;
                            if (!context?.capabilities?.unboundedDrag) {
                                const parent = m.el.parentElement;
                                const pw = parent ? parent.clientWidth : 0;
                                const ph = parent ? parent.clientHeight : 0;
                                nextLeft = Math.max(0, Math.min(nextLeft, pw - m.el.offsetWidth));
                                nextTop = Math.max(0, Math.min(nextTop, ph - m.el.offsetHeight));
                            }
                            m.el.style.transform = '';
                            m.el.style.left = `${Math.round(nextLeft)}px`;
                            m.el.style.top = `${Math.round(nextTop)}px`;
                        });
                    }
                }

                if (onDragEnd) onDragEnd(isDragging, el, ue, members);
                isDragging = false;
                setDragging(false, members.map((m) => m.el));
                members.forEach((m) => { m.el.style.transition = ''; });
                members = [];
            };

            const seenPointerEvents = new WeakSet();
            const oncePerEvent = (handler) => (event) => {
                if (seenPointerEvents.has(event)) return;
                seenPointerEvents.add(event);
                handler(event);
            };
            const onPointerMoveOnce = oncePerEvent(onPointerMove);
            const onPointerUpOnce = oncePerEvent(onPointerUp);

            document.addEventListener('pointermove', onPointerMoveOnce);
            document.addEventListener('pointerup', onPointerUpOnce);
            document.addEventListener('pointercancel', onPointerUpOnce);
            el.addEventListener('pointermove', onPointerMoveOnce);
            el.addEventListener('pointerup', onPointerUpOnce);
            el.addEventListener('pointercancel', onPointerUpOnce);
        };

        el.addEventListener('pointerdown', onPointerDown);
    }

    const GameDrag = { setupDragging };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameDrag;
    } else {
        global.GameDrag = GameDrag;
    }
})(typeof window !== 'undefined' ? window : global);
