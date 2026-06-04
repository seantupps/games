
memo = {}

def solve_state(b, g, r, y_exists):
    state = (b, g, r, y_exists)
    if state in memo:
        return memo[state]
    
    if not y_exists:
        return False # Previous player took Y and won, current position is losing
    
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
    # The rule is: taking the prize always wins if you can take it according to rules.
    # In my logic, solve_state(0,0,0, False) is False, so if we take Y, we win.
    if b == 0 and g == 0 and (r + 1) <= 3:
        if not solve_state(0, 0, 0, False):
            memo[state] = True
            return True
            
    memo[state] = False
    return False

import json

# We want to solve for all states (b, g, r, True) where b, g, r in [0, 8]
results = {}
for b in range(9):
    for g in range(9):
        for r in range(9):
            res = solve_state(b, g, r, True)
            # Format: "B,G,R": boolean
            key = f"{b},{g},{r}"
            results[key] = res

with open('freestyle.json', 'w') as f:
    json.dump(results, f, indent=2)

print(f"Generated freestyle.json with {len(results)} states.")
