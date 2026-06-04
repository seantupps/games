#!/usr/bin/env node
/**
 * Unit checks for shared/platform/mp-board-auth.js (seq, ack, stale commands).
 *
 *   npm run check:board-auth
 */
const MpBoardAuth = require('../shared/platform/mp-board-auth');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

function mockGame(overrides = {}) {
    const updates = [];
    return {
        isHost: () => true,
        isMultiplayer: true,
        identitySynced: true,
        roomData: { global: { resetCount: 1 } },
        _boardSeq: 0,
        _mpAppliedResetCount: 0,
        _resetAcknowledgedAt: 1000,
        hasCap: (n) => n === 'mpBoardAuthoritative',
        updateMetadata: (u) => updates.push(u),
        broadcast: () => {},
        ...overrides,
        _updates: updates
    };
}

function testBoardSeqEnforcement() {
    const game = mockGame();
    MpBoardAuth.initBoardAuthState(game);
    const b1 = MpBoardAuth.hostPublishBoard(game, { initialized: true, ticks: 0 });
    assert(b1.seq === 1, 'first publish seq=1');
    assert(b1.version === 2, 'version=2');
    const b2 = MpBoardAuth.hostPublishBoard(game, { initialized: true, ticks: 1 });
    assert(b2.seq === 2, 'second publish seq=2');
    let threw = false;
    try {
        game._boardSeq = 5;
        MpBoardAuth.hostPublishBoard(game, { seq: 3, initialized: true }, { bumpSeq: false });
    } catch (e) {
        threw = true;
    }
    assert(!threw, 'explicit seq allowed when bumpSeq false');
}

function testShouldApplyBoard() {
    const game = mockGame({
        roomData: { global: { resetCount: 2, board: { version: 2, seq: 3, initialized: true } } },
        _mpAppliedResetCount: 2,
        _boardSeq: 3
    });
    assert(
        MpBoardAuth.shouldApplyIncomingBoard(game, { version: 2, seq: 2, initialized: true }) === false,
        'reject stale seq'
    );
    assert(
        MpBoardAuth.shouldApplyIncomingBoard(game, { version: 2, seq: 4, initialized: true }) === true,
        'accept newer seq'
    );
}

function testCommandAckAndStale() {
    const game = mockGame({ uid: 'guest1' });
    MpBoardAuth.initBoardAuthState(game);
    const ch = MpBoardAuth.createCommandChannel(game, { channel: 'test' });
    const { msg, path } = ch.send({ type: 'tick' });
    assert(msg?.id, 'command has id');
    assert(!ch.isAcked('guest1', msg), 'not acked yet');
    ch.ack('guest1', msg, path);
    assert(ch.isAcked('guest1', msg), 'acked locally');
    assert(ch.isStale({ at: 500 }), 'pre-reset command stale');
    assert(!ch.isStale({ at: 2000 }), 'post-reset command fresh');
}

function testAuditReady() {
    const host = mockGame({
        isHost: () => true,
        roomData: { global: { resetCount: 1, board: { version: 2, seq: 1, initialized: true } } }
    });
    host._auditReady = true;
    assert(MpBoardAuth.isAuditReady(host), 'host ready when board seeded');

    const guest = mockGame({
        isHost: () => false,
        roomData: { global: { resetCount: 1, board: { version: 2, seq: 1, initialized: true } } },
        _mpAppliedResetCount: 1,
        _auditReady: true
    });
    assert(MpBoardAuth.isAuditReady(guest), 'guest ready after epoch applied');
}

function main() {
    testBoardSeqEnforcement();
    testShouldApplyBoard();
    testCommandAckAndStale();
    testAuditReady();
    console.log('[check:board-auth] OK — seq, ack, stale, audit-ready');
}

main();
