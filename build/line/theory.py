import time
import sys
import json
import numpy as np
import numba
from numba import njit, uint64, int8, types
from numba.typed import Dict
import struct
import os
import gzip

# Grid Configuration
GRID_SIZE = 4
NODES = GRID_SIZE * GRID_SIZE

def get_coord(i): return (i % GRID_SIZE, i // GRID_SIZE)
def get_id(x, y): return y * GRID_SIZE + x

def get_nodes_on_segment(a_id, b_id):
    ax, ay = get_coord(a_id); bx, by = get_coord(b_id)
    middle = []
    for i in range(NODES):
        if i == a_id or i == b_id: continue
        cx, cy = get_coord(i)
        if (cy - ay) * (bx - ax) != (by - ay) * (cx - ax): continue
        dot = (cx - ax) * (bx - ax) + (cy - ay) * (by - ay)
        if dot < 0 or dot > (bx - ax)**2 + (by - ay)**2: continue
        middle.append(i)
    middle.sort(key=lambda n: (get_coord(n)[0] - ax)**2 + (get_coord(n)[1] - ay)**2)
    return middle

ATOMIC_SEGMENTS = []
for i in range(NODES):
    for j in range(i + 1, NODES):
        if not get_nodes_on_segment(i, j): ATOMIC_SEGMENTS.append(tuple(sorted((i, j))))

SEG_TO_IDX = {s: i for i, s in enumerate(ATOMIC_SEGMENTS)}
NUM_SEGS = len(ATOMIC_SEGMENTS)

SEG_INTERSECT_MASK = [0] * NUM_SEGS
for i in range(NUM_SEGS):
    m = 0
    for j in range(NUM_SEGS):
        def ccw(A, B, C):
            ax, ay = get_coord(A); bx, by = get_coord(B); cx, cy = get_coord(C)
            val = (cy - ay) * (bx - ax) - (by - ay) * (cx - ax)
            return 1 if val > 0 else (-1 if val < 0 else 0)
        def intersect(s1, s2):
            A, B = s1; C, D = s2
            if A in (C, D) or B in (C, D): return False
            return ccw(A, C, D) != ccw(B, C, D) and ccw(A, B, C) != ccw(A, B, D)
        if i != j and intersect(ATOMIC_SEGMENTS[i], ATOMIC_SEGMENTS[j]): m |= (1 << j)
    SEG_INTERSECT_MASK[i] = m

def get_transformations():
    transforms = []
    ops = [
        lambda x, y: (x, y), lambda x, y: (3-y, x), lambda x, y: (3-x, 3-y), lambda x, y: (y, 3-x),
        lambda x, y: (3-x, y), lambda x, y: (x, 3-y), lambda x, y: (y, x), lambda x, y: (3-y, 3-x)
    ]
    for op in ops: transforms.append([get_id(*op(*get_coord(i))) for i in range(NODES)])
    return transforms

TRANSFORMS = get_transformations()
TRANSFORMS_NP = np.array(TRANSFORMS, dtype=np.uint8)

SYMMETRY_LUT_NP = np.zeros((8, 11, 256, 2), dtype=np.uint64)
for s_idx, t_nodes in enumerate(TRANSFORMS):
    mapping = [SEG_TO_IDX[tuple(sorted((t_nodes[u], t_nodes[v])))] for u, v in ATOMIC_SEGMENTS]
    for chunk in range(11):
        for val in range(256):
            res = 0
            for bit in range(8):
                idx = chunk * 8 + bit
                if idx < NUM_SEGS and (val & (1 << bit)): res |= (1 << mapping[idx])
            SYMMETRY_LUT_NP[s_idx, chunk, val, 0] = uint64(res >> 64)
            SYMMETRY_LUT_NP[s_idx, chunk, val, 1] = uint64(res & 0xFFFFFFFFFFFFFFFF)

@njit(cache=True)
def canonicalize_numba_with_idx(m_hi, m_lo, lut):
    best_hi, best_lo = uint64(m_hi), uint64(m_lo)
    best_idx = 0
    for s_idx in range(1, 8):
        new_hi, new_lo = uint64(0), uint64(0); t_lo, t_hi = uint64(m_lo), uint64(m_hi)
        for chunk in range(8):
            v = t_lo & uint64(255); new_hi |= lut[s_idx, chunk, v, 0]; new_lo |= lut[s_idx, chunk, v, 1]; t_lo >>= 8
        for chunk in range(8, 11):
            v = t_hi & uint64(255); new_hi |= lut[s_idx, chunk, v, 0]; new_lo |= lut[s_idx, chunk, v, 1]; t_hi >>= 8
        if new_hi < best_hi or (new_hi == best_hi and new_lo < best_lo):
            best_hi, best_lo = new_hi, new_lo
            best_idx = s_idx
    return best_hi, best_lo, best_idx

# Move priority: Center (5,6,9,10) > Edges > Corners
PRIO_MAP = {5:0, 6:0, 9:0, 10:0, 1:1, 2:1, 4:1, 7:1, 8:1, 11:1, 13:1, 14:1, 0:2, 3:2, 12:2, 15:2}

MOVE_LIST = []
for s in range(NODES):
    for e in range(NODES):
        if s == e: continue
        mid = get_nodes_on_segment(s, e); full = [s] + mid + [e]
        s_m = n_m = i_m = 0
        for k in range(len(full)-1):
            idx = SEG_TO_IDX[tuple(sorted((full[k], full[k+1])))]; s_m |= (1 << idx); i_m |= SEG_INTERSECT_MASK[idx]
        for node in full[1:]: n_m |= (1 << node)
        prio = PRIO_MAP[s] + PRIO_MAP[e]
        MOVE_LIST.append((uint64(s_m >> 64), uint64(s_m & 0xFFFFFFFFFFFFFFFF), uint64(n_m), uint64(i_m >> 64), uint64(i_m & 0xFFFFFFFFFFFFFFFF), uint64(s), uint64(e), prio))

# Re-sorting MOVE_LIST by start node first, then priority
MOVE_LIST.sort(key=lambda x: (x[5], x[7]))
MOVE_S_HI = np.array([m[0] for m in MOVE_LIST], dtype=np.uint64)
MOVE_S_LO = np.array([m[1] for m in MOVE_LIST], dtype=np.uint64)
MOVE_N_M  = np.array([m[2] for m in MOVE_LIST], dtype=np.uint64)
MOVE_I_HI = np.array([m[3] for m in MOVE_LIST], dtype=np.uint64)
MOVE_I_LO = np.array([m[4] for m in MOVE_LIST], dtype=np.uint64)
MOVE_START = np.array([m[5] for m in MOVE_LIST], dtype=np.uint8)
MOVE_END = np.array([m[6] for m in MOVE_LIST], dtype=np.uint8)

MOVE_PTRS = np.zeros(NODES + 1, dtype=np.int32)
curr = 0
for s in range(NODES):
    MOVE_PTRS[s] = curr
    for m in MOVE_LIST:
        if m[5] == s: curr += 1
MOVE_PTRS[NODES] = curr

@njit(cache=True)
def has_any_moves(m_hi, m_lo, used, ep, m_n_m, m_i_hi, m_i_lo, m_ptrs):
    for sn in range(NODES):
        if not (ep & uint64(1 << sn)): continue
        for mi in range(m_ptrs[sn], m_ptrs[sn+1]):
            if not ((used & m_n_m[mi]) or (m_hi & m_i_hi[mi]) or (m_lo & m_i_lo[mi])):
                return True
    return False

@njit(cache=True)
def solve_numba(m_hi, m_lo, used, ep, lut, m_s_hi, m_s_lo, m_n_m, m_i_hi, m_i_lo, m_start, m_end, m_ptrs, t_nodes, memo, best_moves):
    # Get canonical state
    c_hi, c_lo, s_idx = canonicalize_numba_with_idx(m_hi, m_lo, lut)
    k = (c_hi, c_lo)
    
    # memo[k] encoding: (depth + 2) if WIN, -(depth + 2) if LOSS
    if k in memo: return memo[k]

    min_win_depth = 10000 
    max_loss_depth = -1
    best_win_mi = -1
    best_loss_mi = -1
    any_moves = False

    for sn in range(NODES):
        if not (ep & uint64(1 << sn)): continue
        for mi in range(m_ptrs[sn], m_ptrs[sn+1]):
            if (used & m_n_m[mi]) or (m_hi & m_i_hi[mi]) or (m_lo & m_i_lo[mi]): continue
            
            any_moves = True
            child_hi, child_lo = m_hi | m_s_hi[mi], m_lo | m_s_lo[mi]
            child_used = used | m_n_m[mi]
            child_ep = ep ^ uint64(1 << int(m_start[mi])) ^ uint64(1 << int(m_end[mi]))
            
            # MISERE PRUNING: Immediate LOSS if we make a move that leaves opponent with NO moves
            if not has_any_moves(child_hi, child_lo, child_used, child_ep, m_n_m, m_i_hi, m_i_lo, m_ptrs):
                memo[k] = int8(-2) # We lose in 1 move
                best_moves[k] = uint64((t_nodes[s_idx, int(m_start[mi])] << 4) | t_nodes[s_idx, int(m_end[mi])])
                # We can't break here because this is a loss; we must keep looking for a win
                d = 0 # depth 0 loss for us
                if d > max_loss_depth:
                    max_loss_depth, best_loss_mi = d, mi
                continue
            
            # Recursive solve
            res = solve_numba(child_hi, child_lo, child_used, child_ep, lut, m_s_hi, m_s_lo, m_n_m, m_i_hi, m_i_lo, m_start, m_end, m_ptrs, t_nodes, memo, best_moves)
            
            if res < 0: # Opponent loss -> We win!
                d = abs(res) - 1
                if d < min_win_depth: 
                    min_win_depth, best_win_mi = d, mi
                if d == 0: break # Immediate Win found
            else:
                d = res - 1
                if d > max_loss_depth:
                    max_loss_depth, best_loss_mi = d, mi
        if best_win_mi != -1 and min_win_depth == 0: break

    if not any_moves:
        memo[k] = int8(1); return int8(1) # MISERE: No moves = WIN (depth 0)

    if best_win_mi != -1:
        res = int8(min_win_depth + 2); memo[k] = res
        best_moves[k] = uint64((t_nodes[s_idx, int(m_start[best_win_mi])] << 4) | t_nodes[s_idx, int(m_end[best_win_mi])])
        return res
    else:
        res = int8(-(max_loss_depth + 2)); memo[k] = res
        best_moves[k] = uint64((t_nodes[s_idx, int(m_start[best_loss_mi])] << 4) | t_nodes[s_idx, int(m_end[best_loss_mi])])
        return res

@njit(cache=True)
def extract_memo_numba(memo):
    n = len(memo)
    ws_hi, ws_lo, ws_val = np.zeros(n, dtype=np.uint64), np.zeros(n, dtype=np.uint64), np.zeros(n, dtype=np.int8)
    i = 0
    for k, v in memo.items():
        ws_hi[i], ws_lo[i], ws_val[i] = k[0], k[1], v; i += 1
    return ws_hi, ws_lo, ws_val

if __name__ == "__main__":
    memo = Dict.empty(key_type=types.Tuple((types.uint64, types.uint64)), value_type=int8)
    best_moves = Dict.empty(key_type=types.Tuple((types.uint64, types.uint64)), value_type=types.uint64)
    
    SLICE_LIMIT = -1 # -1 for full solve
    
    print(f"Solving Line Game (Exhaustive Value Table, Limit={SLICE_LIMIT})...")
    t0 = time.time()
    initial = []
    for i in range(NODES):
        for j in range(i + 1, NODES):
            mid = get_nodes_on_segment(i, j); fl = [i] + mid + [j]; s_m = n_m = 0
            for k in range(len(fl)-1): s_m |= (1 << SEG_TO_IDX[tuple(sorted((fl[k], fl[k+1])))])
            for node in fl[1:]: n_m |= (1 << node)
            initial.append((uint64(s_m >> 64), uint64(s_m & 0xFFFFFFFFFFFFFFFF), uint64(uint64(n_m) | uint64(1 << i)), uint64(uint64(1 << i) | uint64(1 << j))))
    
    if SLICE_LIMIT > 0: initial = initial[:SLICE_LIMIT]
    
    for m_hi, m_lo, n_m, ep in initial:
        solve_numba(m_hi, m_lo, n_m, ep, SYMMETRY_LUT_NP, MOVE_S_HI, MOVE_S_LO, MOVE_N_M, MOVE_I_HI, MOVE_I_LO, MOVE_START, MOVE_END, MOVE_PTRS, TRANSFORMS_NP, memo, best_moves)
    
    t_solve = time.time() - t0
    print(f"Solving complete in {t_solve:.2f}s. States: {len(memo):,}")
    
    t1 = time.time()
    # Numba-native extraction to avoid Python-layer OverflowError during large dict iteration
    w_hi, w_lo, w_val = extract_memo_numba(memo)
    idx = np.lexsort((w_lo, w_hi))
    w_hi, w_lo, w_val = w_hi[idx], w_lo[idx], w_val[idx]
    t_sort = time.time() - t1
    
    t2 = time.time()
    raw_path = "tests/line/line_ai_table.bin"
    output = bytearray()
    output.extend(struct.pack("<I", len(w_hi)))
    for i in range(len(w_hi)):
        full_mask = (int(w_hi[i]) << 64) | int(w_lo[i])
        output.extend(full_mask.to_bytes(11, 'big'))
        output.extend(struct.pack("b", w_val[i]))
    with open(raw_path, "wb") as f: f.write(output)
    t_write = time.time() - t2
    
    t3 = time.time()
    gz_path = raw_path + ".gz"
    level = 1 
    with open(raw_path, "rb") as f_in:
        with gzip.open(gz_path, "wb", compresslevel=level) as f_out: f_out.writelines(f_in)
    t_gz = time.time() - t3
    
    print(f"Stats: Sorting={t_sort:.2f}s | Disk_I/O={t_write:.2f}s | Gzip(L{level})={t_gz:.2f}s")
    print(f"Final Path: {gz_path} ({os.path.getsize(gz_path)/1024/1024:.2f} MB)")
