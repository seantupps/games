"""BNWL dictionary — singleton + per-rack word cache."""

from __future__ import annotations

import sys
from pathlib import Path

_PARENT = Path(__file__).resolve().parents[2]
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))

from check_word import default_dict_path, load_dict, lookup  # noqa: E402

from .grid import rack_counts_key

_INSTANCE: "Dictionary | None" = None


class Dictionary:
    def __init__(self, path: Path | None = None):
        self._path = path or default_dict_path()
        self._data = load_dict(self._path)
        self.nodes = self._data["nodes"]
        self.min_len = self._data["min_len"]
        self.max_len = self._data["max_len"]
        self._rack_cache: dict[tuple, tuple[str, ...]] = {}

    @property
    def label(self) -> str:
        return f"{self._path.name} ({self._data['lexicon']})"

    def is_word(self, word: str) -> bool:
        w = word.strip().lower()
        if len(w) < self.min_len or len(w) > self.max_len or not w.isalpha():
            return False
        _pfx, is_w = lookup(self.nodes, w)
        return is_w

    def rack_words(self, rack: list[str], limit: int = 40) -> list[str]:
        key = rack_counts_key(rack)
        cap = min(self.max_len, sum(key))
        if cap < self.min_len:
            return []
        cache_key = (key, cap, limit)
        hit = self._rack_cache.get(cache_key)
        if hit is None:
            from .solver import words_from_counts

            hit = tuple(words_from_counts(self.nodes, self.min_len, cap, key, limit))
            self._rack_cache[cache_key] = hit
        return list(hit)


def get_dictionary(path: Path | None = None) -> Dictionary:
    global _INSTANCE
    if path is not None:
        return Dictionary(path)
    if _INSTANCE is None:
        _INSTANCE = Dictionary()
    return _INSTANCE
