"""
Human vs Nash AI for GOPS (W–L, rollover).

Default: N=13, skip to a random K-card endgame in CHANCE_BOUNDS
(both hands shown). Small N (≤6) can still full-solve; use --full to play
from the opening.

`gops k=N` talks to a background daemon (auto-started) so exits and re-runs
skip numpy/numba import+warmup. Use `gops --stop` to shut the daemon down.

Usage:
  gops k=6                    # play on-demand LP (no table)
  gops k=6 --table            # play; load exact or largest available table
  gops k=6 --seed 42
  gops n=5 --full
  gops k=5 --build            # rebuild table only (does not play)
  gops k=5 --build --workers=6
  gops k=6 --nash             # also print Nash/SM bid mixes each turn
  gops k=10 --nash            # rem>7 uses SM-MCTS (55 sims); rem<=7 exact
  gops k=10 --sims 100 --nash # override SM rollouts/cell
  gops --vs k=6               # enter each prize; AI bids first
  gops --stop                 # stop background daemon
"""

from __future__ import annotations

import json
import os
import random
import socket
import sys
import time
from pathlib import Path

# Wall clock: launcher sets GOPS_WALL0 (epoch ms); else Python module start.
_T_MOD = time.perf_counter()
_WALL0_MS = os.environ.get("GOPS_WALL0")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "nash"))

from build_endgame import ensure_table, find_play_table, load_table  # noqa: E402
from matrix_game import warmup  # noqa: E402
from sm_search import SMSearch, warmup_sm  # noqa: E402
from solve_nash import GopsNashSolver, card_value, clear_dominance_memos  # noqa: E402

try:
    import solve_value as _cy  # noqa: E402
except ImportError:  # pragma: no cover
    _cy = None  # type: ignore

_T_IMPORTS = time.perf_counter() - _T_MOD
_DAEMON_READY = False

# Exact on-demand LP for rem ≤ this; SM-MCTS depth-1 bulk above.
EXACT_REM_MAX = 7
SM_SIMS_DEFAULT = 55

DAEMON_STATE_PATH = Path(os.environ.get("TEMP") or os.environ.get("TMP") or ".") / (
    "gops-daemon.json"
)


def _wall_secs() -> float:
    """Seconds since gops launcher start (or this module if run directly)."""
    if _WALL0_MS is not None:
        return time.time() - (float(_WALL0_MS) / 1000.0)
    return time.perf_counter() - _T_MOD


def _set_wall0_ms(ms: str | None) -> None:
    global _WALL0_MS
    _WALL0_MS = ms


ALL_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
ALIASES = {"ACE": "A", "1": "A", "T": "10", "JACK": "J", "QUEEN": "Q", "KING": "K"}

# Deal filter: each side's win chance (draws as half) must lie in [lo, hi].
# Examples: (0.4, 0.6), (0.01, 0.99), (0.45, 0.55)
CHANCE_BOUNDS = (0.1, .99)
# If True, both hands get the same ranks (V≡0 at opening; still in CHANCE_BOUNDS).
EQUAL_DEALS = True


def ranks_for_n(n: int) -> list[str]:
    return ALL_RANKS[:n]


def parse_bid(raw: str, hand: list[str]) -> str | None:
    s = raw.strip().upper()
    s = ALIASES.get(s, s)
    if s not in hand:
        return None
    return s


def bit_for_rank(rank: str) -> int:
    return ALL_RANKS.index(rank)


def mask_from_ranks(ranks: list[str]) -> int:
    m = 0
    for r in ranks:
        m |= 1 << bit_for_rank(r)
    return m


def fmt_hand(ranks: list[str]) -> str:
    return ",".join(ranks)


def fmt_prize_set(ranks: list[str], rng: random.Random) -> str:
    """Display remaining prizes as a set; shuffle so UI does not leak deal order."""
    shown = list(ranks)
    rng.shuffle(shown)
    return fmt_hand(shown)


def deal_endgame(n: int, k: int, rng: random.Random) -> tuple[list[str], list[str], list[str]]:
    """
    Classic GOPS midgame: three independent suits (prize + two hands).

    Each role samples k ranks from A..N independently — ranks may overlap
    across hands and prizes (they are different physical suits).
    With EQUAL_DEALS, P2 mirrors P1's ranks exactly.
    """
    ranks = ranks_for_n(n)
    player = sorted(rng.sample(ranks, k), key=bit_for_rank)
    if EQUAL_DEALS:
        ai = list(player)
    else:
        ai = sorted(rng.sample(ranks, k), key=bit_for_rank)
    pile = rng.sample(ranks, k)
    return player, ai, pile


def opening_value_p1(
    solver: GopsNashSolver,
    player: list[str],
    ai: list[str],
    pile: list[str],
    *,
    sm_sims: int = SM_SIMS_DEFAULT,
    seed: int = 0,
) -> float:
    """W–L value for P1 at the first face-up (sd=0). Exact if rem≤7 else SM."""
    if not pile:
        return 0.0
    return position_value_p1(
        solver,
        player,
        ai,
        pile[1:],
        [pile[0]],
        sd=0,
        sm_sims=sm_sims,
        seed=seed,
    )


def sm_strategy(
    n: int,
    h1: int,
    h2: int,
    rest: int,
    pending: int,
    sd: int,
    *,
    sims: int = SM_SIMS_DEFAULT,
    seed: int = 0,
) -> tuple[float, list[float], list[int]]:
    """Depth-1 SM-MCTS bulk mix for P1 at this face-up."""
    sims = max(8, int(sims))
    search = SMSearch(
        n,
        max_depth=1,
        playouts_per_sample=sims,
        sims_max=sims,
    )
    v, probs, bits, _stats = search.search(
        h1,
        h2,
        rest,
        pending,
        sd,
        budget_ms=0.0,
        iterations=sims,
        seed=seed,
    )
    return float(v), list(probs), list(bits)


def position_value_p1(
    solver: GopsNashSolver,
    player: list[str],
    ai: list[str],
    pile: list[str],
    pending: list[str],
    sd: int,
    *,
    sm_sims: int = SM_SIMS_DEFAULT,
    seed: int = 0,
) -> float:
    """W–L value for P1: exact if rem≤7, else SM-MCTS estimate."""
    if not pending and not pile:
        if sd > 0:
            return 1.0
        if sd < 0:
            return -1.0
        return 0.0
    # Equal hands + sd=0 ⇒ V≡0 (solver symmetry); skip LP/SM.
    if player == ai and sd == 0:
        return 0.0
    h1 = mask_from_ranks(player)
    h2 = mask_from_ranks(ai)
    pend = mask_from_ranks(pending)
    rest = mask_from_ranks(pile)
    rem = len(player)
    if rem <= EXACT_REM_MAX:
        return float(solver._value(h1, h2, rest, pend, sd))
    v, _p, _b = sm_strategy(
        solver.n, h1, h2, rest, pend, sd, sims=sm_sims, seed=seed
    )
    return v


def deal_endgame_winnable(
    solver: GopsNashSolver,
    n: int,
    k: int,
    rng: random.Random,
    *,
    chance_lo: float = CHANCE_BOUNDS[0],
    chance_hi: float = CHANCE_BOUNDS[1],
    max_tries: int = 20_000,
) -> tuple[list[str], list[str], list[str], float, int]:
    """
    Sample endgames until P1 win chance is in [chance_lo, chance_hi]
    (draws as half; P2 chance is 1 - P1).
    Returns (player, ai, pile, V_p1, tries).
    """
    # P1 chance = (1+V)/2
    for tries in range(1, max_tries + 1):
        player, ai, pile = deal_endgame(n, k, rng)
        v = opening_value_p1(solver, player, ai, pile)
        p1 = 0.5 * (1.0 + v)
        if chance_lo <= p1 <= chance_hi:
            return player, ai, pile, v, tries
    raise RuntimeError(
        f"could not find a {100 * chance_lo:.0f}–{100 * chance_hi:.0f}% "
        f"k={k} deal in {max_tries} tries"
    )


def fmt_nash_chances(v_p1: float) -> str:
    """
    W–L value V = P(win)-P(loss). Report (1±V)/2 as win chances with draws
    counted as half a win (unique recovery from V alone).
    """
    p1 = 0.5 * (1.0 + v_p1)
    p2 = 0.5 * (1.0 - v_p1)
    if v_p1 >= 1.0 - 2.5e-3:
        note = "P1 forces a win"
    elif v_p1 <= -1.0 + 2.5e-3:
        note = "P2 forces a win"
    else:
        note = f"V(P1)={v_p1:+.4f}"
    return (
        f"Perfect play: P1 win chance {100.0 * p1:.1f}%, "
        f"P2 {100.0 * p2:.1f}%  ({note}; draws as half)"
    )


def fmt_nash_mix_line(label: str, bits: list[int], probs) -> str:
    """One line of card:pct for mass ≥0.5%."""
    parts = []
    for b, p in zip(bits, probs):
        if float(p) >= 0.005:
            parts.append(f"{ALL_RANKS[b]}:{100.0 * float(p):.0f}%")
    return f"{label}  " + ("  ".join(parts) if parts else "(—)")


def print_nash_mixes(
    solver: GopsNashSolver,
    player: list[str],
    ai: list[str],
    pile: list[str],
    pending: list[str],
    sd: int,
    *,
    sm_sims: int = SM_SIMS_DEFAULT,
    seed: int = 0,
) -> None:
    """Print bid mixes for You (P1) and AI (P2): exact if rem≤7 else SM."""
    for line in nash_mix_lines(
        solver,
        player,
        ai,
        pile,
        pending,
        sd,
        sm_sims=sm_sims,
        seed=seed,
    ):
        print(line, flush=True)


def nash_mix_lines(
    solver: GopsNashSolver,
    player: list[str],
    ai: list[str],
    pile: list[str],
    pending: list[str],
    sd: int,
    *,
    sm_sims: int = SM_SIMS_DEFAULT,
    seed: int = 0,
) -> list[str]:
    """Bid mix lines for You (P1) and AI (P2): exact if rem≤7 else SM."""
    if not pending:
        return []
    h1 = mask_from_ranks(player)
    h2 = mask_from_ranks(ai)
    rest = mask_from_ranks(pile)
    pend = mask_from_ranks(pending)
    rem = len(player)
    # Equal hands + sd=0 ⇒ identical mixes by symmetry (don't run two noisy SMs).
    symmetric = player == ai and sd == 0
    try:
        if rem <= EXACT_REM_MAX:
            _v1, p1, bits1 = solver.strategy(h1, h2, rest, pend, sd)
            if symmetric:
                p2, bits2 = p1, bits1
            else:
                _v2, p2, bits2 = solver.strategy(h2, h1, rest, pend, -sd)
            lab_you, lab_ai = "Nash You:", "Nash AI: "
        else:
            _v1, p1, bits1 = sm_strategy(
                solver.n, h1, h2, rest, pend, sd, sims=sm_sims, seed=seed
            )
            if symmetric:
                p2, bits2 = p1, bits1
            else:
                _v2, p2, bits2 = sm_strategy(
                    solver.n,
                    h2,
                    h1,
                    rest,
                    pend,
                    -sd,
                    sims=sm_sims,
                    seed=seed + 1,
                )
            lab_you, lab_ai = f"SM{sm_sims} You:", f"SM{sm_sims} AI: "
    except Exception as exc:
        return [f"Mix: (unavailable: {exc})"]
    return [
        fmt_nash_mix_line(lab_you, bits1, p1),
        fmt_nash_mix_line(lab_ai, bits2, p2),
    ]


def parse_kv_args(argv: list[str]) -> dict:
    n = None
    k = None
    seed = None
    workers = 1
    build_only = False
    full = False
    use_table = False
    daemon = False
    stop_daemon = False
    show_nash = False
    sm_sims = SM_SIMS_DEFAULT
    vs = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            return {"help": True}
        if a == "--daemon":
            daemon = True
            i += 1
            continue
        if a == "--stop":
            stop_daemon = True
            i += 1
            continue
        if a == "--nash":
            show_nash = True
            i += 1
            continue
        if a == "--vs":
            vs = True
            i += 1
            continue
        if a in ("--build", "--build-only"):
            build_only = True
            i += 1
            continue
        if a == "--table":
            use_table = True
            i += 1
            continue
        if a == "--full":
            full = True
            i += 1
            continue
        if a in ("--seed", "-s"):
            seed = int(argv[i + 1])
            i += 2
            continue
        if a in ("--sims",):
            sm_sims = int(argv[i + 1])
            i += 2
            continue
        if a.startswith("--sims="):
            sm_sims = int(a.split("=", 1)[1])
            i += 1
            continue
        if a.startswith("sims="):
            sm_sims = int(a.split("=", 1)[1])
            i += 1
            continue
        if a in ("--workers", "-w"):
            workers = int(argv[i + 1])
            i += 2
            continue
        if a.startswith("--workers="):
            workers = int(a.split("=", 1)[1])
            i += 1
            continue
        if a in ("--N", "-n"):
            n = int(argv[i + 1])
            i += 2
            continue
        if a in ("--K", "-k"):
            k = int(argv[i + 1])
            i += 2
            continue
        if a.startswith("n=") or a.startswith("N="):
            n = int(a.split("=", 1)[1])
            i += 1
            continue
        if a.startswith("k=") or a.startswith("K="):
            k = int(a.split("=", 1)[1])
            i += 1
            continue
        if a.startswith("seed="):
            seed = int(a.split("=", 1)[1])
            i += 1
            continue
        if a.startswith("workers="):
            workers = int(a.split("=", 1)[1])
            i += 1
            continue
        if a.isdigit():
            if n is None:
                n = int(a)
            elif seed is None:
                seed = int(a)
            i += 1
            continue
        print(f"Unknown argument: {a}", file=sys.stderr)
        return {"help": True, "error": True}
    if n is None:
        n = 13
    if k is None:
        k = 2
    if workers < 1:
        print("Need workers>=1", file=sys.stderr)
        return {"help": True, "error": True}
    if sm_sims < 8:
        print("Need sims>=8", file=sys.stderr)
        return {"help": True, "error": True}
    return {
        "n": n,
        "k": k,
        "seed": seed,
        "workers": workers,
        "build_only": build_only,
        "full": full,
        "use_table": use_table,
        "daemon": daemon,
        "stop_daemon": stop_daemon,
        "show_nash": show_nash,
        "sm_sims": sm_sims,
        "vs": vs,
    }


def ai_bid(
    solver: GopsNashSolver,
    *,
    ai_hand: list[str],
    player_hand: list[str],
    pile: list[str],
    pending: list[str],
    sd: int,
    k_max: int,
    rng: random.Random,
    sm_sims: int = SM_SIMS_DEFAULT,
) -> str:
    """Return a rank string from ai_hand. Exact if rem≤7 else SM-MCTS."""
    rem = len(ai_hand)
    h_ai = mask_from_ranks(ai_hand)
    h_pl = mask_from_ranks(player_hand)
    rest = mask_from_ranks(pile)
    pend = mask_from_ranks(pending)

    # Table / solve is P1-perspective; AI is P2 → swap hands and negate sd.
    try:
        if rem <= EXACT_REM_MAX:
            _, probs, bits = solver.strategy(h_ai, h_pl, rest, pend, -sd)
        else:
            _v, probs, bits = sm_strategy(
                solver.n,
                h_ai,
                h_pl,
                rest,
                pend,
                -sd,
                sims=sm_sims,
                seed=rng.randrange(1 << 30),
            )
        idx = rng.choices(range(len(bits)), weights=list(probs), k=1)[0]
        return ALL_RANKS[bits[idx]]
    except Exception as exc:
        print(f"[ai] mix fallback ({exc})", file=sys.stderr)

    return rng.choice(ai_hand)


def _empty_solver(n: int) -> GopsNashSolver:
    clear_dominance_memos()
    if _cy is not None:
        _cy.clear_piecewise()
    solver = GopsNashSolver(n)
    solver.cache = {}
    solver.k_ship = 0
    solver.table_k_max = 0
    return solver


def load_solver(
    n: int, k_max: int, *, use_table: bool = False
) -> tuple[GopsNashSolver, int]:
    """
    Load Nash support for endgame play at remaining <= k_max.

    Default: no table (on-demand LP). With use_table=True, load exact table
    if present else the largest available for N (does not build).
    SM-MCTS is used online for rem > EXACT_REM_MAX regardless of table.
    """
    warmup()
    warmup_sm()
    if n <= 6:
        print(f"Solving full N={n} in memory (exact)...", flush=True)
        solver = GopsNashSolver(n)
        solver.opening_value()
        print(f"  cache={solver.cache_size:,}", flush=True)
        return solver, n

    if not use_table:
        print(
            f"On-demand LP for rem≤{EXACT_REM_MAX}; "
            f"SM-MCTS above (default {SM_SIMS_DEFAULT} sims/cell). "
            f"Pass --table to load an endgame table.",
            flush=True,
        )
        return _empty_solver(n), k_max

    path = find_play_table(n, k_max)
    if path is None:
        print(
            f"No endgame table for N={n}. "
            f"Exact rem≤{EXACT_REM_MAX}, SM above. "
            f"Build with: gops k={k_max} --build",
            flush=True,
        )
        return _empty_solver(n), k_max

    print(f"Loading {path.name}...", flush=True)
    solver = load_table(n, k_max, path, allow_smaller_table=True)
    k_ship = int(getattr(solver, "k_ship", 0))
    table_k = int(getattr(solver, "table_k_max", k_max))
    extras = []
    if table_k < k_max:
        extras.append(f"table play-meta K={table_k} < deal k={k_max}")
    if k_ship < k_max:
        extras.append(f"ship k<={k_ship}; k>{k_ship} on demand")
    extra = f" ({'; '.join(extras)})" if extras else ""
    print(
        f"  frac/cache={solver.cache_size:,}{extra} "
        f"(exact rem≤{EXACT_REM_MAX}; SM above)",
        flush=True,
    )
    return solver, k_max


def _fmt_int(n: int) -> str:
    return f"{n:,}"


def _fmt_turn_line(t_ai: float, rem: int, stats: dict | None, cache_n: int) -> str:
    """One-line AI turn timing + DP/matrix counters for optimization."""
    base = f"AI turn {_fmt_secs(t_ai)}  (rem={rem})"
    if not stats:
        return f"{base}  cache={_fmt_int(cache_n)}"
    matrix = int(stats.get("matrix", 0))
    visits = int(stats.get("visits", 0))
    hits = (
        int(stats.get("cache_hit", 0))
        + int(stats.get("plateau", 0))
        + int(stats.get("piecewise", 0))
    )
    hit_pct = (100.0 * hits / visits) if visits else 0.0
    parts = [
        base,
        f"solves={_fmt_int(matrix)}",
        f"new={_fmt_int(int(stats.get('frac_new', 0)))}",
        f"visits={_fmt_int(visits)}",
        f"hit={hit_pct:.0f}%",
        f"forced={_fmt_int(int(stats.get('forced', 0)))}",
        f"cache={_fmt_int(cache_n)}",
    ]
    m_parts = []
    for key, label in (
        ("m_lp", "lp"),
        ("m_2x2", "2x2"),
        ("m_pure", "pure"),
        ("m_approx", "approx"),
    ):
        v = int(stats.get(key, 0))
        if v:
            m_parts.append(f"{label}={_fmt_int(v)}")
    if m_parts:
        parts.append("(" + " ".join(m_parts) + ")")
    pw = int(stats.get("piecewise", 0))
    if pw:
        parts.append(f"table={_fmt_int(pw)}")
    return "  ".join(parts)


def ask_prize(pile: list[str]) -> str:
    """Prompt for a prize card from the remaining pile."""
    left = fmt_hand(pile)
    while True:
        raw = input("Prize: ").strip()
        card = parse_bid(raw, pile)
        if card is None:
            print(f"Enter a remaining prize ({left}).")
            continue
        return card


def play_loop(
    *,
    solver: GopsNashSolver,
    player: list[str],
    ai: list[str],
    pile: list[str],
    k_eff: int,
    rng: random.Random,
    show_ai_hand: bool,
    show_nash: bool = False,
    sm_sims: int = SM_SIMS_DEFAULT,
    vs: bool = False,
) -> None:
    pending: list[str] = []
    player_score = 0
    ai_score = 0

    def stake() -> int:
        return sum(card_value(bit_for_rank(r)) for r in pending)

    def fmt_pending() -> str:
        return pending[0] if len(pending) == 1 else "+".join(pending)

    def reveal_next() -> bool:
        """Add next prize into pending. Returns False if none left."""
        if not pile:
            return False
        if vs:
            print(f"Left   {fmt_hand(pile)}")
            card = ask_prize(pile)
            pile.remove(card)
            pending.append(card)
        else:
            pending.append(pile.pop(0))
        return True

    while player:
        if not pending:
            if not reveal_next():
                break

        print(f"Prize  {fmt_pending()}")
        print()
        print(f"P1 Hand {fmt_hand(player)}")
        if show_ai_hand:
            print(f"P2 Hand {fmt_hand(ai)}")

        sd = player_score - ai_score

        def run_ai() -> str:
            if _cy is not None and hasattr(_cy, "reset_turn_stats"):
                _cy.reset_turn_stats()
            t_ai0 = time.perf_counter()
            card = ai_bid(
                solver,
                ai_hand=ai,
                player_hand=player,
                pile=pile,
                pending=pending,
                sd=sd,
                k_max=k_eff,
                rng=rng,
                sm_sims=sm_sims,
            )
            t_ai = time.perf_counter() - t_ai0
            stats = (
                dict(_cy.turn_stats())
                if _cy is not None and hasattr(_cy, "turn_stats")
                else None
            )
            cache_n = len(solver.cache)
            print(f"AI:    {card}")
            print(_fmt_turn_line(t_ai, len(ai), stats, cache_n), flush=True)
            return card

        def ask_you() -> str:
            while True:
                raw = input("You:   ").strip()
                bid = parse_bid(raw, player)
                if bid is None:
                    print(f"Enter a card from your hand ({fmt_hand(player)}).")
                    continue
                return bid

        if vs:
            # AI bids first (visible), then you answer.
            ai_card = run_ai()
            print()
            bid = ask_you()
        else:
            bid = ask_you()
            ai_card = run_ai()
            print()

        st = stake()
        prize = fmt_pending()
        player.remove(bid)
        ai.remove(ai_card)
        pv = card_value(bit_for_rank(bid))
        av = card_value(bit_for_rank(ai_card))

        if pv > av:
            player_score += st
            pending.clear()
            print(f"You take {prize} (+{st})")
        elif av > pv:
            ai_score += st
            pending.clear()
            print(f"AI takes {prize} (+{st})")
        else:
            print("Tie - prizes roll over")
            if pile:
                reveal_next()
            else:
                pending.clear()

        print(f"Score  {player_score}-{ai_score}")

        if not player:
            break
        if not pending:
            if not reveal_next():
                break
        # After this round: odds for the next face-up position.
        sd_next = player_score - ai_score
        v_next = position_value_p1(
            solver,
            player,
            ai,
            pile,
            pending,
            sd_next,
            sm_sims=sm_sims,
            seed=rng.randrange(1 << 30),
        )
        note = "" if len(player) <= EXACT_REM_MAX else "  [SM est.]"
        print(fmt_nash_chances(v_next) + note, flush=True)
        if show_nash:
            print_nash_mixes(
                solver,
                player,
                ai,
                pile,
                pending,
                sd_next,
                sm_sims=sm_sims,
                seed=rng.randrange(1 << 30),
            )
        print("----------------")

    if pending:
        print()
        print(f"Unclaimed {fmt_pending()} (final tie)")

    print()
    if player_score > ai_score:
        print(f"You win!  {player_score}-{ai_score}")
    elif ai_score > player_score:
        print(f"AI wins.  {player_score}-{ai_score}")
    else:
        print(f"Draw.     {player_score}-{ai_score}")



def _fmt_secs(seconds: float) -> str:
    if seconds < 0.001:
        return f"{seconds * 1e6:.0f}µs"
    if seconds < 1.0:
        return f"{seconds * 1e3:.1f}ms"
    return f"{seconds:.2f}s"


def _print_startup(
    *,
    cold: bool,
    t_load: float,
    t_deal: float,
    tries: int | None = None,
    t_solve: float = 0.0,
) -> None:
    if cold and not _DAEMON_READY:
        parts = [f"imports {_fmt_secs(_T_IMPORTS)}", f"load {_fmt_secs(t_load)}"]
    elif cold:
        parts = [f"load {_fmt_secs(t_load)}"]
    else:
        # Warm rematch / daemon reuse — still report last load cost (often ~0).
        parts = ["warm", f"load {_fmt_secs(t_load)}"]
    if t_solve:
        parts.append(f"solve {_fmt_secs(t_solve)}")
    if tries is not None:
        deal_s = (
            f"deal+solve {_fmt_secs(t_deal)} ({tries} deal"
            f"{'' if tries == 1 else 's'})"
        )
        parts.append(deal_s)
    print(f"Startup: {', '.join(parts)}  (wall {_fmt_secs(_wall_secs())})", flush=True)


def play_one(
    *,
    solver: GopsNashSolver,
    n: int,
    k_max: int,
    k_eff: int,
    seed: int | None,
    full: bool,
    cold: bool,
    t_load: float,
    show_nash: bool = False,
    sm_sims: int = SM_SIMS_DEFAULT,
    vs: bool = False,
) -> None:
    ranks = ranks_for_n(n)
    rng = random.Random(seed)
    ai_note = f"exact≤{EXACT_REM_MAX} / SM{sm_sims}>"

    if full:
        player = ranks[:]
        ai = ranks[:]
        pile = ranks[:]
        rng.shuffle(pile)
        print(f"GOPS - N={n} full game  AI={ai_note}")
        print(f"Cards: {','.join(ranks)}. Ace low. You=P1, AI=P2.")
        t_solve0 = time.perf_counter()
        v0 = opening_value_p1(
            solver,
            player,
            ai,
            pile,
            sm_sims=sm_sims,
            seed=rng.randrange(1 << 30),
        )
        t_solve = time.perf_counter() - t_solve0
        note = "" if n <= EXACT_REM_MAX else "  [SM est.]"
        print(fmt_nash_chances(v0) + note)
        if show_nash and pile and not vs:
            print_nash_mixes(
                solver,
                player,
                ai,
                pile[1:],
                [pile[0]],
                sd=0,
                sm_sims=sm_sims,
                seed=rng.randrange(1 << 30),
            )
        _print_startup(cold=cold, t_load=t_load, t_deal=0.0, t_solve=t_solve)
        print()
        play_loop(
            solver=solver,
            player=player,
            ai=ai,
            pile=pile,
            k_eff=k_eff,
            rng=rng,
            show_ai_hand=False,
            show_nash=show_nash,
            sm_sims=sm_sims,
            vs=vs,
        )
        return

    k = min(k_max, n)
    t_deal0 = time.perf_counter()
    player, ai, pile, v0, tries = deal_endgame_winnable(
        solver, n, k, rng, chance_lo=CHANCE_BOUNDS[0], chance_hi=CHANCE_BOUNDS[1]
    )
    t_deal = time.perf_counter() - t_deal0
    print(f"GOPS - N={n} endgame k={k}  AI={ai_note}")
    print(f"Cards: {','.join(ranks)}. Ace low. You=P1, AI=P2.")
    note = "" if k <= EXACT_REM_MAX else "  [SM est.]"
    # deal_endgame_winnable used opening_value; refresh with SM if rem>7 unequal
    if k > EXACT_REM_MAX and player != ai:
        v0 = opening_value_p1(
            solver,
            player,
            ai,
            pile,
            sm_sims=sm_sims,
            seed=rng.randrange(1 << 30),
        )
    print(fmt_nash_chances(v0) + note)
    if show_nash and pile and not vs:
        print_nash_mixes(
            solver,
            player,
            ai,
            pile[1:],
            [pile[0]],
            sd=0,
            sm_sims=sm_sims,
            seed=rng.randrange(1 << 30),
        )
    _print_startup(cold=cold, t_load=t_load, t_deal=t_deal, tries=tries)
    print()
    print(f"P1 Hand {fmt_hand(player)}")
    print(f"P2 Hand {fmt_hand(ai)}")
    print(f"Prizes  {fmt_prize_set(pile, rng)}")
    print()
    play_loop(
        solver=solver,
        player=player,
        ai=ai,
        pile=pile,
        k_eff=k_eff,
        rng=rng,
        show_ai_hand=True,
        show_nash=show_nash,
        sm_sims=sm_sims,
        vs=vs,
    )


class _ConnTextIO:
    """Minimal text IO over a TCP socket for print()/input()."""

    encoding = "utf-8"
    errors = "replace"
    closed = False

    def __init__(self, conn: socket.socket, *, writing: bool):
        self._conn = conn
        self._writing = writing
        self._buf = ""
        self.buffer = self

    def writable(self) -> bool:
        return self._writing

    def readable(self) -> bool:
        return not self._writing

    def write(self, s: str) -> int:
        if not s:
            return 0
        self._conn.sendall(s.encode(self.encoding, self.errors))
        return len(s)

    def flush(self) -> None:
        return None

    def fileno(self) -> int:
        return self._conn.fileno()

    def isatty(self) -> bool:
        return False

    def readline(self, limit: int = -1) -> str:
        while "\n" not in self._buf:
            try:
                chunk = self._conn.recv(4096)
            except OSError:
                chunk = b""
            if not chunk:
                line, self._buf = self._buf, ""
                return line
            self._buf += chunk.decode(self.encoding, self.errors)
            if limit > 0 and len(self._buf) >= limit:
                break
        if limit > 0 and "\n" not in self._buf[:limit]:
            line, self._buf = self._buf[:limit], self._buf[limit:]
            return line
        i = self._buf.find("\n")
        line, self._buf = self._buf[: i + 1], self._buf[i + 1 :]
        return line

    def read(self, n: int = -1) -> str:
        if n == 0:
            return ""
        if n < 0:
            parts = [self._buf]
            self._buf = ""
            while True:
                try:
                    chunk = self._conn.recv(4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                parts.append(chunk.decode(self.encoding, self.errors))
            return "".join(parts)
        while len(self._buf) < n:
            try:
                chunk = self._conn.recv(4096)
            except OSError:
                chunk = b""
            if not chunk:
                break
            self._buf += chunk.decode(self.encoding, self.errors)
        out, self._buf = self._buf[:n], self._buf[n:]
        return out


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _read_daemon_state() -> dict | None:
    try:
        data = json.loads(DAEMON_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _write_daemon_state(port: int) -> None:
    payload = {
        "port": port,
        "pid": os.getpid(),
        # Epoch ms — launcher restarts if watched sources are newer.
        "boot_ms": int(time.time() * 1000),
    }
    DAEMON_STATE_PATH.write_text(json.dumps(payload), encoding="utf-8")


def _clear_daemon_state() -> None:
    try:
        DAEMON_STATE_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def _daemon_send_cmd(cmd: str, *, timeout: float = 2.0) -> str | None:
    st = _read_daemon_state()
    if not st or not _pid_alive(int(st.get("pid", 0))):
        return None
    port = int(st["port"])
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
            sock.sendall((json.dumps({"cmd": cmd}) + "\n").encode("utf-8"))
            sock.shutdown(socket.SHUT_WR)
            chunks: list[bytes] = []
            while True:
                b = sock.recv(4096)
                if not b:
                    break
                chunks.append(b)
            return b"".join(chunks).decode("utf-8", "replace")
    except OSError:
        return None


def stop_daemon() -> int:
    reply = _daemon_send_cmd("stop")
    if reply is None:
        _clear_daemon_state()
        print("gops daemon is not running.", flush=True)
        return 0
    _clear_daemon_state()
    print("gops daemon stopped.", flush=True)
    return 0


def _ranks_from_req(xs, *, label: str) -> list[str]:
    if not isinstance(xs, list):
        raise ValueError(f"{label} must be a list")
    out: list[str] = []
    for x in xs:
        s = str(x).strip().upper()
        s = ALIASES.get(s, s)
        if s not in ALL_RANKS:
            raise ValueError(f"bad rank in {label}: {x!r}")
        out.append(s)
    return out


class _DaemonSession:
    """Reuse solvers across client connections (warm import+cache)."""

    def __init__(self) -> None:
        self.solver: GopsNashSolver | None = None
        self.k_eff = 2
        self.loaded_key: tuple | None = None
        self.t_load = 0.0

    def ensure_solver(
        self, n: int, load_k: int, *, use_table: bool = False
    ) -> tuple[GopsNashSolver, int, bool]:
        key = (n, load_k, use_table, False)
        cold = False
        if self.loaded_key != key:
            t0 = time.perf_counter()
            # load_solver prints status with Unicode; silence so Windows consoles
            # / redirected stdio cannot raise UnicodeEncodeError into bid JSON.
            old_out, old_err = sys.stdout, sys.stderr
            try:
                with open(os.devnull, "w", encoding="utf-8") as sink:
                    sys.stdout = sink  # type: ignore[assignment]
                    sys.stderr = sink  # type: ignore[assignment]
                    self.solver, self.k_eff = load_solver(
                        n, load_k, use_table=use_table
                    )
            finally:
                sys.stdout, sys.stderr = old_out, old_err
            self.t_load = time.perf_counter() - t0
            self.loaded_key = key
            cold = True
        assert self.solver is not None
        return self.solver, self.k_eff, cold

    def play(self, opts: dict) -> None:
        n, k_max = opts["n"], opts["k"]
        full = bool(opts.get("full"))
        use_table = bool(opts.get("use_table"))
        load_k = n if (full and n <= 6) else k_max
        # Full small-n solve is keyed separately so bid caches stay distinct.
        if full and n <= 6:
            key = (n, load_k, use_table, True)
            cold = False
            if self.loaded_key != key:
                t0 = time.perf_counter()
                self.solver, self.k_eff = load_solver(n, load_k, use_table=use_table)
                self.t_load = time.perf_counter() - t0
                self.loaded_key = key
                cold = True
            assert self.solver is not None
            solver, k_eff = self.solver, self.k_eff
        else:
            solver, k_eff, cold = self.ensure_solver(
                n, load_k, use_table=use_table
            )
        play_one(
            solver=solver,
            n=n,
            k_max=k_max,
            k_eff=k_eff,
            seed=opts.get("seed"),
            full=full,
            cold=cold,
            t_load=self.t_load,
            show_nash=bool(opts.get("show_nash")),
            sm_sims=int(opts.get("sm_sims") or SM_SIMS_DEFAULT),
            vs=bool(opts.get("vs")),
        )

    def bid(self, req: dict) -> dict:
        """One Nash/SM bid for the browser / HTTP bridge. Same path as terminal AI."""
        n = int(req.get("n") or 13)
        if not (1 <= n <= 13):
            raise ValueError("n must be 1..13")
        use_table = bool(req.get("use_table"))
        load_k = int(req.get("k") or n)
        load_k = max(2, min(load_k, n))
        sm_sims = int(req.get("sm_sims") or SM_SIMS_DEFAULT)
        seed = req.get("seed")
        rng = random.Random(None if seed is None else int(seed))
        eval_only = bool(req.get("evalOnly") or req.get("eval_only"))
        want_mixes = bool(req.get("mixes", True))

        # Prefer browser Engine.toJSON field names; also accept terminal names.
        ai_hand = _ranks_from_req(
            req.get("aiHand") if "aiHand" in req else req.get("ai_hand"),
            label="aiHand",
        )
        player_hand = _ranks_from_req(
            req.get("playerHand") if "playerHand" in req else req.get("player_hand"),
            label="playerHand",
        )
        pile = _ranks_from_req(
            req.get("prizePile") if "prizePile" in req else req.get("pile"),
            label="prizePile",
        )
        pending = _ranks_from_req(
            req.get("pendingPrizes")
            if "pendingPrizes" in req
            else req.get("pending"),
            label="pendingPrizes",
        )
        if not ai_hand:
            raise ValueError("aiHand is empty")
        if len(ai_hand) != len(player_hand):
            raise ValueError("hands must be the same length")
        if not pending:
            raise ValueError("pendingPrizes is empty")

        if "sd" in req and req["sd"] is not None:
            sd = int(req["sd"])
        else:
            ps = int(req.get("playerScore") or req.get("player_score") or 0)
            a_s = int(req.get("aiScore") or req.get("ai_score") or 0)
            sd = ps - a_s

        solver, k_eff, cold = self.ensure_solver(n, load_k, use_table=use_table)
        rem = len(ai_hand)
        mode = "exact" if rem <= EXACT_REM_MAX else "sm"
        seed_i = rng.randrange(1 << 30)

        v = position_value_p1(
            solver,
            player_hand,
            ai_hand,
            pile,
            pending,
            sd,
            sm_sims=sm_sims,
            seed=seed_i,
        )
        note = "" if rem <= EXACT_REM_MAX else "  [SM est.]"
        chances = fmt_nash_chances(v) + note
        mixes = (
            nash_mix_lines(
                solver,
                player_hand,
                ai_hand,
                pile,
                pending,
                sd,
                sm_sims=sm_sims,
                seed=seed_i,
            )
            if want_mixes
            else []
        )

        out: dict = {
            "mode": mode,
            "rem": rem,
            "cold": cold,
            "sm_sims": sm_sims if mode == "sm" else None,
            "value": round(float(v), 6),
            "chances": chances,
            "mixes": mixes,
        }
        if eval_only:
            return out

        if _cy is not None and hasattr(_cy, "reset_turn_stats"):
            _cy.reset_turn_stats()
        t0 = time.perf_counter()
        card = ai_bid(
            solver,
            ai_hand=ai_hand,
            player_hand=player_hand,
            pile=pile,
            pending=pending,
            sd=sd,
            k_max=k_eff,
            rng=rng,
            sm_sims=sm_sims,
        )
        t_ai = time.perf_counter() - t0
        stats = (
            dict(_cy.turn_stats())
            if _cy is not None and hasattr(_cy, "turn_stats")
            else None
        )
        out["bid"] = card
        out["ms"] = round(t_ai * 1000.0, 3)
        out["turn_line"] = _fmt_turn_line(t_ai, rem, stats, len(solver.cache))
        return out


def _handle_daemon_conn(conn: socket.socket, session: _DaemonSession) -> bool:
    """
    Serve one client. Returns False if the daemon should exit (stop).
    Request line: {"cmd":"play"|"ping"|"stop"|"bid", ...}
    """
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    buf = ""
    while "\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            return True
        buf += chunk.decode("utf-8", "replace")
    line, rest = buf.split("\n", 1)
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        conn.sendall(b'{"error":"bad request"}\n')
        return True

    cmd = str(req.get("cmd", "play"))
    if cmd == "ping":
        conn.sendall(b"pong\n")
        return True
    if cmd == "stop":
        conn.sendall(b"bye\n")
        return False
    if cmd == "bid":
        try:
            out = session.bid(req)
            conn.sendall((json.dumps(out) + "\n").encode("utf-8"))
        except Exception as exc:
            conn.sendall(
                (json.dumps({"error": str(exc)}) + "\n").encode("utf-8")
            )
        return True

    argv = req.get("argv") or []
    if not isinstance(argv, list):
        argv = []
    opts = parse_kv_args([str(a) for a in argv])
    if opts.get("help") or opts.get("error"):
        conn.sendall(b"bad args\n")
        return True
    n, k = opts["n"], opts["k"]
    if not (1 <= n <= 13 and 2 <= k <= 13) or k > n:
        conn.sendall(b"Need 1<=n<=13 and 2<=k<=n\n")
        return True

    wall0 = req.get("wall0")
    _set_wall0_ms(str(wall0) if wall0 is not None else None)

    # Leftover bytes after the header are already typed stdin.
    reader = _ConnTextIO(conn, writing=False)
    reader._buf = rest
    writer = _ConnTextIO(conn, writing=True)
    old_in, old_out = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = reader, writer  # type: ignore[assignment]
    try:
        session.play(opts)
    except (EOFError, BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        sys.stdin, sys.stdout = old_in, old_out
        try:
            conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    return True


def run_daemon() -> None:
    """Warm process: bind localhost, keep solvers, serve `gops` clients."""
    global _DAEMON_READY
    warmup()
    _DAEMON_READY = True

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    port = int(srv.getsockname()[1])
    _write_daemon_state(port)
    session = _DaemonSession()
    try:
        while True:
            conn, _addr = srv.accept()
            with conn:
                if not _handle_daemon_conn(conn, session):
                    break
    finally:
        srv.close()
        _clear_daemon_state()


def play_direct(
    n: int,
    k_max: int,
    seed: int | None,
    *,
    full: bool = False,
    use_table: bool = False,
    show_nash: bool = False,
    sm_sims: int = SM_SIMS_DEFAULT,
    vs: bool = False,
) -> None:
    """Cold single-process play (no daemon)."""
    load_k = n if (full and n <= 6) else k_max
    t0 = time.perf_counter()
    solver, k_eff = load_solver(n, load_k, use_table=use_table)
    t_load = time.perf_counter() - t0
    play_one(
        solver=solver,
        n=n,
        k_max=k_max,
        k_eff=k_eff,
        seed=seed,
        full=full,
        cold=True,
        t_load=t_load,
        show_nash=show_nash,
        sm_sims=sm_sims,
        vs=vs,
    )


def main() -> None:
    opts = parse_kv_args(sys.argv[1:])
    if opts.get("help"):
        print(__doc__)
        sys.exit(1 if opts.get("error") else 0)
    if opts.get("daemon"):
        run_daemon()
        return
    if opts.get("stop_daemon"):
        sys.exit(stop_daemon())
    n, k = opts["n"], opts["k"]
    if not (1 <= n <= 13 and 2 <= k <= 13):
        print("Need 1<=n<=13 and 2<=k<=13", file=sys.stderr)
        sys.exit(1)
    if k > n:
        print("Need k<=n", file=sys.stderr)
        sys.exit(1)
    if opts.get("build_only"):
        path = ensure_table(n, k, force=True, workers=opts["workers"])
        print(f"=== Ready ===\n  {path}", flush=True)
        return
    # Direct invocation (debugging). Normal `gops` uses the daemon via gops.js.
    play_direct(
        n,
        k,
        opts.get("seed"),
        full=bool(opts.get("full")),
        use_table=bool(opts.get("use_table")),
        show_nash=bool(opts.get("show_nash")),
        sm_sims=int(opts.get("sm_sims") or SM_SIMS_DEFAULT),
        vs=bool(opts.get("vs")),
    )


if __name__ == "__main__":
    main()
