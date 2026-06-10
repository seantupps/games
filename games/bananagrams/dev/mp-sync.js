/**
 * Dev /b solve MP sync — guests pick up solve layouts + pool without affecting peel/dump.
 */
(function (global) {
    const Dev = global.BananaDev = global.BananaDev || {};

    Dev.pendingSolveLayout = function pendingSolveLayout(game, board) {
        const seq = board?.devSolveSeq || 0;
        if (!seq) return false;
        return seq > (game._lastDevSolveSeqApplied || 0);
    };

    Dev.noteSolveBoardApplied = function noteSolveBoardApplied(game, board) {
        const seq = board?.devSolveSeq || 0;
        if (seq > (game._lastDevSolveSeqApplied || 0)) {
            game._lastDevSolveSeqApplied = seq;
            game._lastDevSolvePoolSeq = seq;
        }
    };

    /** Dev-only pool bypass — writes game._tilePool cache only (not roomData wire). */
    Dev.applyDevSolveFromBoard = function applyDevSolveFromBoard(game, board) {
        if (!Dev.allowAuthorityBypass) return false;
        if (!Dev.pendingSolveLayout(game, board)) return false;
        if (!game?._isMultiplayerMode?.() || !game.canMutatePlayingBoard?.()) return false;
        if (Array.isArray(board.pool)) {
            game._tilePool = [...board.pool];
            game._refreshPoolHud?.();
        }
        return true;
    };

    /** @deprecated use applyDevSolveFromBoard */
    Dev.applySolvePoolFromBoard = function applySolvePoolFromBoard(game, board) {
        return Dev.applyDevSolveFromBoard(game, board);
    };

    Dev.preferRemoteSolveLayout = function preferRemoteSolveLayout(game, board, uid, ownedList, remoteList) {
        if (!Dev.pendingSolveLayout(game, board)) return null;
        if (!Array.isArray(remoteList) || !remoteList.length || !ownedList?.length) return null;
        const boardLayout = game._pruneLayout(
            game._positionsMapFromList(remoteList),
            ownedList
        );
        return Object.keys(boardLayout).length === ownedList.length ? boardLayout : null;
    };

    Dev.augmentPlayingBoard = function augmentPlayingBoard(game, board) {
        if (!board || !game._devSolveSeq) return;
        board.devSolveSeq = game._devSolveSeq;
    };

    Dev.bumpSolveSeq = function bumpSolveSeq(game) {
        game._devSolveSeq = (game._devSolveSeq || 0) + 1;
    };

    Dev.revertSolveSeq = function revertSolveSeq(game, seq) {
        if (!game) return;
        game._devSolveSeq = seq || 0;
    };

    Dev.resetSolveSeq = function resetSolveSeq(game) {
        if (!game) return;
        game._devSolveSeq = 0;
        game._lastDevSolveSeqApplied = 0;
        game._lastDevSolvePoolSeq = 0;
    };

    /** Explicit opt-in for dev authority bypass paths (_hostSetPlayerTiles, board-solve). */
    Dev.allowAuthorityBypass = true;

    Dev.isDevBundleLoaded = function isDevBundleLoaded() {
        return true;
    };

    /** Dev bundle is never loaded in production — fail loud by default. */
    Dev.shouldFailLoud = function shouldFailLoud() {
        try {
            if (typeof window !== 'undefined' && window.__FIVE_TEST_MODE__) return true;
            const params = new URLSearchParams(window.location.search);
            if (params.get('devFailLoud') === '0') return false;
            return true;
        } catch (_) {
            return true;
        }
    };

    Dev.failAuthorityCommit = function failAuthorityCommit(context, detail) {
        console.error('[BananaDev authority]', context, detail);
        if (Dev.shouldFailLoud()) {
            throw new Error(`[BananaDev authority] ${context}`);
        }
    };
})(typeof window !== 'undefined' ? window : global);
