#!/usr/bin/env python3
"""
Edit the Bananagrams lexicon and rebuild the dictionary the game loads.

  python build/bananagrams/edit.py word1 -word2 word3

Adds word1 and word3, removes word2, updates build/bananagrams/enable.txt,
then writes games/bananagrams/dict/enable.bin.gz (only artifact in dict/).

First run copies _enable1.txt or an existing dict/enable.txt if enable.txt is missing.
"""

from __future__ import annotations

import gzip
import shutil
import sys
import time
from pathlib import Path

BUILD_DIR = Path(__file__).resolve().parent
REPO_ROOT = BUILD_DIR.parents[1]
DICT_DIR = REPO_ROOT / "games" / "bananagrams" / "dict"
LEXICON_TXT = BUILD_DIR / "enable.txt"
DICT_GZ = DICT_DIR / "enable.bin.gz"
LEGACY_TXT = DICT_DIR / "enable.txt"
BOOTSTRAP_TXT = BUILD_DIR / "_enable1.txt"

MIN_LEN = 2
MAX_LEN = 15
LEXICON = "enable"

from build_wordlist import LEXICON as LEXICON_IDS, load_words, pack  # noqa: E402


def normalize_token(raw: str) -> tuple[str, bool] | None:
    """Return (word, remove) or None if invalid."""
    raw = raw.strip()
    if not raw:
        return None
    remove = raw.startswith("-")
    w = raw[1:] if remove else raw
    w = w.lower()
    if not w or not w.isalpha() or not w.isascii():
        return None
    return w, remove


def ensure_lexicon_txt() -> None:
    if LEXICON_TXT.is_file():
        return
    if LEGACY_TXT.is_file():
        print(f"[edit] moving {LEGACY_TXT} -> {LEXICON_TXT}")
        shutil.move(str(LEGACY_TXT), str(LEXICON_TXT))
        return
    if BOOTSTRAP_TXT.is_file():
        print(f"[edit] creating {LEXICON_TXT.name} from {BOOTSTRAP_TXT.name}")
        shutil.copyfile(BOOTSTRAP_TXT, LEXICON_TXT)
        return
    print(
        f"error: {LEXICON_TXT} not found and no bootstrap at {BOOTSTRAP_TXT}",
        file=sys.stderr,
    )
    print(
        "  place a one-word-per-line lexicon at build/bananagrams/enable.txt",
        file=sys.stderr,
    )
    raise SystemExit(1)


def read_word_set() -> set[str]:
    words: set[str] = set()
    with LEXICON_TXT.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            raw = line.strip()
            if not raw or raw.startswith("#") or raw.startswith(";"):
                continue
            w = raw.lower()
            if w.isalpha() and w.isascii():
                words.add(w)
    return words


def write_word_set(words: set[str]) -> None:
    LEXICON_TXT.parent.mkdir(parents=True, exist_ok=True)
    with LEXICON_TXT.open("w", encoding="utf-8", newline="\n") as f:
        for w in sorted(words):
            f.write(w + "\n")


def validate_for_game(word: str) -> str | None:
    if len(word) < MIN_LEN:
        return f"too short (min {MIN_LEN})"
    if len(word) > MAX_LEN:
        return f"too long (max {MAX_LEN})"
    return None


def rebuild() -> None:
    words = load_words(LEXICON_TXT, min_len=MIN_LEN, max_len=MAX_LEN)
    if not words:
        print("error: no words left after build filters", file=sys.stderr)
        raise SystemExit(1)
    lex_id = LEXICON_IDS[LEXICON]
    raw = pack(words, lex_id, min_len=MIN_LEN, max_len=MAX_LEN)
    DICT_DIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with gzip.open(DICT_GZ, "wb", compresslevel=1) as f_out:
        f_out.write(raw)
    print(
        f"[edit] {len(words):,} words -> {DICT_GZ.relative_to(REPO_ROOT)} "
        f"({DICT_GZ.stat().st_size / 1024 / 1024:.2f} MB, {time.time() - t0:.2f}s)"
    )


def parse_argv(argv: list[str]) -> tuple[bool, list[str]]:
    """Parse argv without treating -remove as flags (PowerShell-safe)."""
    rebuild_only = False
    tokens: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            return rebuild_only, tokens
        if a == "--rebuild-only":
            rebuild_only = True
        elif a == "--":
            tokens.extend(argv[i + 1 :])
            break
        else:
            tokens.append(a)
        i += 1
    return rebuild_only, tokens


def main() -> int:
    rebuild_only, tokens = parse_argv(sys.argv[1:])

    if not tokens and not rebuild_only:
        print(__doc__)
        print("Usage: python edit.py word1 -word2 word3 [--rebuild-only]")
        return 0

    ensure_lexicon_txt()

    if rebuild_only:
        t0 = time.time()
        rebuild()
        print(f"[edit] done in {time.time() - t0:.2f}s")
        return 0

    words = read_word_set()
    before = len(words)

    for token in tokens:
        parsed = normalize_token(token)
        if parsed is None:
            print(f"[edit] skip invalid token: {token!r}")
            continue
        word, remove = parsed
        if remove:
            if word in words:
                words.discard(word)
                print(f"[edit] - {word}")
            else:
                print(f"[edit] - {word} (not in list)")
        else:
            err = validate_for_game(word)
            if err:
                print(f"[edit] skip add {word!r}: {err}")
                continue
            if word in words:
                print(f"[edit] + {word} (already in list)")
            else:
                words.add(word)
                print(f"[edit] + {word}")

    write_word_set(words)
    print(f"[edit] {LEXICON_TXT.name}: {before:,} -> {len(words):,} lines")

    t0 = time.time()
    rebuild()
    print(f"[edit] done in {time.time() - t0:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
