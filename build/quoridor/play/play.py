#!/usr/bin/env python
"""
Quoridor — terminal P1 vs P2 on a 9×9 board (Python port of play/game.js).

Usage:
  python build/quoridor/play/play.py
  python build/quoridor/play/play.py --seed 1
  python build/quoridor/play/play.py --2p
  python build/quoridor/play/play.py --ai random
  quoridor [--seed S | --2p | --ai greedy|random]
"""

from __future__ import annotations

import argparse
import os
import random
import sys
from pathlib import Path

# Allow `python play/play.py` without installing the package.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT.parent) not in sys.path:
    sys.path.insert(0, str(_ROOT.parent))

from quoridor.game import (  # noqa: E402
    FILES,
    MOVE_DOWN,
    MOVE_LEFT,
    MOVE_RIGHT,
    MOVE_UP,
    SIZE,
    WALL_N,
    Move,
    QuoridorGame,
    format_square,
    parse_square,
)
from quoridor.game.greedy import (  # noqa: E402
    choose_greedy,
    choose_random_balanced,
    warmup as ai_warmup,
)

ANSI_RESET = "\x1b[0m"
ANSI_LIGHT = "\x1b[96m"
ANSI_DARK = "\x1b[93m"
ANSI_WALL = "\x1b[91m"


def _use_color() -> bool:
    return sys.stdout.isatty() or os.environ.get("FORCE_COLOR") == "1"


def colorize(ansi: str, text: str) -> str:
    if not _use_color():
        return text
    return f"{ansi}{text}{ANSI_RESET}"


def red(text: str) -> str:
    return colorize(ANSI_WALL, text)


def pawn_glyph(pawn) -> str:
    ansi = ANSI_LIGHT if pawn.index == 0 else ANSI_DARK
    return colorize(ansi, pawn.mark)


def h_seg(game: QuoridorGame, row: int, col: int) -> bool:
    if row < 0 or row >= WALL_N or col < 0 or col >= SIZE:
        return False
    if col > 0 and game.walls_h[row][col - 1]:
        return True
    if col < WALL_N and game.walls_h[row][col]:
        return True
    return False


def v_seg(game: QuoridorGame, row: int, col: int) -> bool:
    if col < 0 or col >= WALL_N or row < 0 or row >= SIZE:
        return False
    if row > 0 and game.walls_v[row - 1][col]:
        return True
    if row < WALL_N and game.walls_v[row][col]:
        return True
    return False


def make_file_header() -> str:
    arr = [" "] * (3 + 4 * SIZE)
    for col in range(SIZE):
        arr[6 + 4 * col] = FILES[col]
    return "".join(arr) + "  "


def make_h_border(kind: str, rank, game=None, fence_row=None) -> str:
    left = f"{rank} " if rank is not None else "  "
    right = f" {rank}" if rank is not None else "  "
    open_ch = {"top": "┌", "bot": "└", "mid": "├"}[kind]
    close_ch = {"top": "┐", "bot": "┘", "mid": "┤"}[kind]
    parts = [left, open_ch]
    for col in range(SIZE):
        if kind == "mid" and game is not None:
            parts.append(red("━━━") if h_seg(game, fence_row, col) else "───")
        else:
            parts.append("───")
        if col < SIZE - 1:
            if kind == "mid" and game is not None:
                through_h = h_seg(game, fence_row, col) and h_seg(
                    game, fence_row, col + 1
                )
                through_v = v_seg(game, fence_row, col) and v_seg(
                    game, fence_row + 1, col
                )
                if through_h and through_v:
                    parts.append(red("╋"))
                elif through_h:
                    parts.append(red("━"))
                elif through_v:
                    parts.append(red("┃"))
                else:
                    parts.append("┼")
            elif kind == "top":
                parts.append("┬")
            elif kind == "bot":
                parts.append("┴")
            else:
                parts.append("┼")
    parts.append(close_ch)
    parts.append(right)
    return "".join(parts)


def make_content_line(row: int, game: QuoridorGame) -> str:
    pawn_at = [[None] * SIZE for _ in range(SIZE)]
    for p in game.pawns:
        pawn_at[p.row][p.col] = p
    parts = ["  │"]
    for col in range(SIZE):
        p = pawn_at[row][col]
        parts.append(f" {pawn_glyph(p)} " if p else "   ")
        if col < SIZE - 1:
            parts.append(red("┃") if v_seg(game, row, col) else "│")
    parts.append("│  ")
    return "".join(parts)


def render_board(game: QuoridorGame) -> str:
    lines = [make_file_header()]
    for row in range(SIZE):
        rank = SIZE - row
        if row == 0:
            lines.append(make_h_border("top", rank))
        else:
            lines.append(make_h_border("mid", rank, game, row - 1))
        lines.append(make_content_line(row, game))
    lines.append(make_h_border("bot", None))
    lines.append(make_file_header())
    return "\n".join(lines)


def status_lines(game: QuoridorGame) -> list[str]:
    turn = game.pawn_of_turn
    p1, p2 = game.pawns
    return [
        f"Walls: {pawn_glyph(p1)} {p1.walls_left}   {pawn_glyph(p2)} {p2.walls_left}",
    ]


def print_state(game: QuoridorGame) -> None:
    print()
    print(render_board(game))
    print()
    for line in status_lines(game):
        print(line)


def print_help() -> None:
    print(
        """
Commands
  e5       move your pawn to e5
  w/a/s/d  move north/west/south/east (straight jump if blocked by pawn)
  H c5     horizontal wall centered on the c / 5 ticks (covers c–d @ rank 5)
  V e5     vertical wall centered on the e|f / 5 tick (covers ranks 6+5)
  u        undo last turn (your move + P2's reply)
  moves    list legal moves
  help     this text
  quit     exit

P1 (you) starts at e1 → goal rank 9.  P2 starts at e9 → goal rank 1.
See build/quoridor/docs/rules.txt for full rules.
"""
    )


def parse_input(raw: str, game: QuoridorGame | None = None):
    s = raw.strip()
    if not s:
        return {"error": "empty"}
    lower = s.lower()
    if lower in ("quit", "exit", "q"):
        return {"quit": True}
    if lower in ("help", "?"):
        return {"help": True}
    if lower in ("moves", "legal"):
        return {"legal": True}
    if lower in ("u", "undo"):
        return {"undo": True}

    if len(s) == 1 and lower in "wasd":
        if game is None:
            return {"error": "WASD needs an active game"}
        delta = {
            "w": MOVE_UP,
            "s": MOVE_DOWN,
            "a": MOVE_LEFT,
            "d": MOVE_RIGHT,
        }[lower]
        me = game.pawn_of_turn
        grid = game.valid_next_positions()
        step1 = (me.row + delta[0], me.col + delta[1])
        step2 = (me.row + 2 * delta[0], me.col + 2 * delta[1])
        for r, c in (step1, step2):
            if 0 <= r < SIZE and 0 <= c < SIZE and grid[r][c]:
                return Move("move", r, c)
        return {"error": f"cannot move {lower.upper()} from here"}

    sq = parse_square(s)
    if sq is not None:
        return Move("move", sq[0], sq[1])

    import re

    m = re.match(r"^([hv])\s*([a-i][1-9])$", s, re.I)
    if m:
        tick = parse_square(m.group(2))
        if tick is None:
            return {"error": "bad wall square"}
        tr, tc = tick
        if tc > WALL_N - 1:
            return {"error": "wall file must be a–h"}
        if tr < 1:
            return {"error": "wall rank must be 1–8 (centered on that rank tick)"}
        nw_row = tr - 1
        if nw_row > WALL_N - 1:
            return {"error": "wall out of range"}
        return Move(m.group(1).upper(), nw_row, tc)

    return {
        "error": "bad move — try e5, wasd, H c5, V e5, u  (or help / moves / quit)"
    }


def play(ai: bool = True, seed: int | None = None, ai_kind: str = "greedy") -> None:
    game = QuoridorGame()
    rng = random.Random(seed)
    history: list[QuoridorGame] = []

    print("Quoridor — 9×9")
    if ai:
        if ai_kind == "greedy":
            sys.stderr.write("Warming Numba pathfinding...\n")
            sys.stderr.flush()
            ai_warmup()
            label = "greedy (path diff)"
        else:
            label = "random"
        print(
            f"P1 {pawn_glyph(game.pawns[0])} (you) vs P2 {pawn_glyph(game.pawns[1])} ({label})."
        )
    else:
        print(
            f"Two humans: P1 {pawn_glyph(game.pawns[0])} then P2 {pawn_glyph(game.pawns[1])}."
        )
    print("Type help for commands.")

    while game.winner is None:
        print_state(game)

        human_turn = (not ai) or game.pawn_of_turn.index == 0
        if not human_turn:
            if ai_kind == "greedy":
                pick = choose_greedy(game, rng)
            else:
                pick = choose_random_balanced(game, rng)
            if pick is None:
                print("No legal moves — stalemate?")
                break
            game.apply_move(pick)
            print()
            print(f"P2: {game.format_move(pick)}")
            continue

        while True:
            try:
                raw = input(f"{game.pawn_of_turn.name}> ")
            except EOFError:
                print("Bye.")
                return
            cmd = parse_input(raw, game)
            if isinstance(cmd, dict) and cmd.get("quit"):
                print("Bye.")
                return
            if isinstance(cmd, dict) and cmd.get("help"):
                print_help()
                continue
            if isinstance(cmd, dict) and cmd.get("undo"):
                if not ai:
                    print("Undo is only for vs-AI games.")
                    continue
                if not history:
                    print("Nothing to undo.")
                    continue
                game.restore(history.pop())
                print("Undid last turn (P1 + P2).")
                break
            if isinstance(cmd, dict) and cmd.get("legal"):
                legal = game.list_legal_moves()
                pawn_moves = [
                    game.format_move(m) for m in legal if m.type == "move"
                ]
                walls = [game.format_move(m) for m in legal if m.type != "move"]
                print(f"Pawn: {' '.join(pawn_moves) if pawn_moves else '(none)'}")
                if len(walls) > 24:
                    shown = ", ".join(walls[:24]) + ", …"
                else:
                    shown = ", ".join(walls) if walls else "(none)"
                print(f"Walls ({len(walls)}): {shown}")
                continue
            if isinstance(cmd, dict) and cmd.get("error"):
                print(cmd["error"])
                continue
            assert isinstance(cmd, Move)
            if ai:
                history.append(game.clone())
            if not game.apply_move(cmd):
                if ai and history:
                    history.pop()
                print("Illegal move.")
                continue
            break

    if game.winner is not None:
        print_state(game)
        print()
        print(f"{pawn_glyph(game.winner)} {game.winner.name} wins!")


def _ensure_utf8_stdio() -> None:
    """Windows consoles often default to cp1252; box-drawing needs UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    _ensure_utf8_stdio()
    p = argparse.ArgumentParser(description="Quoridor terminal play")
    p.add_argument("--seed", "-s", type=int, default=None)
    p.add_argument("--2p", "--hotseat", "--no-ai", dest="two_p", action="store_true")
    p.add_argument(
        "--ai",
        choices=("greedy", "random"),
        default="greedy",
        help="P2 policy when not --2p (default: greedy)",
    )
    args = p.parse_args(argv)
    play(ai=not args.two_p, seed=args.seed, ai_kind=args.ai)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
