# Game platform guide

How to add a game to the hub + iframe stack without sprinkling `if (gameName === '…')` through shared code.

## 1. Register first

Edit `shared/games/registry.js`:

- Add a `GameDefinition` (`id`, `logicKey`, `modes`, `capabilities`, audit paths).
- Set **capabilities** so engine/hub/tests branch on flags, not game id.
- Use **definition-level** fields when behavior is about hub context, not mode:
  - `hubModeInLobby` / `hubModeInParty` — iframe `mode` in lobby vs party (Bananagrams: solo / multiplayer).
  - `preferredForPartySizeAtLeast` — default game when party is large enough.
- Use **`capabilitiesByMode`** for SP vs MP differences (scoreboard, sync style, review).

Run `npm run sync:logic` after adding `GameLogic.<id>` in `shared/platform/logic.js`.

## 2. Capability reference

| Capability | Meaning |
|------------|---------|
| `mobileLayoutPolicy` | `pan-zoom-board`, `piles-dynamic`, `fit-square`, etc. (`shared/platform/mobile-layout.js`) |
| `viewportPanEnabled` | Background pan on large boards (`shared/platform/viewport.js`) |
| `supportsDragging` / `unboundedDrag` | `GameDrag` + `BaseGame.setupDragging` |
| `supportsZoom` | Wheel/pinch zoom (`shared/platform/zoom.js`) |
| `syncStyle` | `event-log`, `hybrid`, `snapshot`, **`board-authoritative`** (MP board is source of truth) |
| `mpBoardAuthoritative` | MP: skip event-log `applyState`; use `global/board` (set with `syncStyle: 'board-authoritative'`) |
| `supportsPostGameReview` | Review phase, iframe Done, hub win-banner obstacle clearance |
| `supportsBoardStateInspect` | Hub `/b state` → `board-state-inspect` message |
| `flexiblePlayerRoles` | Roles P1…Pn in parties (not fixed P2 for all guests) |
| `supportsScoreboard` / `supportsTurnIndicator` / `supportsGameTimer` | Platform audits + hub chrome |
| `winBannerAutoFadeMs` | Hub victory banner auto-hide (optional) |

Helpers on `GameRegistry`:

- `getCapabilities(id, mode)`
- `hubModeFor(id, inParty)`
- `hasCapability(id, name, mode)`
- `defaultPartyGameId(partySize)`

## 3. Game folder layout

**Simple game (piles, line):** one `games/<id>/<id>.js` + `index.html` + `style.css`.

**Complex game (bananagrams):** `game.js` class + `modules/*` mixins — only if you need that complexity.

Copy `games/_template/` → `games/<id>/` and `ptests/games/_template/` → `ptests/games/<id>/`.

### Pan-zoom board checklist

1. Registry: `mobileLayoutPolicy: 'pan-zoom-board'`, `viewportPanEnabled: true`, `supportsDragging`, `supportsZoom`.
2. `index.html`: include `pan-zoom-board.css`, `viewport.js`, `drag.js`, `selection.js` (see `games/bananagrams/index.html`).
3. DOM: `#game-container` → `#board-canvas` → `.board-pan-layer`.
4. Implement `getViewportContentCenter()` if content is not at world origin.
5. `GameAdapter` attaches pan listeners after `initIdentity`.

### Post-game review checklist

1. Registry: `supportsPostGameReview: true`, `winBannerAutoFadeMs` if needed (MP mode).
2. Use board phase `review` on `global/board` (see Bananagrams `MP_PHASE`).
3. Iframe overlays: convention `#<game>-done-btn`, HUD root (Bananagrams uses `#banana-done-btn`, `#banana-hud`).
4. Hub handles banner clearance via capability — no new hub id checks.

### MP board-authoritative checklist

1. Registry: `syncStyle: 'board-authoritative'`, `mpBoardAuthoritative: true`.
2. Implement `serializeBoard` / `applyBoard` (or `_applyMultiplayerBoard`).
3. Do **not** rely on move event log for win state in MP.
4. Optional: `onNetworkUpdate` for interaction sub-trees (`interactions/…`).

## 4. Hub ↔ iframe protocol

Use `HubProtocol.MSG` constants (`shared/js/hub/protocol.js`).

Generic inspect message (replaces game-specific names):

- `board-state-inspect` → game implements `reportBoardState()`
- `board-state-inspect-result` → hub chat displays lines

Legacy aliases `banana-board-state*` still work for Bananagrams.

## 5. New game readiness (before first MP test)

Use `npm run new-game -- <id> --label="..."` to scaffold `games/<id>/`, `ptests/games/<id>/`, a registry row, and `GameLogic.<id>` (starts as `TemplateLogic`).

### Product (iframe)

| Need | Notes |
|------|--------|
| `getValidMoves` + `submitMove` | Default SP/MP move loop |
| `isOver`, `winner`, `scores`, `turn` | Victory / reset |
| MP identity | `isMultiplayer`, `playerRole`, `roomId`, `identitySynced` |
| `isAuditReady()` | Required when `boardKind: 'generic'` (`auditReadyCallable: true`) |
| `serializeBoard` / `applyBoard` | MP board sync |

Opt out of the move loop with `skipGameLoop: true` for drag/peel games (Bananagrams tier).

### Registry

| Field | Typical value |
|-------|----------------|
| `boardKind` | `piles` \| `line` \| `crossword` \| `generic` |
| `mpPlayerCounts` | `[2]` (3p only with custom `mpAudit3p`) |
| `mpSuite` | `default` (in `test:mp`) or `extended` |
| `auditConfig` / `mpAuditConfig` | `ptests/games/<id>/desktop-sp` and `desktop-mp` |
| `mobileMpExtras` | Optional module exporting `runMobileMpExtras` for touch-only steps |

`GameRegistry.auditBoardReady` checks `status.auditReady` from `game.isAuditReady()` first, then `boardKind` heuristics (`hasPiles`, `hasNodes`, tiles+dict, …).

### Ptests

```javascript
// desktop-mp.js — often enough:
const { mpConfig } = require('../../shared/platform/capability-audit');
module.exports = mpConfig('mygame', { gameMode: 'classic' });
```

`buildMpBeforeLoop` infers `skipPiles*` / `skipLineDrag` from `boardKind`. Add `extra: [...]` only for game-specific scenarios.

## 6. Tests

- Register `auditConfig` / `mpAuditConfig` in registry (`mpSuite: 'default'` or `'extended'` for slow MP).
- Thin `ptests/games/<id>/desktop-sp.js` composing `capability-audit` + `scenarios/*`.
- Add npm scripts only for slices you run often; full suite picks up via `test:sp` / `test:mp`.

**Step-by-step:** [PTESTS_NEW_GAME.md](./PTESTS_NEW_GAME.md)

Timer HUD in audits: prefer `[data-testid="game-timer"]` or document game-specific testids in capability docs.

## 7. Engine stays generic

Before changing `shared/platform/engine.js`, ask: **“Would every game benefit from this?”**

If no, put logic in:

- `games/<id>/` — DOM, rules, rendering
- `shared/platform/` — reusable mechanics (drag, zoom, mobile layout)
- `shared/games/` — cross-game contracts (sync, player model)

**Engine responsibilities only:**

- Load registry / capabilities
- Normalize room data
- Pick sync strategy (`GameSync` + caps)
- Route network messages → `EngineNetwork` modules
- Call `GameAdapter` / shared UI (scoreboard, turn, timer)

**Not in engine:** game-specific DOM ids, Bananagrams review rules, board tile rendering.

Network listeners live under `shared/platform/engine-network/`:

| Module | Registers |
|--------|-----------|
| `room.js` | `init-identity`, `network-update`, host warmup, playerData theme |
| `events.js` | `network-events` (event-log sync) |
| `drag.js` | drag / selection / pile colors (gated on caps) |
| `preview.js` | realtime previews (`supportsRealtimePreviews`) |
| `misc.js` | theme, test moves, dict adjust, board inspect, keydown |

`EngineNetwork.registerAll(game)` is called from `engine.initNetworkListeners()`.

Load order in every game `index.html` (before `engine.js`):

1. `shared/games/sync-contracts.js`
2. `shared/games/player-model.js`
3. `engine-network/*.js` (room → events → drag → preview → misc → index)
4. `shared/platform/engine.js`
5. `engine-room-sync.js`, `engine-mobile-layout.js` (install real methods on `BaseGame.prototype`)

See [SHARED_PLATFORM.md](./SHARED_PLATFORM.md) for folder layout, extraction script, and phased reorg.

## 8. Multiplayer sync contracts

**Pick one authority per game** — never mix event-log `applyState` with board-authoritative unless explicitly designed.

Documented in `shared/games/sync-contracts.js` (`GameSyncContracts`):

| Game | `syncStyle` | Read | Write | Winner | Review |
|------|-------------|------|-------|--------|--------|
| piles | `hybrid` | `global/board` + `gameData/events` | event-log | logic from events | n/a |
| line | `hybrid` | same + `global/previews` | event-log | logic from events | n/a |
| bananagrams MP | `board-authoritative` | `global.board` | `global.board` | host on board | `global.board.phase` |

Fields to document for each new game: read source, write source, who computes winner, who repairs stale state, where review state lives.

`GameSync` / engine should consult registry `syncStyle` and `mpBoardAuthoritative` — not game name.

## 9. Capabilities over board-type checks

Avoid `_isPilesBoard()` / `_isBananaBoard()` in platform code.

Prefer:

- `game.hasCap('supportsDragging')`
- `game.hasCap('supportsPileColors')`
- `registry.mobileLayoutPolicy` / `boardKind === 'pan-zoom'`
- Game hooks: `onRoomWarmup()`, `countVisiblePieces()`, `reportBoardState()`

## 10. Player model (P1/P2 vs party UIDs)

`shared/games/player-model.js` (`PlayerModel`):

- **`roles-p1-p2`** — classic 2P turn games (piles, line): scores `{ P1, P2 }`, host = P1.
- **`party-uids`** — flexible MP (bananagrams): roles from party membership; use `firstOtherUid()`, `isHostRole()`.

**Deferred until a turn-based 3+ player game:** full `turnOrder: [uid…]` everywhere, spectator previews, watchdog for N roles. Bananagrams already uses party UIDs on the board; engine repair watchdog runs only when `supportsTurnIndicator` is true.

## 11. Do not

- Add `if (gameName === 'mygame')` in `shared/platform/engine.js` — extend capabilities or game hooks instead.
- Copy `games/bananagrams/modules/mp-*` unless you need the same MP inventory/board model.
- Hardcode party default game id — use `preferredForPartySizeAtLeast` on the definition.
- Mix event-log and board-authoritative sync in one MP mode.

## 12. Reference implementations

| Pattern | Game |
|---------|------|
| Turn-based 2P, event log | piles, line |
| Pan-zoom, drag, solo + MP board | bananagrams |
| Thin SP audit | classic-piles (`ptests/games/classic-piles/`) |
