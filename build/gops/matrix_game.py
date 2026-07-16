"""Shim — real module lives in nash/matrix_game.py."""
from __future__ import annotations

import sys
from pathlib import Path

_nash = str(Path(__file__).resolve().parent / "nash")
if _nash not in sys.path:
    sys.path.insert(0, _nash)

from matrix_game import *  # noqa: F401,F403
