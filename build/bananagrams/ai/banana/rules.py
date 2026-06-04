"""Official-ish constants from games/bananagrams/logic.js + rules.txt."""

from __future__ import annotations

# Full multiplayer bag (144 tiles) — same counts as logic.js TILE_BAG
TILE_BAG: dict[str, int] = {
    "A": 13, "B": 3, "C": 3, "D": 6, "E": 18, "F": 3, "G": 4, "H": 3,
    "I": 12, "J": 2, "K": 2, "L": 5, "M": 3, "N": 8, "O": 11, "P": 3,
    "Q": 2, "R": 9, "S": 6, "T": 9, "U": 6, "V": 3, "W": 3, "X": 2,
    "Y": 3, "Z": 2,
}

MIN_WORD_LEN = 2


def starting_hand_size(player_count: int) -> int:
    n = max(2, min(8, int(player_count)))
    if n <= 4:
        return 21
    if n <= 6:
        return 15
    return 11


def full_pool() -> list[str]:
    """Unshuffled 144-tile bag (multiset from TILE_BAG)."""
    pool: list[str] = []
    for letter, count in TILE_BAG.items():
        pool.extend([letter] * count)
    return pool


POOL_SIZE = sum(TILE_BAG.values())


def build_shuffled_pool(rng) -> list[str]:
    pool = full_pool()
    rng.shuffle(pool)
    return pool


def verify_pool_contents(tiles: list[str]) -> bool:
    """True if tiles are exactly one full bag (order may differ)."""
    if len(tiles) != POOL_SIZE:
        return False
    counts: dict[str, int] = {}
    for ch in tiles:
        counts[ch] = counts.get(ch, 0) + 1
    return counts == TILE_BAG


def verify_hand_from_pool(rack: list[str], bunch: list[str]) -> bool:
    """Rack + bunch (no board) must be a subset of one bag, size <= POOL_SIZE."""
    return len(rack) + len(bunch) <= POOL_SIZE and verify_pool_contents(rack + bunch)


def verify_all_tiles(rack: list[str], bunch: list[str], board: list[str]) -> bool:
    """Rack + bunch + board must be exactly one full bag."""
    return verify_pool_contents(rack + bunch + board)
