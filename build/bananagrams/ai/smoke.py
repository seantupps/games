#!/usr/bin/env python3
"""Smoke: pool check + format transcript."""

from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path

_AI = Path(__file__).resolve().parent
sys.path.insert(0, str(_AI))

from banana.dictionary import get_dictionary
from banana.game import Game
from banana.rules import POOL_SIZE, build_shuffled_pool, verify_all_tiles, verify_pool_contents
from banana.transcript import Transcript

SEED = 42


def _check_pool_randomness() -> None:
    a = build_shuffled_pool(random.Random(1))[:4]
    b = build_shuffled_pool(random.Random(1))[:4]
    c = build_shuffled_pool(random.Random(2))[:4]
    assert a == b
    assert a != c
    assert verify_pool_contents(build_shuffled_pool(random.Random(0)))
    print(f"pool ok  size={POOL_SIZE}  seed1={''.join(a)}  seed2={''.join(c)}\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--hand", type=int, default=4, help="Starting rack size (same as play.py --hand)")
    ap.add_argument("--turns", type=int, default=2)
    ap.add_argument("--timeout", type=float, default=5.0)
    args = ap.parse_args()

    _check_pool_randomness()

    d = get_dictionary()
    g = Game(d, random.Random(args.seed), hand_size=args.hand, log=Transcript())

    t0 = time.perf_counter()
    g.run(max_turns=args.turns, deadline=t0 + args.timeout)
    elapsed = time.perf_counter() - t0

    on_board = [g.board.cells[c] for c in g.board.cells]
    assert verify_all_tiles(g.rack, g.bunch, on_board)

    return 0 if elapsed < args.timeout else 1


if __name__ == "__main__":
    raise SystemExit(main())
