"""
Build / load endgame Nash value tables for GOPS (W–L, rollover).

Stores HOT face-up positions only (|pending| == 1). Multi-prize rollover
stacks are exact on demand from children (k=1 closed form / lower layers).
Equal hands use sd-mirror (store sd > 0 only; V(0)=0). k=1 never stored.
Default target: N=13, K=2.

Speed notes (cf. build/line/theory.py):
  - canonicalize hands before work (shared with solver)
  - enumerate only undecided face-up states
  - memoize forced outcomes during the build
  - parallelize k>=3 over hand configs (cheap round-robin split)
  - reuse one process pool across k layers
  - default: compute+ship k<=K-1 only (leaf LP on demand; --ship-full for all)

Usage:
  python build/gops/nash/build_endgame.py --N 13 --K 2
  python build/gops/nash/build_endgame.py --N 13 --K 3 --force
  python build/gops/nash/build_endgame.py --N 13 --K 4 --force
  python build/gops/nash/build_endgame.py --N 13 --K 4 --force --ship-full
  python build/gops/scripts/profile_build.py --N 13 --K 3
"""

from __future__ import annotations

import argparse
import gzip
import os
import pickle
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from itertools import combinations
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ref"))

from count_states import get_canonical_card_configs  # noqa: E402
from matrix_game import warmup  # noqa: E402
from solve_nash import (  # noqa: E402
    GopsNashSolver,
    _fill_bits,
    _mask_sum,
    _net_bounds,
    _normalize_hands,
    _sum_d_largest,
    _USE_CYTHON,
    clear_dominance_memos,
)

if _USE_CYTHON:
    import solve_value as _cy  # noqa: E402
else:
    _cy = None  # type: ignore


TABLES_DIR = Path(__file__).resolve().parents[1] / "tables"
_PENDING_MASK = (1 << 13) - 1


def table_path(n: int, k: int) -> Path:
    return TABLES_DIR / f"endgame_n{n}_k{k}.pkl.gz"


def available_tables(n: int) -> list[tuple[int, Path]]:
    """Return (k_max_from_name, path) for existing gzip tables, sorted by k ascending."""
    TABLES_DIR.mkdir(parents=True, exist_ok=True)
    out: list[tuple[int, Path]] = []
    prefix = f"endgame_n{n}_k"
    for path in TABLES_DIR.glob(f"{prefix}*.pkl.gz"):
        suffix = path.name[len(prefix) : -len(".pkl.gz")]
        if suffix.isdigit():
            out.append((int(suffix), path))
    out.sort(key=lambda t: t[0])
    return out


def find_play_table(n: int, k_play: int) -> Path | None:
    """
    Prefer exact endgame_n{n}_k{k_play}; else largest available table for N.
    Does not build.
    """
    exact = table_path(n, k_play)
    if exact.exists():
        return exact
    avail = available_tables(n)
    if not avail:
        return None
    return avail[-1][1]


def _tuple_to_mask(cards: tuple[int, ...]) -> int:
    m = 0
    for c in cards:
        m |= 1 << (c - 1)
    return m


def _sd_range(n: int, rem_mask: int) -> range:
    """Undecided W–L scores only: |sd| <= remaining prize sum (parity-matched)."""
    S = n * (n + 1) // 2
    rem = _mask_sum(rem_mask, n)
    taken = S - rem
    bound = min(taken, rem)
    start = -bound
    if (start & 1) != (taken & 1):
        start += 1
    return range(start, bound + 1, 2)


def _face_up_splits(prize_union: int, n: int):
    """Yield (rest, pending) with exactly one face-up prize."""
    for b in range(n):
        bit = 1 << b
        if prize_union & bit:
            yield prize_union ^ bit, bit


def _is_face_up_key(key: int) -> bool:
    pending = (key >> 39) & _PENDING_MASK
    return pending != 0 and pending.bit_count() == 1


def _keep_stored_key(key: int) -> bool:
    """Face-up only; equal-hand keys keep sd > 0 only."""
    if not _is_face_up_key(key):
        return False
    h1 = key & _PENDING_MASK
    h2 = (key >> 13) & _PENDING_MASK
    sd = (key >> 52) - 128
    if h1 == h2 and sd <= 0:
        return False
    return True


def _keep_stored_entry(key: int, v: float) -> bool:
    """Face-up fractional values only (±1 live in plateau thresholds)."""
    if not _keep_stored_key(key):
        return False
    if abs(v) >= 1.0 - 1e-6:
        return False
    return True


def _undecided_sds(h1: int, h2: int, rest: int, pending: int, n: int) -> list[int]:
    """Score diffs that are not closed by dominance / pure-playout nets."""
    rem_mask = rest | pending
    rem = _mask_sum(rem_mask, n)
    my_bits = _fill_bits(h1, n)
    opp_bits = _fill_bits(h2, n)
    my_max = my_bits[-1]
    opp_max = opp_bits[-1]
    my_dom = sum(1 for b in my_bits if b > opp_max)
    opp_dom = sum(1 for b in opp_bits if b > my_max)
    g1 = _sum_d_largest(rem_mask, n, my_dom) if my_dom else 0
    g2 = _sum_d_largest(rem_mask, n, opp_dom) if opp_dom else 0
    m, m_swap = _net_bounds(h1, h2, rest, pending, n)

    out: list[int] = []
    equal = h1 == h2
    for sd in _sd_range(n, rem_mask):
        if equal and sd <= 0:
            continue
        lo = sd + 2 * g1 - rem
        hi = sd + rem - 2 * g2
        if lo > 0 or hi < 0 or (lo == 0 and hi == 0):
            continue
        if sd > m or sd < -m_swap or (m == -m_swap and sd == m):
            continue
        out.append(sd)
    return out


def _seed_layer(
    solver: GopsNashSolver,
    n: int,
    configs: list[tuple[tuple[int, ...], tuple[int, ...]]],
    prize_sets: list[tuple[int, ...]],
) -> int:
    """
    Solve undecided face-up seeds for these hand configs.

    Uses sd-monotonicity of W–L Nash value: ±1 plateaus are binary-searched
    and filled; only the fractional band is LP-solved entrywise.
    """
    seeded = 0
    use_mono = _USE_CYTHON and _cy is not None
    for my, opp in configs:
        h1 = _tuple_to_mask(my)
        h2 = _tuple_to_mask(opp)
        for prize_bits in prize_sets:
            prize_union = 0
            for b in prize_bits:
                prize_union |= 1 << b
            for rest, pending in _face_up_splits(prize_union, n):
                und = _undecided_sds(h1, h2, rest, pending, n)
                if not und:
                    continue
                if use_mono:
                    seeded += int(
                        _cy.seed_shell_monotone(
                            n,
                            solver.cache,
                            solver.forced_cache,
                            h1,
                            h2,
                            rest,
                            pending,
                            und,
                        )
                    )
                else:
                    for sd in und:
                        solver._value(h1, h2, rest, pending, sd)
                        seeded += 1
    return seeded


def _split_configs(
    configs: list[tuple[tuple[int, ...], tuple[int, ...]]],
    n_chunks: int,
) -> list[list]:
    """Round-robin split — avoids O(configs×prizes) dominance weight scans."""
    n_chunks = max(1, min(n_chunks, len(configs)))
    chunks: list[list] = [[] for _ in range(n_chunks)]
    for i, cfg in enumerate(configs):
        chunks[i % n_chunks].append(cfg)
    return [c for c in chunks if c]


def _worker_init(n: int) -> None:
    """Once per process: JIT warmup + rank-normalize stub."""
    warmup()
    _normalize_hands(1, 2, n)
    clear_dominance_memos()


def _parallel_chunk(payload: tuple) -> tuple[dict[int, float], int]:
    """Worker: solve one hand-config chunk with a shared base cache."""
    n, configs, prize_sets, base_cache = payload
    clear_dominance_memos()
    solver = GopsNashSolver(n)
    solver.cache = dict(base_cache)
    seeded = _seed_layer(solver, n, configs, prize_sets)
    base_keys = base_cache.keys()
    delta = {k: v for k, v in solver.cache.items() if k not in base_keys}
    return delta, seeded


def build_endgame(
    n: int, k_max: int, *, verbose: bool = True, workers: int = 1
) -> GopsNashSolver:
    """Fill cache for face-up HOT positions with hand size 2..k_max."""
    if k_max < 2:
        raise ValueError("K must be >= 2 (k=1 is closed form)")
    if k_max > n:
        raise ValueError("K cannot exceed N")
    if workers < 1:
        raise ValueError("workers must be >= 1")

    warmup()
    _normalize_hands(1, 2, n)
    clear_dominance_memos()
    if _USE_CYTHON:
        _cy.clear_piecewise()
    solver = GopsNashSolver(n)
    t0 = time.perf_counter()
    seeded = 0
    pool: ProcessPoolExecutor | None = None

    try:
        for k in range(2, k_max + 1):
            configs = get_canonical_card_configs(k, n)
            prize_sets = list(combinations(range(n), k))
            if verbose:
                print(
                    f"  k={k}: {len(configs):,} hand configs x "
                    f"{len(prize_sets):,} prize sets",
                    flush=True,
                )
            t_k = time.perf_counter()
            before_k = len(solver.cache)
            seeded_before = seeded

            if k == 2 or len(configs) < 4 or workers == 1:
                seeded += _seed_layer(solver, n, configs, prize_sets)
            else:
                base_cache = dict(solver.cache)
                chunks = _split_configs(configs, min(workers, len(configs)))
                payloads = [
                    (n, chunk, prize_sets, base_cache) for chunk in chunks
                ]
                if pool is None:
                    pool = ProcessPoolExecutor(
                        max_workers=workers,
                        initializer=_worker_init,
                        initargs=(n,),
                    )
                if verbose:
                    print(
                        f"    parallel workers={len(payloads)} "
                        f"(base memo={len(base_cache):,})",
                        flush=True,
                    )
                for delta, nseed in pool.map(_parallel_chunk, payloads):
                    solver.cache.update(delta)
                    seeded += nseed

            if verbose:
                dt_k = time.perf_counter() - t_k
                added = len(solver.cache) - before_k
                seeded_k = seeded - seeded_before
                print(
                    "    done in %.1fs  memo %s -> %s  (+%s)  seeded +%s"
                    % (
                        dt_k,
                        f"{before_k:,}",
                        f"{len(solver.cache):,}",
                        f"{added:,}",
                        f"{seeded_k:,}",
                    ),
                    flush=True,
                )
    finally:
        if pool is not None:
            pool.shutdown()

    before = len(solver.cache)
    solver.cache = {
        k: v for k, v in solver.cache.items() if _keep_stored_entry(k, float(v))
    }
    solver.cache_size = len(solver.cache)
    n_plat = int(_cy.plateau_count()) if _USE_CYTHON else 0
    if verbose:
        # Per-hand-size fractional breakdown
        by_k: dict[int, int] = {}
        for key in solver.cache.keys():
            kk = _shell_hand_k(int(key))
            by_k[kk] = by_k.get(kk, 0) + 1
        print("  compute summary", flush=True)
        print(f"    wall              {time.perf_counter() - t0:.1f}s", flush=True)
        print(f"    seeded undecided  {seeded:,}", flush=True)
        print(f"    raw memo          {before:,}", flush=True)
        print(
            f"    fractional kept   {solver.cache_size:,}  "
            f"(dropped +/-1 / non-face-up)",
            flush=True,
        )
        for kk in sorted(by_k):
            print(f"      k={kk} fractional  {by_k[kk]:,}", flush=True)
        print(f"    +/-1 plateaus       {n_plat:,}", flush=True)
    return solver


def _print_save_report(
    path: Path,
    *,
    play_k: int,
    k_ship: int,
    raw_bytes: int,
    stats: dict,
) -> None:
    gz_kb = path.stat().st_size / 1024
    raw_kb = raw_bytes / 1024
    n_frac = int(stats["n_fractional_entries"])
    knots = int(stats["n_piecewise_knots"])
    shells = int(stats["n_piecewise_shells"])
    n_plat = int(stats.get("n_plateaus", 0))
    ratio = (n_frac / knots) if knots else 0.0
    leaf = play_k if k_ship < play_k else None
    print("  save summary", flush=True)
    print(f"    file              {path.name}", flush=True)
    print(f"    play K            {play_k}", flush=True)
    print(f"    shipped layers    k <= {k_ship}", flush=True)
    if leaf is not None:
        print(
            f"    on-demand leaf    k = {leaf} (exact LP at play)",
            flush=True,
        )
    else:
        print("    on-demand leaf    (none; full ship)", flush=True)
    print(f"    gzip              {gz_kb:.1f} KB", flush=True)
    print(f"    raw pickle        {raw_kb:.1f} KB", flush=True)
    print(f"    +/-1 plateaus       {n_plat:,}", flush=True)
    print(f"    fractional kept   {n_frac:,}", flush=True)
    print(f"    piecewise shells  {shells:,}", flush=True)
    if knots:
        print(
            f"    piecewise knots   {knots:,}  "
            f"({ratio:.2f}x fewer than frac)",
            flush=True,
        )
    else:
        print("    piecewise knots   0", flush=True)
    print("    encoding          float16 piecewise_sd", flush=True)


_SHELL_MASK = (1 << 52) - 1


def _shell_key_from_full(key: int) -> int:
    return int(key) & _SHELL_MASK


def _shell_hand_k(shell_or_key: int) -> int:
    """Remaining hand size from a shell key or full pack key (h1 popcount)."""
    return (int(shell_or_key) & _PENDING_MASK).bit_count()


def default_k_ship(k_max: int) -> int:
    """Ship all layers except the deepest face-up leaf (LP at play)."""
    return max(1, int(k_max) - 1)


def _fractional_to_piecewise(
    items: list[tuple[int, float]],
) -> dict[int, tuple[tuple[int, ...], tuple[float, ...]]]:
    """
    Group fractional (full_key, v) by shell and keep V(sd) change-points only.

    Within a shell, sorted by sd; a new knot is stored whenever float16(v)
    differs from the previous knot (step-function encoding).
    """
    by_shell: dict[int, list[tuple[int, float]]] = {}
    for key, v in items:
        sd = (int(key) >> 52) - 128
        sk = _shell_key_from_full(key)
        by_shell.setdefault(sk, []).append((sd, float(v)))

    out: dict[int, tuple[tuple[int, ...], tuple[float, ...]]] = {}
    for sk, pairs in by_shell.items():
        pairs.sort(key=lambda p: p[0])
        sds: list[int] = []
        vs: list[float] = []
        prev = None
        for sd, v in pairs:
            q = np_float16(v)
            if prev is None or q != prev:
                sds.append(sd)
                vs.append(q)
                prev = q
        out[sk] = (tuple(sds), tuple(vs))
    return out


def np_float16(v: float) -> float:
    """Round to IEEE float16, return as Python float."""
    return float(np.float16(v))


def save_table(
    solver: GopsNashSolver,
    k_max: int,
    path: Path | None = None,
    *,
    k_ship: int | None = None,
) -> tuple[Path, int, dict]:
    """
    Write gzip table. Returns (path, uncompressed_pickle_bytes, stats).

    Fractional V(sd) is stored piecewise (change-points only, float16).
    ±1 plateaus stay as int thresholds. Uncompressed size = pickle bytes.

    By default only shells with hand-size <= k_max-1 are shipped; the leaf
    layer is left to exact on-demand LP from children at play/load time.
    Pass k_ship=k_max (or --ship-full) to store every built layer.
    Production builds compute only through k_ship (see ensure_table).
    """
    path = path or table_path(solver.n, k_max)
    path.parent.mkdir(parents=True, exist_ok=True)
    ks = default_k_ship(k_max) if k_ship is None else int(k_ship)
    if ks < 1 or ks > k_max:
        raise ValueError(f"k_ship={ks} out of range for k_max={k_max}")

    all_frac = [
        (int(k), float(v))
        for k, v in solver.cache.items()
        if _keep_stored_entry(k, float(v))
    ]
    items = [kv for kv in all_frac if _shell_hand_k(kv[0]) <= ks]
    piecewise = _fractional_to_piecewise(items)
    # Parallel arrays for compact pickle of knots
    shell_keys = np.fromiter(piecewise.keys(), dtype=np.int64, count=len(piecewise))
    # Flatten knots with offset table
    offsets = np.empty(len(piecewise) + 1, dtype=np.int32)
    offsets[0] = 0
    all_sds: list[int] = []
    all_vs: list[float] = []
    for i, sk in enumerate(shell_keys):
        sds, vs = piecewise[int(sk)]
        all_sds.extend(sds)
        all_vs.extend(vs)
        offsets[i + 1] = len(all_sds)

    plateaus: dict = {}
    if _USE_CYTHON:
        plateaus = {
            int(k): v
            for k, v in _cy.export_plateaus().items()
            if _shell_hand_k(k) <= ks
        }

    stats = {
        "k_ship": ks,
        "n_fractional_built": len(all_frac),
        "n_fractional_entries": len(items),
        "n_piecewise_knots": len(all_sds),
        "n_piecewise_shells": len(piecewise),
        "n_plateaus": len(plateaus),
    }
    payload = {
        "n": solver.n,
        "k_max": k_max,
        "k_ship": ks,
        "face_up_only": True,
        "fractional_only": True,
        "value_dtype": "float16",
        "encoding": "piecewise_sd",
        "pw_shells": shell_keys,
        "pw_offsets": offsets,
        "pw_sds": np.asarray(all_sds, dtype=np.int16),
        "pw_vs": np.asarray(all_vs, dtype=np.float16),
        "plateaus": plateaus,
        **stats,
    }
    raw = pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL)
    with gzip.open(path, "wb", compresslevel=6) as f:
        f.write(raw)
    return path, len(raw), stats


def _payload_to_piecewise_dict(payload: dict) -> dict:
    """Rebuild {shell: (sds_tuple, vs_tuple)} from compact arrays or legacy."""
    if payload.get("encoding") == "piecewise_sd":
        shells = payload["pw_shells"]
        offsets = payload["pw_offsets"]
        sds = payload["pw_sds"]
        vs = payload["pw_vs"]
        out: dict[int, tuple[tuple[int, ...], tuple[float, ...]]] = {}
        for i, sk in enumerate(shells):
            a = int(offsets[i])
            b = int(offsets[i + 1])
            out[int(sk)] = (
                tuple(int(x) for x in sds[a:b]),
                tuple(float(x) for x in vs[a:b]),
            )
        return out

    # Legacy flat cache_keys / cache_vals → change-points
    if "cache_keys" in payload and "cache_vals" in payload:
        items = [
            (int(k), float(v))
            for k, v in zip(payload["cache_keys"], payload["cache_vals"])
        ]
        return _fractional_to_piecewise(items)

    if "cache" in payload:
        items = [(int(k), float(v)) for k, v in payload["cache"].items()]
        return _fractional_to_piecewise(items)

    return {}


def load_table(
    n: int,
    k_max: int,
    path: Path | None = None,
    *,
    allow_smaller_table: bool = False,
) -> GopsNashSolver:
    path = path or table_path(n, k_max)
    legacy = TABLES_DIR / f"endgame_n{n}_k{k_max}.pkl"
    if not path.exists() and legacy.exists():
        path = legacy

    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rb") as f:
        payload = pickle.load(f)
    if payload["n"] < n:
        raise ValueError(f"table N={payload['n']} too small for play N={n}")
    if payload["k_max"] < k_max and not allow_smaller_table:
        raise ValueError(f"table K={payload['k_max']} < requested K={k_max}")
    solver = GopsNashSolver(payload["n"])
    # Live cache stays empty; fractional hits go through piecewise lookup.
    # Missing layers (k > k_ship) fall through to exact on-demand LP.
    solver.cache = {}
    solver.k_ship = int(payload.get("k_ship", payload["k_max"]))
    solver.table_k_max = int(payload["k_max"])
    if _USE_CYTHON:
        _cy.load_plateaus(payload.get("plateaus", {}))
        pw = _payload_to_piecewise_dict(payload)
        _cy.load_piecewise(pw)
        solver.cache_size = int(
            payload.get("n_fractional_entries", _cy.piecewise_knot_count())
        )
    else:
        # Fallback: expand piecewise into a plain dict cache.
        pw = _payload_to_piecewise_dict(payload)
        cache: dict[int, float] = {}
        for sk, (sds, vs) in pw.items():
            # Expand step function onto stored knot sds only (exact knots).
            for sd, v in zip(sds, vs):
                cache[int(sk) | ((int(sd) + 128) << 52)] = float(v)
            # Also fill intervening undecided-parity gaps between knots with
            # left value so parity queries match Cython step semantics.
            if len(sds) >= 2:
                for i in range(len(sds) - 1):
                    a, b = int(sds[i]), int(sds[i + 1])
                    step = 2 if ((b - a) % 2 == 0) else 1
                    for sd in range(a + step, b, step):
                        cache[int(sk) | ((sd + 128) << 52)] = float(vs[i])
        solver.cache = cache
        solver.cache_size = len(cache)
    return solver


def ensure_table(
    n: int,
    k_max: int,
    *,
    force: bool = False,
    universe: int | None = None,
    workers: int = 1,
    k_ship: int | None = None,
) -> Path:
    """
    Ensure a table exists that supports play with remaining hands <= k_max.

    Default: compute and ship only k <= k_max-1 (most compressed). The leaf
    layer is exact on-demand LP at play — no need to solve it at build time.
    Use k_ship=k_max / --ship-full to precompute every layer.
    """
    uni = universe if universe is not None else (13 if n <= 13 else n)
    target = table_path(uni, k_max)
    legacy = TABLES_DIR / f"endgame_n{uni}_k{k_max}.pkl"
    ks = default_k_ship(k_max) if k_ship is None else int(k_ship)
    if ks < 1 or ks > k_max:
        raise ValueError(f"k_ship={ks} out of range for k_max={k_max}")

    if not force and target.exists():
        return target
    if not force and legacy.exists():
        return legacy

    k_build = ks  # only solve what we ship; leaf on demand
    print(f"=== Build endgame N={uni} ===", flush=True)
    print(f"  play K            {k_max}", flush=True)
    print(f"  compute+ship      k <= {ks}", flush=True)
    if ks < k_max:
        print(
            f"  on-demand leaf    k = {k_max} (exact LP at play; not built)",
            flush=True,
        )
    else:
        print("  on-demand leaf    (none; shipping full)", flush=True)
    print(f"  workers           {workers}", flush=True)
    print(f"  output            {target}", flush=True)
    print("  layers", flush=True)
    if k_build < 2:
        warmup()
        _normalize_hands(1, 2, uni)
        clear_dominance_memos()
        if _USE_CYTHON:
            _cy.clear_piecewise()
        solver = GopsNashSolver(uni)
        solver.cache = {}
        solver.cache_size = 0
        print(
            "    (no layers precomputed; k=1 closed form + on-demand LP)",
            flush=True,
        )
    else:
        solver = build_endgame(uni, k_build, workers=workers)

    path, raw_bytes, stats = save_table(solver, k_max, target, k_ship=ks)
    _print_save_report(
        path, play_k=k_max, k_ship=ks, raw_bytes=raw_bytes, stats=stats
    )
    return target


def main() -> None:
    ap = argparse.ArgumentParser(description="Build GOPS endgame Nash table")
    ap.add_argument("--N", type=int, default=13)
    ap.add_argument("--K", type=int, default=2)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--universe", type=int, default=None)
    ap.add_argument(
        "--workers",
        type=int,
        default=1,
        help="parallel workers for k>=3 (default 1; raise for larger layers)",
    )
    ap.add_argument(
        "--k-ship",
        type=int,
        default=None,
        help="max hand-size layer to ship (default K-1; leaf LP on demand)",
    )
    ap.add_argument(
        "--ship-full",
        action="store_true",
        help="ship all built layers (equivalent to --k-ship K)",
    )
    args = ap.parse_args()
    uni = args.universe if args.universe is not None else args.N
    ks = args.K if args.ship_full else args.k_ship
    ensure_table(
        args.N,
        args.K,
        force=args.force,
        universe=uni,
        workers=args.workers,
        k_ship=ks,
    )


if __name__ == "__main__":
    main()
