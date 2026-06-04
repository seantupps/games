"""Placement search — one best move at a time."""

from __future__ import annotations

from .grid import Board, Coord, rack_counts_key, validate_placement

# re-export for dictionary
__all__ = ["words_from_counts", "find_best_placement", "apply_placement"]


def words_from_counts(
    nodes,
    min_len: int,
    max_len: int,
    counts_key: tuple[int, ...],
    limit: int,
) -> list[str]:
    found: list[str] = []
    counts = list(counts_key)

    def dfs(node_idx: int, path: str, depth: int) -> None:
        if len(found) >= limit:
            return
        node = nodes[node_idx]
        if depth >= min_len and node["terminal"]:
            found.append(path.upper())
        if depth >= max_len:
            return
        for ch, child in node["children"].items():
            i = ord(ch) - 97
            if 0 <= i < 26 and counts[i] > 0:
                counts[i] -= 1
                dfs(child, path + ch, depth + 1)
                counts[i] += 1

    dfs(0, "", 0)
    found.sort(key=lambda w: (-len(w), w))
    return found


def _coords_for_word(
    word: str,
    ax: int,
    ay: int,
    anchor_i: int,
    horizontal: bool,
) -> list[Coord]:
    out: list[Coord] = []
    for i, ch in enumerate(word.upper()):
        if horizontal:
            out.append((ax + i - anchor_i, ay))
        else:
            out.append((ax, ay + i - anchor_i))
    return out


def _try_place(
    board: Board,
    word: str,
    coords: list[Coord],
    dictionary,
) -> int | None:
    """Rack letters used, or None if illegal."""
    new_coords_list: list[Coord] = []
    used = 0
    for c, ch in zip(coords, word.upper()):
        existing = board.cells.get(c)
        if existing:
            if existing != ch:
                return None
        else:
            new_coords_list.append(c)
            used += 1

    if used == 0:
        return None

    # Connectivity and word check without cloning
    new_coords_set = set(new_coords_list)
    if not board.is_connected_with(new_coords_set):
        return None

    # Temporarily apply new tiles to board for words_through check
    added: list[Coord] = []
    for c in new_coords_list:
        # We use a raw dict update to avoid by_letter overhead during trial
        board.cells[c] = word.upper()[coords.index(c)]
        added.append(c)

    ok = True
    for w in board.words_through(new_coords_set):
        if not dictionary.is_word(w):
            ok = False
            break

    # Rollback
    for c in added:
        del board.cells[c]

    return used if ok else None


def find_best_placement(
    board: Board, rack: list[str], dictionary
) -> tuple[str, list[Coord]] | None:
    if not rack:
        return None

    limit = 60 if len(rack) <= 4 else 100
    rack_set = {ch.upper() for ch in rack}
    best: tuple[str, list[Coord], int] | None = None

    if not board.cells:
        candidates = dictionary.rack_words(rack, limit=limit)
        if not candidates:
            return None
        for word in candidates[:24]:
            for horizontal in (True, False):
                coords = _coords_for_word(word, 0, 0, 0, horizontal)
                used = _try_place(board, word, coords, dictionary)
                if used is not None:
                    score = used * 100 + len(word)
                    if best is None or score > best[2]:
                        best = (word.upper(), coords, score)
        return (best[0], best[1]) if best else None

    # 1) "Rack-only" candidate generation
    candidates = dictionary.rack_words(rack, limit=limit)
    if candidates:
        for word in candidates:
            w = word.upper()
            for anchor_i, ch in enumerate(w):
                # Optimization: only check board locations that HAVE this letter
                anchors = board.by_letter.get(ch)
                if not anchors:
                    continue

                for ax, ay in anchors:
                    for horizontal in (True, False):
                        coords = _coords_for_word(w, ax, ay, anchor_i, horizontal)
                        used = _try_place(board, w, coords, dictionary)
                        if used is None:
                            continue
                        score = used * 100 + len(w)
                        if best is None or score > best[2]:
                            best = (w, coords, score)

    # 2) Additional search for the "bridge off existing word" case:
    #    when rack has only a single useful letter, consider words that use
    #    that one rack letter at a new empty cell, and take all other letters
    #    from already-occupied board cells.
    #
    #    This fixes cases like: board contains "... L ..." and rack contains "I"
    #    => allow placing the word "LI" by adding the "I" in the adjacent empty cell.
    min_len = getattr(dictionary, "min_len", 2)
    max_len = getattr(dictionary, "max_len", 15)

    # Multiset of rack letters (we only need membership counts for choosing the
    # single letter to place).
    rack_counts = [0] * 26
    for ch in rack:
        i = ord(ch.upper()) - 65
        if 0 <= i < 26:
            rack_counts[i] += 1
    rack_letters = [chr(i + 65) for i, n in enumerate(rack_counts) if n > 0]
    if rack_letters:
        # Empty cells adjacent to existing letters; new placements must connect.
        adj_empty: set[Coord] = set()
        for x, y in board.cells.keys():
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                c = (x + dx, y + dy)
                if c not in board.cells:
                    adj_empty.add(c)

        # Bound search to keep latency reasonable.
        adj_empty_list = list(adj_empty)
        if len(adj_empty_list) > 48:
            adj_empty_list.sort(
                key=lambda c: sum(
                    1
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                    if (c[0] + dx, c[1] + dy) in board.cells
                ),
                reverse=True,
            )
            adj_empty_list = adj_empty_list[:48]

        for new_x, new_y in adj_empty_list:
            for rack_ch in rack_letters:
                # Try both orientations; the new tile can participate in either.
                for horizontal in (True, False):
                    if horizontal:
                        left_max = 0
                        while (
                            left_max < max_len - 1
                            and (new_x - left_max - 1, new_y) in board.cells
                        ):
                            left_max += 1
                        right_max = 0
                        while (
                            right_max < max_len - 1
                            and (new_x + right_max + 1, new_y) in board.cells
                        ):
                            right_max += 1

                        # Words must include the new tile and may extend into
                        # contiguous occupied cells only (no additional empties).
                        for le in range(0, left_max + 1):
                            for re in range(
                                0, min(right_max, max_len - 1 - le) + 1
                            ):
                                word_len = le + 1 + re
                                if word_len < min_len:
                                    continue

                                coords = [(x, new_y) for x in range(new_x - le, new_x + re + 1)]
                                # Build word letters from fixed board letters plus the chosen rack letter.
                                word_chars: list[str] = []
                                ok = True
                                for x in range(new_x - le, new_x + re + 1):
                                    if x == new_x:
                                        word_chars.append(rack_ch)
                                    else:
                                        ch = board.cells.get((x, new_y))
                                        if ch is None:
                                            ok = False
                                            break
                                        word_chars.append(ch)
                                if not ok:
                                    continue

                                word = "".join(word_chars).upper()
                                if not dictionary.is_word(word):
                                    continue

                                used = _try_place(board, word, coords, dictionary)
                                if used is None:
                                    continue
                                score = used * 100 + len(word)
                                if best is None or score > best[2]:
                                    best = (word, coords, score)
                    else:
                        up_max = 0
                        while (
                            up_max < max_len - 1
                            and (new_x, new_y - up_max - 1) in board.cells
                        ):
                            up_max += 1
                        down_max = 0
                        while (
                            down_max < max_len - 1
                            and (new_x, new_y + down_max + 1) in board.cells
                        ):
                            down_max += 1

                        for ue in range(0, up_max + 1):
                            for de in range(
                                0, min(down_max, max_len - 1 - ue) + 1
                            ):
                                word_len = ue + 1 + de
                                if word_len < min_len:
                                    continue

                                coords = [(new_x, y) for y in range(new_y - ue, new_y + de + 1)]
                                word_chars = []
                                ok = True
                                for y in range(new_y - ue, new_y + de + 1):
                                    if y == new_y:
                                        word_chars.append(rack_ch)
                                    else:
                                        ch = board.cells.get((new_x, y))
                                        if ch is None:
                                            ok = False
                                            break
                                        word_chars.append(ch)
                                if not ok:
                                    continue

                                word = "".join(word_chars).upper()
                                if not dictionary.is_word(word):
                                    continue

                                used = _try_place(board, word, coords, dictionary)
                                if used is None:
                                    continue
                                score = used * 100 + len(word)
                                if best is None or score > best[2]:
                                    best = (word, coords, score)

    return (best[0], best[1]) if best else None


def apply_placement(board: Board, word: str, coords: list[Coord]) -> None:
    for c, ch in zip(coords, word.upper()):
        board.set_cell(c[0], c[1], ch)
