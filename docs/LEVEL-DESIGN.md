# Steel Rampage — Level Design Blueprint: "Overdrive City" (Arena 3.0)

Goal: spacious, fast, free-roaming; near-miss adrenaline instead of instant deaths.

## 1. Road-to-vehicle scaling & spatial freedom

Vehicle standard width = 2 m. Ratios (enforced in arena.ts):

| Surface | Width | Ratio |
|---|---|---|
| Ring highway (octagonal loop, r≈78) | 20 m | 10× |
| N-S / E-W boulevards | 18 m | 9× |
| Quadrant alleys / block gaps | ≥ 12 m | 6× |
| Tunnel pinch (deliberate risk point) | 14 m | 7× |

Anti-snag colliders:
- Props (buildings, bunkers, kiosks, wrecks, dumpsters): `roundCuboid` colliders at
  **92% of visual footprint with 0.35 m corner radius** — grazing hits deflect
  instead of stopping the car. Implemented via `addProp()` in arena.ts.
- Streetlight poles: collider 0.10 vs visual 0.14.
- Driving surfaces (floor, walls, ramps, tunnel, deck) stay exact — flush contact.
- No free-standing pillars. No 90° corners on primary flow lines: the ring uses
  45° chamfer segments (8-segment octagon) so full-speed drifting lines exist
  everywhere. (True banked curves deferred — needs mesh terrain, phase 2+.)

## 2. Map size — the encounter-cadence formula

Kinetic-gas model with occlusion:

```
T_encounter ≈ A / (2 · κ · r_sight · v_rel · (N−1))
Side(N)     = sqrt(T · 2 · κ · r_sight · v_rel · (N−1))
κ = 0.35 (city LOS occlusion), r_sight = 60 m, v_rel = 30 m/s
```

- 8-player lobby @ T = 17 s → **side ≈ 330 m** (use for multiplayer).
- Current 6-combatant lobby with HUNTING bots (they seek, not roam — halves T):
  sized to **240×240** (ARENA_HALF = 120) → ~10–12 s effective contact, matching
  arcade TM pacing while leaving genuine breakaway room.

LOS breakouts (skill-based missile escape — missiles turn at 3 rad/s, ~15 m radius
at full speed, so hard corners physically break them):
- Central overpass/tunnel interchange (elevation split).
- Quadrant alleys between building blocks (≥12 m, corner-heavy).
- Ring chamfer corners hugged at speed drag pursuing missiles into buildings.

## 3. Pedestrians (risk/reward recovery)

- ~26 kinematic NPCs (no rigid bodies — pure gameplay objects) in `peds.ts`.
- Zones: boulevard sidewalks (4 strips) + one plaza pocket per quadrant.
- Behavior: wander at 1.5 m/s; flee at 4.5 m/s when a vehicle comes within 14 m.
- Splat: vehicle within 1.5 m at speed > 8 → ped dies (particle burst), respawns
  10–16 s later at a point ≥ 40 m from every vehicle.
- Reward: **+4 armor** (4% of pool) only if speed ≥ 12 m/s (chase-speed gate).
- Anti-farm: 2.5 s per-vehicle reward cooldown (theoretical max ~1.6 hp/s, worse
  than any health pickup), fleeing makes chaining hard, population cap, far respawns.

## 4. Item layout & respawn fairness

Zoning:
- **Central / high-risk (offense)**: missiles on the overpass deck + 4 ring-median
  points; overdrive in the tunnel (rotates — see below); mines in plaza pockets.
- **Peripheral / escape (defense & utility)**: shields inside the 2 bunkers, turbo
  on outer-apron corners, health in quadrant alleys + outer apron.

Dynamic respawn rules (pickups.ts):
- **Jitter**: respawn = base × (0.7..1.3) — timers can't be memorized/camped.
- **Proximity hold**: a pickup will NOT respawn while any living vehicle is within
  12 m of its socket — spawn-campers see nothing spawn until they leave.
- **Roaming spawn**: overdrive rotates among 3 sockets (tunnel / NE plaza / SW
  plaza) on each respawn, so the strongest item can't be owned.

## Vehicle scale & speed-illusion camera (hybrid strategy)

On top of the expanded roadways (Strategy B), vehicles run at **80% scale**
(Strategy A) — effective ratios: boulevards 11×, ring 12.5×, alleys 8×.

Physics scaling rules that keep 80% tight rather than floaty:
- All drive/grip/anti-roll forces are written as `acceleration × mass`, so they
  are scale-invariant by construction. Mass follows volume (×0.51 at s=0.8).
- Suspension geometry is absolute and must scale by hand: REST_LEN 0.55→0.44,
  WHEEL_RADIUS 0.32→0.26 (vehicle.ts).
- Knockback impulses are mass-normalized (`k × body.mass()`) in game.ts so blast
  shove feels identical at any scale (verified: 5.9 m/s Δv pre/post rescale).
- Speeds stay absolute — same m/s over a smaller wheelbase reads ~25% faster.

Camera (game.ts updateCamera): distance 7.8 + 1.6·speedN, height 3.4 + 0.4·speedN
(pull-in keeps the smaller car the same screen fraction; stretch = "pulling away"
under acceleration). FOV = 74 + 14·speedN² (+8 turbo) — quadratic bloom is the
primary speed cue. speedN = speed/36.

## Tuning knobs

`arena.ts`: ARENA_HALF, road widths, building tables. `peds.ts`: COUNT, FLEE_RADIUS,
reward gate in game.ts (`PED_HEAL`, `PED_HEAL_COOLDOWN`, speed gate 12).
`pickups.ts`: jitter range, HOLD_RADIUS.
