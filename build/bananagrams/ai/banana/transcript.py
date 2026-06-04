"""Terminal transcript matching format.txt."""

from __future__ import annotations

from .grid import Board


def _ascii_board(board: Board) -> list[str]:
    """Grid with '.' padding; one space between cells."""
    if not board.cells:
        return [". . . . . . . ."]
    xs = [c[0] for c in board.cells]
    ys = [c[1] for c in board.cells]
    min_x, max_x = min(xs) - 1, max(xs) + 1
    min_y, max_y = min(ys) - 1, max(ys) + 1
    lines: list[str] = []
    for gy in range(min_y, max_y + 1):
        row: list[str] = []
        for gx in range(min_x, max_x + 1):
            ch = board.cells.get((gx, gy))
            row.append(ch if ch else ".")
        lines.append(" ".join(row))
    return lines


class Transcript:
    def __init__(self, *, echo: bool = True) -> None:
        self.echo = echo
        self.lines: list[str] = []

    def _out(self, *parts: str) -> None:
        for part in parts:
            self.lines.append(part)
            if self.echo:
                print(part, flush=True)

    def separator(self) -> None:
        self._out("--------------")

    def start(self, board: Board) -> None:
        self._out("Start")
        self._out(*_ascii_board(board))

    def attempt(self, n: int) -> None:
        self._out(f"Attempt: {n}")

    def false_attempt(self, n: int) -> None:
        self._out(f"[FALSE] Attempt: {n}")

    def board(self, board: Board) -> None:
        self._out(*_ascii_board(board))

    def peel(self, letter: str) -> None:
        self._out(f"Peel -> {letter.upper()}")

    def dump(self, returned: str, drawn: list[str]) -> None:
        drawn_s = "".join(drawn).upper()
        self._out(f"Dump {returned.upper()} -> {drawn_s}")
