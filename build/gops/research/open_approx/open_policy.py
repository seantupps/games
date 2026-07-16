"""
Open-game (rem > K_exact) policies for GOPS W–L.

Exact Nash stays for rem <= K_exact. Above that we solve a truncated
Ross/Rhoads matrix recursion: depth-d open with a cheap leaf at the
horizon.

Leaves:
  score / tight — Layer-1 + tanh (pure Python; microseconds)
  rollout — strength-biased Monte Carlo (Numba)

Research parking: ``research/open_approx/``. Measure with
``research/open_approx/scripts/eval_open_pareto.py``.
"""

from __future__ import annotations

import math
from typing import Callable

import numpy as np
from numba import njit

from matrix_game import matrix_game_strategy
from solve_nash import (
    _fill_bits,
    _forced_wl,
    _mask_sum,
    _sum_d_largest,
    _terminal,
)


def _rem_mask(rest: int, pending: int) -> int:
    return rest if pending == 0 else (rest | pending)


def leaf_score_wl(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    *,
    temp: float = 1.0,
) -> float:
    rem_m = _rem_mask(rest, pending)
    rem = _mask_sum(rem_m, n)
    if rem == 0:
        return _terminal(sd)
    if sd > rem:
        return 1.0
    if sd < -rem:
        return -1.0
    forced = _forced_wl(h1, h2, rem_m, n, sd, rest=None, pending=None)
    if forced is not None:
        return float(forced)
    x = sd / max(rem, 1)
    if temp <= 0:
        return max(-1.0, min(1.0, x))
    return math.tanh(x / temp)


def leaf_tight_wl(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
) -> float:
    rem_m = _rem_mask(rest, pending)
    rem = _mask_sum(rem_m, n)
    if rem == 0:
        return _terminal(sd)
    forced = _forced_wl(h1, h2, rem_m, n, sd, rest=None, pending=None)
    if forced is not None:
        return float(forced)
    my_max = h1.bit_length() - 1 if h1 else -1
    opp_max = h2.bit_length() - 1 if h2 else -1
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
    g1 = _sum_d_largest(rem_m, n, my_dom) if my_dom else 0
    g2 = _sum_d_largest(rem_m, n, opp_dom) if opp_dom else 0
    soft = max(rem - g1 - g2, 1)
    return math.tanh(sd / soft)


@njit(cache=True)
def _mask_sum_n(mask: int) -> int:
    s = 0
    m = mask
    while m:
        bit = m & -m
        b = 0
        t = bit
        while t > 1:
            t >>= 1
            b += 1
        s += b + 1
        m ^= bit
    return s


@njit(cache=True)
def _terminal_n(sd: int) -> float:
    if sd > 0:
        return 1.0
    if sd < 0:
        return -1.0
    return 0.0


@njit(cache=True)
def _fill_bits_n(mask: int, n: int, out: np.ndarray) -> int:
    k = 0
    for b in range(n):
        if mask & (1 << b):
            out[k] = b
            k += 1
    return k


@njit(cache=True)
def _bid_weight(val: int, stake: int, mode: int) -> int:
    """Integer weight for sampling a bid of face value ``val``."""
    if mode == 0:
        # strength-biased
        return val
    # stake-match (Rhoads-ish): prefer cards near stake; parity bonus
    d = val - stake
    if d < 0:
        d = -d
    w = 100 // (1 + d)
    if w < 1:
        w = 1
    if stake >= 6 and (val & 1) == (stake & 1):
        w = (w * 3) // 2
        if w < 1:
            w = 1
    return w


@njit(cache=True)
def _rollout_mean(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    sims: int,
    seed: int,
    mode: int = 0,
) -> float:
    rem = rest if pending == 0 else (rest | pending)
    rem_sum = _mask_sum_n(rem)
    if rem_sum == 0:
        return _terminal_n(sd)
    if sd > rem_sum:
        return 1.0
    if sd < -rem_sum:
        return -1.0

    bits_buf = np.empty(13, dtype=np.int64)
    bits2 = np.empty(13, dtype=np.int64)
    state = np.uint64(
        seed
        ^ (h1 * 0x9E3779B97F4A7C15)
        ^ ((h2 << 1) & 0xFFFFFFFFFFFFFFFF)
        ^ rest
        ^ pending
        ^ ((sd + 128) << 16)
        ^ (mode * 0xD1B54A32D192ED03)
    )
    if state == 0:
        state = np.uint64(0xDEADBEEF)

    total = 0.0
    for _s in range(sims):
        cur_sd = sd
        cur_h1 = h1
        cur_h2 = h2
        cur_rest = rest
        cur_pend = pending
        while cur_h1 != 0 and cur_h2 != 0:
            if cur_pend == 0:
                nb = _fill_bits_n(cur_rest, n, bits_buf)
                if nb == 0:
                    break
                state ^= state >> np.uint64(12)
                state ^= state << np.uint64(25)
                state ^= state >> np.uint64(27)
                r = state * np.uint64(0x2545F4914F6CDD1D)
                idx = int(r % np.uint64(nb))
                pb = int(bits_buf[idx])
                cur_rest ^= 1 << pb
                cur_pend = 1 << pb

            stake = _mask_sum_n(cur_pend)
            n1 = _fill_bits_n(cur_h1, n, bits_buf)
            n2 = _fill_bits_n(cur_h2, n, bits2)
            sum1 = 0
            for i in range(n1):
                sum1 += _bid_weight(int(bits_buf[i]) + 1, stake, mode)
            sum2 = 0
            for j in range(n2):
                sum2 += _bid_weight(int(bits2[j]) + 1, stake, mode)
            if sum1 < 1:
                sum1 = 1
            if sum2 < 1:
                sum2 = 1
            state ^= state >> np.uint64(12)
            state ^= state << np.uint64(25)
            state ^= state >> np.uint64(27)
            r1 = int((state * np.uint64(0x2545F4914F6CDD1D)) % np.uint64(sum1))
            state ^= state >> np.uint64(12)
            state ^= state << np.uint64(25)
            state ^= state >> np.uint64(27)
            r2 = int((state * np.uint64(0x2545F4914F6CDD1D)) % np.uint64(sum2))
            bi = 0
            acc = 0
            for i in range(n1):
                acc += _bid_weight(int(bits_buf[i]) + 1, stake, mode)
                if r1 < acc:
                    bi = int(bits_buf[i])
                    break
            bj = 0
            acc = 0
            for j in range(n2):
                acc += _bid_weight(int(bits2[j]) + 1, stake, mode)
                if r2 < acc:
                    bj = int(bits2[j])
                    break
            cur_h1 ^= 1 << bi
            cur_h2 ^= 1 << bj
            if bi != bj:
                cur_sd += stake if bi > bj else -stake
                cur_pend = 0
            elif cur_rest == 0:
                cur_pend = 0
                break
            else:
                nb = _fill_bits_n(cur_rest, n, bits_buf)
                state ^= state >> np.uint64(12)
                state ^= state << np.uint64(25)
                state ^= state >> np.uint64(27)
                r = state * np.uint64(0x2545F4914F6CDD1D)
                pb = int(bits_buf[int(r % np.uint64(nb))])
                cur_rest ^= 1 << pb
                cur_pend |= 1 << pb
        total += _terminal_n(cur_sd)
    return total / sims


@njit(cache=True)
def _open_payoff_rollout(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    my_bits: np.ndarray,
    opp_bits: np.ndarray,
    sims: int,
    seed: int,
    mode: int = 0,
) -> np.ndarray:
    k = my_bits.shape[0]
    ko = opp_bits.shape[0]
    payoff = np.empty((k, ko), dtype=np.float64)
    stake = _mask_sum_n(pending)
    for i in range(k):
        bi = int(my_bits[i])
        vi = bi + 1
        h1n = h1 ^ (1 << bi)
        for j in range(ko):
            bj = int(opp_bits[j])
            vj = bj + 1
            h2n = h2 ^ (1 << bj)
            if vi != vj:
                sdn = sd + stake if vi > vj else sd - stake
                payoff[i, j] = _rollout_mean(
                    h1n, h2n, rest, 0, sdn, n, sims, seed + i * 64 + j, mode
                )
            elif rest == 0:
                payoff[i, j] = _terminal_n(sd)
            else:
                acc = 0.0
                cnt = 0
                rm = rest
                while rm:
                    pbit = rm & -rm
                    pb = 0
                    t = pbit
                    while t > 1:
                        t >>= 1
                        pb += 1
                    acc += _rollout_mean(
                        h1n,
                        h2n,
                        rest ^ pbit,
                        pending | pbit,
                        sd,
                        n,
                        sims,
                        seed + i * 64 + j + pb * 3,
                        mode,
                    )
                    cnt += 1
                    rm ^= pbit
                payoff[i, j] = acc / cnt
    return payoff


def _leaf_value(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    leaf: str,
    temp: float,
    sims: int,
) -> float:
    if leaf == "rollout":
        return float(_rollout_mean(h1, h2, rest, pending, sd, n, sims, 0, 0))
    if leaf == "rollmatch":
        return float(_rollout_mean(h1, h2, rest, pending, sd, n, sims, 0, 1))
    if leaf == "tight":
        return leaf_tight_wl(h1, h2, rest, pending, sd, n)
    if leaf == "mlp":
        from leaf_mlp import leaf_mlp_wl

        return leaf_mlp_wl(h1, h2, rest, pending, sd, n)
    if leaf == "mlp_blend":
        from leaf_mlp import leaf_mlp_wl

        r = float(_rollout_mean(h1, h2, rest, pending, sd, n, sims, 0, 0))
        g = leaf_mlp_wl(h1, h2, rest, pending, sd, n)
        return 0.5 * (r + g)
    if leaf == "reg":
        from leaf_reg import get_weights, leaf_reg_wl

        return leaf_reg_wl(h1, h2, rest, pending, sd, n, get_weights())
    if leaf == "blend":
        from leaf_reg import get_weights, leaf_reg_wl

        r = float(_rollout_mean(h1, h2, rest, pending, sd, n, sims, 0, 0))
        g = leaf_reg_wl(h1, h2, rest, pending, sd, n, get_weights())
        return 0.5 * (r + g)
    return leaf_score_wl(h1, h2, rest, pending, sd, n, temp=temp)


def _open_payoff_mlp(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    *,
    blend_sims: int = 0,
) -> tuple[np.ndarray, list[int]]:
    """Depth-1 payoff matrix with batched MLP leaf (optional rollout blend)."""
    from leaf_mlp import leaf_mlp_batch

    my_bits = _fill_bits(h1, n)
    opp_bits = _fill_bits(h2, n)
    k, ko = len(my_bits), len(opp_bits)
    stake = _mask_sum(pending, n)
    # Flatten unique child states for batch predict
    child_keys: list[tuple[int, int, int, int, int]] = []
    cell_refs: list[list[int]] = []  # per (i,j): indices into child_keys
    for i, bi in enumerate(my_bits):
        vi = bi + 1
        h1n = h1 ^ (1 << bi)
        for j, bj in enumerate(opp_bits):
            vj = bj + 1
            h2n = h2 ^ (1 << bj)
            refs: list[int] = []
            if vi != vj:
                sdn = sd + stake if vi > vj else sd - stake
                refs.append(len(child_keys))
                child_keys.append((h1n, h2n, rest, 0, sdn))
            elif rest == 0:
                refs.append(-1)  # terminal marker
            else:
                rm = rest
                while rm:
                    pbit = rm & -rm
                    refs.append(len(child_keys))
                    child_keys.append(
                        (h1n, h2n, rest ^ pbit, pending | pbit, sd)
                    )
                    rm ^= pbit
            cell_refs.append(refs)

    vals = (
        leaf_mlp_batch(child_keys, n)
        if child_keys
        else np.zeros(0, dtype=np.float64)
    )
    if blend_sims > 0 and child_keys:
        rolls = np.array(
            [
                float(
                    _rollout_mean(
                        a, b, r, p, s, n, blend_sims, idx, 0
                    )
                )
                for idx, (a, b, r, p, s) in enumerate(child_keys)
            ],
            dtype=np.float64,
        )
        vals = 0.5 * (vals + rolls)

    payoff = np.empty((k, ko), np.float64)
    c = 0
    for i, bi in enumerate(my_bits):
        for j, bj in enumerate(opp_bits):
            refs = cell_refs[c]
            c += 1
            if refs == [-1]:
                payoff[i, j] = _terminal(sd)
            elif len(refs) == 1:
                payoff[i, j] = vals[refs[0]]
            else:
                payoff[i, j] = float(np.mean([vals[r] for r in refs]))
    return payoff, my_bits


def _build_payoff(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    child_value: Callable[[int, int, int, int, int], float],
) -> tuple[np.ndarray, list[int], list[int]]:
    my_bits = _fill_bits(h1, n)
    opp_bits = _fill_bits(h2, n)
    k, ko = len(my_bits), len(opp_bits)
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
                payoff[i, j] = child_value(h1n, h2n, rest, 0, sdn)
            elif rest == 0:
                payoff[i, j] = _terminal(sd)
            else:
                acc = 0.0
                cnt = 0
                rm = rest
                while rm:
                    pbit = rm & -rm
                    acc += child_value(
                        h1n, h2n, rest ^ pbit, pending | pbit, sd
                    )
                    cnt += 1
                    rm ^= pbit
                payoff[i, j] = acc / cnt
    return payoff, my_bits, opp_bits


def open_value(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    *,
    depth: int = 1,
    leaf: str = "score",
    temp: float = 1.0,
    sims: int = 48,
    cache: dict | None = None,
) -> float:
    """
    Surrogate game value with ``depth`` matrix-game plies then ``leaf``.

    depth=0 → leaf only; depth=1 → one Nash matrix with leaf children.
    """
    if depth < 0:
        raise ValueError("depth must be >= 0")
    if cache is None:
        cache = {}
    key = (h1, h2, rest, pending, sd, depth, leaf, temp, sims)
    hit = cache.get(key)
    if hit is not None:
        return hit

    if depth == 0:
        v = _leaf_value(h1, h2, rest, pending, sd, n, leaf, temp, sims)
        cache[key] = v
        return v

    my_bits = _fill_bits(h1, n)
    if not my_bits:
        v = _terminal(sd)
        cache[key] = float(v)
        return float(v)

    # Fast path: depth-1 rollout / MLP matrix.
    if depth == 1 and leaf in ("rollout", "rollmatch"):
        opp_bits = _fill_bits(h2, n)
        if not opp_bits:
            v = _terminal(sd)
            cache[key] = float(v)
            return float(v)
        mode = 1 if leaf == "rollmatch" else 0
        payoff = _open_payoff_rollout(
            h1,
            h2,
            rest,
            pending,
            sd,
            n,
            np.asarray(my_bits, dtype=np.int64),
            np.asarray(opp_bits, dtype=np.int64),
            sims,
            1,
            mode,
        )
        v, _ = matrix_game_strategy(payoff)
        cache[key] = float(v)
        return float(v)
    if depth == 1 and leaf in ("mlp", "mlp_blend"):
        blend = sims if leaf == "mlp_blend" else 0
        payoff, _ = _open_payoff_mlp(
            h1, h2, rest, pending, sd, n, blend_sims=blend
        )
        v, _ = matrix_game_strategy(payoff)
        cache[key] = float(v)
        return float(v)

    def child(a: int, b: int, r: int, p: int, s: int) -> float:
        return open_value(
            a,
            b,
            r,
            p,
            s,
            n,
            depth=depth - 1,
            leaf=leaf,
            temp=temp,
            sims=sims,
            cache=cache,
        )

    payoff, _my, _opp = _build_payoff(h1, h2, rest, pending, sd, n, child)
    v, _ = matrix_game_strategy(payoff)
    cache[key] = float(v)
    return float(v)


def open_strategy(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    *,
    leaf: str = "score",
    temp: float = 1.0,
    sims: int = 48,
    depth: int = 1,
    cache: dict | None = None,
) -> tuple[float, np.ndarray, list[int]]:
    """
    Depth-d open Nash: current face-up matrix with children from open_value.

    Returns (surrogate_value, row_probs, my_bits).
    """
    if depth < 1:
        raise ValueError("open_strategy requires depth >= 1")
    if cache is None:
        cache = {}

    my_bits = _fill_bits(h1, n)
    k = len(my_bits)
    probs = np.zeros(k, dtype=np.float64)
    if k == 0:
        return 0.0, probs, my_bits

    if depth == 1 and leaf in ("rollout", "rollmatch"):
        opp_bits = _fill_bits(h2, n)
        mode = 1 if leaf == "rollmatch" else 0
        payoff = _open_payoff_rollout(
            h1,
            h2,
            rest,
            pending,
            sd,
            n,
            np.asarray(my_bits, dtype=np.int64),
            np.asarray(opp_bits, dtype=np.int64),
            sims,
            1,
            mode,
        )
    elif depth == 1 and leaf == "mlp":
        payoff, my_bits = _open_payoff_mlp(
            h1, h2, rest, pending, sd, n, blend_sims=0
        )
        k = len(my_bits)
        probs = np.zeros(k, dtype=np.float64)
    elif depth == 1 and leaf == "mlp_blend":
        payoff, my_bits = _open_payoff_mlp(
            h1, h2, rest, pending, sd, n, blend_sims=sims
        )
        k = len(my_bits)
        probs = np.zeros(k, dtype=np.float64)
    else:

        def child(a: int, b: int, r: int, p: int, s: int) -> float:
            return open_value(
                a,
                b,
                r,
                p,
                s,
                n,
                depth=depth - 1,
                leaf=leaf,
                temp=temp,
                sims=sims,
                cache=cache,
            )

        payoff, my_bits, _opp = _build_payoff(
            h1, h2, rest, pending, sd, n, child
        )
        k = len(my_bits)
        probs = np.zeros(k, dtype=np.float64)

    value, row = matrix_game_strategy(payoff)
    probs[:] = row
    return float(value), probs, my_bits


def exact_payoff_matrix(
    solver,
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
) -> tuple[np.ndarray, list[int], list[int]]:
    """Build the exact one-step payoff matrix (children via solver._value)."""
    n = solver.n
    my_bits = _fill_bits(h1, n)
    opp_bits = _fill_bits(h2, n)
    stake = _mask_sum(pending, n)
    k, ko = len(my_bits), len(opp_bits)
    payoff = np.empty((k, ko), np.float64)
    for i, bi in enumerate(my_bits):
        vi = bi + 1
        h1n = h1 ^ (1 << bi)
        for j, bj in enumerate(opp_bits):
            vj = bj + 1
            h2n = h2 ^ (1 << bj)
            if vi != vj:
                sdn = sd + stake if vi > vj else sd - stake
                payoff[i, j] = solver._value(h1n, h2n, rest, 0, sdn)
            else:
                if rest == 0:
                    payoff[i, j] = _terminal(sd)
                else:
                    acc = 0.0
                    cnt = 0
                    rm = rest
                    while rm:
                        pbit = rm & -rm
                        acc += solver._value(
                            h1n, h2n, rest ^ pbit, pending | pbit, sd
                        )
                        cnt += 1
                        rm ^= pbit
                    payoff[i, j] = acc / cnt
    return payoff, my_bits, opp_bits
