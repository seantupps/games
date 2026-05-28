/** Opt-in Done / review sync tracing. Enable: localStorage.setItem('five_banana_trace_done', '1') */
(function (global) {
    const G = global.BananagramsGame;
    if (!G) return;

    Object.assign(G.prototype, {
        _doneTraceOn() {
            try {
                return localStorage.getItem('five_banana_trace_done') === '1'
                    || sessionStorage.getItem('five_banana_trace_done') === '1';
            } catch (_) {
                return false;
            }
        },

        _traceDoneSig(board) {
            if (!board) return '';
            return `${board.phase}|${board.seq}|${board.reviewEpoch ?? 0}`;
        },

        _traceDoneFlags(where) {
            if (!this._doneTraceOn()) return;
            const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
            const board = S?.readBoardFromRoom
                ? S.readBoardFromRoom(this.roomData)
                : this.roomData?.global?.board;
            const sig = this._traceDoneSig(board);
            if (sig === this._traceDoneLastFlagSig && where !== 'done-button') return;
            this._traceDoneLastFlagSig = sig;
            console.log('[FLAGS]', {
                where,
                _postGameReview: this._postGameReview,
                isOver: this.isOver,
                _boardSeq: this._boardSeq,
                _mpClientBoardPhase: this._mpClientBoardPhase,
                _victoryRegistered: this._victoryRegistered,
                _hostReviewCompleting: this._hostReviewCompleting,
                boardPhase: board?.phase,
                boardReviewDone: board?.reviewDone,
                boardSeq: board?.seq
            });
        },

        _traceDoneWrite(updates, label) {
            if (!this._doneTraceOn()) return;
            const keys = Object.keys(updates || {});
            const fullBoard = updates['global/board'];
            const reviewDoneKeys = keys.filter((k) => k.includes('reviewDone'));
            const reviewDonePatches = {};
            reviewDoneKeys.forEach((k) => {
                reviewDonePatches[k] = updates[k];
            });
            console.log('[WRITE]', {
                label: label || 'updateMetadata',
                updateKeys: keys,
                reviewDonePatches,
                phase: fullBoard?.phase,
                reviewDone: fullBoard?.reviewDone,
                seq: fullBoard?.seq,
                resetCount: updates['global/resetCount'] ?? updates['meta/resetCount']
            });
        },

        _traceDoneNetwork(incoming, label) {
            if (!this._doneTraceOn()) return;
            const S = typeof RtdbSchema !== 'undefined' ? RtdbSchema : null;
            const merged = this.roomData;
            const board = S?.readBoardFromRoom
                ? S.readBoardFromRoom(merged)
                : merged?.global?.board;
            const sig = this._traceDoneSig(board);
            const hasReviewDonePatch = incoming && Object.keys(incoming).some((k) => {
                if (k === 'state' && incoming.state?.board?.reviewDone) return true;
                if (k === 'global' && incoming.global?.board?.reviewDone) return true;
                return String(k).includes('reviewDone');
            });
            if (!hasReviewDonePatch && sig === this._traceDoneLastNetSig) return;
            this._traceDoneLastNetSig = sig;
            const incBoard = incoming?.global?.board
                ?? incoming?.state?.board
                ?? null;
            console.log('[NETWORK]', {
                label: label || 'network-update',
                incomingKeys: incoming ? Object.keys(incoming) : [],
                incomingBoard: incBoard ? {
                    phase: incBoard.phase,
                    reviewDone: incBoard.reviewDone,
                    seq: incBoard.seq
                } : null,
                mergedBoard: board ? {
                    phase: board.phase,
                    reviewDone: board.reviewDone,
                    seq: board.seq
                } : null,
                resetCount: S?.readResetCount ? S.readResetCount(merged) : merged?.global?.resetCount
            });
        },

        _traceDoneApply(board, options, caller) {
            if (!this._doneTraceOn()) return;
            const sig = `${this._traceDoneSig(board)}|${!!options?.force}|${!!options?.reset}`;
            if (sig === this._traceDoneLastApplySig) return;
            this._traceDoneLastApplySig = sig;
            console.log('[APPLY]', {
                caller,
                force: !!options?.force,
                reset: !!options?.reset,
                phase: board?.phase,
                reviewDone: board?.reviewDone,
                seq: board?.seq
            });
        }
    });

    const baseUpdate = global.BaseGame?.prototype?.updateMetadata;
    if (baseUpdate) {
        global.BaseGame.prototype.updateMetadata = function (updates) {
            if (this.gameName === 'bananagrams' && typeof this._traceDoneWrite === 'function') {
                this._traceDoneWrite(updates, 'updateMetadata');
            }
            return baseUpdate.call(this, updates);
        };
    }
})(typeof window !== 'undefined' ? window : global);
