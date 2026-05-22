# Game platform architecture

## Add a new game (ordered checklist)

### 1. Registry (`shared/games/registry.js`)

Add one `GameDefinition` object. This wires hub, RTDB reset, SP tests, and MP tests.

| Field | Required | Notes |
|--------|----------|--------|
| `id`, `label`, `logicKey` | yes | `logicKey` must match `GameLogic[logicKey]` |
| `modes`, `defaultMode` | yes | |
| `capabilities` | yes | See table below — engine branches on these, **not** `gameName` |
| `capabilitiesByMode` | optional | Per-mode overrides (e.g. freestyle layout) |
| `globalResetKeys` | yes | RTDB keys cleared on host game/mode switch |
| `clearGameDataOnReset` | yes | Usually `true` when using event log |
| `auditConfig` or `auditByMode` | yes for SP | Directory under `ptests/desktop/singleplayer/` |
| `mpAuditConfig` or `mpAuditByMode` | yes for MP | Directory under `ptests/desktop/multiplayer/` |

**Capabilities (defaults in `DEFAULT_CAPABILITIES`):**

| Flag | Meaning |
|------|---------|
| `boardKind` | `'line'`, `'piles'`, or `'generic'` — engine layout/board paths |
| `mobileLayoutPolicy` | `'none'`, `'fit-square'`, `'piles-dynamic'`, `'fixed-spiral-anchor'` |
| `syncStyle` | `'event-log'` (prefer for new games), `'hybrid'`, `'snapshot'` |
| `hasBoardState` | Host writes `global/board` on reset |
| `supportsDragging` | Piece/node drag UX |
| `supportsRealtimePreviews` | Opponent sees live drag (line) |
| `supportsPileColors` | Freestyle pile color RTDB sync |
| `supportsZoom` / `supportsLongPressEndTurn` / … | See registry typedef |

**Do not** add `if (gameName === 'yourgame')` in `engine.js`. Add a capability or a hook on your game class.

### 2. Logic (`shared/platform/logic.js`)

Implement `GameLogic[yourId]`:

- `initialState(mode, seed?)`
- `isValidMove(state, move)`
- `applyMove(state, move)`

Then run:

```bash
npm run sync:logic
```

### 3. Game iframe (`games/<id>/`)

Copy `games/_template/` → `games/<your-id>/`.

| File | Role |
|------|------|
| `index.html` | Script order: registry → game-adapter → engine → logic → your game |
| `<id>.js` | `class X extends BaseGame` — render, `getValidMoves`, hooks only |
| `style.css` | Game visuals |

**Hooks:**

- `serializeBoard()` / `applyBoard()` if `hasBoardState`
- `onGameReset()` — clear local UI on rematch
- `getExtraGlobalReset()` — extra RTDB null keys if needed

### 4. Hub button

Registry-only: `#game-picker-host` is filled by `HubGamePickerUI.mountGamePickerButtons()` on bootstrap. No HTML edit when adding a game (only registry).

### 5. SP test (registry-driven)

Add `ptests/desktop/singleplayer/<yourgame>/` exporting audit config (see `line` or `classic_piles`).

Set `auditConfig` or `auditByMode` in registry. Run:

```bash
npm run test:sp
```

`ptests/shared/test-manifest.js` → `buildSingleplayerAudits()` picks it up automatically.

### 6. MP test (registry-driven)

Add `ptests/desktop/multiplayer/mp_<yourgame>.js`:

```js
const { slimMpBeforeLoop } = require('../../shared/mp_audit_helpers');
const { runMultiplayerAudit } = require('./multiplayer_base');

const config = {
    gameMode: 'classic',
    beforeLoop: slimMpBeforeLoop
};
module.exports = config;
```

Set `mpAuditConfig` or `mpAuditByMode` in registry. Run:

```bash
npm run test:mp
```

### 7. Mobile (optional)

Only if the game needs touch layout checks:

- Set `mobileLayoutPolicy` in registry (or `capabilitiesByMode`)
- Add mobile assertions in SP `beforeLoop` when `ctx.isMobile` (see `freestyle_piles.js`)
- Hub: `npm run test:mobile:freestyle:center` pattern for anchor stability

---

## Hub modules (`shared/js/hub/`)

| Module | Role |
|--------|------|
| `app.js` | `HubApp.bootstrap()` — wires ctx, games, room, chat, bridge |
| `game-picker-ui.js` | Registry-driven game buttons |
| `games-controller.js` | Iframe URLs, cycle game/mode |
| `bridge-handlers.js` | RTDB-aware iframe ↔ hub messages |
| `room.js` | Party, invites, reset |

## Platform modules

| Path | Role |
|------|------|
| `shared/games/registry.js` | Games list, capabilities, audit paths, host reset builder |
| `shared/platform/game-adapter.js` | Attach capabilities + default board hooks |
| `shared/platform/engine.js` | `BaseGame`, MP sync, mobile layout (capability-driven) |
| `shared/platform/logic.js` | Authoritative rules (synced to Cloud Functions) |
| `ptests/shared/test-manifest.js` | `buildSingleplayerAudits()`, `buildMultiplayerAudits()` |

## RTDB layout

**Legacy (current):** `games/{roomId}/global/*` + `gameData/{roomId}/events`

Client helpers: `RtdbSchema`, `buildHostGameSwitchUpdates()`, `expandRelativeWrites()`.

On `global/resetCount` bump, bridge wipes `gameData/{roomId}` (events).

## MP rematch checklist

- Moves via `submitMove` → events include `resetCount`
- Host `resetGame()` alternates `firstPlayer`, bumps `resetCount`
- `onGameReset()` clears local state; filter replay with `_eventsForReplay()` (reset round)

See also **`docs/PROJECT_LAYOUT.md`**.
