import functools
import json

@functools.lru_cache(None)
def solve(b, g, r, y_exists):
    if not y_exists:
        return False
    
    # B moves
    for i in range(1, 4):
        if b >= i:
            if not solve(b - i, g, r, True):
                return True
    # G moves
    for i in range(1, 4):
        if g >= i:
            if not solve(b, g - i, r, True):
                return True
    # R moves
    for i in range(1, 4):
        if r >= i:
            if not solve(b, g, r - i, True):
                return True
    # RY move
    if b == 0 and g == 0 and r + 1 <= 3:
        if not solve(0, 0, 0, False):
            return True
            
    return False

def get_strategy():
    strategy = {}
    for b in range(6):
        for g in range(6):
            for r in range(5):  # Max 4 Red pieces
                # We only want states where Yellow STILL EXISTS
                y = True
                res = solve(b, g, r, y)
                strategy[f"{b},{g},{r},{y}"] = res
    return strategy

if __name__ == "__main__":
    s = get_strategy()
    with open("d:/Projects/five/tests/strategy.json", "w") as f:
        json.dump(s, f, indent=2)
    print("Strategy saved to tests/strategy.json")
    
    # Check 5,5,4,True
    print(f"5,5,4,True: {s['5,5,4,True']}")
