"""
Linear / ridge leaf for open-game W–L values.

Trained on exact solver values for rem <= K_train. Pure NumPy (no sklearn).
Load via ``load_leaf_model``; predict is microseconds.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from solve_nash import _fill_bits, _forced_wl, _mask_sum, _sum_d_largest, _terminal


FEATURE_DIM = 16

DEFAULT_MODEL_PATH = (
    Path(__file__).resolve().parent / "artifacts" / "leaf_ridge_wl.npz"
)


def feature_vector(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
) -> np.ndarray:
    rem_m = rest if pending == 0 else (rest | pending)
    rem = _mask_sum(rem_m, n)
    stake = _mask_sum(pending, n)
    s1 = _mask_sum(h1, n)
    s2 = _mask_sum(h2, n)
    bits1 = _fill_bits(h1, n)
    bits2 = _fill_bits(h2, n)
    k = len(bits1)
    my_max = bits1[-1] if bits1 else -1
    opp_max = bits2[-1] if bits2 else -1
    my_dom = sum(1 for b in bits1 if b > opp_max)
    opp_dom = sum(1 for b in bits2 if b > my_max)
    g1 = _sum_d_largest(rem_m, n, my_dom) if my_dom else 0
    g2 = _sum_d_largest(rem_m, n, opp_dom) if opp_dom else 0
    soft = max(rem - g1 - g2, 1)
    x = np.empty(FEATURE_DIM, dtype=np.float64)
    x[0] = 1.0
    x[1] = sd / 91.0
    x[2] = rem / 91.0
    x[3] = stake / 91.0
    x[4] = (s1 - s2) / 91.0
    x[5] = s1 / 91.0
    x[6] = s2 / 91.0
    x[7] = k / 13.0
    x[8] = my_dom / 13.0
    x[9] = opp_dom / 13.0
    x[10] = g1 / 91.0
    x[11] = g2 / 91.0
    x[12] = np.tanh(sd / max(rem, 1))
    x[13] = np.tanh(sd / soft)
    x[14] = (my_max - opp_max) / 13.0
    x[15] = 1.0 if rem > 0 and abs(sd) > rem else 0.0
    return x


def leaf_reg_wl(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    weights: np.ndarray,
) -> float:
    rem_m = rest if pending == 0 else (rest | pending)
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
    v = float(feature_vector(h1, h2, rest, pending, sd, n) @ weights)
    return max(-1.0, min(1.0, v))


def fit_ridge(
    X: np.ndarray, y: np.ndarray, *, l2: float = 1e-2
) -> np.ndarray:
    # weights for columns 1..; column 0 is bias (unpenalized lightly)
    xtx = X.T @ X
    diag = np.eye(X.shape[1]) * l2
    diag[0, 0] = 0.0
    return np.linalg.solve(xtx + diag, X.T @ y)


def save_model(path: Path, weights: np.ndarray, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, weights=weights, **{f"m_{k}": v for k, v in meta.items()})


def load_leaf_model(path: Path | None = None) -> np.ndarray:
    p = path or DEFAULT_MODEL_PATH
    data = np.load(p)
    return np.asarray(data["weights"], dtype=np.float64)


_WEIGHTS: np.ndarray | None = None


def get_weights(path: Path | None = None) -> np.ndarray:
    global _WEIGHTS
    if _WEIGHTS is None:
        _WEIGHTS = load_leaf_model(path)
    return _WEIGHTS
