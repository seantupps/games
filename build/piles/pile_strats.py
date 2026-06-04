
memo = {}

def solve_state(b, g, r, y_exists):
    state = (b, g, r, y_exists)
    if state in memo:
        return memo[state]
    
    if not y_exists:
        return False # Previous player took Y and won
    
    # Try all moves
    # Take 1-3 from Blue
    for i in range(1, 4):
        if b >= i:
            if not solve_state(b - i, g, r, y_exists):
                memo[state] = True
                return True
                
    # Take 1-3 from Green
    for i in range(1, 4):
        if g >= i:
            if not solve_state(b, g - i, r, y_exists):
                memo[state] = True
                return True
                
    # Take 1-3 from Red (not including Y)
    for i in range(1, 4):
        if r >= i:
            if not solve_state(b, g, r - i, y_exists):
                memo[state] = True
                return True
                
    # Take Y (requires B=0, G=0, and r is all that's left)
    if b == 0 and g == 0 and (r + 1) <= 3:
        if not solve_state(0, 0, 0, False):
            memo[state] = True
            return True
            
    memo[state] = False
    return False

import sys

# Find all losing starting positions for P1
def generate_losing_report():
    losing_positions = []
    checked_count = 0
    for b in range(1, 9):
        for g in range(1, 9):
            for r in range(1, 9):
                if 14 <= (b + g + r) <= 20:
                    checked_count += 1
                    if not solve_state(b, g, r, True):
                        losing_positions.append((b, g, r))
    return checked_count, losing_positions
