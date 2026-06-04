#!/usr/bin/env python3
"""Run solve → peel/dump loop; transcript matches banana/format.txt."""

from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path

# Starting rack size (tiles dealt before first solve). Override anytime: --hand 21
DEFAULT_HAND_SIZE = 4

_AI = Path(__file__).resolve().parent
sys.path.insert(0, str(_AI))

from banana.dictionary import get_dictionary
from banana.game import Game
from banana.transcript import Transcript


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Bananagrams AI (play.py). Change DEFAULT_HAND_SIZE or use --hand."
    )
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument(
        "--hand",
        type=int,
        default=DEFAULT_HAND_SIZE,
        metavar="N",
        help=f"Tiles dealt at start (default: {DEFAULT_HAND_SIZE}; solo game uses 21)",
    )
    ap.add_argument(
        "--turns",
        type=int,
        default=None,
        help="Max solve attempts (default: entire game)",
    )
    ap.add_argument("--timeout", type=float, default=5.0, help="Wall seconds (0=none)")
    ap.add_argument("--dict", type=Path, default=None)
    args = ap.parse_args()

    seed = args.seed if args.seed is not None else random.randint(0, 1_000_000)
    if args.hand < 1:
        print("error: --hand must be at least 1", file=sys.stderr)
        return 1

    d = get_dictionary(args.dict)
    g = Game(d, random.Random(seed), hand_size=args.hand, log=Transcript())
    print(f"[play] seed={seed}  hand={args.hand}  dict={d.label}", flush=True)

    deadline = None
    if args.timeout > 0:
        deadline = time.perf_counter() + args.timeout

    g.run(max_turns=args.turns, deadline=deadline)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
