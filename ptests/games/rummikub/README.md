# Playwright test scaffold

Copy to `ptests/games/<id>/` and point registry `auditConfig` / `mpAuditConfig` at these modules.

## Required MP checks (automatic)

All MP audits through `multiplayer_base.js` include:

1. **Join:** `assertResetEpochSynced` — both clients agree on `resetCount`, game not `isOver`
2. **After victory auto-reset:** `assertRematchResetEpoch` — `resetCount` advanced, no stale events (hybrid/event-log), board v2 (board-authoritative)

You do not need to copy these into each game. Add game-specific `extra` hooks in `desktop-mp.js` only for unique mechanics.

Run contract CI after registry changes:

```bash
npm run check:sync
npm run check:board-auth   # board-authoritative seq/ack helpers
```

## Board-authoritative games

Use `npm run new-game -- id "Label" --sync=board-authoritative --mp`.

Reference implementation: `games/_template/game-board-auth.js` + `shared/platform/mp-board-auth.js`.

Do not use `submitMove → sendEvent` in MP. Guests send commands; host publishes `global/board` with monotonic `board.seq`.

## Layout

```
ptests/games/<id>/
  desktop-sp.js      # Solo audit (required)
  desktop-mp.js      # 2p MP audit (if multiplayer)
  mobile/
    sp.js            # Optional — only if touch UX needs custom suite
    mp.js            # Optional — same for MP
  scenarios/         # Game-specific steps (optional)
  lib/               # Shared helpers (optional)
  assertions/        # Custom assertions (optional)
```

## Default path (recommended for new games)

Write **desktop** audits only. Mobile topology re-runs them automatically:

```bash
node ptests/run.js sp --game=<id> --topology=mobile
node ptests/run.js mp --game=<id> --topology=mobile
# or: npm run sp:mobile --game=<id>
```

`capability-audit.js` + `mobile-layout-audit.js` read registry capabilities and verify scoreboard, turn indicator, board fit, etc. on both topologies.

## When to add `mobile/sp.js`

Add `mobileAuditConfig` in registry **only** when desktop audits cannot exercise:

- Pinch zoom / pan gestures
- Edge-swipe settings
- Touch drag paths that differ from mouse (e.g. Line mobile drag utils)
- Mobile-only UI flows

Pattern (see `mobile/sp.js` in this folder):

1. Re-export desktop config
2. In `beforeLoop`, if `ctx.isMobile`, run touch suite OR delegate to desktop
3. Set `skipGameLoop: true` if mobile suite is self-contained

Bananagrams is the reference for a full mobile suite; Line shows minimal `ctx.isMobile` branches inside desktop-sp.

## Registry wiring

```javascript
auditConfig: 'ptests/games/<id>/desktop-sp',
mpAuditConfig: 'ptests/games/<id>/desktop-mp',
// optional:
mobileAuditConfig: 'ptests/games/<id>/mobile/sp',
mobileMpAuditConfig: 'ptests/games/<id>/mobile/mp',
```

## Scenarios

- `smoke` — fast CI, skips move loop (`spConfig` / `mpConfig` detect via `--scenario=smoke`)
- `default` — capability checks + standard move loop
- Add game slices in `scenarios/registry.js` only when needed (see bananagrams)

## Phone-path (real device)

Not part of default `npm run all`. After emulator stack is up:

```bash
npm run phone:path
npm run phone:sync    # PC + phone-path tabs same room
```

Add to release checklist for games with touch-heavy UX.
