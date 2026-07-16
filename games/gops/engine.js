/**
 * GOPS rules engine (browser + worker). Port of build/gops/play/game.js.
 * Full opening N=13 by default (classic / "k=13" full deal).
 */
(function (root) {
    "use strict";

    const ALL_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    const RANK_VALUE = {};
    ALL_RANKS.forEach((r, i) => {
        RANK_VALUE[r] = i + 1;
    });

    function ranksForN(n) {
        if (!Number.isInteger(n) || n < 1 || n > ALL_RANKS.length) {
            throw new Error(`N must be 1..${ALL_RANKS.length}`);
        }
        return ALL_RANKS.slice(0, n);
    }

    function shuffle(arr, rng) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const t = a[i];
            a[i] = a[j];
            a[j] = t;
        }
        return a;
    }

    function mulberry32(seed) {
        let t = seed >>> 0;
        return () => {
            t += 0x6d2b79f5;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }

    class Engine {
        constructor({ n = 13, seed = null } = {}) {
            this.n = n;
            this.ranks = ranksForN(n);
            this.rng = seed == null ? Math.random : mulberry32(seed);
            this.playerHand = this.ranks.slice();
            this.aiHand = this.ranks.slice();
            this.prizePile = shuffle(this.ranks, this.rng);
            this.pendingPrizes = [];
            this.playerScore = 0;
            this.aiScore = 0;
            this.lastRound = null;
        }

        clone() {
            const g = new Engine({ n: this.n, seed: 0 });
            g.rng = this.rng;
            g.playerHand = this.playerHand.slice();
            g.aiHand = this.aiHand.slice();
            g.prizePile = this.prizePile.slice();
            g.pendingPrizes = this.pendingPrizes.slice();
            g.playerScore = this.playerScore;
            g.aiScore = this.aiScore;
            g.lastRound = this.lastRound ? { ...this.lastRound } : null;
            return g;
        }

        toJSON() {
            return {
                n: this.n,
                playerHand: this.playerHand.slice(),
                aiHand: this.aiHand.slice(),
                prizePile: this.prizePile.slice(),
                pendingPrizes: this.pendingPrizes.slice(),
                playerScore: this.playerScore,
                aiScore: this.aiScore,
                lastRound: this.lastRound,
            };
        }

        static fromJSON(data) {
            const g = new Engine({ n: data.n || 13 });
            g.playerHand = (data.playerHand || []).slice();
            g.aiHand = (data.aiHand || []).slice();
            g.prizePile = (data.prizePile || []).slice();
            g.pendingPrizes = (data.pendingPrizes || []).slice();
            g.playerScore = data.playerScore || 0;
            g.aiScore = data.aiScore || 0;
            g.lastRound = data.lastRound || null;
            return g;
        }

        pendingValue() {
            return this.pendingPrizes.reduce((sum, c) => sum + RANK_VALUE[c], 0);
        }

        formatPrize() {
            if (!this.pendingPrizes.length) return "";
            if (this.pendingPrizes.length === 1) return this.pendingPrizes[0];
            return this.pendingPrizes.join("+");
        }

        revealNextPrize() {
            if (this.prizePile.length === 0) return false;
            this.pendingPrizes.push(this.prizePile.shift());
            return true;
        }

        /** Heuristic “solver”: bid closest rank to current stake (prefer exact). */
        chooseAiBid() {
            const hand = this.aiHand;
            if (!hand.length) return null;
            const target = this.pendingValue() || 7;
            let best = hand[0];
            let bestDist = Math.abs(RANK_VALUE[best] - target);
            for (let i = 1; i < hand.length; i++) {
                const d = Math.abs(RANK_VALUE[hand[i]] - target);
                if (d < bestDist || (d === bestDist && RANK_VALUE[hand[i]] > RANK_VALUE[best])) {
                    best = hand[i];
                    bestDist = d;
                }
            }
            return best;
        }

        resolveRound(playerBid, aiBid) {
            if (!this.playerHand.includes(playerBid)) return null;
            if (!this.aiHand.includes(aiBid)) return null;

            const prize = this.formatPrize();
            const stake = this.pendingValue();

            this.playerHand = this.playerHand.filter((c) => c !== playerBid);
            this.aiHand = this.aiHand.filter((c) => c !== aiBid);

            const pv = RANK_VALUE[playerBid];
            const av = RANK_VALUE[aiBid];

            let winner = "tie";
            if (pv > av) {
                this.playerScore += stake;
                this.pendingPrizes = [];
                winner = "player";
            } else if (av > pv) {
                this.aiScore += stake;
                this.pendingPrizes = [];
                winner = "ai";
            }

            this.lastRound = { winner, stake, prize, playerBid, aiBid };
            return this.lastRound;
        }

        prepareNextPrize() {
            if (this.playerHand.length === 0) return false;
            if (this.pendingPrizes.length > 0) {
                if (this.prizePile.length > 0) this.revealNextPrize();
                return this.pendingPrizes.length > 0;
            }
            return this.revealNextPrize();
        }

        isFinished() {
            return this.playerHand.length === 0;
        }

        matchWinner() {
            if (!this.isFinished()) return null;
            if (this.playerScore > this.aiScore) return "P1";
            if (this.aiScore > this.playerScore) return "P2";
            return "draw";
        }
    }

    const api = {
        ALL_RANKS,
        RANK_VALUE,
        ranksForN,
        Engine,
        chooseAiBid: (eng) => eng.chooseAiBid(),
    };
    root.GopsEngine = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof self !== "undefined" ? self : this);
