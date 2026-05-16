def count_games():
    memo = {}

    def solve(b, g, r, y_exists):
        state = (b, g, r, y_exists)
        if state in memo:
            return memo[state]
        
        # Terminal state: y_exists is False (someone took the yellow piece)
        if not y_exists:
            return 1
        
        total = 0
        
        # Moves from Blue pile
        for i in range(1, 4):
            if b >= i:
                total += solve(b - i, g, r, y_exists)
        
        # Moves from Green pile
        for i in range(1, 4):
            if g >= i:
                total += solve(b, g - i, r, y_exists)
                
        # Moves from Red pile
        # 1. Take only R pieces
        for i in range(1, 4):
            if r >= i:
                total += solve(b, g, r - i, y_exists)
        
        # 2. Take the Yellow piece
        # Rule: Only if B and G are empty AND it empties the Red pile
        # In our case, if B=0, G=0, and we take all remaining R's and the Y
        # Total pieces in R pile = r + 1 (if y_exists)
        if b == 0 and g == 0:
            remaining_r_plus_y = r + 1
            if remaining_r_plus_y <= 3:
                # This move takes all remaining pieces and the Y
                total += solve(0, 0, 0, False)
                
        memo[state] = total
        return total

    # Initial state: BBBB, GGGG, RRYRR (4 R, 1 Y)
    # Wait, the user said "3 piles of 5 objects".
    # BBBB was a mistake in my thought, it's 5 B, 5 G, and (4 R + 1 Y) = 5 R/Y.
    result = solve(5, 5, 4, True)
    return result

if __name__ == "__main__":
    total = count_games()
    print(f"Total possible games: {total}")
    with open("game_analysis.txt", "w") as f:
        f.write(f"Total possible unique game sequences: {total}\n")
