"""Shim — real module lives in nash/solve_nash.py."""
from __future__ import annotations

import runpy
import sys
from pathlib import Path

_TARGET = Path(__file__).resolve().parent / "nash" / "solve_nash.py"

if __name__ == "__main__":
    sys.argv[0] = str(_TARGET)
    runpy.run_path(str(_TARGET), run_name="__main__")
else:
    _nash = str(Path(__file__).resolve().parent / "nash")
    if _nash not in sys.path:
        sys.path.insert(0, _nash)
    from solve_nash import *  # noqa: F401,F403
