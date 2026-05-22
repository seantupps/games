# Mobile / phone Playwright & UX

Landscape-first emulation (`galaxys24`: 915×412). Real device: `npm run phone:dev` + `npm run phone:dev:tunnel`.

## Mobile UX

| Feature | Behavior |
|---------|----------|
| Settings | Bottom bar **⚙**; swipe **right edge → left** opens panel via `#mobile-settings-edge` (above iframe) + iframe relay (`#settings-trigger` hidden on mobile) |
| Bottom bar | **💬** chat, expand icon fullscreen, **⚙** settings — transparent, low-contrast icons |
| Fullscreen | CSS immersive on mobile (no Fullscreen API — avoids browser “drag from top” hint); game hub fills screen; **⚙ hidden**, **fullscreen + chat stay** for exit |
| Zoom | App pinch on hub + iframe `body` (blocks browser page zoom); full range 0.2–5× |
| Classic piles | Mobile portrait: B/R/G **column** (same 3+2 shape per pile); mobile landscape + PC: horizontal row |
| PC isolation | `html.five-mobile` only when `(pointer: coarse)` — **not** when the window is merely narrow; small windowed PC keeps desktop UI |
| Line board | Auto `fitBoardToViewport()`; drag uses `toWorld()` with transform inverse |
| Piles end turn | Long-press (~550ms) when it's your turn |
| Colors | Native `<input type="color">` — any hex (hub + freestyle piles); tests assert CSS vars |

## Playwright commands

```powershell
npm run phone:dev:status
npm run test:mobile          # 1 browser; hub + SP∥MP
npm run test:mobile:hub      # lobby shell checks only (listed below)
npm run test:mobile:mp
npm run test:mobile:sp
npm run test:mobile:freestyle:center   # freestyle anchor: center once, no recenter on removal
```

### Speed (one browser, pooled workers)

| Env | Default | Effect |
|-----|---------|--------|
| `FIVE_MOBILE_WORKERS` | `4` | Max concurrent SP or MP game jobs |
| `FIVE_MOBILE_MP_PARALLEL` | `1` | Each MP game gets its own P1/P2 pair (fast). `0` = reuse one pair (2 contexts). |
| `FIVE_MOBILE_SUITE_TIMEOUT_MS` | `420000` | Whole-run cap |

`test:mobile` runs **SP and MP blocks in parallel** after hub. Hub uses **one** context, **one** page load (ngrok-shaped URL), no debug-relay wait, **2s** per-step caps (`FIVE_HUB_STEP_MS`). Party limit uses **one** context + 3 pages (was 3 contexts).

## Hub checks (`test:mobile:hub`)

Each line is logged as `[MOBILE] ▶ …` / `✓ …` and appears in the results table.

| Step | What it verifies |
|------|------------------|
| Load ngrok-shaped hub URL | Same query shape as real phone (`rtdbUrl`, `phoneDebug=1`) |
| Phone path: Firebase SDK, rtdbUrl tunnel, game iframe | SDK loads, tunnel DB URL, iframe has a game (not blank) |
| NetworkEngine initialized | RTDB client ready |
| Auto mobile viewport | `five-mobile` on touch; desktop `#settings-trigger` hidden; bottom bar visible |
| Mobile bottom bar layout | Bar at bottom; 💬 / fullscreen / ⚙ present |
| Chat toggle | Bottom 💬 opens and closes `#chat-container` |
| Settings gear → panel on right + theme color | ⚙ opens `#settings-sidebar` on the right; native theme color applies |
| Settings edge swipe (right → left) | `#mobile-settings-edge` overlay + iframe right-strip relay; overlay swipe, iframe edge swipe, center must not open |
| Pinch zoom does not end piles turn | Two-finger pinch with a pile selected does not advance turn |
| Host: switch game (Line ↔ Piles) | Host control changes game iframe |
| Pinch zoom in/out range | Zoom in ≥2× and out ≤0.55× (game iframe) |
| Line pinch outside board | Pinch on letterbox/body still zooms game (not browser page zoom) |
| Fullscreen keeps chat + bar controls | Immersive/fullscreen: chat stays usable; bar controls stay visible |
| Board centered portrait + landscape | Line board centered and in bounds at 390×844 and 915×412 |
| Classic piles vertical / horizontal | Portrait: B–G span is vertical; landscape: horizontal |
| Freestyle piles anchor stable after removals | Center once at start; piece removal + viewport ping must not shift anchor |
| Classic / freestyle piles centered (landscape) | Classic: centered in iframe (±48px); freestyle: fits viewport |
| Line node touch target | Mobile snap radius ≥75px (easier taps than visible dot) |

Not in hub: PC↔phone RTDB sync (`test:phone:sync`), debug relay to `:8002` (`test:phone:path`).

### Manual checks (real device, outside hub)

| Check | What to verify |
|-------|----------------|
| Piles pick stability | Selecting / dragging pieces does **not** shift or re-center the whole board (hub cannot simulate touch pick UX fully) |
| Freestyle anchor | `test:mobile:freestyle:center` — layout locks once; piece removal + `hub-visible-viewport` must not change `transformOrigin` / anchor `cx`/`cy` |

## Strict checks (no shortcuts)

- **Pinch:** `TouchEvent` pair on iframe `#game-container`, Δzoom ≥ 0.45, zoom in ≥ 2×, zoom out ≤ 0.55
- **Hub color:** native picker must be visible inside open `#settings-sidebar` (via bottom ⚙)
- **Line drag:** 6–8 steps; preview `x2/y2` must match `game.toWorld(clientX, clientY)` within 10px
- **Viewport:** `#game-container` + all `.node` / `.piece` inside iframe bounds
- **Colors:** obscure hex (`#3d5a14`, `#124578`) must update computed CSS variables
- **Fullscreen:** immersive class or Fullscreen API; chat visible, other bar buttons hidden

## Timeouts

See `ptests/mobile/mobile-timeouts.js` — `FIVE_MOBILE_*` env vars; hub steps use `FIVE_HUB_STEP_MS` (default **2s**). Override: `FIVE_HUB_STEP_MS=5000 npm run test:mobile:hub`. Long MP/SP blocks still use `runStep` heartbeats.
