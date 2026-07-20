# Steel Rampage — Online Multiplayer

Private-room online play, up to 6 players (empty seats fill with bots).

## How to play with friends

1. **Start the relay server** (once, on any machine reachable by all players):
   ```
   npm run server        # listens on ws://<host>:8787
   ```
   For same-network play the host's machine is fine. For internet play, run it
   on a small VPS / any host with an open port, and set `NET_URL` in
   `src/net/net.ts` to that address (default: same hostname as the page, :8787).

2. **Serve the game** so friends can open it:
   ```
   npm run dev           # binds LAN (vite --host) → http://<your-ip>:5173
   ```
   (or `npm run build` and host `dist/` anywhere.)

3. In the menu: pick a car, type a name.
   - **Host:** click **HOST PRIVATE GAME** → you get a 4-letter room code.
   - **Friends:** type the code → **JOIN**. They appear in your lobby.
   - Host clicks **ENTER THE ARENA**. Everyone drops into the same match; any
     empty seats (up to 6) become AI bots.

## Architecture — host-authoritative relay

```
 Guest ──inputs 30Hz──►  Relay (server.js)  ──forward──►  HOST browser
   ▲                      (room codes only,               (runs game.step —
   └──snapshots 20Hz──────  no simulation)  ◄──broadcast── the real sim)
```

- The **host's browser is the authority** — it runs the exact single-player
  `Game.step()` we've tested for the whole project. Zero sim logic on the server.
- **Guests are thin clients**: they build the same arena (seeded by `skyIdx` so
  the sky matches), send their inputs, and render 20Hz snapshots interpolated
  ~110ms behind real time (`GuestSync`). They never call `game.step()`.
- **Snapshots** (`serializeSnapshot`, ~1.3 KB): every vehicle transform + HUD
  field, plus live missiles/mines/bombs/barrels/pickups/pedestrians, plus a
  one-shot `ev` array for kills, explosions, damage popups, and pickups.
- **Disconnects**: if a guest drops, `Game.adoptBot()` hands their car to the AI
  so the match continues. If the host drops, guests return to the menu.
- **Hidden-tab safety**: a Web Worker timer keeps a backgrounded HOST tab
  simulating and snapshotting (browsers throttle rAF when hidden).

### Trade-off (honest)

The host has zero latency; guests see ~110ms interpolation delay + their ping.
Great for private games among friends. The clean upgrade path to fairness for
competitive play is a **dedicated server sim** — extract `game.step` from
THREE/DOM into a headless module the server runs. The relay is exactly the piece
that gets replaced; everything else (snapshot format, GuestSync) stays.

## Files

- `server/server.js` — relay (rooms, forwarding). Run with `npm run server`.
- `src/net/net.ts` — `NetClient`, `serializeSnapshot`, `GuestSync`.
- `src/main.ts` — lobby UI + host/guest loop wiring.
- `src/game/game.ts` — `NetOpts`, `netEvents`, `adoptBot`.
