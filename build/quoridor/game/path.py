"""Quoridor pathfinding — Numba BFS on openWays grids."""

from __future__ import annotations

import numpy as np
from numba import njit

SIZE = 9
WALL_N = 8
INF = 32767


@njit(cache=True)
def shortest_path_length(
    up_down: np.ndarray,
    left_right: np.ndarray,
    start_r: int,
    start_c: int,
    goal_row: int,
) -> int:
    """BFS distance from (start_r, start_c) to any cell on goal_row. INF if none."""
    if start_r == goal_row:
        return 0

    dist = np.full((SIZE, SIZE), INF, dtype=np.int16)
    qr = np.empty(SIZE * SIZE, dtype=np.int16)
    qc = np.empty(SIZE * SIZE, dtype=np.int16)
    head = 0
    tail = 0

    dist[start_r, start_c] = 0
    qr[tail] = start_r
    qc[tail] = start_c
    tail = 1

    while head < tail:
        r = int(qr[head])
        c = int(qc[head])
        head += 1
        d = int(dist[r, c]) + 1

        # up
        if r > 0 and up_down[r - 1, c] and dist[r - 1, c] == INF:
            nr, nc = r - 1, c
            dist[nr, nc] = d
            if nr == goal_row:
                return d
            qr[tail] = nr
            qc[tail] = nc
            tail += 1
        # down
        if r < 8 and up_down[r, c] and dist[r + 1, c] == INF:
            nr, nc = r + 1, c
            dist[nr, nc] = d
            if nr == goal_row:
                return d
            qr[tail] = nr
            qc[tail] = nc
            tail += 1
        # left
        if c > 0 and left_right[r, c - 1] and dist[r, c - 1] == INF:
            nr, nc = r, c - 1
            dist[nr, nc] = d
            if nr == goal_row:
                return d
            qr[tail] = nr
            qc[tail] = nc
            tail += 1
        # right
        if c < 8 and left_right[r, c] and dist[r, c + 1] == INF:
            nr, nc = r, c + 1
            dist[nr, nc] = d
            if nr == goal_row:
                return d
            qr[tail] = nr
            qc[tail] = nc
            tail += 1

    return INF


@njit(cache=True)
def path_exists(
    up_down: np.ndarray,
    left_right: np.ndarray,
    start_r: int,
    start_c: int,
    goal_row: int,
) -> bool:
    return shortest_path_length(up_down, left_right, start_r, start_c, goal_row) < INF


def arrays_from_open_ways(up_down_list, left_right_list):
    """Python bool lists → contiguous uint8 arrays for Numba."""
    up = np.asarray(up_down_list, dtype=np.uint8)
    left = np.asarray(left_right_list, dtype=np.uint8)
    return np.ascontiguousarray(up), np.ascontiguousarray(left)


def warmup() -> None:
    """Force-JIT with a trivial open board."""
    up = np.ones((WALL_N, SIZE), dtype=np.uint8)
    left = np.ones((SIZE, WALL_N), dtype=np.uint8)
    _ = shortest_path_length(up, left, 8, 4, 0)
    _ = shortest_path_length(up, left, 0, 4, 8)
