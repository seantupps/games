"""
Numba-accelerated zero-sum matrix game solvers.

Row player maximizes, column minimizes. Returns value for the row player.
"""

from __future__ import annotations

import numpy as np
from numba import njit


@njit(cache=True)
def _solve_2x2_value(a: float, b: float, c: float, d: float) -> float:
    row0_min = a if a < b else b
    row1_min = c if c < d else d
    maximin = row0_min if row0_min > row1_min else row1_min

    col0_max = a if a > c else c
    col1_max = b if b > d else d
    minimax = col0_max if col0_max < col1_max else col1_max

    if maximin >= minimax - 1e-10:
        return maximin

    denom = a - b - c + d
    if abs(denom) < 1e-12:
        return 0.5 * (maximin + minimax)

    value = (a * d - b * c) / denom
    if value < maximin - 1e-9:
        return maximin
    if value > minimax + 1e-9:
        return minimax
    return value


@njit(cache=True)
def _simplex_min(c: np.ndarray, A: np.ndarray, b: np.ndarray) -> float:
    """
    Minimize c^T x s.t. A x >= b, x >= 0.
    Returns optimal objective, or +1e20 if infeasible, -1e20 if unbounded.
    """
    m, n = A.shape
    BIG_M = 1e8
    total_vars = n + 2 * m
    tableau = np.zeros((m + 1, total_vars + 1))

    for i in range(m):
        for j in range(n):
            tableau[i, j] = A[i, j]
        tableau[i, n + i] = -1.0
        tableau[i, n + m + i] = 1.0
        tableau[i, total_vars] = b[i]

    for j in range(n):
        tableau[m, j] = c[j]
    for j in range(m):
        tableau[m, n + m + j] = BIG_M

    for i in range(m):
        for j in range(total_vars + 1):
            tableau[m, j] -= BIG_M * tableau[i, j]

    basis = np.empty(m, dtype=np.int64)
    for i in range(m):
        basis[i] = n + m + i

    for _ in range(2000):
        entering = -1
        best_rc = -1e-9
        for j in range(total_vars):
            rc = tableau[m, j]
            if rc < best_rc:
                best_rc = rc
                entering = j
        if entering < 0:
            break

        leaving = -1
        min_ratio = 1e20
        for i in range(m):
            piv = tableau[i, entering]
            if piv > 1e-10:
                ratio = tableau[i, total_vars] / piv
                if ratio < min_ratio:
                    min_ratio = ratio
                    leaving = i
        if leaving < 0:
            return -1e20

        pivot = tableau[leaving, entering]
        for j in range(total_vars + 1):
            tableau[leaving, j] /= pivot

        for i in range(m + 1):
            if i == leaving:
                continue
            factor = tableau[i, entering]
            if factor != 0.0:
                for j in range(total_vars + 1):
                    tableau[i, j] -= factor * tableau[leaving, j]

        basis[leaving] = entering

    for i in range(m):
        if basis[i] >= n + m and tableau[i, total_vars] > 1e-6:
            return 1e20

    return tableau[m, total_vars]


@njit(cache=True)
def _simplex_min_with_x(c: np.ndarray, A: np.ndarray, b: np.ndarray) -> tuple:
    """Like _simplex_min but also returns x (length n)."""
    m, n = A.shape
    BIG_M = 1e8
    total_vars = n + 2 * m
    tableau = np.zeros((m + 1, total_vars + 1))

    for i in range(m):
        for j in range(n):
            tableau[i, j] = A[i, j]
        tableau[i, n + i] = -1.0
        tableau[i, n + m + i] = 1.0
        tableau[i, total_vars] = b[i]

    for j in range(n):
        tableau[m, j] = c[j]
    for j in range(m):
        tableau[m, n + m + j] = BIG_M

    for i in range(m):
        for j in range(total_vars + 1):
            tableau[m, j] -= BIG_M * tableau[i, j]

    basis = np.empty(m, dtype=np.int64)
    for i in range(m):
        basis[i] = n + m + i

    for _ in range(2000):
        entering = -1
        best_rc = -1e-9
        for j in range(total_vars):
            rc = tableau[m, j]
            if rc < best_rc:
                best_rc = rc
                entering = j
        if entering < 0:
            break

        leaving = -1
        min_ratio = 1e20
        for i in range(m):
            piv = tableau[i, entering]
            if piv > 1e-10:
                ratio = tableau[i, total_vars] / piv
                if ratio < min_ratio:
                    min_ratio = ratio
                    leaving = i
        if leaving < 0:
            x = np.zeros(n)
            return -1e20, x

        pivot = tableau[leaving, entering]
        for j in range(total_vars + 1):
            tableau[leaving, j] /= pivot

        for i in range(m + 1):
            if i == leaving:
                continue
            factor = tableau[i, entering]
            if factor != 0.0:
                for j in range(total_vars + 1):
                    tableau[i, j] -= factor * tableau[leaving, j]

        basis[leaving] = entering

    x = np.zeros(n)
    for i in range(m):
        if basis[i] >= n + m and tableau[i, total_vars] > 1e-6:
            return 1e20, x
        if basis[i] < n:
            x[basis[i]] = tableau[i, total_vars]

    return tableau[m, total_vars], x


@njit(cache=True)
def matrix_game_value(M: np.ndarray) -> float:
    """Value of zero-sum matrix game for the row player."""
    n = M.shape[0]
    m = M.shape[1]

    if n == 1:
        best = M[0, 0]
        for j in range(1, m):
            if M[0, j] < best:
                best = M[0, j]
        return best

    if m == 1:
        best = M[0, 0]
        for i in range(1, n):
            if M[i, 0] > best:
                best = M[i, 0]
        return best

    maximin = -1e20
    for i in range(n):
        row_min = M[i, 0]
        for j in range(1, m):
            if M[i, j] < row_min:
                row_min = M[i, j]
        if row_min > maximin:
            maximin = row_min

    minimax = 1e20
    for j in range(m):
        col_max = M[0, j]
        for i in range(1, n):
            if M[i, j] > col_max:
                col_max = M[i, j]
        if col_max < minimax:
            minimax = col_max

    if maximin >= minimax - 1e-9:
        return maximin

    if n == 2 and m == 2:
        return _solve_2x2_value(M[0, 0], M[0, 1], M[1, 0], M[1, 1])

    min_val = M[0, 0]
    for i in range(n):
        for j in range(m):
            if M[i, j] < min_val:
                min_val = M[i, j]
    shift = 1.0 - min_val

    c = np.ones(n)
    A = np.empty((m, n))
    for i in range(n):
        for j in range(m):
            A[j, i] = M[i, j] + shift
    b = np.ones(m)

    # Tableau stores -obj for min form used above in some conventions;
    # match goofspiel-nash: negate the returned objective.
    opt_sum = -_simplex_min(c, A, b)
    if opt_sum <= 1e-10 or opt_sum >= 1e19:
        return 0.5 * (maximin + minimax)
    return 1.0 / opt_sum - shift


@njit(cache=True)
def matrix_game_strategy(M: np.ndarray) -> tuple:
    """
    Returns (value, row_strategy) for the row player.
    row_strategy is a probability vector of length n_rows.
    """
    n = M.shape[0]
    m = M.shape[1]
    probs = np.zeros(n)

    if n == 1:
        probs[0] = 1.0
        best = M[0, 0]
        for j in range(1, m):
            if M[0, j] < best:
                best = M[0, j]
        return best, probs

    if m == 1:
        best_i = 0
        best = M[0, 0]
        for i in range(1, n):
            if M[i, 0] > best:
                best = M[i, 0]
                best_i = i
        probs[best_i] = 1.0
        return best, probs

    maximin = -1e20
    maximin_row = 0
    for i in range(n):
        row_min = M[i, 0]
        for j in range(1, m):
            if M[i, j] < row_min:
                row_min = M[i, j]
        if row_min > maximin:
            maximin = row_min
            maximin_row = i

    minimax = 1e20
    for j in range(m):
        col_max = M[0, j]
        for i in range(1, n):
            if M[i, j] > col_max:
                col_max = M[i, j]
        if col_max < minimax:
            minimax = col_max

    if maximin >= minimax - 1e-9:
        probs[maximin_row] = 1.0
        return maximin, probs

    min_val = M[0, 0]
    for i in range(n):
        for j in range(m):
            if M[i, j] < min_val:
                min_val = M[i, j]
    shift = 1.0 - min_val

    c = np.ones(n)
    A = np.empty((m, n))
    for i in range(n):
        for j in range(m):
            A[j, i] = M[i, j] + shift
    b = np.ones(m)

    opt_obj, y = _simplex_min_with_x(c, A, b)
    opt_sum = -opt_obj
    if opt_sum <= 1e-10 or opt_sum >= 1e19:
        probs[maximin_row] = 1.0
        return 0.5 * (maximin + minimax), probs

    value = 1.0 / opt_sum - shift
    for i in range(n):
        probs[i] = y[i] / opt_sum
    # Normalize against numerical drift
    s = 0.0
    for i in range(n):
        if probs[i] < 0.0:
            probs[i] = 0.0
        s += probs[i]
    if s > 0.0:
        for i in range(n):
            probs[i] /= s
    else:
        probs[maximin_row] = 1.0
    return value, probs


def warmup() -> None:
    M = np.array([[1.0, -1.0], [-1.0, 1.0]], dtype=np.float64)
    matrix_game_value(M)
    matrix_game_strategy(M)
