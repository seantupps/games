# New game scaffold

Copy via `npm run new-game -- <id> --label="My Game"` (patches registry + logic stub).

Follow **[docs/GAME_PLATFORM.md](../../docs/GAME_PLATFORM.md)** and the checklist in **[notes/game_prep.txt](../../notes/game_prep.txt)**.

## Iframe contract (standard 2p turn-based)

| Method / field | Purpose |
|----------------|---------|
| `getValidMoves()` + `submitMove(move)` | SP/MP move loop |
| `isOver`, `winner`, `scores`, `turn` | Victory / reset audits |
| `isAuditReady()` | MP ready when `boardKind: generic` |
| `serializeBoard` / `applyBoard` | MP sync |
| `isMultiplayer`, `playerRole`, `roomId`, `identitySynced` | MP bootstrap |

Drag-only or simultaneous games: set `skipGameLoop: true` in `desktop-sp.js` / use Bananagrams-style custom MP.

## Do not

Add `if (gameName === '<id>')` in `engine.js` — set **capabilities** in `shared/games/registry.js` instead.
