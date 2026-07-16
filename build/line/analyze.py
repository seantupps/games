import gzip
import struct
import sys
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TABLE_PATH = os.path.join(ROOT, 'games', 'line', 'ai', 'line_ai_table.bin.gz')

# Grid Constants
GRID_SIZE = 4
NODES = GRID_SIZE * GRID_SIZE

def get_coord(i): return (i % GRID_SIZE, i // GRID_SIZE)
def get_id(x, y): return y * GRID_SIZE + x

def get_nodes_on_segment(a_id, b_id):
    ax, ay = get_coord(a_id); bx, by = get_coord(b_id)
    nodes = []
    for i in range(NODES):
        if i == a_id or i == b_id: continue
        cx, cy = get_coord(i)
        if (cy - ay) * (bx - ax) != (by - ay) * (cx - ax): continue
        dot = (cx - ax) * (bx - ax) + (cy - ay) * (by - ay)
        if dot < 0 or dot > (bx - ax)**2 + (by - ay)**2: continue
        nodes.append(i)
    nodes.sort(key=lambda n: (get_coord(n)[0] - ax)**2 + (get_coord(n)[1] - ay)**2)
    return nodes

# Build Segment & Intersect Maps
ATOMIC_SEGMENTS = []
for i in range(NODES):
    for j in range(i + 1, NODES):
        if not get_nodes_on_segment(i, j): ATOMIC_SEGMENTS.append(tuple(sorted((i, j))))

SEG_TO_IDX = {s: i for i, s in enumerate(ATOMIC_SEGMENTS)}
NUM_SEGS = len(ATOMIC_SEGMENTS)

def ccw(A, B, C):
    ax, ay = get_coord(A); bx, by = get_coord(B); cx, cy = get_coord(C)
    val = (cy - ay) * (bx - ax) - (by - ay) * (cx - ax)
    return 1 if val > 0 else (-1 if val < 0 else 0)

def intersect(s1, s2):
    A, B = s1; C, D = s2
    if A in (C, D) or B in (C, D): return False
    return ccw(A, C, D) != ccw(B, C, D) and ccw(A, B, C) != ccw(A, B, D)

SEG_INTERSECT_MASK = [0] * NUM_SEGS
for i in range(NUM_SEGS):
    m = 0
    for j in range(NUM_SEGS):
        if i != j and intersect(ATOMIC_SEGMENTS[i], ATOMIC_SEGMENTS[j]): m |= (1 << j)
    SEG_INTERSECT_MASK[i] = m

ALL_MOVES = []
for s in range(NODES):
    for e in range(NODES):
        if s == e: continue
        mid = get_nodes_on_segment(s, e); full = [s] + mid + [e]
        s_m = n_m = i_m = 0
        for k in range(len(full)-1):
            idx = SEG_TO_IDX[tuple(sorted((full[k], full[k+1])))]; s_m |= (1 << idx); i_m |= SEG_INTERSECT_MASK[idx]
        for node in full[1:]: n_m |= (1 << node)
        ALL_MOVES.append({'start': s, 'end': e, 'seg_mask': s_m, 'node_mask': n_m, 'int_mask': i_m})

def transform_node(n, t_idx):
    x, y = get_coord(n)
    if t_idx == 1: nx, ny = (3 - y), x # R90
    elif t_idx == 2: nx, ny = (3 - x), (3 - y) # R180
    elif t_idx == 3: nx, ny = y, (3 - x) # R270
    elif t_idx == 4: nx, ny = (3 - x), y # FlipX
    elif t_idx == 5: nx, ny = x, (3 - y) # FlipY
    elif t_idx == 6: nx, ny = y, x # FlipD1
    elif t_idx == 7: nx, ny = (3 - y), (3 - x) # FlipD2
    else: return n
    return int(ny * 4 + nx)

def binary_state_lookup(data, count, mask_hi, mask_lo):
    for t_idx in range(8):
        t_mask_full = 0
        for idx in range(NUM_SEGS):
            is_set = (mask_lo & (1 << idx)) if idx < 64 else (mask_hi & (1 << (idx - 64)))
            if is_set:
                u, v = ATOMIC_SEGMENTS[idx]
                nu, nv = transform_node(u, t_idx), transform_node(v, t_idx)
                if tuple(sorted((nu, nv))) in SEG_TO_IDX:
                    t_mask_full |= (1 << SEG_TO_IDX[tuple(sorted((nu, nv)))])
        
        low, high = 0, count - 1
        while low <= high:
            mid = (low + high) // 2
            offset = 4 + (mid * 12)
            m_val = int.from_bytes(data[offset : offset + 11], 'big')
            if m_val == t_mask_full:
                res_raw = data[offset + 11]
                return struct.unpack("b", bytes([res_raw]))[0]
            elif m_val < t_mask_full: low = mid + 1
            else: high = mid - 1
    return None

def find_strategy(data, count, mask_hi, mask_lo, used_mask, eps):
    responses = []
    for mv in ALL_MOVES:
        if not (eps & (1 << mv['start'])): continue
        if (used_mask & mv['node_mask']) or (mask_hi & (mv['int_mask'] >> 64)) or (mask_lo & (mv['int_mask'] & 0xFFFFFFFFFFFFFFFF)):
            continue
        
        res_hi, res_lo = mask_hi | (mv['seg_mask'] >> 64), mask_lo | (mv['seg_mask'] & 0xFFFFFFFFFFFFFFFF)
        val = binary_state_lookup(data, count, res_hi, res_lo)
        if val is not None: responses.append({'move': (mv['start']+1, mv['end']+1), 'val': val})
    return responses

def main():
    path = TABLE_PATH
    if not os.path.exists(path): return print(f"Error: {path} not found.")
    with gzip.open(path, "rb") as f:
        data = f.read(); count = struct.unpack("<I", data[:4])[0]
    
    args = sys.argv[1:]
    if not args:
        print(f"Strategy Table Loaded: {count:,} states.")
        print("\nWINNING OPENING MOVES:")
        wins = []
        for mv in [m for m in ALL_MOVES if m['start'] < m['end']]:
            val = binary_state_lookup(data, count, mv['seg_mask'] >> 64, mv['seg_mask'] & 0xFFFFFFFFFFFFFFFF)
            if val is not None and val < 0: wins.append(((mv['start']+1, mv['end']+1), abs(val)-1))
        for w in sorted(wins, key=lambda x: x[1]): print(f"  [WIN] {w[0][0]} -> {w[0][1]} (Depth {w[1]})")
        return

    # Process Move Sequence
    m_hi = m_lo = u_mask = eps = 0
    seq = []
    for i in range(0, len(args), 2):
        s, e = int(args[i])-1, int(args[i+1])-1
        mv = [m for m in ALL_MOVES if m['start'] == s and m['end'] == e]
        if not mv: return print(f"Invalid move: {s+1} -> {e+1}")
        m = mv[0]
        
        # Validity Check
        if eps != 0 and not (eps & (1 << s)): return print(f"Move {s+1}->{e+1} does not connect to path endpoints.")
        if u_mask & m['node_mask']: return print(f"Move {s+1}->{e+1} intersects or uses existing nodes.")
        if (m_hi & (m['int_mask'] >> 64)) or (m_lo & (m['int_mask'] & 0xFFFFFFFFFFFFFFFF)): return print(f"Move {s+1}->{e+1} intersects existing lines.")
        
        m_hi |= (m['seg_mask'] >> 64); m_lo |= (m['seg_mask'] & 0xFFFFFFFFFFFFFFFF)
        u_mask |= m['node_mask'] | (1 << s)
        eps = (1 << s) | (1 << e) if eps == 0 else eps ^ (1 << s) ^ (1 << e)
        seq.append(f"{s+1}->{e+1}")

    current_val = binary_state_lookup(data, count, m_hi, m_lo)
    turn = "PLAYER 1" if (len(args)//2) % 2 == 0 else "PLAYER 2"
    next_up = "PLAYER 2" if turn == "PLAYER 1" else "PLAYER 1"
    
    print(f"\nPOSITION AFTER SEQUENCE: {' | '.join(seq)}")
    if current_val is None: print("  Outcome: UNDEFINED (State missing from table)")
    elif current_val < 0: print(f"  Outcome: FORCED WIN FOR {turn} ({next_up} loses in {abs(current_val)-1} moves)")
    else: print(f"  Outcome: FORCED WIN FOR {next_up} ({next_up} wins in {current_val-1} moves)")

    responses = find_strategy(data, count, m_hi, m_lo, u_mask, eps)
    print(f"\nLEGAL RESPONSES (FOR {next_up}):")
    for r in sorted(responses, key=lambda x: x['val']):
        tag = "[LOSS]" if r['val'] > 0 else "[WIN]"
        print(f"  {r['move'][0]} -> {r['move'][1]:2} : {tag:8} (Depth {abs(r['val'])-1})")

if __name__ == "__main__":
    main()
