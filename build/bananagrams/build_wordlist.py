"""
Build a compressed trie word list for Bananagrams (build/bananagrams → games/bananagrams/dict).

Source: plain text, one word per line (NASPA NWL, Collins CSW, legacy SOWPODS export, etc.).
You must supply the .txt yourself; this repo does not ship copyrighted lexicons.

Usage:
  python build_wordlist.py --input path/to/NWL2023.txt --lexicon nwl --output build/bananagrams/nwl
  python build_wordlist.py --self-test

Output:
  <output>.bin      raw trie
  <output>.bin.gz   gzip level 1 (same pattern as tests/line/theory.py → line_ai_table.bin.gz)

Binary layout (little-endian):
  magic "BNWL" | u32 version=1 | u32 lexicon | u32 word_count | u32 node_count
  u8 min_len | u8 max_len | u16 reserved
  nodes[node_count]: u8 flags (bit0=terminal) | u8 n | n × (u8 letter, u32 child_index)
"""

from __future__ import annotations

import argparse
import gzip
import struct
import sys
import time
from collections import deque
from pathlib import Path

MAGIC = b"BNWL"
VERSION = 1

LEXICON = {
    "nwl": 1,   # NASPA Word List (current NA tournament; replaces TWL/OTCWL)
    "twl": 1,   # alias → nwl
    "otcwl": 1,
    "csw": 2,   # Collins Scrabble Words (international tournament)
    "sowpods": 3,
    "enable": 4,  # public-domain dev fallback only
}


class TrieNode:
    __slots__ = ("children", "terminal")

    def __init__(self) -> None:
        self.children: dict[str, TrieNode] = {}
        self.terminal = False


def load_words(
    path: Path,
    *,
    min_len: int,
    max_len: int,
) -> list[str]:
    words: set[str] = set()
    skipped = 0
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            raw = line.strip()
            if not raw or raw.startswith("#") or raw.startswith(";"):
                continue
            w = raw.lower()
            if not w.isalpha() or not w.isascii():
                skipped += 1
                continue
            if len(w) < min_len or len(w) > max_len:
                skipped += 1
                continue
            words.add(w)
    if skipped:
        print(f"[build] skipped {skipped:,} lines (length/charset)")
    return sorted(words)


def insert(root: TrieNode, word: str) -> None:
    node = root
    for ch in word:
        node = node.children.setdefault(ch, TrieNode())
    node.terminal = True


def flatten(root: TrieNode) -> tuple[list[TrieNode], list[tuple[int, int, str]]]:
    """BFS node order; edges as (parent_idx, child_idx, letter)."""
    order: list[TrieNode] = []
    q: deque[TrieNode] = deque([root])
    seen: set[int] = {id(root)}
    while q:
        node = q.popleft()
        order.append(node)
        for ch in sorted(node.children.keys()):
            child = node.children[ch]
            cid = id(child)
            if cid not in seen:
                seen.add(cid)
                q.append(child)
    idx = {id(n): i for i, n in enumerate(order)}
    edges: list[tuple[int, int, str]] = []
    for parent_i, node in enumerate(order):
        for ch in sorted(node.children.keys()):
            child = node.children[ch]
            edges.append((parent_i, idx[id(child)], ch))
    return order, edges


def pack(
    words: list[str],
    lexicon_id: int,
    *,
    min_len: int,
    max_len: int,
) -> bytes:
    root = TrieNode()
    for w in words:
        insert(root, w)

    nodes, _edges = flatten(root)
    out = bytearray()
    out.extend(MAGIC)
    out.extend(struct.pack("<IIII", VERSION, lexicon_id, len(words), len(nodes)))
    out.extend(struct.pack("<BBH", min_len, max_len, 0))

    idx_map = {id(n): i for i, n in enumerate(nodes)}
    for node in nodes:
        flags = 1 if node.terminal else 0
        kids = sorted(node.children.items())
        out.append(flags)
        out.append(len(kids))
        for ch, child in kids:
            out.append(ord(ch))
            out.extend(struct.pack("<I", idx_map[id(child)]))

    return bytes(out)


def write_gzip_only(raw: bytes, gz_path: Path) -> None:
    """Write BNWL trie as .bin.gz only (what the game loads)."""
    gz_path.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with gzip.open(gz_path, "wb", compresslevel=1) as f_out:
        f_out.write(raw)
    print(
        f"[build] gzip {gz_path} ({gz_path.stat().st_size / 1024 / 1024:.2f} MB) "
        f"write={time.time() - t0:.2f}s"
    )


def write_outputs(raw: bytes, output: Path) -> None:
    bin_path = output.with_suffix(".bin") if output.suffix != ".bin" else output
    if bin_path.suffix != ".bin":
        bin_path = Path(str(bin_path) + ".bin")
    gz_path = Path(str(bin_path) + ".gz")

    t0 = time.time()
    bin_path.parent.mkdir(parents=True, exist_ok=True)
    bin_path.write_bytes(raw)
    t_bin = time.time() - t0

    t1 = time.time()
    with bin_path.open("rb") as f_in:
        with gzip.open(gz_path, "wb", compresslevel=1) as f_out:
            f_out.write(f_in.read())
    t_gz = time.time() - t1

    print(f"[build] raw  {bin_path} ({len(raw)/1024/1024:.2f} MB) write={t_bin:.2f}s")
    print(f"[build] gzip {gz_path} ({gz_path.stat().st_size/1024/1024:.2f} MB) gzip={t_gz:.2f}s")


def self_test() -> None:
    sample = ["aa", "ab", "ba", "banana", "anagram", "ram", "am"]
    root = TrieNode()
    for w in sample:
        insert(root, w)
    nodes, edges = flatten(root)
    assert len(nodes) >= 7
    packed = pack(sample, LEXICON["enable"], min_len=2, max_len=15)
    assert packed[:4] == MAGIC
    print(f"[self-test] ok - {len(sample)} words -> {len(nodes)} nodes, {len(packed)} bytes")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build BNWL trie + .bin.gz")
    ap.add_argument("--input", type=Path, help="Lexicon text file (one word per line)")
    ap.add_argument(
        "--lexicon",
        choices=sorted(LEXICON.keys()),
        default="nwl",
        help="Label stored in header (nwl/twl = NA tournament, csw, sowpods)",
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=Path("build/bananagrams/nwl"),
        help="Output path without extension (writes .bin and .bin.gz)",
    )
    ap.add_argument("--min-len", type=int, default=2, help="Min word length (Bananagrams grids)")
    ap.add_argument("--max-len", type=int, default=15, help="Max word length (NWL/CSW cap)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return 0

    if not args.input or not args.input.is_file():
        print("error: --input must point to an existing lexicon .txt", file=sys.stderr)
        print("  NA tournament: NASPA member NWL2023.txt (replaces TWL/SOWPODS for US/Canada)", file=sys.stderr)
        print("  International: Collins CSW text export", file=sys.stderr)
        return 1

    lex_id = LEXICON[args.lexicon]
    t0 = time.time()
    words = load_words(args.input, min_len=args.min_len, max_len=args.max_len)
    if not words:
        print("error: no words loaded", file=sys.stderr)
        return 1
    print(f"[build] {len(words):,} words from {args.input} (lexicon={args.lexicon})")
    raw = pack(words, lex_id, min_len=args.min_len, max_len=args.max_len)
    write_outputs(raw, args.output)
    print(f"[build] done in {time.time() - t0:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
