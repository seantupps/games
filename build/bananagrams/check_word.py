"""
Interactive (or one-shot) lookup against a BNWL .bin / .bin.gz trie.

  python check_word.py
  python check_word.py --dict games/bananagrams/dict/enable.bin.gz
  python check_word.py banana qi zz
"""

from __future__ import annotations

import argparse
import gzip
import struct
import sys
from pathlib import Path

MAGIC = b"BNWL"
HEADER_SIZE = 24

LEXICON_NAMES = {
    1: "NWL/TWL",
    2: "CSW",
    3: "SOWPODS",
    4: "ENABLE",
}


def read_bytes(path: Path) -> bytes:
    if path.suffix == ".gz" or path.name.endswith(".bin.gz"):
        with gzip.open(path, "rb") as f:
            return f.read()
    return path.read_bytes()


def load_dict(path: Path) -> dict:
    raw = read_bytes(path)
    if len(raw) < HEADER_SIZE or raw[:4] != MAGIC:
        raise ValueError(f"not a BNWL file: {path}")

    version, lexicon, word_count, node_count = struct.unpack_from("<IIII", raw, 4)
    min_len, max_len = struct.unpack_from("<BB", raw, 20)

    nodes: list[dict] = []
    off = HEADER_SIZE
    for _ in range(node_count):
        flags = raw[off]
        off += 1
        n = raw[off]
        off += 1
        children: dict[str, int] = {}
        for _ in range(n):
            letter = chr(raw[off])
            off += 1
            child, = struct.unpack_from("<I", raw, off)
            off += 4
            children[letter] = child
        nodes.append({"terminal": bool(flags & 1), "children": children})

    return {
        "path": path,
        "version": version,
        "lexicon": LEXICON_NAMES.get(lexicon, f"id={lexicon}"),
        "word_count": word_count,
        "node_count": node_count,
        "min_len": min_len,
        "max_len": max_len,
        "nodes": nodes,
    }


def normalize(word: str) -> str | None:
    w = word.strip().lower()
    if not w:
        return None
    if not w.isalpha() or not w.isascii():
        return None
    return w


def lookup(nodes: list[dict], word: str) -> tuple[bool, bool]:
    """Returns (is_prefix, is_word)."""
    idx = 0
    for ch in word:
        node = nodes[idx]
        nxt = node["children"].get(ch)
        if nxt is None:
            return False, False
        idx = nxt
    node = nodes[idx]
    return True, node["terminal"]


def check(nodes: list[dict], word: str, *, min_len: int, max_len: int) -> str:
    w = normalize(word)
    if w is None:
        return "invalid (use a-z only)"

    if len(w) < min_len:
        return f"too short (min {min_len})"
    if len(w) > max_len:
        return f"too long (max {max_len})"

    is_prefix, is_word = lookup(nodes, w)
    if is_word:
        return "YES - in list"
    if is_prefix:
        return "no - prefix only (longer words exist)"
    return "no - not in list"


def default_dict_path() -> Path:
    here = Path(__file__).resolve().parent
    game_dict = here.parents[1] / "games" / "bananagrams" / "dict" / "enable.bin.gz"
    if game_dict.is_file():
        return game_dict
    for name in ("nwl.bin.gz", "csw.bin.gz", "enable_sample.bin.gz"):
        p = here / name
        if p.is_file():
            return p
    return here / "enable_sample.bin.gz"


def repl(d: dict) -> None:
    nodes = d["nodes"]
    print(f"Loaded {d['path'].name} ({d['lexicon']}, {d['word_count']:,} words)")
    print("Enter a word to check (empty line or Ctrl+C to quit).\n")
    while True:
        try:
            line = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            break
        print(check(nodes, line, min_len=d["min_len"], max_len=d["max_len"]))


def main() -> int:
    ap = argparse.ArgumentParser(description="Check words against a BNWL dictionary")
    ap.add_argument(
        "--dict",
        type=Path,
        default=None,
        help="Path to .bin or .bin.gz (default: nwl.bin.gz, else enable_sample.bin.gz)",
    )
    ap.add_argument("words", nargs="*", help="Words to check (non-interactive)")
    args = ap.parse_args()

    dict_path = args.dict or default_dict_path()
    if not dict_path.is_file():
        print(f"error: dictionary not found: {dict_path}", file=sys.stderr)
        print("  build one: python build_wordlist.py --input your_lexicon.txt --output build/bananagrams/nwl", file=sys.stderr)
        return 1

    try:
        d = load_dict(dict_path)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if args.words:
        for w in args.words:
            print(f"{w!r}: {check(d['nodes'], w, min_len=d['min_len'], max_len=d['max_len'])}")
        return 0

    repl(d)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
