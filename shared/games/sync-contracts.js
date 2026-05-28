/**
 * Multiplayer sync contracts — one primary authority per game.
 * Engine + GameSync branch on syncStyle / mpBoardAuthoritative; this documents intent.
 *
 * @typedef {'event-log'|'gameData/events'|'global/board'|'global/board+events'|'none'} MpReadSource
 * @typedef {'event-log'|'gameData/events'|'global/board'|'host-metadata'|'none'} MpWriteSource
 * @typedef {'event-log'|'global/board'|'host-metadata'|'game-local'} MpWinnerSource
 * @typedef {'none'|'global/board.phase'|'global/board.reviewPhase'} MpReviewSource
 *
 * @typedef {Object} MpSyncContract
 * @property {import('./registry').SyncStyle} style
 * @property {MpReadSource} read
 * @property {MpWriteSource} write
 * @property {MpWinnerSource} winner
 * @property {MpReviewSource} review
 * @property {string} [notes]
 */

(function (global) {
    /** @type {Record<string, MpSyncContract>} */
    const BY_GAME = {
        piles: {
            style: 'hybrid',
            read: 'global/board+events',
            write: 'event-log',
            winner: 'event-log',
            review: 'none',
            notes: 'Board snapshot for layout; moves replayed from gameData/events.'
        },
        line: {
            style: 'hybrid',
            read: 'global/board+events',
            write: 'event-log',
            winner: 'event-log',
            review: 'none',
            notes: 'Previews on global/previews; turn on global/turn.'
        },
        bananagrams: {
            style: 'board-authoritative',
            read: 'global/board',
            write: 'global/board',
            winner: 'host-metadata',
            review: 'global/board.phase',
            notes: 'Do not apply event-log isOver/applyState in MP. Interactions under interactions/banana.'
        }
    };

    /** @type {Record<string, MpSyncContract>} */
    const BY_GAME_MODE = {
        'bananagrams:solo': {
            style: 'event-log',
            read: 'none',
            write: 'none',
            winner: 'game-local',
            review: 'none',
            notes: 'Solo — local persistence only.'
        },
        'bananagrams:multiplayer': BY_GAME.bananagrams
    };

    function contractFor(gameId, mode) {
        const key = mode ? `${gameId}:${mode}` : gameId;
        if (BY_GAME_MODE[key]) return { ...BY_GAME_MODE[key] };
        const base = BY_GAME[gameId];
        return base ? { ...base } : null;
    }

    function isBoardAuthoritative(contract) {
        return contract?.style === 'board-authoritative';
    }

    function allowsEventLogApply(contract) {
        if (!contract) return true;
        return contract.style === 'event-log' || contract.style === 'hybrid';
    }

    const GameSyncContracts = {
        BY_GAME,
        BY_GAME_MODE,
        contractFor,
        isBoardAuthoritative,
        allowsEventLogApply
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameSyncContracts;
    } else {
        global.GameSyncContracts = GameSyncContracts;
    }
})(typeof window !== 'undefined' ? window : global);
