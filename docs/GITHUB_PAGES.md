# GitHub Pages + Firebase

Live site (after deploy): **https://seantupps.github.io/games/**

Hub entry: **https://seantupps.github.io/games/shared/index.html**

## One-time setup

### 1. Enable GitHub Pages

In [seantupps/games](https://github.com/seantupps/games) → **Settings → Pages**:

- **Build and deployment → Source:** GitHub Actions

Push to `main` (or run the **Deploy GitHub Pages** workflow manually). The site deploys from `shared/`, `games/`, and root `index.html` only.

### 2. Firebase authorized domain

In [Firebase Console](https://console.firebase.google.com/) → project **games-fad3a**:

1. **Authentication → Settings → Authorized domains**
2. Add: `seantupps.github.io`

(Required if you add Auth later; good practice now.)

### 3. Production database rules

Deploy strict rules (not emulator rules):

```powershell
npx firebase deploy --only database --config firebase.prod.json --project games-fad3a
```

## Environments

| Where | URL | Firebase |
|-------|-----|----------|
| Local dev | `http://127.0.0.1:8000/shared/index.html?firebase=emulator` | Emulator |
| GitHub Pages | `https://seantupps.github.io/games/shared/index.html` | Production (default) |
| Dev testing | Same + `?firebase=dev` | Dev project (when configured) |

Playwright tests use the emulator only — see [FIREBASE_ENVIRONMENTS.md](./FIREBASE_ENVIRONMENTS.md).

## Deploy

Push to `main`:

```powershell
git add -A
git commit -m "Your message"
git push origin main
```

Check **Actions** tab for deploy status.
