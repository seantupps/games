"""Greedy 1-ply Quoridor policy: maximize (opp_path − my_path) after the move."""

from __future__ import annotations

import random
from typing import Optional

from . import Move, QuoridorGame
from .path import INF, warmup as path_warmup


def warmup() -> None:
    path_warmup()
    g = QuoridorGame()
    choose_greedy(g)  # JIT + legal-move path through once


def choose_greedy(
    game: QuoridorGame,
    rng: Optional[random.Random] = None,
) -> Optional[Move]:
    """
    Among legal moves, pick one maximizing score_for_player after applying.
    Ties broken at random (or first if rng is None → deterministic first).
    """
    legal = game.list_legal_moves()
    if not legal:
        return None

    me = game.pawn_of_turn.index
    best_score = -INF * 2
    best: list[Move] = []

    for mv in legal:
        child = game.clone()
        if not child.apply_move(mv):
            continue
        # After our move: if we won, take it immediately.
        if child.winner is not None and child.winner.index == me:
            return mv
        sc = child.score_for_player(me)
        if sc > best_score:
            best_score = sc
            best = [mv]
        elif sc == best_score:
            best.append(mv)

    if not best:
        return legal[0]
    if rng is None:
        return best[0]
    return rng.choice(best)


def choose_random_balanced(
    game: QuoridorGame,
    rng: random.Random,
) -> Optional[Move]:
    """50/50 between pawn moves and wall moves when both exist."""
    legal = game.list_legal_moves()
    if not legal:
        return None
    pawn = [m for m in legal if m.type == "move"]
    wall = [m for m in legal if m.type != "move"]
    if pawn and wall:
        pool = pawn if rng.random() < 0.5 else wall
    else:
        pool = pawn or wall
    return rng.choice(pool)
