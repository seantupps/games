# Quoridor

Singleplayer vs AI (P1 human, P2 greedy), same lobby pattern as Line/Piles.

- **Layout:** `fit-square` (`localSize` 800), zoom OK, no free pan
- **Theme:** hub `--theme-color` / `--opponent-color`
- **AI:** Web Worker (`ai-worker.js`) + `onAITurn` / `triggerAITurn`
- **MP:** not shipped yet (`hideWhenPartyAtLeast: 2`)

```bash
npm run serve          # hub → Quoridor
npm run sp:quoridor    # desktop SP audit
```

CLI research engine remains under `build/quoridor/`.
