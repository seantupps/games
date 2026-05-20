# Firebase environments

Three targets — pick how you load the hub (root `index.html` on Pages: `/games/`):

| Target | When | How |
|--------|------|-----|
| **emulator** | Coding, Playwright, CI | `?firebase=emulator` or `window.FIVE_FIREBASE_TARGET = 'emulator'` |
| **dev** | Real two-phone / two-laptop testing | `?firebase=dev` (configure `DEV` in `shared/js/firebase-env.js`) |
| **production** | Public release | Default (no query param) |

Playwright **always** uses the emulator (`ptests/multiplayer/emulator-utils.js`). It does not hit production RTDB.

## Local stack (emulator + localhost)

**Recommended:** run these in two terminals, then run tests:

```powershell
# Terminal 1
npm run serve

# Terminal 2
npm run emulators
```

```powershell
# Terminal 3 — tests (uses existing stack, no auto-spawn)
npm run test:mp
```

Tests probe **RTDB port 9000** and **static server 8000** — not the Emulator UI on 4000.

Optional auto-spawn if you prefer one command:

```powershell
$env:FIVE_AUTO_START_STACK=1; npm run test:mp
```

Open the app manually:

`http://127.0.0.1:8000/?firebase=emulator`

Emulator UI (optional): `http://127.0.0.1:4000/`

## Dev Firebase project

1. Create a second Firebase project (e.g. `games-fad3a-dev`).
2. Paste its web config into `DEV` in `shared/js/firebase-env.js`.
3. Update `.firebaserc` `"dev"` project id.
4. Deploy rules/functions to dev only:  
   `npx firebase deploy --config firebase.prod.json --project YOUR_DEV_PROJECT`

Test on two devices with:

`https://your-dev-host/games/?firebase=dev&room=...`

## Production

- Hub without `?firebase=` uses production config.
- Deploy database rules:  
  `npx firebase deploy --only database --config firebase.prod.json --project games-fad3a`
- Do **not** point Playwright at production.

## Emulator vs production rules

- `database.rules.emulator.json` — open read/write (local only).
- `database.rules.json` — strict rules for dev/prod (`firebase.prod.json`).

## Future: latency / jitter tests

For production-like robustness, consider:

- Playwright `context.route` with delayed RTDB responses (partial).
- `tc netem` / Clumsy / Charles on a LAN test machine for real two-device dev.
- Separate soak test job (not the fast 8s MP benchmark).

Network emulation is not wired yet; emulator + dev project cover quota safety and real-device testing first.
