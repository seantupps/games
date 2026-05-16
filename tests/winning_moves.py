import json

def analyze_winning_openings():
    try:
        with open("d:/Projects/five/tests/strategy.json", "r") as f:
            strategy = json.load(f)
    except FileNotFoundError:
        print("Error: strategy.json not found. Run generate_strategy.py first.")
        return

    # Initial State
    b_init, g_init, r_init = 5, 5, 4
    y_init = True
    
    print(f"FINDING WINNING OPENING MOVES FOR: B:{b_init}, G:{g_init}, R:{r_init}, Y:{y_init}")
    print("-" * 65)
    
    # Try all moves
    winning_moves = []
    
    # 1. Blue moves
    for i in range(1, 4):
        next_state = f"{b_init - i},{g_init},{r_init},{y_init}"
        if next_state in strategy and strategy[next_state] == False:
            winning_moves.append(f"Take {i} from Blue -> leaves {next_state}")

    # 2. Green moves
    for i in range(1, 4):
        next_state = f"{b_init},{g_init - i},{r_init},{y_init}"
        if next_state in strategy and strategy[next_state] == False:
            winning_moves.append(f"Take {i} from Green -> leaves {next_state}")

    # 3. Red moves (Rs only)
    for i in range(1, 4):
        next_state = f"{b_init},{g_init},{r_init - i},{y_init}"
        if next_state in strategy and strategy[next_state] == False:
            winning_moves.append(f"Take {i} from Red -> leaves {next_state}")

    if winning_moves:
        print("WINNING MOVES (that lead to a LOSS for your opponent):")
        for move in winning_moves:
            print(f" [!] {move}")
    else:
        print("No winning opening moves found.")

if __name__ == "__main__":
    analyze_winning_openings()
