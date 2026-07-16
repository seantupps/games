# GOPS (Game of Pure Strategy)

Singleplayer vs AI — full **N=13** deal each game.

- Both hands **open** (you can see AI’s cards)
- Prize pile face-down on the left; current prize(s) face-up
- Drag a card from your hand into the play slot
- Card faces tinted with theme / opponent colors
- AI: same Nash/SM as terminal `gops` via local `/gops-ai/bid` (needs `games` stack); heuristic fallback if offline

```bash
games                 # stack (first bid warms the gops daemon)
# hub → GOPS
npm run sp:gops
node scripts/dev/bench-gops-ai.js
```
