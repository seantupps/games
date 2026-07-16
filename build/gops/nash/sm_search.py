"""
Do not remove this comment.

k=8 5ms 48 sims 2.17 win% mean 383.8x

Simultaneous-move search with regret matching for GOPS (W–L, rollover).

Anytime from a face-up state (SM-MCTS / RM spirit):
  - empirical payoff matrix at each decision node
  - sample joint actions (fill under-visited, then exploit mix)
  - Numba playout (or exact leaf) backs up into matrix cells
  - regret matching on the estimated matrix; average strategy returned

No full-game tables.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
from numba import njit

from matrix_game import matrix_game_strategy
from solve_nash import _fill_bits, _mask_sum, _terminal


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
def _xorshift(state: np.uint64) -> np.uint64:
    state ^= state >> np.uint64(12)
    state ^= state << np.uint64(25)
    state ^= state >> np.uint64(27)
    return state * np.uint64(0x2545F4914F6CDD1D)


@njit(cache=True)
def _pick_bid_weighted(bits: np.ndarray, nbits: int, weights: np.ndarray, state: np.uint64):
    """Sample index into bits[0:nbits] with positive weights; returns (bit, new_state)."""
    total = 0
    for i in range(nbits):
        w = int(weights[i])
        if w < 1:
            w = 1
        total += w
    state = _xorshift(state)
    r = int(state % np.uint64(max(total, 1)))
    acc = 0
    for i in range(nbits):
        w = int(weights[i])
        if w < 1:
            w = 1
        acc += w
        if r < acc:
            return int(bits[i]), state
    return int(bits[nbits - 1]), state


@njit(cache=True)
def _base_bid_weight(b: int, prize: int, n: int, mode: int) -> int:
    if mode == 0:
        return b + 1
    if mode == 1:
        return n - b
    if mode == 2:
        d = b - prize
        if d < 0:
            d = -d
        return (n - d) + 1
    # mix: prefer low + stake-near
    d = b - prize
    if d < 0:
        d = -d
    return (n - b) + (n - d) + 2


@njit(cache=True)
def _penalize_overbid(w: int, b: int, prize: int, bias: int) -> int:
    """Down-weight bets with card rank > prize. bias=0 → no change."""
    if w < 1:
        w = 1
    if bias <= 0:
        return w
    over = b - prize
    if over <= 0:
        return w
    # w' = w / (1 + bias * over); mild underbids untouched
    out = w // (1 + bias * over)
    if out < 1:
        out = 1
    return out


@njit(cache=True)
def _playout_wl(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    seed: int,
    mode: int = 0,
    overbid_bias: int = 0,
) -> float:
    """
    mode: 0=strength (high bias), 1=low-card bias, 2=stake-near,
          3=mix low+stake (empirical Nash-ish at small rem).
    overbid_bias: penalize sampling card > prize (Nash underbids more).
    """
    rem = rest if pending == 0 else (rest | pending)
    rem_sum = _mask_sum_n(rem)
    if rem_sum == 0:
        return _terminal_n(sd)
    if sd > rem_sum:
        return 1.0
    if sd < -rem_sum:
        return -1.0

    bits1 = np.empty(13, dtype=np.int64)
    bits2 = np.empty(13, dtype=np.int64)
    w1 = np.empty(13, dtype=np.int64)
    w2 = np.empty(13, dtype=np.int64)
    state = np.uint64(
        seed
        ^ (h1 * 0x9E3779B97F4A7C15)
        ^ ((h2 << 1) & 0xFFFFFFFFFFFFFFFF)
        ^ rest
        ^ pending
        ^ ((sd + 128) << 16)
        ^ (mode * 0x9E3779B1)
        ^ (overbid_bias * 0x85EBCA6B)
    )
    if state == 0:
        state = np.uint64(0xDEADBEEF)

    cur_sd = sd
    cur_h1, cur_h2 = h1, h2
    cur_rest, cur_pend = rest, pending
    while cur_h1 != 0 and cur_h2 != 0:
        if cur_pend == 0:
            nb = _fill_bits_n(cur_rest, n, bits1)
            if nb == 0:
                break
            state = _xorshift(state)
            pb = int(bits1[int(state % np.uint64(nb))])
            cur_rest ^= 1 << pb
            cur_pend = 1 << pb

        stake = _mask_sum_n(cur_pend)
        # prize rank = bit length of lowest set bit in pending (single) / stake proxy
        prize = 0
        t = cur_pend
        while t > 1:
            t >>= 1
            prize += 1

        n1 = _fill_bits_n(cur_h1, n, bits1)
        n2 = _fill_bits_n(cur_h2, n, bits2)
        for i in range(n1):
            b = int(bits1[i])
            w1[i] = _penalize_overbid(
                _base_bid_weight(b, prize, n, mode), b, prize, overbid_bias
            )
        for j in range(n2):
            b = int(bits2[j])
            w2[j] = _penalize_overbid(
                _base_bid_weight(b, prize, n, mode), b, prize, overbid_bias
            )

        bi, state = _pick_bid_weighted(bits1, n1, w1, state)
        bj, state = _pick_bid_weighted(bits2, n2, w2, state)
        cur_h1 ^= 1 << bi
        cur_h2 ^= 1 << bj
        if bi != bj:
            cur_sd += stake if bi > bj else -stake
            cur_pend = 0
        elif cur_rest == 0:
            break
        else:
            nb = _fill_bits_n(cur_rest, n, bits1)
            state = _xorshift(state)
            pb = int(bits1[int(state % np.uint64(nb))])
            cur_rest ^= 1 << pb
            cur_pend |= 1 << pb
    return _terminal_n(cur_sd)


def _regret_match(regrets: np.ndarray) -> np.ndarray:
    pos = np.maximum(regrets, 0.0)
    s = float(pos.sum())
    if s <= 1e-18:
        return np.full(regrets.shape[0], 1.0 / max(regrets.shape[0], 1))
    return pos / s


@dataclass
class SMNode:
    my_bits: list[int]
    opp_bits: list[int]
    sum_u: np.ndarray  # (k, ko) cumulative utilities for P1
    count: np.ndarray  # (k, ko)
    regret1: np.ndarray
    regret2: np.ndarray
    strat_sum1: np.ndarray
    strat_sum2: np.ndarray
    visits: int = 0


class SMSearch:
    def __init__(
        self,
        n: int = 13,
        *,
        exact_leaf_k: int = 0,
        max_depth: int = 4,
        solver=None,
        explore: float = 1.5,
        playouts_per_sample: int = 48,
        sims_max: int = 64,
        playout_mode: int = 2,  # stake-near; scales to rem=13 (no exact)
        overbid_bias: int = 0,  # penalize card > prize in playouts (0=off; 1~weak)
        restrict_support: bool = False,
        exact_support: bool = False,
        adaptive_exact: bool = False,  # not scalable past rem~8; off by default
        adapt_v_thr: float = 0.35,
        adapt_hi_thr: float = 0.20,
    ):
        self.n = n
        self.exact_leaf_k = exact_leaf_k
        self.max_depth = max_depth
        self.solver = solver
        self.explore = explore
        self.playouts_per_sample = max(1, playouts_per_sample)
        self.sims_max = max(8, int(sims_max))
        self.playout_mode = int(playout_mode)
        self.overbid_bias = max(0, int(overbid_bias))
        self.restrict_support = bool(restrict_support)
        self.exact_support = bool(exact_support)
        self.adaptive_exact = bool(adaptive_exact)
        self.adapt_v_thr = float(adapt_v_thr)
        self.adapt_hi_thr = float(adapt_hi_thr)
        self.nodes: dict[tuple, SMNode] = {}
        self._rng = np.random.default_rng(0)
        self._salt = 0

    def reset(self) -> None:
        self.nodes.clear()
        self._salt = 0

    def _exact_joint(
        self, h1: int, h2: int, rest: int, pending: int, sd: int, bi: int, bj: int
    ) -> float:
        assert self.solver is not None
        stake = _mask_sum(pending, self.n)
        h1n, h2n = h1 ^ (1 << bi), h2 ^ (1 << bj)
        if bi != bj:
            sdn = sd + stake if bi > bj else sd - stake
            return float(self.solver._value(h1n, h2n, rest, 0, sdn))
        if rest == 0:
            return float(_terminal(sd))
        acc = 0.0
        cnt = 0
        rm = rest
        while rm:
            pbit = rm & -rm
            acc += float(
                self.solver._value(h1n, h2n, rest ^ pbit, pending | pbit, sd)
            )
            cnt += 1
            rm ^= pbit
        return acc / max(cnt, 1)

    def _support_indices(self, bits: list[int], prize: int) -> list[int]:
        """Lowest + up to 3 nearest-to-prize (Nash mass mostly lives here)."""
        if not bits:
            return []
        order_near = sorted(range(len(bits)), key=lambda i: abs(bits[i] - prize))
        keep = {int(np.argmin(bits))}  # index of lowest card
        for i in order_near[:3]:
            keep.add(i)
        return sorted(keep)

    def _get_node(self, h1, h2, rest, pending, sd) -> SMNode:
        key = (h1, h2, rest, pending, sd)
        node = self.nodes.get(key)
        if node is not None:
            return node
        my = _fill_bits(h1, self.n)
        opp = _fill_bits(h2, self.n)
        k, ko = len(my), len(opp)
        node = SMNode(
            my_bits=my,
            opp_bits=opp,
            sum_u=np.zeros((k, ko), dtype=np.float64),
            count=np.zeros((k, ko), dtype=np.float64),
            regret1=np.zeros(k, dtype=np.float64),
            regret2=np.zeros(ko, dtype=np.float64),
            strat_sum1=np.zeros(k, dtype=np.float64),
            strat_sum2=np.zeros(ko, dtype=np.float64),
        )
        self.nodes[key] = node
        return node

    def _mean_matrix(self, node: SMNode) -> np.ndarray:
        """Empirical means; unvisited cells get 0 (neutral W–L prior)."""
        M = np.zeros_like(node.sum_u)
        mask = node.count > 0
        M[mask] = node.sum_u[mask] / node.count[mask]
        return M

    def _leaf(self, h1, h2, rest, pending, sd) -> float:
        rem_m = rest if pending == 0 else (rest | pending)
        rem = _mask_sum(rem_m, self.n)
        if rem == 0:
            return _terminal(sd)
        if sd > rem:
            return 1.0
        if sd < -rem:
            return -1.0
        k = h1.bit_count()
        if (
            self.exact_leaf_k > 0
            and self.solver is not None
            and k <= self.exact_leaf_k
        ):
            return float(self.solver._value(h1, h2, rest, pending, sd))
        total = 0.0
        for p in range(self.playouts_per_sample):
            self._salt += 1
            total += _playout_wl(
                h1,
                h2,
                rest,
                pending,
                sd,
                self.n,
                self._salt * 7919 + p,
                self.playout_mode,
                self.overbid_bias,
            )
        return total / self.playouts_per_sample

    def _successors(self, h1, h2, rest, pending, sd, bi, bj):
        stake = _mask_sum(pending, self.n)
        h1n, h2n = h1 ^ (1 << bi), h2 ^ (1 << bj)
        if bi != bj:
            sdn = sd + stake if bi > bj else sd - stake
            return [(h1n, h2n, rest, 0, sdn)]
        if rest == 0:
            return [(h1n, h2n, 0, 0, sd)]
        outs = []
        rm = rest
        while rm:
            pbit = rm & -rm
            outs.append((h1n, h2n, rest ^ pbit, pending | pbit, sd))
            rm ^= pbit
        return outs

    def _estimate_joint(
        self, h1, h2, rest, pending, sd, bi, bj, depth: int
    ) -> float:
        succs = self._successors(h1, h2, rest, pending, sd, bi, bj)
        if len(succs) == 1:
            nxt = succs[0]
            if depth + 1 >= self.max_depth or nxt[3] == 0 and nxt[2] == 0:
                return self._leaf(*nxt)
            if nxt[3] == 0:
                # chance: average a cheap sample of future prizes for speed
                return self._leaf(*nxt) if nxt[2] == 0 else self._traverse_chance(
                    *nxt, depth + 1
                )
            return self._value_state(*nxt, depth + 1)
        # Tie → average over next prizes (exact chance node)
        acc = 0.0
        for nxt in succs:
            if depth + 1 >= self.max_depth:
                acc += self._leaf(*nxt)
            else:
                acc += self._value_state(*nxt, depth + 1)
        return acc / len(succs)

    def _traverse_chance(self, h1, h2, rest, pending, sd, depth: int) -> float:
        bits = _fill_bits(rest, self.n)
        if not bits:
            return _terminal(sd)
        pb = int(bits[int(self._rng.integers(0, len(bits)))])
        return self._value_state(
            h1, h2, rest ^ (1 << pb), 1 << pb, sd, depth
        )

    def _value_state(self, h1, h2, rest, pending, sd, depth: int) -> float:
        rem_m = rest if pending == 0 else (rest | pending)
        rem = _mask_sum(rem_m, self.n)
        if rem == 0 or h1 == 0 or h2 == 0:
            return _terminal(sd)
        if sd > rem:
            return 1.0
        if sd < -rem:
            return -1.0
        if pending == 0:
            return self._traverse_chance(h1, h2, rest, pending, sd, depth)
        if depth >= self.max_depth or (
            self.exact_leaf_k > 0 and h1.bit_count() <= self.exact_leaf_k
        ):
            return self._leaf(h1, h2, rest, pending, sd)
        # One local RM improvement step's current value estimate
        node = self._get_node(h1, h2, rest, pending, sd)
        M = self._mean_matrix(node)
        if node.count.sum() < 1:
            return self._leaf(h1, h2, rest, pending, sd)
        v, _ = matrix_game_strategy(M)
        return float(v)

    def _select_cell(self, node: SMNode) -> tuple[int, int]:
        k, ko = node.count.shape
        # Prefer unvisited joints
        unvis = np.argwhere(node.count == 0)
        if len(unvis) > 0:
            # Cap how many forced fills: pick among unvisited at random
            pick = unvis[int(self._rng.integers(0, len(unvis)))]
            return int(pick[0]), int(pick[1])
        # UCB over joint actions using empirical means
        total = max(float(node.count.sum()), 1.0)
        means = self._mean_matrix(node)
        # For zero-sum, UCB on P1 payoff
        bonus = self.explore * np.sqrt(np.log(total + 1.0) / node.count)
        score = means + bonus
        flat = int(np.argmax(score))
        return flat // ko, flat % ko

    def _rm_update(self, node: SMNode) -> None:
        M = self._mean_matrix(node)
        if node.count.sum() < 1:
            return
        sigma1 = _regret_match(node.regret1)
        sigma2 = _regret_match(node.regret2)
        # Action values vs current strategies
        u1 = M @ sigma2  # (k,)
        u2 = -(sigma1 @ M)  # (ko,)
        v1 = float(sigma1 @ u1)
        v2 = float(sigma2 @ u2)
        node.regret1 += u1 - v1
        node.regret2 += u2 - v2
        node.strat_sum1 += _regret_match(node.regret1)
        node.strat_sum2 += _regret_match(node.regret2)

    def _iterate_root(self, h1, h2, rest, pending, sd) -> None:
        if pending == 0:
            bits = _fill_bits(rest, self.n)
            if not bits:
                return
            pb = int(bits[int(self._rng.integers(0, len(bits)))])
            h1, h2, rest, pending, sd = (
                h1,
                h2,
                rest ^ (1 << pb),
                1 << pb,
                sd,
            )
        node = self._get_node(h1, h2, rest, pending, sd)
        if not node.my_bits or not node.opp_bits:
            return
        i, j = self._select_cell(node)
        bi, bj = node.my_bits[i], node.opp_bits[j]
        u = self._estimate_joint(h1, h2, rest, pending, sd, bi, bj, 0)
        node.sum_u[i, j] += u
        node.count[i, j] += 1.0
        node.visits += 1
        self._rm_update(node)

    def search(
        self,
        h1: int,
        h2: int,
        rest: int,
        pending: int,
        sd: int,
        *,
        budget_ms: float = 50.0,
        iterations: int | None = None,
        seed: int = 0,
    ) -> tuple[float, np.ndarray, list[int], dict]:
        self.reset()
        self._rng = np.random.default_rng(seed)
        _playout_wl(
            h1,
            h2,
            rest,
            pending,
            sd,
            self.n,
            1,
            self.playout_mode,
            self.overbid_bias,
        )

        t0 = time.perf_counter()
        n_it = 0
        mode = "tree"

        # Depth-1 bulk: optional support mask + low/stake leaf or exact cells.
        if self.max_depth <= 1 and pending != 0:
            mode = "bulk"
            root = self._get_node(h1, h2, rest, pending, sd)
            my_bits = root.my_bits
            opp_bits = root.opp_bits
            prize = int(pending.bit_length() - 1)
            my_idx = (
                self._support_indices(my_bits, prize)
                if self.restrict_support
                else list(range(len(my_bits)))
            )
            opp_idx = (
                self._support_indices(opp_bits, prize)
                if self.restrict_support
                else list(range(len(opp_bits)))
            )
            my_a = np.asarray([my_bits[i] for i in my_idx], dtype=np.int64)
            opp_a = np.asarray([opp_bits[j] for j in opp_idx], dtype=np.int64)
            sub_cells = max(len(my_idx) * len(opp_idx), 1)

            if self.exact_support and self.solver is not None:
                mode = "bulk-exact-support"
                Msub = np.empty((len(my_idx), len(opp_idx)), dtype=np.float64)
                for ii, i in enumerate(my_idx):
                    for jj, j in enumerate(opp_idx):
                        Msub[ii, jj] = self._exact_joint(
                            h1, h2, rest, pending, sd, my_bits[i], opp_bits[j]
                        )
                sims = 0
            else:
                ms_per_sim = 0.095 * (sub_cells / 64.0)
                target = max(8, int(self.playouts_per_sample))
                soft_max = max(self.sims_max, target)
                if iterations is not None:
                    sims = max(8, min(int(iterations), soft_max))
                else:
                    fit = int(max(budget_ms, 0.0) / max(ms_per_sim, 1e-6))
                    if fit >= target:
                        sims = int(min(target, soft_max))
                    else:
                        sims = int(min(max(fit, 8), soft_max))
                Msub = _matrix_playout_fill(
                    h1,
                    h2,
                    rest,
                    pending,
                    sd,
                    self.n,
                    my_a,
                    opp_a,
                    sims,
                    seed + 1,
                    self.playout_mode,
                    self.overbid_bias,
                )
                mode = f"bulk-m{self.playout_mode}"
                if self.overbid_bias > 0:
                    mode += f"-ob{self.overbid_bias}"
                if self.restrict_support:
                    mode += "-mask"

            _v, p_sub = matrix_game_strategy(Msub)
            probs = np.zeros(len(my_bits), dtype=np.float64)
            for ii, i in enumerate(my_idx):
                probs[i] = float(p_sub[ii])
            s = float(probs.sum())
            if s > 0:
                probs /= s
            else:
                probs[:] = 1.0 / max(len(my_bits), 1)

            # Contested → escalate to full exact open matrix (rem=7 children
            # are rem=6; shared memo ≈ full rem=7 solve, but only when needed).
            escalated = False
            if (
                self.adaptive_exact
                and not (self.exact_support and self.solver is not None)
            ):
                hi = max(my_bits)
                i_hi = my_bits.index(hi)
                contested = (
                    abs(float(_v)) < self.adapt_v_thr
                    or float(probs[i_hi]) >= self.adapt_hi_thr
                )
                if contested and self.solver is not None:
                    Mfull_ex = np.empty(
                        (len(my_bits), len(opp_bits)), dtype=np.float64
                    )
                    for i, bi in enumerate(my_bits):
                        for j, bj in enumerate(opp_bits):
                            Mfull_ex[i, j] = self._exact_joint(
                                h1, h2, rest, pending, sd, bi, bj
                            )
                    _v, probs = matrix_game_strategy(Mfull_ex)
                    probs = np.asarray(probs, dtype=np.float64)
                    Msub = Mfull_ex
                    my_idx = list(range(len(my_bits)))
                    opp_idx = list(range(len(opp_bits)))
                    escalated = True
                    mode = "bulk-adapt-exact"

            # Store full padded matrix for stats / debugging
            Mfull = np.zeros((len(my_bits), len(opp_bits)), dtype=np.float64)
            if escalated:
                Mfull[:, :] = Msub
            else:
                for ii, i in enumerate(my_idx):
                    for jj, j in enumerate(opp_idx):
                        Mfull[i, j] = Msub[ii, jj]
            root.sum_u[:, :] = Mfull
            root.count[:, :] = 0.0
            if escalated:
                root.count[:, :] = 1.0
            else:
                for ii, i in enumerate(my_idx):
                    for jj, j in enumerate(opp_idx):
                        root.count[i, j] = 1.0
            root.visits = int(root.count.sum())
            n_it = root.visits
            value = float(_v)
            elapsed_ms = (time.perf_counter() - t0) * 1e3
            stats = {
                "iterations": n_it,
                "nodes": len(self.nodes),
                "elapsed_ms": elapsed_ms,
                "root_visits": root.visits,
                "root_cells_filled": int((root.count > 0).sum()),
                "root_cells": int(root.count.size),
                "bulk_sims": 0 if escalated else sims,
                "support_my": len(my_idx),
                "support_opp": len(opp_idx),
                "escalated": escalated,
                "mode": mode,
            }
            return (
                float(value),
                np.asarray(probs, dtype=np.float64),
                root.my_bits,
                stats,
            )

        if iterations is not None:
            for _ in range(iterations):
                self._iterate_root(h1, h2, rest, pending, sd)
                n_it += 1
        else:
            t_end = t0 + max(budget_ms, 0.0) * 1e-3
            node0 = self._get_node(h1, h2, rest, pending, sd)
            min_it = max(16, node0.count.size)
            while n_it < min_it or time.perf_counter() < t_end:
                self._iterate_root(h1, h2, rest, pending, sd)
                n_it += 1
                if n_it > 2_000_000:
                    break

        elapsed_ms = (time.perf_counter() - t0) * 1e3
        root = self._get_node(h1, h2, rest, pending, sd)
        M = self._mean_matrix(root)
        if float(root.count.min()) >= 1.0:
            value, probs = matrix_game_strategy(M)
        else:
            Mf = M.copy()
            for i, bi in enumerate(root.my_bits):
                for j, bj in enumerate(root.opp_bits):
                    if root.count[i, j] < 1:
                        Mf[i, j] = self._leaf(
                            *self._successors(
                                h1, h2, rest, pending, sd, bi, bj
                            )[0]
                        )
            value, probs = matrix_game_strategy(Mf)

        stats = {
            "iterations": n_it,
            "nodes": len(self.nodes),
            "elapsed_ms": elapsed_ms,
            "root_visits": root.visits,
            "root_cells_filled": int((root.count > 0).sum()),
            "root_cells": int(root.count.size),
            "mode": mode,
        }
        return (
            float(value),
            np.asarray(probs, dtype=np.float64),
            root.my_bits,
            stats,
        )


@njit(cache=True)
def _matrix_playout_fill(
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
    overbid_bias: int = 0,
) -> np.ndarray:
    """Fill root payoff via averaged Numba playouts (open-style)."""
    k = my_bits.shape[0]
    ko = opp_bits.shape[0]
    payoff = np.empty((k, ko), dtype=np.float64)
    stake = _mask_sum_n(pending)
    for i in range(k):
        bi = int(my_bits[i])
        h1n = h1 ^ (1 << bi)
        for j in range(ko):
            bj = int(opp_bits[j])
            h2n = h2 ^ (1 << bj)
            if bi != bj:
                sdn = sd + stake if bi > bj else sd - stake
                acc = 0.0
                for s in range(sims):
                    acc += _playout_wl(
                        h1n,
                        h2n,
                        rest,
                        0,
                        sdn,
                        n,
                        seed + i * 1024 + j * 17 + s,
                        mode,
                        overbid_bias,
                    )
                payoff[i, j] = acc / sims
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
                    sub = 0.0
                    for s in range(sims):
                        sub += _playout_wl(
                            h1n,
                            h2n,
                            rest ^ pbit,
                            pending | pbit,
                            sd,
                            n,
                            seed + i * 1024 + j * 17 + pb * 3 + s,
                            mode,
                            overbid_bias,
                        )
                    acc += sub / sims
                    cnt += 1
                    rm ^= pbit
                payoff[i, j] = acc / cnt
    return payoff


def warmup_sm() -> None:
    for m in (0, 1, 2, 3):
        _playout_wl(0b1111, 0b11110000, 0, 1 << 8, 0, 13, 1, m, 3)
    bits = np.array([0, 1, 2], dtype=np.int64)
    _matrix_playout_fill(
        0b111, 0b111000, 0, 1 << 6, 0, 13, bits, bits, 2, 1, 3, 3
    )
