import random
import sys

class ColorPileGame:
    def __init__(self):
        self.piles = {
            'B': ['B', 'B', 'B', 'B', 'B'],
            'R': ['R', 'R', 'Y', 'R', 'R'],
            'G': ['G', 'G', 'G', 'G', 'G']
        }
        self.turn = "P1"  # P1 is user, P2 is AI

    def display_state(self):
        b_str = "".join(self.piles['B'])
        r_str = "".join(self.piles['R'])
        g_str = "".join(self.piles['G'])
        print(f"\n{b_str} {r_str} {g_str}")

    def is_valid_move(self, pile_key, items_to_remove):
        if pile_key not in self.piles:
            return False, "Invalid pile. Use B, R (for red/yellow), or G."
        
        count = len(items_to_remove)
        if count < 1 or count > 3:
            return False, "You must take 1-3 objects."
        
        # Check if all items exist in the target pile
        temp_pile = list(self.piles[pile_key])
        for item in items_to_remove:
            item_up = item.upper()
            if item_up in temp_pile:
                temp_pile.remove(item_up)
            else:
                return False, f"Pile {pile_key} does not have enough '{item_up}' pieces."

        # Yellow rule: cannot be taken until B and G are empty
        # AND it must be the final move for the Red pile (empties it)
        if 'Y' in [i.upper() for i in items_to_remove]:
            if self.piles['B'] or self.piles['G']:
                return False, "You cannot take the yellow piece until the Blue (B) and Green (G) piles are empty!"
            
            # Count how many pieces will be left in the R pile
            if len(self.piles['R']) > count:
                return False, "The yellow piece can only be taken if it is part of the move that empties the Red pile!"
        
        return True, ""

    def make_move(self, move_str):
        if not move_str:
            return False, "Empty move."
        
        # Determine pile key. If mixed, we need to be careful.
        # But 'R' and 'Y' are in the same 'R' pile. 
        # So we check if all chars belong to the same pile.
        item_to_pile = {'B': 'B', 'R': 'R', 'Y': 'R', 'G': 'G'}
        piles_found = set()
        for c in move_str:
            c_up = c.upper()
            if c_up not in item_to_pile:
                return False, f"Invalid character '{c}'."
            piles_found.add(item_to_pile[c_up])
        
        if len(piles_found) > 1:
            return False, "You can only take from ONE pile per turn."
        
        pile_key = list(piles_found)[0]
        items_to_remove = [c.upper() for c in move_str]
        
        valid, msg = self.is_valid_move(pile_key, items_to_remove)
        if not valid:
            return False, msg
        
        # Perform removal
        for item in items_to_remove:
            self.piles[pile_key].remove(item)
            
        return True, ""

    def get_ai_move(self, difficulty="random"):
        if difficulty == "perfect":
            move = self.get_perfect_ai_move()
            if move:
                return move
        
        # Fallback to random if perfect move not found or difficulty is random
        available_piles = [k for k, v in self.piles.items() if v]
        valid_moves = []
        for pk in available_piles:
            pile_content = list(self.piles[pk])
            for count in range(1, min(4, len(pile_content) + 1)):
                items = pile_content[:count]
                valid, _ = self.is_valid_move(pk, items)
                if valid:
                    valid_moves.append("".join(items))
                    
        if not valid_moves:
            return None
        return random.choice(valid_moves)

    def get_perfect_ai_move(self):
        # Current state
        b = len(self.piles['B'])
        g = len(self.piles['G'])
        r = sum(1 for c in self.piles['R'] if c == 'R')
        y_exists = 'Y' in self.piles['R']
        
        memo = {}

        def can_win(b_c, g_c, r_c, y_e):
            state = (b_c, g_c, r_c, y_e)
            if state in memo:
                return memo[state]
            
            if not y_e:
                return False, None # The player who just moved took Y and won, so this state is a Loss for the current player
            
            # Generate all possible moves
            moves = []
            # Blue moves
            for i in range(1, 4):
                if b_c >= i: moves.append(('B', ['B']*i, (b_c-i, g_c, r_c, y_e)))
            # Green moves
            for i in range(1, 4):
                if g_c >= i: moves.append(('G', ['G']*i, (b_c, g_c-i, r_c, y_e)))
            # Red moves
            for i in range(1, 4):
                if r_c >= i: moves.append(('R', ['R']*i, (b_c, g_c, r_c-i, y_e)))
            # Yellow move rule: can take Y if B and G empty and empties the R pile
            if b_c == 0 and g_c == 0:
                # Total pieces in R = r_c + 1
                if r_c + 1 <= 3:
                    # Move takes all remaining R's and the Y
                    move_items = ['R']*r_c + ['Y']
                    moves.append(('R', move_items, (0, 0, 0, False)))

            for pile_key, items, next_state in moves:
                # If any move leads to a losing state for the opponent, we win
                opponent_can_win, _ = can_win(*next_state)
                if not opponent_can_win:
                    memo[state] = (True, "".join(items))
                    return memo[state]
            
            memo[state] = (False, None)
            return memo[state]

        winning, move_str = can_win(b, g, r, y_exists)
        return move_str

    def is_game_over(self):
        return 'Y' not in self.piles['R']

    def play(self):
        difficulty = "perfect"
        
        while not self.is_game_over():
            self.display_state()
            if self.turn == "P1":
                move = input(f"{self.turn}: ").strip()
                success, error = self.make_move(move)
                if success:
                    if self.is_game_over():
                        print(f"\n{self.turn} took the yellow piece and WINS!")
                        break
                    self.turn = "P2"
                else:
                    print(f"Error: {error}")
            else:
                move = self.get_ai_move(difficulty)
                print(f"{self.turn}: {move}")
                self.make_move(move)
                if self.is_game_over():
                    self.display_state()
                    print(f"\n{self.turn} took the yellow piece and WINS!")
                    break
                self.turn = "P1"

if __name__ == "__main__":
    game = ColorPileGame()
    game.play()
