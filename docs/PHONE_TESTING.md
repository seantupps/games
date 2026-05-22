# Phone dev stack (`phone:dev`)

## Commands

| Command | Purpose |
|---------|---------|
| `npm run phone:dev` | Start local stack (detached): static :8000, RTDB :9000, debug :8002 |
| `npm run phone:dev:stop` | Stop stack |
| `npm run phone:dev:status` | Show ports, PIDs, URLs |
| `npm run phone:dev:restart` | Stop + start (fresh emulator data) |
| `npm run phone:dev:tunnel` | Start ngrok tunnel (real phone only) |
| `npm run phone:dev:tunnel:stop` | Stop tunnel |
| `npm run phone:dev:tunnel:status` | Tunnel URL or offline |
| `npm run phone:ngrok:auth -- <token>` | One-time ngrok token setup |
| `npm run test:phone:path` | Playwright (ngrok-shaped URL on localhost) |
| `npm run test:phone:sync` | Playwright: PC URL + phone URL share same RTDB / lobby (3s max per step) |

Logs: `.five/logs/*.log`  
State: `.five/phone-stack.json`, `.five/phone-tunnel.json`

## Typical workflow

### Fast path: LAN (same Wi‑Fi, recommended)

Phone and PC both use **realtime** Firebase to the emulator (no `rtdbUrl` poll). Ngrok stays available but you do not need it on LAN.

```powershell
npm run phone:dev
npm run phone:lan:urls
```

Example output:

- **PC:** `http://127.0.0.1:8000/?room=lobby&firebase=emulator`
- **Phone:** `http://192.168.1.25:8000/?room=GJMYI&firebase=emulator` (use your room id)

Requirements:

- PC and phone on the **same Wi‑Fi**
- Stack running (`phone:dev` — static server already binds `0.0.0.0:8000`; RTDB emulator listens on `0.0.0.0:9000` in `firebase.json`)
- Phone URL has **`firebase=emulator` only** — **no `rtdbUrl`**
- If you used ngrok before: **close the phone tab** or clear site data (stale `five_rtdb_url` in session storage forces slow tunnel mode)

Find IP manually: `ipconfig` → Wi‑Fi **IPv4 Address**.

**Phone stalls / never loads (no error):** almost always PC firewall or Wi‑Fi isolation — not a wrong URL.

1. On the phone, open **`http://<PC-IP>:8000/five-lan-ping.txt`** first. You must see plain text: `five-lan-ok`.
   - If that **never** loads → network/firewall (see below).
   - If ping works but the game URL stalls → say so (different problem: page/RTDB).
2. PC Wi‑Fi must be **Private** (Settings → Network → Wi‑Fi → your network → Private). Or run as Admin: `npm run phone:lan:firewall` (opens TCP 8000/9000/8002 on Private + Public).
3. Phone on **same** Wi‑Fi (not guest / mobile data). Disable VPN on the phone.
4. Some routers block phone→PC (**AP isolation**); try another network or use ngrok.

You do **not** need `python -m http.server` when using `phone:dev` — use `scripts/dev/dev-static-server.js` (started by the stack).

### Slow path: ngrok (off‑LAN or when LAN blocked)

```powershell
npm run phone:dev:tunnel
npm run phone:dev:tunnel:status   # copy Game URL to phone
```

Ngrok Game URLs include `rtdbUrl` (REST + ~1.2s polls). Keep this until LAN is verified; do not remove ngrok scripts.

```powershell
npm run phone:dev:tunnel:stop
npm run phone:dev:stop
```

**PC play (LAN or ngrok):** http://127.0.0.1:8000/?room=lobby&firebase=emulator

**Lobby player list:** Only tabs with a recent heartbeat (~45s on emulator) appear. Closed tabs remove their row on `pagehide`; stale rows are pruned (~90s on emulator). Old Playwright guests (e.g. `Sync PC`, `Guest####`) disappear from the list automatically — or run `npm run phone:dev:restart` for a clean RTDB.

## When to restart

### No restart — refresh the browser

- `index.html`, `shared/js/hub/`, `shared/mobile/`, `shared/network/`, `games/`, CSS
- `shared/network/firebase-env.js` client config

Playwright: re-run tests. Ngrok tunnel can stay up.

### Restart `phone:dev` only when

- You changed `scripts/dev/dev-static-server.js`, `phone-debug-server.js`, or stack scripts
- You changed `firebase.json` emulator settings
- After `npm install` affecting stack deps
- You want a clean RTDB (lobby/rooms reset)

```powershell
npm run phone:dev:restart
```

### Restart tunnel only when

- ERR_NGROK_3200 / endpoint offline
- You stopped and restarted `phone:dev`

```powershell
npm run phone:dev:tunnel:stop
npm run phone:dev:tunnel
```

## Ngrok one-time setup

1. https://dashboard.ngrok.com/signup  
2. Token: https://dashboard.ngrok.com/get-started/your-authtoken  
3. `npm run phone:ngrok:auth -- YOUR_TOKEN`

## Ports

| Port | Role |
|------|------|
| **8000** | Game + RTDB proxy (`/.json` → :9000) + phone debug proxy (`/phone-debug` → :8002) |
| **9000** | RTDB emulator API |
| **8002** | Phone debug dashboard (PC) |
| **4000** | Firebase emulator admin UI |

## PC + phone see the same lobby

Both must hit the **same RTDB** (local emulator via `phone:dev`) and the **same room** name.

| Mode | PC | Phone | Sync speed |
|------|----|-------|------------|
| **LAN** | `127.0.0.1:8000/?firebase=emulator&room=…` | `http://<PC-LAN-IP>:8000/?firebase=emulator&room=…` (no `rtdbUrl`) | Like two PCs on emulator |
| **Ngrok** | same PC URL | Game URL from `phone:dev:tunnel` (has `rtdbUrl`) | Slower (poll path) |

If sync broke after switching modes: clear phone site data / close tab (stale `rtdbUrl`).

Verify in automation: `npm run test:phone:sync` (each step capped at 3s; override lower via `FIVE_PHONE_SYNC_STEP_MS` / `FIVE_PHONE_LOBBY_TIMEOUT_MS`, never above 3000)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Ports in use | `npm run phone:dev:stop` |
| ngrok offline | `phone:dev:tunnel:stop` then `phone:dev:tunnel` (tunnel must stay running) |
| PC and phone don’t see each other | Same room + `firebase=emulator`; LAN: no `rtdbUrl`; firewall allows :8000/:9000 on private network |
| Phone feels slow on LAN | Phone URL must not include `rtdbUrl`; run `phone:lan:urls` and clear stale session storage |
| PC and phone don’t see each other (ngrok) | Phone uses tunnel **Game URL**; clear phone cache if tunnel URL changed |
| No phone logs on PC | URL must include `phoneDebug=1` (tunnel URL does automatically) |
| `test:phone:path` fails debug proxy | `npm run phone:dev:restart` (needs `dev-static-server`, not old `http-server`) |

Legacy aliases: `phone:stack` → `phone:dev`, `phone:tunnel` → `phone:dev:tunnel`
