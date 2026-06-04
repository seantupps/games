"""Deal hand → solve (reorg allowed) → peel if empty → dump if stuck."""

from __future__ import annotations

import random
import time

from .grid import Board, validate_full
from .reorg import rebuild
from .rules import POOL_SIZE, build_shuffled_pool, verify_all_tiles, verify_hand_from_pool
from .solver import apply_placement, find_best_placement
from .transcript import Transcript


class Game:
    def __init__(
        self,
        dictionary,
        rng: random.Random,
        *,
        hand_size: int = 4,
        log: Transcript | None = None,
    ):
        self.dictionary = dictionary
        self.rng = rng
        self.hand_size = hand_size
        self.log = log or Transcript()
        self.bunch: list[str] = []
        self.rack: list[str] = []
        self.board = Board()
        self.dumps = 0
        self.peels = 0
        self.reorgs = 0
        self.attempt = 0
        self._deadline: float | None = None

    def _draw(self, n: int) -> list[str]:
        out: list[str] = []
        for _ in range(n):
            if not self.bunch:
                break
            out.append(self.bunch.pop())
        return out

    def _timed_out(self) -> bool:
        return self._deadline is not None and time.perf_counter() >= self._deadline

    def load_rack(self, letters: list[str]) -> None:
        """Start from an existing rack (e.g. browser hand) — no deal/shuffle."""
        self.rack = [c.upper() for c in letters]
        self.board = Board()
        self.bunch = []

    def deal(self) -> None:
        self.bunch = build_shuffled_pool(self.rng)
        if not verify_hand_from_pool([], self.bunch):
            raise RuntimeError("shuffled pool is not a valid 144-tile bag")
        self.rack = self._draw(self.hand_size)
        self.board = Board()
        if not verify_all_tiles(self.rack, self.bunch, []):
            raise RuntimeError("deal broke pool multiset")

    def _place_words(self) -> int:
        n = 0
        while not self._timed_out():
            hit = find_best_placement(self.board, self.rack, self.dictionary)
            if not hit:
                break
            word, coords = hit
            before_b = self.board.clone()
            before_r = list(self.rack)
            take = [
                ch
                for c, ch in zip(coords, word.upper())
                if c not in self.board.cells
            ]
            try:
                for ch in take:
                    self.rack.remove(ch)
            except ValueError:
                self.board = before_b
                self.rack = before_r
                break
            apply_placement(self.board, word, coords)
            if not validate_full(self.board, self.dictionary)["ok"]:
                self.board = before_b
                self.rack = before_r
                break
            n += 1
        return n

    def _reorganize(self) -> bool:
        letters = [self.board.cells[c] for c in self.board.cells] + list(self.rack)
        if len(letters) < 2:
            return False
        built = rebuild(letters, self.dictionary, self.rng)
        if not built:
            return False
        new_board, new_rack = built
        if len(new_rack) >= len(self.rack) and len(new_board) <= len(self.board):
            return False
        self.board, self.rack = new_board, new_rack
        self.reorgs += 1
        return True

    def _solve_attempt(self) -> tuple[bool, bool]:
        """Place words; reorg once if stuck. Returns (rack_empty, board_changed)."""
        before = dict(self.board.cells)
        self._place_words()
        if not self.rack:
            return True, dict(self.board.cells) != before
        if find_best_placement(self.board, self.rack, self.dictionary):
            return False, dict(self.board.cells) != before
        if self._reorganize():
            self._place_words()
            if not self.rack:
                return True, dict(self.board.cells) != before
        cleared = not self.rack and not find_best_placement(
            self.board, self.rack, self.dictionary
        )
        return cleared, dict(self.board.cells) != before

    def _stuck(self) -> bool:
        return bool(self.rack) and find_best_placement(
            self.board, self.rack, self.dictionary
        ) is None

    def peel(self) -> str | None:
        if self.rack or not self.bunch:
            return None
        letter = self.bunch.pop()
        self.rack.append(letter)
        self.peels += 1
        return letter

    def dump(self) -> tuple[str, list[str]] | None:
        if not self.rack or len(self.bunch) < 3:
            return None
        returned = self.rack.pop(self.rng.randrange(len(self.rack)))
        self.bunch.insert(0, returned)
        drawn = self._draw(3)
        self.rack.extend(drawn)
        self.dumps += 1
        return returned, drawn

    def run(self, *, max_turns: int | None = None, deadline: float | None = None) -> None:
        self._deadline = deadline
        self.deal()

        self.log.start(self.board)
        self.log.separator()

        while (max_turns is None or self.attempt < max_turns) and not self._timed_out():
            self.attempt += 1
            self.log.attempt(self.attempt)
            cleared, changed = self._solve_attempt()
            if changed:
                self.log.board(self.board)

            if cleared:
                letter = self.peel()
                if letter:
                    self.log.peel(letter)
                    self.log.separator()
                    continue
                break

            if self._stuck():
                self.log.false_attempt(self.attempt)
                hit = self.dump()
                if hit is None:
                    break
                returned, drawn = hit
                self.log.dump(returned, drawn)
                self.log.separator()
                continue

            break
