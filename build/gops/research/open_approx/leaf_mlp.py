"""
MLP leaf for open-game W–L values (torch).

Trained on exact solver values for rem in {3,4,5,6}. Forced Layer-1
overrides remain exact. Predicts a residual on top of the tight heuristic.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from solve_nash import (
    _fill_bits,
    _forced_wl,
    _mask_sum,
    _normalize_hands,
    _sum_d_largest,
    _terminal,
)

# h1,h2,rem bits + norm h1,h2 bits + scalars
FEATURE_DIM = 13 + 13 + 13 + 13 + 13 + 20
DEFAULT_MODEL_PATH = (
    Path(__file__).resolve().parent / "artifacts" / "leaf_mlp_wl.pt"
)


def _baseline_tight(
    h1: int, h2: int, rem_m: int, rem: int, sd: int, n: int
) -> float:
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
    return float(np.tanh(sd / soft))


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
    nh1, nh2 = _normalize_hands(h1, h2, n)
    base_tight = _baseline_tight(h1, h2, rem_m, rem, sd, n)

    x = np.zeros(FEATURE_DIM, dtype=np.float32)
    for b in range(n):
        if h1 & (1 << b):
            x[b] = 1.0
        if h2 & (1 << b):
            x[13 + b] = 1.0
        if rem_m & (1 << b):
            x[26 + b] = 1.0
        if nh1 & (1 << b):
            x[39 + b] = 1.0
        if nh2 & (1 << b):
            x[52 + b] = 1.0
    base = 65
    x[base + 0] = sd / 91.0
    x[base + 1] = rem / 91.0
    x[base + 2] = stake / 91.0
    x[base + 3] = (s1 - s2) / 91.0
    x[base + 4] = s1 / 91.0
    x[base + 5] = s2 / 91.0
    x[base + 6] = k / 13.0
    x[base + 7] = my_dom / 13.0
    x[base + 8] = opp_dom / 13.0
    x[base + 9] = g1 / 91.0
    x[base + 10] = g2 / 91.0
    x[base + 11] = float(np.tanh(sd / max(rem, 1)))
    x[base + 12] = base_tight
    x[base + 13] = (my_max - opp_max) / 13.0
    x[base + 14] = 1.0 if rem > 0 and abs(sd) > rem else 0.0
    x[base + 15] = 1.0 if pending != 0 else 0.0
    x[base + 16] = stake / max(rem, 1)
    x[base + 17] = (g1 - g2) / 91.0
    x[base + 18] = float(bin(h1 & h2).count("1")) / 13.0
    x[base + 19] = float(bin(rem_m).count("1")) / 13.0
    return x


class LeafMLP(nn.Module):
    def __init__(
        self, in_dim: int = FEATURE_DIM, hidden: tuple[int, ...] = (256, 128, 64)
    ):
        super().__init__()
        layers: list[nn.Module] = []
        d = in_dim
        for h in hidden:
            layers.append(nn.Linear(d, h))
            layers.append(nn.ReLU())
            layers.append(nn.Dropout(0.05))
            d = h
        layers.append(nn.Linear(d, 1))
        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # residual around tight baseline at feature index 65+12 = 77
        base = x[..., 77]
        delta = torch.tanh(self.net(x).squeeze(-1))
        return torch.clamp(base + 0.75 * delta, -1.0, 1.0)


def _forced_or_terminal(
    h1: int, h2: int, rest: int, pending: int, sd: int, n: int
) -> float | None:
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
    return None


_MODEL: LeafMLP | None = None
_DEVICE = torch.device("cpu")


def load_mlp(path: Path | None = None, device: torch.device | None = None) -> LeafMLP:
    global _MODEL, _DEVICE
    p = path or DEFAULT_MODEL_PATH
    if device is not None:
        _DEVICE = device
    ckpt = torch.load(p, map_location=_DEVICE, weights_only=False)
    model = LeafMLP(
        in_dim=int(ckpt.get("in_dim", FEATURE_DIM)),
        hidden=tuple(ckpt.get("hidden", (256, 128, 64))),
    )
    model.load_state_dict(ckpt["state_dict"])
    model.to(_DEVICE)
    model.eval()
    _MODEL = model
    return model


def get_mlp(path: Path | None = None) -> LeafMLP:
    global _MODEL
    if _MODEL is None:
        load_mlp(path)
    assert _MODEL is not None
    return _MODEL


def predict_batch(model: LeafMLP, X: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        t = torch.from_numpy(np.asarray(X, dtype=np.float32)).to(_DEVICE)
        return model(t).cpu().numpy().astype(np.float64)


def leaf_mlp_wl(
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    n: int,
    model: LeafMLP | None = None,
) -> float:
    hit = _forced_or_terminal(h1, h2, rest, pending, sd, n)
    if hit is not None:
        return hit
    m = model or get_mlp()
    x = feature_vector(h1, h2, rest, pending, sd, n)
    return float(predict_batch(m, x[None, :])[0])


def leaf_mlp_batch(
    states: list[tuple[int, int, int, int, int]],
    n: int,
    model: LeafMLP | None = None,
) -> np.ndarray:
    m = model or get_mlp()
    out = np.empty(len(states), dtype=np.float64)
    need_idx = []
    need_x = []
    for i, (h1, h2, rest, pending, sd) in enumerate(states):
        hit = _forced_or_terminal(h1, h2, rest, pending, sd, n)
        if hit is not None:
            out[i] = hit
        else:
            need_idx.append(i)
            need_x.append(feature_vector(h1, h2, rest, pending, sd, n))
    if need_x:
        preds = predict_batch(m, np.vstack(need_x))
        for j, i in enumerate(need_idx):
            out[i] = preds[j]
    return out
