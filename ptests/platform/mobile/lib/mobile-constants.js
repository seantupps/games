/** Shared timeouts + mobile runner tuning. */
const T = require('../../../shared/infra/timeouts');

module.exports = {
    ...T,
    HEARTBEAT_MS: Number(process.env.FIVE_MOBILE_HEARTBEAT_MS || 2000),
    /** Outer cap for full mobile suite (hub + SP + MP in parallel). */
    SUITE_MS: Number(process.env.FIVE_MOBILE_SUITE_TIMEOUT_MS || 300000),
    WORKERS: Number(process.env.FIVE_MOBILE_WORKERS || 4),
    MP_PARALLEL: process.env.FIVE_MOBILE_MP_PARALLEL !== '0',
    /** Per-game SP audit (move loop + 2s auto-reset + banner wait). */
    SP_GAME_MS: Number(process.env.FIVE_MOBILE_SP_GAME_MS || 60000),
    /** Single MP audit (two clients, moves, auto-reset). */
    MP_GAME_MS: Number(process.env.FIVE_MOBILE_MP_GAME_MS || 90000),
    MP_INVITE_MS: Number(process.env.FIVE_MOBILE_MP_INVITE_MS || 45000),
    MP_PARTY_MS: Number(process.env.FIVE_MOBILE_MP_PARTY_MS || 20000),
    MP_BLOCK_MS: Number(process.env.FIVE_MOBILE_MP_BLOCK_MS || 240000),
    /** Post-win auto-reset (host delay + RTDB); 2s STEP_MS is too tight on mobile. */
    AUTO_RESET_MS: Number(process.env.FIVE_AUTO_RESET_WAIT_MS || T.STEP_MS),
    PARTY_SYNC_MS: Number(process.env.FIVE_PARTY_SYNC_MS || T.STEP_MS),
    /** Post peel/dump settle — poll-first; cap well below STEP_MS (was 3s, dominated MP block). */
    MP_BOARD_SYNC_MS: Number(process.env.FIVE_MP_BOARD_SYNC_MS || 400),
    /** Guest SPLIT letter-shuffle watch (desktop runs this; mobile skips the whole step). */
    GUEST_SPLIT_WATCH_MS: Number(process.env.FIVE_MP_GUEST_SPLIT_WATCH_MS || 1200)
};
