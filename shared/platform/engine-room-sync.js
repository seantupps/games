/**
 * Multiplayer room snapshot merge, event-log replay, and rebuildState.
 * Loaded after engine.js; install() patches BaseGame.prototype.
 */
(function (global) {
    /** Active rematch generation — never treat RTDB resetCount 0 as authoritative when host already bumped locally. */
    function currentResetRound(game) {
        const roomRc = game.roomData?.global?.resetCount;
        const last = game.lastResetCount;
        const ack = game._resetAcknowledgedCount;
        const candidates = [roomRc, last, ack].filter((n) => typeof n === 'number' && n > 0);
        if (candidates.length) return Math.max(...candidates);
        return 1;
    }

    function eventTimestamp(game, ev) {
        const ts = ev?.timestamp;
        if (typeof ts === 'number' && Number.isFinite(ts)) {
            return ts < 1e12 ? ts * 1000 : ts;
        }
        return 0;
    }

    function dropStaleFinishedBatch(game, events, round) {
        if (events.length === 0) return [];

        const newestTs = events.reduce((max, ev) => Math.max(max, eventTimestamp(game, ev)), 0);
        const preReset =
            (newestTs > 0 && newestTs < game._resetAcknowledgedAt)
            || (
                newestTs === 0
                && game._resetAcknowledgedCount != null
                && round <= game._resetAcknowledgedCount
            );
        if (preReset) return [];

        const cfg = {
            mode: game.mode,
            createdAt: game.roomData?.createdAt || Date.now(),
            board: game.roomData?.global?.board || null,
            firstPlayer: game.roomData?.global?.firstPlayer || 'P1'
        };
        const probe = global.GameLogic.computeState(game.gameName, events, cfg);
        return probe?.isOver ? [] : events;
    }

    function eventsForReplay(game, events) {
        if (!game.isMultiplayer || !Array.isArray(events)) return events || [];
        const round = Number(currentResetRound(game));
        const tagged = events.filter((ev) => Number(ev.resetCount ?? round) === round);
        if (tagged.length > 0) return tagged;

        if (!game._resetAcknowledgedAt) return events;

        const resetCountStale =
            (game.roomData?.global?.resetCount || 0) > (game._eventsSyncedAtResetCount ?? 0);
        if (resetCountStale) return dropStaleFinishedBatch(game, events, round);

        return events;
    }

    function mpBoardFromRoomData(game) {
        const S = global.RtdbSchema;
        return S?.readBoardFromRoom
            ? S.readBoardFromRoom(game.roomData)
            : game.roomData?.global?.board;
    }

    /** MP games with board-authoritative sync (registry mpBoardAuthoritative / syncStyle). */
    function mpBoardAuthoritative(game) {
        if (!game.isMultiplayer) return false;
        if (game.hasCap('mpBoardAuthoritative')) return true;
        if (game.capabilities?.syncStyle === 'board-authoritative') {
            const mpBoard = mpBoardFromRoomData(game);
            return !!(mpBoard?.version >= 2);
        }
        return false;
    }

    function boardInReviewPhase(game) {
        if (!game.hasCap('supportsPostGameReview')) return false;
        const mpBoard = mpBoardFromRoomData(game);
        return !!(mpBoard?.phase === 'review' || mpBoard?.reviewPhase === true);
    }

    function partyMemberCount(game) {
        const pd = game.roomData?.playerData || {};
        return Object.keys(pd).filter((id) => pd[id] != null && typeof pd[id] === 'object').length;
    }

    function mergeRoomSnapshot(game, prev, incoming) {
        if (game.sync?.mergeRoomSnapshot) {
            return game.sync.mergeRoomSnapshot(prev, incoming);
        }
        if (!incoming || typeof incoming !== 'object') return prev;
        if (!prev || typeof prev !== 'object') return incoming;
        const hasPayload = incoming.global || incoming.state || incoming.meta
            || incoming.playerData || incoming.interactions || incoming.previews;
        if (!hasPayload) return incoming;

        const merged = { ...prev, ...incoming };
        if (prev.meta || incoming.meta) {
            merged.meta = { ...(prev.meta || {}), ...(incoming.meta || {}) };
        }
        if (prev.global || incoming.global) {
            merged.global = { ...(prev.global || {}), ...(incoming.global || {}) };
        }
        if (prev.state || incoming.state) {
            merged.state = { ...(prev.state || {}), ...(incoming.state || {}) };
        }
        if (incoming.playerData != null) {
            merged.playerData = { ...incoming.playerData };
        } else if (prev.playerData) {
            merged.playerData = { ...prev.playerData };
        }
        if (prev.interactions || incoming.interactions) {
            merged.interactions = { ...(prev.interactions || {}), ...(incoming.interactions || {}) };
        }
        if (incoming.interactions === null) merged.interactions = null;
        if (incoming.previews === null) merged.previews = null;
        else if (prev.previews || incoming.previews) {
            merged.previews = { ...(prev.previews || {}), ...(incoming.previews || {}) };
        }

        const S = global.RtdbSchema;
        if (S?.mergeRoomBoard) {
            const picked = S.mergeRoomBoard(prev, incoming);
            if (picked !== undefined) {
                merged.global = merged.global || {};
                merged.global.board = picked;
                merged.state = merged.state || {};
                merged.state.board = picked;
            }
        }

        return S?.normalizeRoomSnapshot ? S.normalizeRoomSnapshot(merged) : merged;
    }

    function clearResetTransientState(game) {
        game.clearAutoReset();
        game._victoryRegistered = false;
        game._winBannerSent = false;
        game.isOver = false;
        game.winner = null;
        game.clearWinOverlay();
        game.selection = { pk: null, ids: [] };
        game.opponentSelection = null;
        game.gameEvents = [];
        game._lastTurnSyncedEventCount = -1;
        window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
    }

    function applyRemoteResetSignal(game, data) {
        const snap = game.roomData || data;
        const g = snap?.global;
        if (!g) return;

        const currentResetCount = g.resetCount || 0;
        game.lastResetCount = currentResetCount;
        game._resetAcknowledgedCount = currentResetCount;
        game._resetAcknowledgedAt = Date.now();
        game._eventsSyncedAtResetCount = currentResetCount;

        clearResetTransientState(game);

        if (g.firstPlayer) game.firstPlayer = g.firstPlayer;
        if (g.turn) game.turn = g.turn;
        if (g.mode) game.mode = g.mode;

        let board = g.board;
        const S = global.RtdbSchema;
        if (S?.normalizeRoomSnapshot) {
            board = S.normalizeRoomSnapshot(snap).global?.board ?? board;
        }

        if (game.isHost()) {
            if (game.onGameReset) game.onGameReset();
            return;
        }

        if (board != null && typeof game.applyBoard === 'function') {
            if (typeof game.onRemoteReset === 'function') {
                game.onRemoteReset();
            }
            game.applyBoard(board, { force: true });
            game.updateTurnIndicator();
            game.renderScoreboard();
            game.safeRender();
            if (typeof game._syncViewportAfterLayout === 'function') {
                game._syncViewportAfterLayout();
            }
            return;
        }

        if (!global.GameLogic || !game.applyState) {
            if (game.onGameReset) game.onGameReset();
            return;
        }
        const fresh = global.GameLogic.computeState(game.gameName, [], {
            mode: game.mode,
            createdAt: game.roomData?.createdAt || Date.now(),
            board: board || null,
            firstPlayer: g.firstPlayer || 'P1'
        });
        if (fresh) game.applyState(fresh);
        if (g.turn) game.turn = g.turn;
    }

    function applyFreshBoardFromRoom(game) {
        if (!game.roomData?.global) return;
        applyRemoteResetSignal(game, { global: game.roomData.global });
    }

    function rebuildState(game) {
        if (!global.GameLogic) return;
        if (game.isMultiplayer) {
            if (!game.roomData || !game.roomData.global) {
                return;
            }
            const scoresObj = game.roomData.global.scores?.[game.gameName]?.[game.mode];
            const PM = global.PlayerModel;
            game.scores = scoresObj ? { ...scoresObj } : (PM?.defaultScores?.() || { P1: 0, P2: 0 });

            if (game.hasCap('mpBoardAuthoritative')) {
                const g = game.roomData.global;
                game.turn = g.turn || g.firstPlayer || game.turn;
                if (typeof game._traceDoneFlags === 'function') {
                    game._traceDoneFlags('rebuildState-board-authoritative');
                }
                game.updateTurnIndicator();
                game.renderScoreboard();
                game.safeRender();
                return;
            }
        }
        const config = {
            mode: game.mode,
            createdAt: game.roomData?.createdAt || Date.now(),
            board: game.roomData?.global?.board || null,
            firstPlayer: game.roomData?.global?.firstPlayer || 'P1'
        };
        const replayEvents = eventsForReplay(game, game.gameEvents);
        try {
            const state = global.GameLogic.computeState(game.gameName, replayEvents, config);
            if (state) {
                if (game.isMultiplayer && game._eventsLoaded && replayEvents.length > 0) {
                    game.turn = state.turn;
                    if (game.isHost()) {
                        const eventCount = replayEvents.length;
                        if (eventCount !== game._lastTurnSyncedEventCount) {
                            game._lastTurnSyncedEventCount = eventCount;
                            if (game.roomData?.global?.turn !== state.turn) {
                                game.broadcastTurn(state.turn);
                            }
                        }
                    }
                } else if (game.isMultiplayer) {
                    const g = game.roomData.global;
                    game.turn = g.turn || g.firstPlayer || state.turn;
                } else {
                    game.turn = state.turn;
                }

                const mpBoard = mpBoardFromRoomData(game);
                const boardInReview = boardInReviewPhase(game);
                const boardAuthoritative = game.isMultiplayer
                    && game.hasCap('mpBoardAuthoritative')
                    && !!(mpBoard?.version >= 2);

                if (game.isMultiplayer && replayEvents.length === 0 && !boardInReview) {
                    game.isOver = false;
                    game.winner = null;
                } else {
                    game.isOver = state.isOver;
                    game.winner = state.winner;
                }
                if (boardInReview) {
                    game.isOver = true;
                    if (mpBoard?.winnerUid) {
                        game._winnerUid = mpBoard.winnerUid;
                    }
                }

                const resetCountStale =
                    (game.roomData?.global?.resetCount || 0) > (game._eventsSyncedAtResetCount ?? 0);
                const replayStale = replayEvents.length < game.gameEvents.length;
                const staleVictory =
                    game.isMultiplayer
                    && state.isOver
                    && !boardInReview
                    && (
                        resetCountStale
                        || (!game.hasCap('mpBoardAuthoritative') && replayStale)
                    );

                if (staleVictory) {
                    console.warn('[ENGINE] Ignoring stale game-over from event log after host reset');
                    game.isOver = false;
                    game.winner = null;
                    game._victoryRegistered = false;
                    game.clearWinOverlay();
                    window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
                    applyFreshBoardFromRoom(game);
                } else if (boardAuthoritative) {
                    if (typeof game._traceDoneFlags === 'function') {
                        game._traceDoneFlags('rebuildState-skip-board-authoritative-applyState');
                    }
                } else {
                    const skipApplyInReview = boardInReview && game._victoryRegistered;
                    if (game.applyState && !skipApplyInReview) {
                        if (typeof game._traceDoneFlags === 'function') {
                            game._traceDoneFlags('rebuildState-before-applyState');
                        }
                        game.applyState(state);
                    } else if (skipApplyInReview && typeof game._traceDoneFlags === 'function') {
                        game._traceDoneFlags('rebuildState-skip-applyState');
                    }
                    if (game.isOver) {
                        game.setGameOver(game.winner);
                    } else if (!game._victoryRegistered) {
                        game._victoryRegistered = false;
                        game.clearWinOverlay();
                        window.parent.postMessage({ type: 'update-win-banner', visible: false }, '*');
                    }
                }
                if (boardInReview) {
                    game.isOver = true;
                    if (mpBoard?.winnerUid) {
                        game._winnerUid = mpBoard.winnerUid;
                    }
                }

                game.updateTurnIndicator();
                game.renderScoreboard();
                game.safeRender();
            } else if (!game.isMultiplayer && game.gameName !== 'unknown') {
                const logic = global.GameLogic[game.gameName];
                if (logic) {
                    const soloConfig = { mode: game.mode, createdAt: Date.now(), board: null };
                    const soloState = logic.initialState(game.mode);
                    if (game.applyState) game.applyState(soloState);
                    game.safeRender();
                }
            }
        } catch (e) {
            console.error(`[ENGINE] State compute failed for ${game.gameName}:`, e);
        }
    }

    const api = {
        currentResetRound,
        eventTimestamp,
        dropStaleFinishedBatch,
        eventsForReplay,
        mpBoardFromRoomData,
        mpBoardAuthoritative,
        boardInReviewPhase,
        partyMemberCount,
        mergeRoomSnapshot,
        clearResetTransientState,
        applyRemoteResetSignal,
        applyFreshBoardFromRoom,
        rebuildState
    };

    /** Must load after engine.js — replaces no-op class stubs. */
    function install(BaseGame) {
        if (!BaseGame?.prototype) return;
        Object.assign(BaseGame.prototype, {
            _currentResetRound() { return currentResetRound(this); },
            _eventTimestamp(ev) { return eventTimestamp(this, ev); },
            _dropStaleFinishedBatch(events, round) { return dropStaleFinishedBatch(this, events, round); },
            _eventsForReplay(events) { return eventsForReplay(this, events); },
            rebuildState() { return rebuildState(this); },
            _partyMemberCount() { return partyMemberCount(this); },
            _mergeRoomSnapshot(prev, incoming) { return mergeRoomSnapshot(this, prev, incoming); },
            _clearResetTransientState() { return clearResetTransientState(this); },
            _applyRemoteResetSignal(data) { return applyRemoteResetSignal(this, data); },
            _applyFreshBoardFromRoom() { return applyFreshBoardFromRoom(this); },
            _mpBoardFromRoomData() { return mpBoardFromRoomData(this); },
            _mpBoardAuthoritative() { return mpBoardAuthoritative(this); },
            _boardInReviewPhase() { return boardInReviewPhase(this); }
        });
    }

    global.EngineRoomSync = api;
    global.EngineRoomSync.install = install;
    if (global.BaseGame) install(global.BaseGame);
})(typeof window !== 'undefined' ? window : global);
