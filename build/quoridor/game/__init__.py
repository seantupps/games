"""Quoridor game state — rules match ref/quoridor-ai and the JS play UI."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Optional

from .path import (
    INF,
    SIZE,
    WALL_N,
    arrays_from_open_ways,
    path_exists,
    shortest_path_length,
)

FILES = "abcdefghi"

MOVE_UP = (-1, 0)
MOVE_DOWN = (1, 0)
MOVE_LEFT = (0, -1)
MOVE_RIGHT = (0, 1)
ORTHO = (MOVE_UP, MOVE_DOWN, MOVE_LEFT, MOVE_RIGHT)


def zeros2(rows: int, cols: int, fill=False):
    return [[fill for _ in range(cols)] for _ in range(rows)]


def clone2(arr):
    return [row[:] for row in arr]


def parse_square(raw: str) -> Optional[tuple[int, int]]:
    s = raw.strip().lower()
    if len(s) < 2 or s[0] not in FILES:
        return None
    try:
        rank = int(s[1:])
    except ValueError:
        return None
    if rank < 1 or rank > 9:
        return None
    col = FILES.index(s[0])
    row = SIZE - rank
    return row, col


def format_square(row: int, col: int) -> str:
    return FILES[col] + str(SIZE - row)


@dataclass
class Move:
    type: str  # "move" | "H" | "V"
    row: int
    col: int

    def as_dict(self) -> dict[str, Any]:
        return {"type": self.type, "row": self.row, "col": self.col}


class Pawn:
    __slots__ = ("index", "row", "col", "goal_row", "name", "walls_left", "mark")

    def __init__(self, index: int):
        self.index = index
        self.mark = "O"
        if index == 0:
            self.row = 8
            self.col = 4
            self.goal_row = 0
            self.name = "P1"
        else:
            self.row = 0
            self.col = 4
            self.goal_row = 8
            self.name = "P2"
        self.walls_left = 10

    def clone(self) -> "Pawn":
        p = Pawn(self.index)
        p.row = self.row
        p.col = self.col
        p.walls_left = self.walls_left
        return p


class QuoridorGame:
    def __init__(self) -> None:
        self.pawns = [Pawn(0), Pawn(1)]
        self.walls_h = zeros2(WALL_N, WALL_N, False)
        self.walls_v = zeros2(WALL_N, WALL_N, False)
        self.up_down = zeros2(WALL_N, SIZE, True)
        self.left_right = zeros2(SIZE, WALL_N, True)
        self.valid_h = zeros2(WALL_N, WALL_N, True)
        self.valid_v = zeros2(WALL_N, WALL_N, True)
        self.turn = 0
        self.winner: Optional[Pawn] = None
        self._moves_cache: Optional[list[list[bool]]] = None
        self._np_cache = None  # (up, left) numpy — invalidated with board changes

    @property
    def pawn_of_turn(self) -> Pawn:
        return self.pawns[self.turn % 2]

    @property
    def pawn_of_not_turn(self) -> Pawn:
        return self.pawns[(self.turn + 1) % 2]

    def invalidate(self) -> None:
        self._moves_cache = None
        self._np_cache = None

    def _np_open(self):
        if self._np_cache is None:
            self._np_cache = arrays_from_open_ways(self.up_down, self.left_right)
        return self._np_cache

    def clone(self) -> "QuoridorGame":
        g = QuoridorGame.__new__(QuoridorGame)
        g.pawns = [p.clone() for p in self.pawns]
        g.walls_h = clone2(self.walls_h)
        g.walls_v = clone2(self.walls_v)
        g.up_down = clone2(self.up_down)
        g.left_right = clone2(self.left_right)
        g.valid_h = clone2(self.valid_h)
        g.valid_v = clone2(self.valid_v)
        g.turn = self.turn
        g.winner = None if self.winner is None else g.pawns[self.winner.index]
        g._moves_cache = None
        g._np_cache = None
        return g

    def restore(self, snap: "QuoridorGame") -> None:
        self.pawns = [p.clone() for p in snap.pawns]
        self.walls_h = clone2(snap.walls_h)
        self.walls_v = clone2(snap.walls_v)
        self.up_down = clone2(snap.up_down)
        self.left_right = clone2(snap.left_right)
        self.valid_h = clone2(snap.valid_h)
        self.valid_v = clone2(snap.valid_v)
        self.turn = snap.turn
        self.winner = None if snap.winner is None else self.pawns[snap.winner.index]
        self.invalidate()

    def is_open_way(self, row: int, col: int, move: tuple[int, int]) -> bool:
        dr, dc = move
        if dr == -1 and dc == 0:
            return row > 0 and self.up_down[row - 1][col]
        if dr == 1 and dc == 0:
            return row < 8 and self.up_down[row][col]
        if dr == 0 and dc == -1:
            return col > 0 and self.left_right[row][col - 1]
        if dr == 0 and dc == 1:
            return col < 8 and self.left_right[row][col]
        return False

    def can_step(self, row: int, col: int, move: tuple[int, int]) -> bool:
        return self.is_open_way(row, col, move)

    def valid_next_positions(self) -> list[list[bool]]:
        if self._moves_cache is not None:
            return self._moves_cache
        grid = zeros2(SIZE, SIZE, False)
        me = self.pawn_of_turn
        them = self.pawn_of_not_turn

        def try_toward(main, sub1, sub2):
            if not self.can_step(me.row, me.col, main):
                return
            r1 = me.row + main[0]
            c1 = me.col + main[1]
            if r1 == them.row and c1 == them.col:
                if self.can_step(r1, c1, main):
                    grid[r1 + main[0]][c1 + main[1]] = True
                else:
                    if self.can_step(r1, c1, sub1):
                        grid[r1 + sub1[0]][c1 + sub1[1]] = True
                    if self.can_step(r1, c1, sub2):
                        grid[r1 + sub2[0]][c1 + sub2[1]] = True
            else:
                grid[r1][c1] = True

        try_toward(MOVE_UP, MOVE_LEFT, MOVE_RIGHT)
        try_toward(MOVE_DOWN, MOVE_LEFT, MOVE_RIGHT)
        try_toward(MOVE_LEFT, MOVE_UP, MOVE_DOWN)
        try_toward(MOVE_RIGHT, MOVE_UP, MOVE_DOWN)
        self._moves_cache = grid
        return grid

    def list_pawn_moves(self) -> list[Move]:
        grid = self.valid_next_positions()
        out = []
        for r in range(SIZE):
            for c in range(SIZE):
                if grid[r][c]:
                    out.append(Move("move", r, c))
        return out

    def _exist_path(self, pawn: Pawn) -> bool:
        up, left = self._np_open()
        return bool(path_exists(up, left, pawn.row, pawn.col, pawn.goal_row))

    def _both_paths_exist(self) -> bool:
        return self._exist_path(self.pawn_of_turn) and self._exist_path(
            self.pawn_of_not_turn
        )

    def path_length(self, pawn: Pawn) -> int:
        up, left = self._np_open()
        return int(shortest_path_length(up, left, pawn.row, pawn.col, pawn.goal_row))

    def can_place_horizontal(self, row: int, col: int) -> bool:
        if self.pawn_of_turn.walls_left <= 0:
            return False
        if not self.valid_h[row][col]:
            return False
        self.up_down[row][col] = False
        self.up_down[row][col + 1] = False
        self._np_cache = None
        ok = self._both_paths_exist()
        self.up_down[row][col] = True
        self.up_down[row][col + 1] = True
        self._np_cache = None
        return ok

    def can_place_vertical(self, row: int, col: int) -> bool:
        if self.pawn_of_turn.walls_left <= 0:
            return False
        if not self.valid_v[row][col]:
            return False
        self.left_right[row][col] = False
        self.left_right[row + 1][col] = False
        self._np_cache = None
        ok = self._both_paths_exist()
        self.left_right[row][col] = True
        self.left_right[row + 1][col] = True
        self._np_cache = None
        return ok

    def move_pawn(self, row: int, col: int) -> bool:
        grid = self.valid_next_positions()
        if not grid[row][col]:
            return False
        p = self.pawn_of_turn
        p.row = row
        p.col = col
        if p.row == p.goal_row:
            self.winner = p
        self.turn += 1
        self.invalidate()
        return True

    def place_horizontal(self, row: int, col: int) -> bool:
        if not self.can_place_horizontal(row, col):
            return False
        self.up_down[row][col] = False
        self.up_down[row][col + 1] = False
        self.valid_v[row][col] = False
        self.valid_h[row][col] = False
        if col > 0:
            self.valid_h[row][col - 1] = False
        if col < 7:
            self.valid_h[row][col + 1] = False
        self.walls_h[row][col] = True
        self.pawn_of_turn.walls_left -= 1
        self.turn += 1
        self.invalidate()
        return True

    def place_vertical(self, row: int, col: int) -> bool:
        if not self.can_place_vertical(row, col):
            return False
        self.left_right[row][col] = False
        self.left_right[row + 1][col] = False
        self.valid_h[row][col] = False
        self.valid_v[row][col] = False
        if row > 0:
            self.valid_v[row - 1][col] = False
        if row < 7:
            self.valid_v[row + 1][col] = False
        self.walls_v[row][col] = True
        self.pawn_of_turn.walls_left -= 1
        self.turn += 1
        self.invalidate()
        return True

    def list_legal_moves(self) -> list[Move]:
        moves = self.list_pawn_moves()
        if self.pawn_of_turn.walls_left > 0:
            for r in range(WALL_N):
                for c in range(WALL_N):
                    if self.can_place_horizontal(r, c):
                        moves.append(Move("H", r, c))
                    if self.can_place_vertical(r, c):
                        moves.append(Move("V", r, c))
        return moves

    def apply_move(self, move: Move) -> bool:
        if move.type == "move":
            return self.move_pawn(move.row, move.col)
        if move.type == "H":
            return self.place_horizontal(move.row, move.col)
        if move.type == "V":
            return self.place_vertical(move.row, move.col)
        return False

    def format_move(self, move: Move) -> str:
        if move.type == "move":
            return format_square(move.row, move.col)
        return f"{move.type} {format_square(move.row + 1, move.col)}"

    def score_for_player(self, player_index: int) -> int:
        """Higher is better for player_index: opp_dist - my_dist (INF-safe)."""
        me = self.pawns[player_index]
        opp = self.pawns[1 - player_index]
        my_d = self.path_length(me)
        opp_d = self.path_length(opp)
        if my_d >= INF:
            return -INF
        if opp_d >= INF:
            return INF
        return opp_d - my_d
