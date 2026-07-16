"""
Reference: GOPS / Goofspiel state-space counts.

Reproduces goofspiel-nash original/optimized formulas and compares to
our opening-reachable memos (rollover + discard-tie variants).

Source formulas: https://github.com/ollijarviniemi/goofspiel-nash
  solver_optimized.py → compute_all_values()

Usage:
  python build/gops/ref/count_states.py
  python build/gops/ref/count_states.py --N 8
  python build/gops/ref/count_states.py --ours-to 6
"""

from __future__ import annotations

import argparse
import sys
import time
from itertools import combinations
from math import comb
from pathlib import Path

# Allow importing our nash solver when counting reachable memos.
_NASH = Path(__file__).resolve().parents[1] / "nash"
if str(_NASH) not in sys.path:
    sys.path.insert(0, str(_NASH))


# --- goofspiel-nash card normalization (reference) ---


def enumerate_normalized_card_configs(
    k: int, N: int
) -> list[tuple[tuple[int, ...], tuple[int, ...]]]:
    """
    Normalized (my_cards, opp_cards) after gap-removal.
    Hands together use values {1..m} for some m in [k, min(2k, N)].
    """
    configs: list[tuple[tuple[int, ...], tuple[int, ...]]] = []
    for m in range(k, min(2 * k, N) + 1):
        c = 2 * k - m  # shared values
        if c < 0 or c > k:
            continue
        values = list(range(1, m + 1))
        for shared in combinations(values, c):
            exclusive = [v for v in values if v not in set(shared)]
            num_exclusive_each = m - k
            if num_exclusive_each == 0:
                configs.append((tuple(sorted(shared)), tuple(sorted(shared))))
            else:
                for my_exclusive in combinations(exclusive, num_exclusive_each):
                    my_set = set(my_exclusive)
                    opp_exclusive = [v for v in exclusive if v not in my_set]
                    my_cards = tuple(sorted(set(shared) | my_set))
                    opp_cards = tuple(sorted(set(shared) | set(opp_exclusive)))
                    configs.append((my_cards, opp_cards))
    return configs


def get_canonical_card_configs(
    k: int, N: int
) -> list[tuple[tuple[int, ...], tuple[int, ...]]]:
    """Canonical hand pairs with my_cards <= opp_cards (lex)."""
    seen: set[tuple[tuple[int, ...], tuple[int, ...]]] = set()
    out: list[tuple[tuple[int, ...], tuple[int, ...]]] = []
    for my_cards, opp_cards in enumerate_normalized_card_configs(k, N):
        key = (my_cards, opp_cards) if my_cards <= opp_cards else (opp_cards, my_cards)
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def their_original_states(N: int, max_k: int | None = None) -> int:
    """
    goofspiel-nash 'original_states':
      sum_{k=1..max_k} C(N,k)^3 * (2*(S - k(k+1)/2) + 1)
    """
    if max_k is None:
        max_k = N
    S = N * (N + 1) // 2
    return sum(
        comb(N, k) ** 3 * (2 * (S - k * (k + 1) // 2) + 1)
        for k in range(1, max_k + 1)
    )


def their_optimized_states(N: int, max_k: int | None = None) -> int:
    """
    goofspiel-nash 'optimized_states' estimate used in metadata:
      sum_k n_canonical_configs * C(N,k) * avg_score_range
    """
    if max_k is None:
        max_k = N
    total = 0
    S = N * (N + 1) // 2
    for k in range(1, max_k + 1):
        n_configs = len(get_canonical_card_configs(k, N))
        n_prizes = comb(N, k)
        min_remaining = k * (k + 1) // 2
        max_remaining = S - (N - k) * (N - k + 1) // 2
        avg_bound = (min_remaining + max_remaining) // 2
        avg_score_range = 2 * min(S - avg_bound, avg_bound) + 1
        total += n_configs * n_prizes * avg_score_range
    return total


def naive_sum_binom_cubed(N: int) -> int:
    return sum(comb(N, k) ** 3 for k in range(N + 1))


# --- reachable exploration (no LP solves) ---


def _popcnt(x: int) -> int:
    return x.bit_count()


def _mask_sum(mask: int, n: int) -> int:
    s = 0
    for b in range(n):
        if (mask >> b) & 1:
            s += b + 1
    return s


def _pack(h1: int, h2: int, rest: int, pending: int, sd: int) -> int:
    return h1 | (h2 << 13) | (rest << 26) | (pending << 39) | ((sd + 128) << 52)


def _fill_bits(mask: int, n: int) -> list[int]:
    return [b for b in range(n) if mask & (1 << b)]


def count_reachable(n: int, *, rollover: bool) -> int:
    """
    Opening-reachable packed keys with hand symmetry h1 <= h2.
    rollover=True  → equal bids stack pending (our rules)
    rollover=False → equal bids discard prize, return to cold
    """
    seen: set[int] = set()
    stack: list[tuple[int, int, int, int, int]] = []

    def push(h1: int, h2: int, rest: int, pending: int, sd: int) -> None:
        if h1 > h2:
            h1, h2, sd = h2, h1, -sd
        key = _pack(h1, h2, rest, pending, sd)
        if key in seen:
            return
        seen.add(key)
        stack.append((h1, h2, rest, pending, sd))

    full = (1 << n) - 1
    for b in range(n):
        bit = 1 << b
        push(full, full, full ^ bit, bit, 0)

    while stack:
        h1, h2, rest, pending, sd = stack.pop()
        if pending == 0:
            prizes = rest
            k = _popcnt(h1)
            rem = _mask_sum(prizes, n)
            if sd > rem or sd < -rem or k == 0:
                continue
            for b in range(n):
                bit = 1 << b
                if prizes & bit:
                    push(h1, h2, prizes ^ bit, bit, sd)
            continue

        k = _popcnt(h1)
        rem = _mask_sum(rest, n) + _mask_sum(pending, n)
        if sd > rem or sd < -rem:
            continue
        stake = _mask_sum(pending, n)
        for bi in _fill_bits(h1, n):
            vi = bi + 1
            h1n = h1 ^ (1 << bi)
            for bj in _fill_bits(h2, n):
                vj = bj + 1
                h2n = h2 ^ (1 << bj)
                if vi != vj:
                    sdn = sd + stake if vi > vj else sd - stake
                    if k == 1:
                        continue
                    push(h1n, h2n, rest, 0, sdn)
                elif rollover:
                    if rest == 0:
                        continue
                    for pb in range(n):
                        pbit = 1 << pb
                        if rest & pbit:
                            push(h1n, h2n, rest ^ pbit, pending | pbit, sd)
                else:
                    # discard-on-tie
                    if k == 1:
                        continue
                    push(h1n, h2n, rest, 0, sd)

    return len(seen)


def count_ours_memo(n: int) -> tuple[float, int]:
    """Actual solve_nash.py cache size (runs the DP)."""
    from solve_nash import GopsNashSolver

    s = GopsNashSolver(n)
    v = s.opening_value()
    return v, s.cache_size


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--N", type=int, default=8, help="print their counts up to N")
    ap.add_argument(
        "--ours-to",
        type=int,
        default=0,
        help="also count opening-reachable (rollover+discard) up to this N",
    )
    ap.add_argument(
        "--solve-to",
        type=int,
        default=0,
        help="also run our real solver memo sizes up to this N (slower)",
    )
    args = ap.parse_args()

    print("goofspiel-nash formulas (verify N=5 -> 49001 / 4226, N=8 -> 38639417 / 1246443)")
    print(f"{'N':>3} {'original':>16} {'optimized':>14} {'sum C(N,k)^3':>14}")
    for n in range(1, args.N + 1):
        o = their_original_states(n)
        z = their_optimized_states(n)
        print(f"{n:3d} {o:16,d} {z:14,d} {naive_sum_binom_cubed(n):14,d}")

    if args.ours_to > 0:
        print()
        print("Opening-reachable (no LP):")
        print(f"{'N':>3} {'rollover':>12} {'discard':>12}")
        for n in range(1, args.ours_to + 1):
            t0 = time.perf_counter()
            r = count_reachable(n, rollover=True)
            d = count_reachable(n, rollover=False)
            print(
                f"{n:3d} {r:12,d} {d:12,d}  ({time.perf_counter() - t0:.2f}s)",
                flush=True,
            )

    if args.solve_to > 0:
        from matrix_game import warmup
        from solve_nash import GopsNashSolver

        print()
        print("Our solver memo (rollover DP):")
        warmup()
        for n in range(1, args.solve_to + 1):
            s = GopsNashSolver(n)
            v = s.opening_value()
            print(f"  N={n} value={v:+.3e} states={s.cache_size:,}", flush=True)


if __name__ == "__main__":
    main()
