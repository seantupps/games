"""
GOPS exact Nash (W–L) with rollover ties.

Payoffs: +1 win, 0 draw, -1 loss (P1 perspective).
Ties: pending prizes roll over.

DP hot path is Cython (``solve_value``) with a pure-Python fallback.
Matrix games use Numba (cached).

Optimizations (goofspiel-nash style, adapted to rollover):
  - relative-rank hand normalization in cache keys
  - hand-swap symmetry
  - |sd| vs remaining cutoffs
  - dominance pruning (exclusive high cards force top prizes)
  - k=1 closed form (never stored; bids are forced)

Usage:
  python build/gops/nash/solve_nash.py --N 5
  python build/gops/nash/solve_nash.py --N 6 --vs-random 200
  python build/gops/solve_nash.py --N 5          # root shim
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
from numba import njit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from matrix_game import matrix_game_strategy, matrix_game_value, warmup

# Packed key (N <= 13): pending == 0 ⇒ cold; `rest` is unrevealed prizes.
# Hands in the key are relative-rank normalized.

try:
    import solve_value as _cy  # type: ignore

    _USE_CYTHON = True
except ImportError:
    _cy = None  # type: ignore
    _USE_CYTHON = False


def _mask_sum(mask: int, n: int) -> int:
    """Sum of card ranks (bit_index+1) set in mask. `n` unused; kept for call sites."""
    if _USE_CYTHON:
        return int(_cy.mask_sum_py(mask, n))
    s = 0
    m = mask
    while m:
        bit = m & -m
        s += bit.bit_length()  # power-of-two bit → rank == bit_length
        m ^= bit
    return s


def _pack(h1: int, h2: int, rest: int, pending: int, sd: int) -> int:
    return h1 | (h2 << 13) | (rest << 26) | (pending << 39) | ((sd + 128) << 52)


def _terminal(sd: int) -> float:
    if sd > 0:
        return 1.0
    if sd < 0:
        return -1.0
    return 0.0


def _fill_bits(mask: int, n: int) -> list[int]:
    """Bits set in mask, low→high (for strategy API / rare paths)."""
    out: list[int] = []
    m = mask
    while m:
        bit = m & -m
        out.append(bit.bit_length() - 1)
        m ^= bit
    return out


@njit(cache=True)
def _normalize_hands_njit(h1: int, h2: int, n: int) -> tuple[int, int]:
    union = h1 | h2
    nh1 = 0
    nh2 = 0
    nb = 0
    for b in range(n):
        bit = 1 << b
        if union & bit:
            mapped = 1 << nb
            if h1 & bit:
                nh1 |= mapped
            if h2 & bit:
                nh2 |= mapped
            nb += 1
    return nh1, nh2


def _normalize_hands(h1: int, h2: int, n: int) -> tuple[int, int]:
    """
    Collapse gaps in ranks unused by either hand.
    Bid comparisons are order-isomorphic; prize stakes stay absolute in rest/pending.
    """
    if _USE_CYTHON:
        return _cy.normalize_hands_py(h1, h2, n)
    return _normalize_hands_njit(h1, h2, n)


@njit(cache=True)
def _sum_d_largest_njit(mask: int, n: int, d: int) -> int:
    if d <= 0:
        return 0
    s = 0
    taken = 0
    for b in range(n - 1, -1, -1):
        if (mask >> b) & 1:
            s += b + 1
            taken += 1
            if taken == d:
                break
    return s


def _sum_d_largest(mask: int, n: int, d: int) -> int:
    if _USE_CYTHON:
        return int(_cy.sum_d_largest_py(mask, n, d))
    return int(_sum_d_largest_njit(mask, n, d))


def _max_p2_net(
    h1: int, h2: int, rest: int, pending: int, n: int, memo: dict
) -> int:
    """
    Max of (points2 - points1) over every pure playout and every prize order.
    Independent of sd. Used for sound forced W–L without solving the LP.

    Hands are relative-rank normalized for memo sharing; stakes stay absolute.
    """
    nh1, nh2 = _normalize_hands(h1, h2, n)
    key = (nh1, nh2, rest, pending)
    hit = memo.get(key)
    if hit is not None:
        return hit

    if nh1 == 0:
        memo[key] = 0
        return 0

    if pending == 0:
        if rest == 0:
            memo[key] = 0
            return 0
        best = -10**9
        m = rest
        while m:
            bit = m & -m
            v = _max_p2_net(nh1, nh2, rest ^ bit, bit, n, memo)
            if v > best:
                best = v
            m ^= bit
        memo[key] = best
        return best

    stake = _mask_sum(pending, n)
    best = -10**9
    m1 = nh1
    while m1:
        bit_i = m1 & -m1
        bi = bit_i.bit_length() - 1
        h1n = nh1 ^ bit_i
        vi = bi + 1
        m2 = nh2
        while m2:
            bit_j = m2 & -m2
            bj = bit_j.bit_length() - 1
            h2n = nh2 ^ bit_j
            vj = bj + 1
            if vi > vj:
                v = -stake + _max_p2_net(h1n, h2n, rest, 0, n, memo)
                if v > best:
                    best = v
            elif vi < vj:
                v = stake + _max_p2_net(h1n, h2n, rest, 0, n, memo)
                if v > best:
                    best = v
            elif rest == 0:
                if 0 > best:
                    best = 0
            else:
                rm = rest
                while rm:
                    pbit = rm & -rm
                    v = _max_p2_net(
                        h1n, h2n, rest ^ pbit, pending | pbit, n, memo
                    )
                    if v > best:
                        best = v
                    rm ^= pbit
            m2 ^= bit_j
        m1 ^= bit_i
    memo[key] = best
    return best


# Shared memo for extreme nets (Python fallback path only).
_NET_MEMO: dict[tuple[int, int, int, int], int] = {}
_NET_BOUNDS: dict[tuple[int, int, int, int], tuple[int, int]] = {}


def clear_dominance_memos() -> None:
    if _USE_CYTHON:
        _cy.clear_dominance_memos()
    _NET_MEMO.clear()
    _NET_BOUNDS.clear()


def _net_bounds(h1: int, h2: int, rest: int, pending: int, n: int) -> tuple[int, int]:
    if _USE_CYTHON:
        return _cy.net_bounds_py(h1, h2, rest, pending, n)
    nh1, nh2 = _normalize_hands(h1, h2, n)
    key = (nh1, nh2, rest, pending)
    hit = _NET_BOUNDS.get(key)
    if hit is not None:
        return hit
    m = _max_p2_net(nh1, nh2, rest, pending, n, _NET_MEMO)
    m_swap = _max_p2_net(nh2, nh1, rest, pending, n, _NET_MEMO)
    _NET_BOUNDS[key] = (m, m_swap)
    return m, m_swap


def _forced_wl(
    h1: int, h2: int, rem_mask: int, n: int, sd: int,
    *, rest: int | None = None, pending: int | None = None,
) -> float | None:
    """
    Return +1 / 0 / -1 if W–L is decided under every pure playout; else None.

    Layer 1 — score + card dominance (goofspiel-nash style):
      d cards > opp max guarantee the d largest prizes.
    Layer 2 — achievable-net bound (sound, no LP; only when rem hand <= 4):
      M = max (p2-p1) over all pure bids and prize orders.
      If sd > M then every playout is a P1 win; if sd < -M_swap then every
      playout is a P1 loss. Skipped at rem>=5 (exact via LP; nets too costly).
    """
    if _USE_CYTHON:
        return _cy.forced_wl_py(h1, h2, rem_mask, n, sd, rest, pending)

    rem = _mask_sum(rem_mask, n)
    if sd > rem:
        return 1.0
    if sd < -rem:
        return -1.0
    if rem == 0:
        return _terminal(sd)

    if h1 == 0 or h2 == 0:
        return _terminal(sd)

    my_max = h1.bit_length() - 1
    opp_max = h2.bit_length() - 1
    my_dom = 0
    m = h1
    while m:
        bit = m & -m
        if bit.bit_length() - 1 > opp_max:
            my_dom += 1
        m ^= bit
    opp_dom = 0
    m = h2
    while m:
        bit = m & -m
        if bit.bit_length() - 1 > my_max:
            opp_dom += 1
        m ^= bit

    g1 = _sum_d_largest(rem_mask, n, my_dom) if my_dom else 0
    g2 = _sum_d_largest(rem_mask, n, opp_dom) if opp_dom else 0
    lo = sd + 2 * g1 - rem
    hi = sd + rem - 2 * g2
    if lo > 0:
        return 1.0
    if hi < 0:
        return -1.0
    if lo == 0 and hi == 0:
        return 0.0

    if rest is None or pending is None:
        return None
    if h1.bit_count() > 4:
        return None

    m_net, m_swap = _net_bounds(h1, h2, rest, pending, n)
    if sd > m_net:
        return 1.0
    if sd < -m_swap:
        return -1.0
    if m_net == -m_swap and sd == m_net:
        return 0.0
    return None


def _only_bit(mask: int, n: int) -> int:
    for b in range(n):
        if mask & (1 << b):
            return b
    return -1


def _value_k1(h1: int, h2: int, rest: int, pending: int, sd: int, n: int) -> float:
    """
    Closed-form W–L when each player has one card left (no strategic choice).
    Not stored in the lookup table.
    """
    if _USE_CYTHON:
        return float(_cy.value_k1_py(h1, h2, rest, pending, sd, n))

    b1 = _only_bit(h1, n)
    b2 = _only_bit(h2, n)
    v1, v2 = b1 + 1, b2 + 1

    if pending == 0:
        # Cold: average over revealing each remaining prize, then forced bids.
        total = 0.0
        cnt = 0
        for b in range(n):
            bit = 1 << b
            if rest & bit:
                total += _value_k1(h1, h2, rest ^ bit, bit, sd, n)
                cnt += 1
        return total / cnt if cnt else _terminal(sd)

    stake = _mask_sum(pending, n)
    if v1 > v2:
        return _terminal(sd + stake)
    if v1 < v2:
        return _terminal(sd - stake)
    # Tie: rollover — if nothing left to flip, prize is unclaimed.
    if rest == 0:
        return _terminal(sd)
    total = 0.0
    cnt = 0
    for b in range(n):
        bit = 1 << b
        if rest & bit:
            total += _value_k1(h1, h2, rest ^ bit, pending | bit, sd, n)
            cnt += 1
    return total / cnt


class GopsNashSolver:
    def __init__(self, n: int):
        if n < 1 or n > 13:
            raise ValueError("N must be in 1..13")
        self.n = n
        self.full = (1 << n) - 1
        if _USE_CYTHON:
            self._cache = _cy.FloatMap()
            self.forced_cache = _cy.FloatMap()
        else:
            self._cache = {}
            self.forced_cache = {}
        self.cache_size = 0
        self.value: float | None = None

    @property
    def cache(self):
        return self._cache

    @cache.setter
    def cache(self, mapping) -> None:
        """Accept dict or FloatMap (build/load paths often assign a plain dict)."""
        if _USE_CYTHON:
            if isinstance(mapping, _cy.FloatMap):
                self._cache = mapping
            else:
                self._cache = _cy.FloatMap(mapping)
        else:
            self._cache = dict(mapping)

    def _value(self, h1: int, h2: int, rest: int, pending: int, sd: int) -> float:
        if _USE_CYTHON:
            return float(
                _cy.value(
                    self.n, self._cache, self.forced_cache, h1, h2, rest, pending, sd
                )
            )
        return self._value_py(h1, h2, rest, pending, sd)

    def _value_py(self, h1: int, h2: int, rest: int, pending: int, sd: int) -> float:
        n = self.n
        cache = self.cache
        forced_cache = self.forced_cache

        # k=1: closed form, never memoized (no choice; W–L is exact).
        if h1.bit_count() == 1:
            return _value_k1(h1, h2, rest, pending, sd, n)

        # Canonical key: normalize ranks, then fold hand-swap / sd-mirror
        # into a sign (avoids a bounce recursion).
        sign = 1.0
        nh1, nh2 = _normalize_hands(h1, h2, n)
        if nh1 > nh2:
            h1, h2 = h2, h1
            nh1, nh2 = nh2, nh1
            sd = -sd
            sign = -1.0

        if nh1 == nh2:
            if sd == 0:
                return 0.0
            if sd < 0:
                sd = -sd
                sign = -sign

        key = _pack(nh1, nh2, rest, pending, sd)
        hit = cache.get(key)
        if hit is not None:
            return sign * hit
        fhit = forced_cache.get(key)
        if fhit is not None:
            return sign * fhit

        # Dominance / nets use the (possibly swapped) absolute hands so that
        # prize ranks stay consistent with the bid ranks after the fold.
        rem_mask = rest if pending == 0 else (rest | pending)
        forced = _forced_wl(h1, h2, rem_mask, n, sd, rest=rest, pending=pending)
        if forced is not None:
            forced_cache[key] = forced
            return sign * forced

        if pending == 0:
            if h1 == 0:
                v = _terminal(sd)
                cache[key] = v
                return sign * v

            total = 0.0
            cnt = 0
            prizes = rest
            while prizes:
                bit = prizes & -prizes
                total += self._value_py(h1, h2, rest ^ bit, bit, sd)
                cnt += 1
                prizes ^= bit
            v = total / cnt
            cache[key] = v
            return sign * v

        km = h1.bit_count()
        ko = h2.bit_count()
        stake = _mask_sum(pending, n)
        payoff = np.empty((km, ko), np.float64)

        i = 0
        m1 = h1
        while m1:
            bit_i = m1 & -m1
            bi = bit_i.bit_length() - 1
            h1n = h1 ^ bit_i
            vi = bi + 1
            j = 0
            m2 = h2
            while m2:
                bit_j = m2 & -m2
                bj = bit_j.bit_length() - 1
                h2n = h2 ^ bit_j
                vj = bj + 1
                if vi != vj:
                    sdn = sd + stake if vi > vj else sd - stake
                    payoff[i, j] = self._value_py(h1n, h2n, rest, 0, sdn)
                else:
                    if rest == 0:
                        payoff[i, j] = _terminal(sd)
                    else:
                        acc = 0.0
                        cnt = 0
                        rm = rest
                        while rm:
                            pbit = rm & -rm
                            acc += self._value_py(
                                h1n, h2n, rest ^ pbit, pending | pbit, sd
                            )
                            cnt += 1
                            rm ^= pbit
                        payoff[i, j] = acc / cnt
                j += 1
                m2 ^= bit_j
            i += 1
            m1 ^= bit_i

        v = float(matrix_game_value(payoff))
        cache[key] = v
        return sign * v

    def opening_value(self) -> float:
        self.cache.clear()
        self.forced_cache.clear()
        clear_dominance_memos()
        full = self.full
        total = 0.0
        for b in range(self.n):
            bit = 1 << b
            total += self._value(full, full, full ^ bit, bit, 0)
        self.value = total / self.n
        self.cache_size = len(self.cache)
        return self.value

    def strategy(self, h1: int, h2: int, rest: int, pending: int, sd: int):
        # Do not call opening_value() here. Endgame table loads keep cache empty
        # (values live in piecewise/plateaus); opening_value() would clear those
        # memos and make every bid fall back to a broken pure strategy.
        n = self.n
        my_bits = _fill_bits(h1, n)
        k = len(my_bits)
        probs = np.zeros(k, dtype=np.float64)

        if k == 1:
            probs[0] = 1.0
            return _value_k1(h1, h2, rest, pending, sd, n), probs, my_bits

        # Do not short-circuit on forced_wl: that bound is for VALUE under
        # optimal play (e.g. one dominating card guarantees a win), not "any
        # card works". Returning probs[0]=1 played the lowest card and looked
        # awful whenever a higher card was the forcing move.

        opp_bits = _fill_bits(h2, n)
        ko = len(opp_bits)
        stake = _mask_sum(pending, n)
        payoff = np.empty((k, ko), np.float64)

        for i, bi in enumerate(my_bits):
            vi = bi + 1
            h1n = h1 ^ (1 << bi)
            for j, bj in enumerate(opp_bits):
                vj = bj + 1
                h2n = h2 ^ (1 << bj)
                if vi != vj:
                    sdn = sd + stake if vi > vj else sd - stake
                    payoff[i, j] = self._value(h1n, h2n, rest, 0, sdn)
                else:
                    if rest == 0:
                        payoff[i, j] = _terminal(sd)
                    else:
                        acc = 0.0
                        cnt = 0
                        for pb in range(n):
                            pbit = 1 << pb
                            if rest & pbit:
                                acc += self._value(
                                    h1n, h2n, rest ^ pbit, pending | pbit, sd
                                )
                                cnt += 1
                        payoff[i, j] = acc / cnt

        value, row = matrix_game_strategy(payoff)
        probs[:] = row
        return float(value), probs, my_bits


def card_value(bit: int) -> int:
    return bit + 1


def mask_bits(mask: int, n: int) -> list[int]:
    return _fill_bits(mask, n)


def popcount(mask: int) -> int:
    return mask.bit_count()


def terminal_wl(sd: int) -> float:
    return _terminal(sd)


def verify_matrix_game() -> None:
    assert abs(matrix_game_value(np.array([[1.0, -1.0], [-1.0, 1.0]]))) < 1e-6
    assert abs(matrix_game_value(np.array([[2.0, 1.0], [0.0, -1.0]])) - 1.0) < 1e-6
    M3 = np.array([[0.0, -1.0, 1.0], [1.0, 0.0, -1.0], [-1.0, 1.0, 0.0]])
    assert abs(matrix_game_value(M3)) < 1e-5


def sample_play_vs_random(solver: GopsNashSolver, games: int, seed: int = 0) -> float:
    rng = np.random.default_rng(seed)
    n, full = solver.n, solver.full
    total = 0.0
    for _ in range(games):
        h1 = h2 = full
        pile = list(range(n))
        rng.shuffle(pile)
        pending: list[int] = []
        sd = 0
        while popcount(h1) > 0:
            if not pending:
                if not pile:
                    break
                pending.append(pile.pop(0))
            rest_mask = 0
            for b in pile:
                rest_mask |= 1 << b
            pend_mask = 0
            for b in pending:
                pend_mask |= 1 << b
            _, probs, my_bits = solver.strategy(h1, h2, rest_mask, pend_mask, sd)
            bi = my_bits[int(rng.choice(len(my_bits), p=probs))]
            bj = int(rng.choice(mask_bits(h2, n)))
            stake = sum(card_value(b) for b in pending)
            vi, vj = card_value(bi), card_value(bj)
            h1 ^= 1 << bi
            h2 ^= 1 << bj
            if vi > vj:
                sd += stake
                pending.clear()
            elif vi < vj:
                sd -= stake
                pending.clear()
            elif pile:
                pending.append(pile.pop(0))
            else:
                pending.clear()
        total += terminal_wl(sd)
    return total / games


def main() -> None:
    parser = argparse.ArgumentParser(description="GOPS W–L Nash solver (rollover)")
    parser.add_argument("--N", type=int, default=5)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--vs-random", type=int, default=0)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    if args.N < 1 or args.N > 13:
        raise SystemExit("N must be in 1..13")

    print("Warming up numba…", flush=True)
    t0 = time.perf_counter()
    warmup()
    verify_matrix_game()
    print(f"  ready ({time.perf_counter() - t0:.2f}s)", flush=True)

    if args.verify:
        for n in range(1, 6):
            v = GopsNashSolver(n).opening_value()
            assert abs(v) < 1e-5, (n, v)
            print(f"  N={n} ok value={v:+.2e}", flush=True)

    print(f"Solving N={args.N} (W–L, rollover)…", flush=True)
    print(f"  cython hot path: {_USE_CYTHON}", flush=True)
    t1 = time.perf_counter()
    solver = GopsNashSolver(args.N)
    value = solver.opening_value()
    elapsed = time.perf_counter() - t1
    print(f"  opening value (P1): {value:+.6f}", flush=True)
    print(f"  cached states: {solver.cache_size}", flush=True)
    print(f"  time: {elapsed:.2f}s", flush=True)
    if abs(value) > 1e-4:
        print("  warning: opening value should be ~0 by symmetry", flush=True)

    if args.vs_random > 0:
        t2 = time.perf_counter()
        mean = sample_play_vs_random(solver, args.vs_random, seed=args.seed)
        print(f"  vs random mean: {mean:+.4f} ({time.perf_counter() - t2:.2f}s)", flush=True)


if __name__ == "__main__":
    main()
