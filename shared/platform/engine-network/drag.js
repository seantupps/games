/**
 * Real-time drag + piecePositions sync (piles-style boards).
 */
(function (global) {
    function myUid(game) {
        return game.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
    }

    function handleDragInteractions(game, data) {
        if (!game.hasCap?.('supportsDragging')) return;
        const uid = myUid(game);

        if (data.interactions?.drag) {
            Object.entries(data.interactions.drag).forEach(([dragUid, pieces]) => {
                if (dragUid !== uid && pieces) {
                    Object.entries(pieces).forEach(([pid, dragData]) => {
                        if (!dragData) return;
                        const el = document.getElementById(pid);
                        if (el && !game.isDragging) {
                            const worldPos = game.fromWorld(dragData.x + 500, dragData.y + 500);
                            el.style.transition = 'none';
                            el.style.left = `${worldPos.lx}px`;
                            el.style.top = `${worldPos.ly}px`;
                            el.style.zIndex = '1000';
                            game.piecePositions[pid] = { nx: dragData.x + 500, ny: dragData.y + 500 };
                            game.remotelyDraggedPieces[pid] = Date.now();
                        }
                    });
                }
            });
        }

        if (data.global && (data.global.piecePositions || data.global.piecePositions === null)) {
            if (data.global.piecePositions === null) {
                game.piecePositions = {};
            } else {
                Object.entries(data.global.piecePositions).forEach(([id, pos]) => {
                    if (pos && pos.uid !== uid) {
                        if (game.remotelyDraggedPieces[id]
                            && (Date.now() - game.remotelyDraggedPieces[id] < 500)) {
                            return;
                        }
                        game.piecePositions[id] = pos;
                        const el = document.getElementById(id);
                        if (el && !game.isDragging) {
                            const worldPos = game.fromWorld(pos.nx, pos.ny);
                            el.style.left = `${worldPos.lx}px`;
                            el.style.top = `${worldPos.ly}px`;
                        }
                    } else if (pos === null) {
                        delete game.piecePositions[id];
                    }
                });
            }
        }

        if (data.interactions) {
            if (data.interactions.select) {
                const otherUid = Object.keys(data.interactions.select).find((id) => id !== uid);
                if (otherUid) {
                    const selectData = data.interactions.select[otherUid];
                    game.opponentSelection = (selectData && typeof selectData === 'object' && selectData.ids)
                        ? selectData
                        : null;
                } else {
                    game.opponentSelection = null;
                }
            } else {
                game.opponentSelection = null;
            }
        } else {
            game.opponentSelection = null;
        }

        if (data.interactions?.invalid && data.interactions.invalid.uid !== uid) {
            game.triggerInvalidFlash(data.interactions.invalid.ids);
        }

        game.safeRender();
    }

    function handlePileColors(game, data) {
        if (!game.hasCap?.('supportsPileColors')) return;
        if (!data.global) return;

        if (data.global.pileColors && typeof data.global.pileColors === 'object') {
            const varMap = game.colorVariableMap;
            Object.entries(data.global.pileColors).forEach(([type, color]) => {
                if (typeof color !== 'string') return;
                const varName = varMap ? varMap[type] : null;
                if (varName) document.documentElement.style.setProperty(varName, color);
            });
            game.safeRender();
        } else if (game.mode === 'classic') {
            const defaults = {
                '--blue-color': '#3b82f6',
                '--red-color': '#ef4444',
                '--green-color': '#22c55e',
                '--yellow-color': '#eab308'
            };
            Object.entries(defaults).forEach(([k, v]) => {
                document.documentElement.style.setProperty(k, v);
            });
            game.safeRender();
        }
    }

    function handleDragOnUpdate(game, data) {
        handleDragInteractions(game, data);
        handlePileColors(game, data);
    }

    global.EngineNetwork = global.EngineNetwork || {};
    global.EngineNetwork.drag = { handleDragOnUpdate };
})(typeof window !== 'undefined' ? window : global);
