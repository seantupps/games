# Project layout

## `shared/` — client platform

| Folder | Loaded by | Contents |
|--------|-----------|----------|
| `shared/js/hub/` | Root `index.html` | Hub shell: bootstrap, chat, room, bridge, protocol |
| `shared/platform/` | Game iframes | `engine.js`, `logic.js`, `game-adapter.js` |
| `shared/network/` | Hub (+ games for schema) | `firebase-env.js`, `network.js`, `rtdb-schema.js` |
| `shared/mobile/` | Hub + game iframes | Viewport, mobile bar, keyboard, settings swipe |
| `shared/dev/` | Hub (local/ngrok only) | `phone-debug-relay.js` |
| `shared/games/` | Hub + games | `registry.js` |
| `shared/css/` | Hub + games | `core.css`, `mobile.css` |

## Other top-level

| Path | Role |
|------|------|
| `games/{piles,line}/` | Per-game HTML, JS, CSS |
| `functions/` | Cloud Functions (`logic.js` synced from `shared/platform/logic.js`) |
| `ptests/` | Playwright / Node integration tests (not deployed) |
| `tests/` | Python line analysis tools (legacy) |
| `scripts/` | Dev stack, sync, tunnel helpers |
| `docs/` | Architecture and runbooks |
| `vendor/firebase/` | Offline Firebase compat SDK |

## Root config (Firebase / deploy)

`firebase.json`, `firebase.prod.json`, `database.rules*.json`, `database.seed.json`, `.firebaserc` — see `docs/FIREBASE_ENVIRONMENTS.md`.
