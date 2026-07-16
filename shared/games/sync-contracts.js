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
        },
        quoridor: {
            style: 'event-log',
            read: 'event-log',
            write: 'event-log',
            winner: 'event-log',
            review: 'none',
            notes: 'SP vs AI for now; MP event-log reserved for later (line/piles pattern).'
        },
        gops: {
            style: 'event-log',
            read: 'event-log',
            write: 'event-log',
            winner: 'event-log',
            review: 'none',
            notes: 'SP vs AI for now; MP event-log reserved for later.'
        }
        // NEW_GAME_CONTRACT_INSERT
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

    /**
     * CI helper — registry syncStyle / mpBoardAuthoritative must match documented contracts.
     * @returns {string[]} error messages (empty = ok)
     */
    function validateRegistryAlignment(registry) {
        const reg = registry || (typeof global !== 'undefined' ? global.GameRegistry : null);
        if (!reg?.list) return ['GameRegistry not available'];
        const errors = [];

        function mpAuditForMode(game, mode) {
            if (game.mpAuditByMode?.[mode]) return game.mpAuditByMode[mode];
            if (game.mpAuditConfig && (mode === game.defaultMode || game.modes.length === 1)) {
                return game.mpAuditConfig;
            }
            return null;
        }

        function requiresContract(game, mode) {
            if (mpAuditForMode(game, mode)) return true;
            if ((game.mpPlayerCounts || []).some((n) => n >= 2)) return true;
            return false;
        }

        for (const game of registry.list()) {
            for (const mode of game.modes) {
                const caps = registry.getCapabilities(game.id, mode);
                const contract = contractFor(game.id, mode);
                if (!contract) {
                    if (requiresContract(game, mode)) {
                        errors.push(`Missing sync contract: ${game.id}:${mode}`);
                    }
                    continue;
                }
                if (contract.style !== caps.syncStyle) {
                    errors.push(
                        `${game.id}:${mode} syncStyle registry=${caps.syncStyle} contract=${contract.style}`
                    );
                }
                const boardAuthCap = !!caps.mpBoardAuthoritative;
                const boardAuthContract = contract.style === 'board-authoritative';
                if (boardAuthCap !== boardAuthContract) {
                    errors.push(
                        `${game.id}:${mode} mpBoardAuthoritative=${boardAuthCap} vs contract=${contract.style}`
                    );
                }
            }
        }
        return errors;
    }

    const GameSyncContracts = {
        BY_GAME,
        BY_GAME_MODE,
        contractFor,
        isBoardAuthoritative,
        allowsEventLogApply,
        validateRegistryAlignment
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameSyncContracts;
    } else {
        global.GameSyncContracts = GameSyncContracts;
    }
})(typeof window !== 'undefined' ? window : global);
