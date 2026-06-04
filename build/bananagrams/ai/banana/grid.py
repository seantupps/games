"""Grid — tuple coords, incremental validation (hot path)."""

from __future__ import annotations

from dataclasses import dataclass

from .rules import MIN_WORD_LEN

Coord = tuple[int, int]


@dataclass(frozen=True)
class Tile:
    id: str
    letter: str
    gx: int
    gy: int

    @property
    def coord(self) -> Coord:
        return (self.gx, self.gy)


class Board:
    """Mutable crossword; keeps coord map + letter index for fast anchors."""

    __slots__ = ("cells", "by_letter", "_n")

    def __init__(self) -> None:
        self.cells: dict[Coord, str] = {}
        self.by_letter: dict[str, list[Coord]] = {}
        self._n = 0

    def __len__(self) -> int:
        return self._n

    def clone(self) -> Board:
        b = Board()
        b.cells = dict(self.cells)
        b.by_letter = {k: list(v) for k, v in self.by_letter.items()}
        b._n = self._n
        return b

    def to_tiles(self) -> list[Tile]:
        return [
            Tile(id=f"c{x},{y}", letter=ch, gx=x, gy=y)
            for (x, y), ch in self.cells.items()
        ]

    def set_cell(self, x: int, y: int, letter: str) -> bool:
        c = (x, y)
        if c in self.cells:
            return self.cells[c] == letter
        self.cells[c] = letter
        self.by_letter.setdefault(letter, []).append(c)
        self._n += 1
        return True

    def anchors_for(self, letters: set[str]) -> list[Coord]:
        out: list[Coord] = []
        for ch in letters:
            out.extend(self.by_letter.get(ch, ()))
        return out

    def aspect_ratio(self) -> float:
        if not self.cells:
            return 1.0
        xs = [c[0] for c in self.cells]
        ys = [c[1] for c in self.cells]
        w = max(xs) - min(xs) + 1
        h = max(ys) - min(ys) + 1
        return max(w, h) / min(w, h)

    def read_run(self, x: int, y: int, horizontal: bool) -> str:
        if horizontal:
            while (x - 1, y) in self.cells:
                x -= 1
            chars: list[str] = []
            while (x, y) in self.cells:
                chars.append(self.cells[(x, y)])
                x += 1
        else:
            while (x, y - 1) in self.cells:
                y -= 1
            chars = []
            while (x, y) in self.cells:
                chars.append(self.cells[(x, y)])
                y += 1
        return "".join(chars)

    def words_through(self, coords: set[Coord]) -> list[str]:
        """Words that pass through any of these cells (deduped)."""
        seen: set[str] = set()
        out: list[str] = []
        for x, y in coords:
            for horiz in (True, False):
                w = self.read_run(x, y, horiz)
                if len(w) >= MIN_WORD_LEN and w not in seen:
                    seen.add(w)
                    out.append(w)
        return out

    def is_connected_with(self, new_coords: set[Coord]) -> bool:
        if not new_coords:
            return False
        if not self.cells:
            return _new_blob_connected(new_coords)
        touches_old = False
        for x, y in new_coords:
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if (x + dx, y + dy) in self.cells:
                    touches_old = True
                    break
            if touches_old:
                break
        return touches_old and _new_blob_connected(new_coords)


def _new_blob_connected(coords: set[Coord]) -> bool:
    if len(coords) <= 1:
        return True
    start = next(iter(coords))
    seen = {start}
    stack = [start]
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (x + dx, y + dy)
            if n in coords and n not in seen:
                seen.add(n)
                stack.append(n)
    return len(seen) == len(coords)


def validate_placement(board: Board, new_coords: set[Coord], dictionary) -> bool:
    """Only checks words through new cells (+ connectivity). O(new cells), not O(board)."""
    if not new_coords:
        return False
    if not board.is_connected_with(new_coords):
        return False
    for w in board.words_through(new_coords):
        if not dictionary.is_word(w):
            return False
    return True


def validate_full(board: Board, dictionary) -> dict:
    if not board.cells:
        return {"ok": False, "reason": "empty"}
    words = board.words_through(set(board.cells.keys()))
    for w in words:
        if not dictionary.is_word(w):
            return {"ok": False, "reason": "invalid-word", "word": w}
    return {"ok": True, "words": words}


def rack_counts_key(rack: list[str]) -> tuple[int, ...]:
    counts = [0] * 26
    for ch in rack:
        o = ord(ch.upper()) - 65
        if 0 <= o < 26:
            counts[o] += 1
    return tuple(counts)
