# New game scaffold

Copy this folder to `games/<id>/`, register in `shared/games/registry.js`, add logic in `shared/platform/logic.js`, and wire tests under `ptests/games/<id>/`.

Run `npm run new-game -- <id> "<Label>"` to generate the above automatically.

## Step 0 — pick sync style first (before MP code)

**The risk is not missing sync primitives. The risk is picking the wrong sync model.**

Do not start coding multiplayer until you choose one path. The engine already implements all three.

```
Is gameplay simultaneous, shared inventory, drag-heavy,
or is layout/board state the source of truth?
│
├─ YES → board-authoritative (+ mpBoardAuthoritative: true)
│         Host writes global/board v2+ with board.seq every publish.
│         Guests send commands on interactions/* (host acks).
│         Do NOT use event-log applyState in MP.
│         Reference: games/bananagrams/modules/mp-board.js, mp-network.js
│
└─ NO → turn-based discrete moves?
          │
          ├─ Board layout also on RTDB (piles, piece positions)?
          │    → hybrid (moves → events, reset → global/board snapshot)
          │    Reference: piles, line
          │
          └─ Pure move replay is enough?
               → event-log (submitMove → sendEvent, GameLogic.applyMove)
               Reference: games/_template/game.js
```

| Style | When | Registry | MP writes |
|-------|------|----------|-----------|
| `event-log` | Simple turn-based | `syncStyle: 'event-log'` | `sendEvent` only |
| `hybrid` | Turn-based + board snapshot | `syncStyle: 'hybrid'` | events + board on reset |
| `board-authoritative` | Simultaneous / layout truth | `syncStyle: 'board-authoritative'`, `mpBoardAuthoritative: true` | host `global/board` only |

Document your choice in `shared/games/sync-contracts.js`. CI enforces match:

```bash
npm run check:sync
```

Scaffold with sync style:

```bash
npm run new-game -- mygame "My Game" --sync=hybrid --mp
npm run new-game -- mygame "My Game" --sync=board-authoritative --mp --policy=pan-zoom-board
```

**MP tests always include rematch/resetCount checks** (`mp-reset-audit.js`) for games with victory auto-reset.

## Board-authoritative checklist (5 patterns)

Scaffold: `npm run new-game -- id "Label" --sync=board-authoritative --mp`

| # | Pattern | Where |
|---|---------|--------|
| 1 | **Board-auth template** | `game-board-auth.js`, `index-board-auth.html` |
| 2 | **Command/ack** | `MpBoardAuth.createCommandChannel()` → `interactions/{channel}/{uid}/{id}`; ack on `board.commandAck` |
| 3 | **board.seq enforcement** | `MpBoardAuth.hostPublishBoard()` — always `version: 2`, monotonic `seq` |
| 4 | **Ready/warmup gate** | `MpBoardAuth.isAuditReady()` + `hostWarmupBoardNeeded()` in engine init |
| 5 | **Ephemeral cleanup** | `commandChannel.ack()` clears interaction path; `clearAllEphemeral()` on reset |

Shared module: `shared/platform/mp-board-auth.js`

```javascript
// Guest command
this.sync.createCommandChannel({ channel: 'mygame' }).send({ type: 'move', ... });

// Host publish (after handling commands)
this.sync.publishHostBoard(this.serializeBoard(), { bumpSeq: true });

// Apply incoming board (guest + host)
MpBoardAuth.applyIncomingBoard(this, board, (b) => this.applyBoard(b, { force: true }));
```

Verify: `npm run check:board-auth`

See also: `games/bananagrams/modules/mp-network.js` (production-scale command/ack).

## Desktop → mobile (one codebase)

There is **no separate mobile build**. The hub loads `games/<id>/index.html` in an iframe. Touch-primary devices get `html.five-mobile`; the engine applies your registry `mobileLayoutPolicy`.

### Step 1 — pick `mobileLayoutPolicy` before layout code

| Policy | Use when | Engine does | Game hooks | Example |
|--------|----------|-------------|------------|---------|
| `none` | No board fitting (menus, simple UI) | Nothing | None | — |
| `fit-square` | Fixed square board, known `localSize` | Scales `#game-container` to viewport | Call `fitBoardToViewport()` on resize / orientationchange | Line |
| `piles-dynamic` | Bounded pile/grid with computable bounds | Fits piles to viewport, dynamic bounds | Optional pile layout in render | Piles classic |
| `fixed-spiral-anchor` | Unbounded spiral, anchor locked on mobile | Pan from fixed anchor | Minimize custom mobile branches | Piles freestyle |
| `pan-zoom-board` | Large / infinite canvas | Pan + zoom layer (`GameViewport`) | `getPanZoomWorldVisualBounds()`, `getViewportContentCenter()`, call `refreshMobileLayout()` after board changes | Bananagrams |

**Rule of thumb:** fixed grid → `fit-square`. Growing bounded layout → `piles-dynamic`. Infinite canvas → `pan-zoom-board`. Avoid sprinkling `isMobileViewport()` unless you have genuinely different UX (not just layout).

Set the policy in registry `capabilities.mobileLayoutPolicy`. Per-mode overrides go in `capabilitiesByMode`.

### Step 2 — iframe contract (`game.js`)

Extend `BaseGame` and implement:

- **SP/MP gameplay:** `getValidMoves`, `submitMove`, `isOver`, `winner`, `scores`, `turn`
- **MP sync:** `serializeBoard`, `applyBoard`, `onGameReset`
- **Audit ready:** `isAuditReady()` when `auditReadyCallable: true` (recommended for `boardKind: 'generic'`)
- **Mobile layout:** resize listener calling `fitBoardToViewport()` or `refreshMobileLayout()` per policy

Use engine drag/zoom (`supportsDragging`, `supportsZoom`) instead of raw mouse-only handlers.

### Step 3 — registry entry

Minimum fields:

```javascript
{
    id: 'mygame',
    label: 'My Game',
    logicKey: 'mygame',
    modes: ['classic'],
    defaultMode: 'classic',
    capabilities: {
        boardKind: 'generic',           // or piles | line | crossword
        mobileLayoutPolicy: 'fit-square',
        supportsDragging: false,
        syncStyle: 'event-log',         // see sync-contracts.js
        auditReadyCallable: true
    },
    globalResetKeys: ['board'],
    clearGameDataOnReset: true,
    auditConfig: 'ptests/games/mygame/desktop-sp',
    mpAuditConfig: 'ptests/games/mygame/desktop-mp'   // if 2p MP
}
```

**Lobby vs party mode** (e.g. solo in lobby, multiplayer in party): set `hubModeInLobby` and `hubModeInParty`. Hub picks mode via `GameRegistry.hubModeFor()`.

**Mobile-specific Playwright suites** (optional): only when desktop audits cannot cover touch UX (pinch, edge swipe, complex drag):

```javascript
mobileAuditConfig: 'ptests/games/mygame/mobile/sp',
mobileMpAuditConfig: 'ptests/games/mygame/mobile/mp'
```

If omitted, `npm run sp:mobile` / `mp:mobile` re-run desktop audit configs under emulated phone viewport — sufficient for most games.

### Step 4 — logic + cloud sync

Add `GameLogic.<id>` in `shared/platform/logic.js`, then:

```bash
npm run sync:logic
```

Document MP authority in `shared/games/sync-contracts.js` (`event-log`, `hybrid`, or `board-authoritative`).

### Step 5 — tests

1. Copy `ptests/games/_template/` → `ptests/games/<id>/`
2. Replace `YOUR_GAME_ID` in `desktop-sp.js` / `desktop-mp.js`
3. Desktop: `node ptests/run.js sp --game=<id>` and `node ptests/run.js mp --game=<id>`
4. Mobile (same audits, phone emulation): `node ptests/run.js sp --game=<id> --topology=mobile`
5. Real device smoke: `npm run phone:dev` then open LAN URL; `npm run phone:path` for automated phone-path check

Universal platform checks run automatically via `capability-audit.js` and `mobile-layout-audit.js` from your registry flags.

### Step 6 — new-game checklist

- [ ] **Sync style chosen** and documented in `sync-contracts.js` (`npm run check:sync` passes)
- [ ] `games/<id>/` (from this template)
- [ ] `GameLogic.<id>` + `sync:logic`
- [ ] `sync-contracts.js` entry if MP
- [ ] `ptests/games/<id>/desktop-sp.js` (+ `desktop-mp.js` if MP)
- [ ] `npm run sp --game=<id>` passes
- [ ] `npm run sp:mobile --game=<id>` passes (layout + capabilities)
- [ ] `npm run mp --game=<id>` passes (if MP)
- [ ] Optional: `npm run phone:path` on real stack

## Script load order

`index.html` in this template loads the shared stack in the correct order. Do not reorder without checking dependencies in `shared/platform/engine.js`.
