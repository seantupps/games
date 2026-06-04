"""Pick up all tiles and rebuild."""

from __future__ import annotations

import random

from .grid import Board, validate_full
from .solver import _coords_for_word, apply_placement, find_best_placement


def rebuild(
    letters: list[str],
    dictionary,
    rng: random.Random,
    *,
    max_openers: int = 12,
    max_places: int = 48,
) -> tuple[Board, list[str]] | None:
    if len(letters) < 2 or len(letters) > 55:
        return None

    openers = dictionary.rack_words(letters, limit=max_openers + 4)[:max_openers]
    if not openers:
        return None

    best_board: Board | None = None
    best_rack: list[str] | None = None
    best_left = 999

    for opener in openers:
        board = Board()
        rack = [c.upper() for c in letters]
        w = opener.upper()
        for ch in w:
            try:
                rack.remove(ch)
            except ValueError:
                break
        else:
            apply_placement(board, w, _coords_for_word(w, 0, 0, 0, True))

        for _ in range(max_places):
            hit = find_best_placement(board, rack, dictionary)
            if not hit:
                break
            word, coords = hit
            take = [ch for c, ch in zip(coords, word.upper()) if c not in board.cells]
            for ch in take:
                rack.remove(ch)
            apply_placement(board, word, coords)

        if not validate_full(board, dictionary)["ok"]:
            continue
        if len(rack) < best_left:
            best_left = len(rack)
            best_board = board
            best_rack = rack
        if not rack:
            return board, []

    if best_board is None:
        return None
    return best_board, best_rack or []
