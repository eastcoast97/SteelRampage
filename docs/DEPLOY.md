# Deploy Steel Rampage to Render (free, public URL)

One free Render web service runs everything: it serves the built game **and** the
WebSocket relay on the same origin, so friends anywhere just open one URL.

## What's already prepared
- `server/server.js` serves `dist/` + the `wss` relay on one port (Render's `PORT`).
- `render.yaml` — Blueprint that auto-configures the service.
- The client auto-targets `wss://<same-host>` in production (no config needed).
- The project is a git repo with an initial commit ready to push.

## Steps

### 1. Put the code on GitHub
Render deploys from a Git repo. Create an **empty** repo on github.com (no README),
then from this folder:
```bash
git remote add origin https://github.com/<you>/steel-rampage.git
git branch -M main
git push -u origin main
```
(If you have the GitHub CLI: `gh repo create steel-rampage --public --source=. --push`.)

### 2. Create the Render service
1. Go to **dashboard.render.com** → **New +** → **Blueprint**.
2. Connect your GitHub and pick the `steel-rampage` repo.
3. Render reads `render.yaml` and fills everything in (free plan, build + start
   commands, health check). Click **Apply / Create**.
4. First build takes ~2–4 min. When it's live you get a URL like
   `https://steel-rampage.onrender.com`.

*(Manual alternative if you skip the Blueprint: New + → Web Service → connect the
repo → Runtime **Node**, Build `npm install --include=dev && npm run build`,
Start `node server/server.js`, Health check path `/healthz`, Plan **Free**.)*

### 3. Play
Open the Render URL, **HOST PRIVATE GAME**, share the 4-letter code. Friends open
the same URL, enter the code, **JOIN**. No LAN, no IP addresses.

## Good to know
- **Free-tier sleep:** after ~15 min idle the service spins down. The first person
  to open it then waits ~40–50s while it wakes, after which it's warm for everyone.
  For instant connects, bump the service to a paid instance in Render (no code
  change) or ping the URL to keep it warm.
- **Updating the game:** `git push` again → Render auto-redeploys (`autoDeploy`).
- **Separate relay host** (advanced): if you ever host the relay elsewhere, set a
  `VITE_RELAY_URL` env var at build time and the client will use it instead of the
  same-origin default.

## Local development is unchanged
`npm run dev` (game on :5173) + `npm run server` (relay on :8787), both on your
machine. The client only switches to same-origin `wss://` when served over HTTPS.
