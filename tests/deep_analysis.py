import functools

# The rules:
# 1. Take 1-3 pieces from one pile.
# 2. Yellow (Y) is in the Red pile.
# 3. Y can ONLY be taken if Blue (B) and Green (G) are empty.
# 4. Y must be part of the move that empties the Red pile.
# 5. Last player to take a piece (specifically Y) wins. 
#    Actually, since Y is the last piece, the winner is whoever takes Y.

@functools.lru_cache(None)
def solve(b, g, r, y_exists):
    """
    Returns True if the current state is a winning state.
    """
    if not y_exists:
        # The game ended in the previous turn. 
        # The player who arrives at this state has lost.
        return False
    
    # Possible moves:
    # 1. Take from Blue (1-3)
    for i in range(1, 4):
        if b >= i:
            if not solve(b - i, g, r, True):
                return True
    
    # 2. Take from Green (1-3)
    for i in range(1, 4):
        if g >= i:
            if not solve(b, g - i, r, True):
                return True
    
    # 3. Take from Red (1-3)
    # Can only take Red pieces if B/G are not empty OR if taking Y is not possible
    for i in range(1, 4):
        if r >= i:
            if not solve(b, g, r - i, True):
                return True
                
    # 4. Take Yellow (possibly with Red pieces)
    # ONLY if B and G are empty AND it empties the Red pile
    if b == 0 and g == 0:
        # Must take all remaining Reds + Yellow
        # This is only possible if Total (r + 1) <= 3
        if r + 1 <= 3:
            if not solve(0, 0, 0, False):
                return True
                
    return False

def find_best_move(b, g, r, y_exists):
    moves = []
    if y_exists:
        # Take from B
        for i in range(1, 4):
            if b >= i:
                moves.append((f"B:{i}", (b-i, g, r, True)))
        # Take from G
        for i in range(1, 4):
            if g >= i:
                moves.append((f"G:{i}", (b, g-i, r, True)))
        # Take from R
        for i in range(1, 4):
            if r >= i:
                moves.append((f"R:{i}", (b, g, r-i, True)))
        # Take Y
        if b == 0 and g == 0 and r + 1 <= 3:
            moves.append((f"RY:{r+1}", (0, 0, 0, False)))
            
    for name, next_state in moves:
        if not solve(*next_state):
            return name, next_state
    return None, None

def print_analysis(b, g, r):
    print(f"State: B:{b}, G:{g}, R:{r}, Y:True")
    is_win = solve(b, g, r, True)
    print(f"Outcome: {'WIN' if is_win else 'LOSS'}")
    if is_win:
        name, next_state = find_best_move(b, g, r, True)
        print(f"Winning move: {name} -> {next_state}")
    print("-" * 40)

if __name__ == "__main__":
    # Test a few states
    print_analysis(0, 0, 0) # R:0, Y:1 -> WIN (Take Y)
    print_analysis(0, 0, 1) # R:1, Y:1 -> WIN (Take R, Y)
    print_analysis(0, 0, 2) # R:2, Y:1 -> WIN (Take R, R, Y)
    print_analysis(0, 0, 3) # R:3, Y:1 -> LOSS (Can't take all 4, MUST leave some)
    print_analysis(0, 0, 4) # R:4, Y:1 -> WIN (Take 1 R -> leaves 3,1 which is LOSS)
    
    print_analysis(1, 0, 0) # B:1, Y:1 -> LOSS (Must take B -> leaves 0,0,0,1 which is WIN for next)
    
    print_analysis(5, 5, 4) # 5B, 5G, 4R + 1Y = 3 piles of 5
