# Steel Rampage

Twisted Metal-style arena vehicular combat game for the web. Single-player vs AI bots today; architected for online multiplayer later.

## Commands

- `npm run dev` — Vite dev server (port 5173). Also launchable via `.claude/launch.json` (name: `steel-rampage`).
- `npm run build` — typecheck (`tsc`) + production build.
- `npx tsc --noEmit` — typecheck only.

## Stack

Three.js (rendering) + Rapier `@dimforge/rapier3d-compat` (physics, WASM) + Vite + TypeScript. No external assets — cars, arena, textures, particles, and audio are all procedural.

## Architecture

The simulation is deliberately separated from rendering so server-authoritative netcode can slot in later:

- `src/main.ts` — bootstrap, menu, fixed-timestep loop (60 Hz sim via accumulator, per-frame render).
- `src/game/game.ts` — match coordinator: weapons (hitscan MG, homing missiles), damage/kills/respawns, lock-on targeting, ram damage via Rapier collision events, camera (chase + occlusion raycast + shake), win condition. `step(dt, input)` is the sim; `render(dt)` is visuals-only.
- `src/game/vehicle.ts` — raycast-suspension arcade car physics. Key design: **yaw-rate controller** (steering commands a target yaw rate; torque drives toward it) instead of relying on tire forces alone — this is what makes handling feel tight and prevents spin-outs. Suspension/grip/drive forces are applied per-wheel as impulses scaled by body mass.
- `src/game/bots.ts` — AI: target selection (grudge > player-bias > nearest), obstacle-avoidance ray, unstuck reverse, burst fire, pickup-seeking when low.
- `src/game/arena.ts` — physics colliders + meshes for the arena, spawn points, pickup locations, lighting.
- `src/game/specs.ts` — car archetype tuning table (speed/armor/grip per car).
- `src/render/` — procedural car meshes (box-built per archetype), particle/tracer/explosion effects.
- `src/audio/sfx.ts` — procedural WebAudio SFX (no audio files). Init requires user gesture (start button).
- `src/ui/hud.ts` — DOM-based HUD: bars, scoreboard, kill feed, radar canvas, hit feedback.

## Conventions & gotchas

- Car forward is **-Z**; steer input positive = left. Yaw quaternion helpers in `vehicle.ts`.
- All gameplay forces are impulses scaled by `dt` and body mass — never per-frame forces.
- Rapier ray hits: use `(hit as any).timeOfImpact ?? (hit as any).toi` (API renamed across versions).
- `window.__game` is a debug handle set on match start — used for headless testing via `game.step(1/60, mockInput)`.
- Vehicles get 3s spawn protection; firing cancels it.
- The preview browser tab throttles rAF when backgrounded — test physics by manually stepping `__game.step(...)` in an eval, never by wall-clock waiting.

## Roadmap (agreed with user)

Phase 1 (done): arena deathmatch vs 5 bots, 3 car classes, MG + homing missiles + pickups, first-to-15.
Phase 1.5 (done): 3 game modes (deathmatch / survival 3-lives / time attack 3min), mines + shield + overdrive power-ups, explosive chain-reaction barrels, overpass + tunnel arena, detailed car models, pause menu. Physics: grip applied at CoM height + speed-scaled anti-roll (no turbo-turn flips); missiles launch low + proximity fuse (no point-blank pass-through).
Phase 1.6 (done): 6-vehicle roster, each with a unique special weapon on an energy meter (VIPER nitro-ram dash, HELLCAT twin miniguns, SCORCH flamethrower, RAMPART 360° auto-turret, JUGGERNAUT seismic slam, MORTIS remote bomb — `specialId` in specs.ts, engine in game.ts `handleSpecial`). MG is the only default weapon: everyone starts with 0 missiles/0 mines (pickups only). Controls: RCLICK/E special, G missile, Q mine.
Phase 1.7 (done): special input is EDGE-TRIGGERED (`input.consumeSpecial()`) — a held button must never re-trigger (it used to insta-detonate MORTIS's just-launched bomb). Town arena: crossing N-S/E-W streets with road/facade/sign canvas textures, freeway overpass at the intersection (N-S road bridges the E-W street — ramp HIGH ends must face the deck), gas station with barrel cluster, billboards, streetlights, wrecks. Cars rebuilt as beveled ExtrudeGeometry side-profiles (see carMesh.ts `extrudeProfile`; profile +x = car front = world -Z).
Phase 1.8 (done): real GLB car models (Kenney Car Kit, CC0, in `public/models/` — bodies + separate wheel models mounted on our steer/spin rig; loader in `render/carModels.ts`). Per-vehicle paint via palette recoloring (saturated pixels take spec.color; police/ambulance/taxi keep stock livery — `KEEP_STOCK_PAINT`). GLBs reference external `Textures/colormap.png` — must ship alongside. 8-vehicle roster (added MEDIC ambulance 'repair' + JACKRABBIT taxi 'minetrail'). Shield now blocks 100% of damage. Missiles hard-capped at 3 (full rack refuses pickup, leaves it on the ground). Cars ground via soft AO contact blob (no underglow quad). Turbo pickup is a thunderbolt.
Phase 1.9 (done): "Overdrive City" arena 240×240 (docs/LEVEL-DESIGN.md) — octagonal ring highway (20m, 10× vehicle width), 18m boulevards, ≥13m alleys, anti-snag props (`addProp` = roundCuboid at 92% of visual), encounter-cadence formula for map sizing. Pedestrians (peds.ts, kinematic, flee AI) grant +4 armor at ≥12 m/s with 2.5s per-vehicle cooldown. Pickup respawns: ±30% jitter + 12m proximity hold (anti-spawn-camping) + overdrive roams 3 sockets. Balance system (docs/BALANCE.md): universal 100 HP pool, armor rating mitigation `raw×100/(100+armor)`, damage hierarchy locked missile 34 > specials ≤29 (per-activation per-victim ledger) > ram ≤18 > MG 2.2. Lock-on: 0.9s cone acquisition (36.9°/78m), 3.0/s decay, hysteresis retention, LOCKING ring → LOCKED + sfx.
Phase 1.10 (done): 80% vehicle scale (suspension REST_LEN/WHEEL_RADIUS scaled; knockback impulses mass-normalized), speed-illusion camera (FOV 74+14·speedN², distance stretch). HUD: 10-block segmented armor bar + 10-block shield timer bar (10s full-immunity shield, final-2s expiry blink), over-vehicle enemy HP sprites (shown when locked/locking/recently-damaged), panic state <30% (vignette + quickening heartbeat sfx), aggregated damage popups (player-dealt only, 0.25s window, yellow→red under 30%).
Phase 1.11 (done): scripted loop REMOVED (user: felt out-of-control/physics-defying) → SKYWAY: drivable elevated roller-coaster track along z=-78 (`skySeg` in arena.ts — on-ramps both ends, humps tuned so ~20 m/s keeps contact & boosted speed gets air, guard rails, deck boost pad + crest pickups; boost pads have y for elevation). 9 boost pads (+10 m/s, +1.2s turbo, 1.2s/vehicle cooldown, 1.45× cap). Sky presets (sunset/day/night, random per match): gradient dome + sun disc + stars in arena.ts SKY_PRESETS.
Phase 1.12 (done): "juice" overhaul — altitude-aware AO shadows (ground-projected raycast, fade+expand with height), zone-contrast textures (dark asphalt + dense bright dashes vs warm concrete lots), horizon-matched fog + distant skyline silhouette cylinder (r300, per-preset tint), radar street-map underlay + high-value pickup dots, turbo camera (+15° FOV + pull-back via turboLerp), wall-impact shake/sparks/thud (vehicle-vs-static collision events), mid-air pitch/roll control (W=nose down; overrides self-level), perfect-landing detection (flat + airtime>0.35s → 1s boost) + heavy-landing rumble, drift skid-mark pool (240, recycled) + tire smoke, modular engine audio (sports scream / V8 rumble / rally punch per build, virtual gear shifts), missile-lock warning beeps (rate scales with distance), bass-boosted explosions. Bridge ramp yaws re-fixed after Arena 3.0 regression (high ends MUST face the deck — see addRamp).
Phase 1.12 (done): visual/spawn rigidity pass. Buildings rebuilt (`makeBuildingTextures` glass/concrete/brick albedo+normal+roughness maps; `building()` adds decorative base plinth, floor ledges, parapet cornice, corner pilasters, rooftop vents/stacks — no colliders, main box keeps full footprint). Cars get shared brushed-metal scratch roughnessMap + metalness 0.55 (`getCarScratchMap` in carMesh.ts, applied to ALL bodies incl stock-paint). Bulletproof respawn (`respawn()` in game.ts): scores on-road spawn points, HARD-invalidates any within 28m of a living enemy OR 34m of a missile heading toward it, routes to safest. Blinking invuln: player mesh visibility toggles at 9Hz while `spawnProtection > 0`. NOTE: systems 3-8 of the "9-system spec" (AO shadow, zone textures, skybox/fog, radar map, turbo FOV, screen shake, mid-air control, particles, modular audio) were ALREADY built in phases 1.9-1.11 — this phase only added the genuinely-missing texture rigidity + spawn safety.
Phase 2 (done): online multiplayer — private rooms w/ 4-letter codes. HOST-AUTHORITATIVE: host browser runs the real `game.step` sim; `server/server.js` is a thin `ws` relay (room codes + message forwarding, never simulates). `npm run server` (port 8787). Guests are render-only: send inputs @30Hz, receive 20Hz snapshots (`serializeSnapshot` in net/net.ts, ~1.3KB/snap), interpolate transforms 110ms behind via `GuestSync`. Host emits discrete events (kills/booms/dmg/pickups) in the snapshot `ev` array. `Game` takes `NetOpts{role,roster,playerIdx,skyIdx}`; roster fills to 6 seats w/ bots; host-only spawns BotControllers. Disconnected guest → `game.adoptBot(idx)`. A Web Worker ticker (50ms) keeps a hidden HOST tab simulating for guests. NOTE the sim mutates `body.setTranslation` on guests for interp — fine because guests never call `game.step`.
Ideas: gamepad support, energy attacks (freeze), split-screen, dedicated server-sim (extract game.step from THREE/DOM), lag compensation.

## Testing recipe (headless, in preview eval)

`__game.step(1/60, mockInput)` in a loop; park unused vehicles far away AND zero their `input` (bot inputs freeze at last values when `game.bots` is emptied — zombie drivers otherwise). The arena is dense: verify a test lane is actually clear before measuring speed (cars parking against props look like physics bugs). Settle the camera with ~100 `game.render(1/60)` calls before screenshots.
