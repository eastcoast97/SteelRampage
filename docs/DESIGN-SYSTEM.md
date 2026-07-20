# Steel Rampage — Pickup & Power-up Design System

Design reference for in-game items and power-ups. Principles:

1. **One hue + one silhouette per item.** Color is never the only channel — every item
   must read by shape alone at 24px (radar dots, kill feed, HUD chips).
2. **Hue spacing ≥40°** on the color wheel between any two items.
3. **Shared state grammar** — acquire/active/depleted behave identically across items.
4. **Motion identity** — each item has a signature rhythm (turbo 8Hz flicker, shield 1Hz
   breath, mine 1.5Hz blink, bomb accelerating blink). Third redundant channel.

Reserved hues: **magenta #FF44DD = Overdrive only**, gold/white = score & UI chrome.

## Palettes

| Item | Name | Core | Deep | Accent | Silhouette | Hue |
|---|---|---|---|---|---|---|
| Missiles | Hunter Orange | `#FF6A1A` | `#C43000` | `#FFC896` flare | tactical rocket (see spec below) | 20° |
| Turbo | Bolt Yellow | `#FFE44D` | `#FFB300` | `#FFF9C4` streak | thunderbolt | 52° (per user; 32° from missiles — silhouette + lightness carry the separation) |
| Health | Vital Green | `#2EE86C` | `#009648` | `#C8FFDD` mint | rounded cross + EKG notch | 140° |
| Shield | Aegis Indigo | `#5C7CFF` | `#2B3FCC` | `#C9D4FF` glow | hex-faceted dome | 228° |
| Mines | Graphite & Dot | `#2A2A32` body | `#9A9AA6` grey trim | `#FF2E2E` arm dot | dark disc + red dot | n/a (neutral) |
| Bombs | Detonation Crimson | `#FF1E3C` | `#8C0616` | `#FFF3F5` ring | sphere on countdown ring | 350° |

Rationale: shield was moved OFF cyan (old `#7de8ff`) after live playtest confusion with
turbo — both read as "blue crystal" at speed.

### Missile icon spec (pickup + projectile share one design)

Sleek tactical rocket, NOT a cone: bone-white hull (`#E8E4DC`, metalness 0.65) with a
**pointed Hunter-Orange nose cone** (emissive) and orange body band; four **swept
graphite fins** (`#22202A`, raked 0.16 rad); dark nozzle; **two-layer thruster plume**
(orange `#FF8830` sheath over a white-hot `#FFF2C0` core, additive). Pickup poses at a
0.55 rad launch tilt and spins — the silhouette reads "rocket" from every angle. The
fired projectile uses identical hull/nose/fins/plume so pickup → weapon is one object.

## State grammar (all items)

- **Acquire**: icon punch 1.6×→1× elastic (~180ms); counter tick + 2-frame flash; toast
  in item hue. World: 12–16 radial sparks in core color + expanding ground ring; pickup
  mesh implodes (90ms) rather than vanishing.
- **Active**: chip breathes (1Hz outline glow); timed items get radial wipe countdown.
  World: item hue leaks onto the vehicle (underglow/trail tint) — enemies can read state.
- **Depleted / denied**: icon 40% desat + hollow outline; 2-frame shake on failed input.
  Never fail silently. World: dim socket ring marks the respawn spot.
- **Respawning**: socket ring fills clockwise over respawn timer → pickup pops in with a
  1s vertical light beacon.

## Per-item motion signatures

- **Missiles**: acquire streaks fly INTO the ammo counter; firing ejects a pip downward
  with smoke. Lock-on reticle uses missile orange.
- **Turbo**: 60ms screen-edge speedline on acquire; active bar has 2px voltage jitter;
  exhaust goes white-hot core / cyan edge; depletion = three rapid flickers then gray.
- **Health**: mint EKG sweep across armor bar on acquire; floating green heal numbers.
  Critical health = armor bar pulses red at heartbeat pace that quickens as HP drops.
- **Shield**: hex tiles assemble front-to-back (250ms). Hits flare only the struck facet
  white (damage visibly bounced). Last 1.5s: facets flicker off one by one.
- **Mines**: counter stamps down like a pressure plate. Deployed mine and pickup share
  the same look: graphite disc + red dot blinking 1.5Hz when armed (per user direction —
  neutral body, the red dot is the signal). Being hard to spot IS the tactical identity.
- **Bombs**: world-space white countdown ring shrinks; blink 2Hz→8Hz before timeout.
  Detonate chip pulses crimson. Detonation = one 40ms full-screen white flash frame.

## Implementation mapping (current code)

- Colors live in `src/game/pickups.ts` (`COLORS`) and toasts in `game.ts collectPickup`.
- Update shield `0x7de8ff → 0x5C7CFF` (+ bubble material, HUD chip, pickup mesh).
- Mines `0xffcc33 → 0xFFC400`; missiles `0xff8a2a → 0xFF6A1A`; health `0x3aff6e → 0x2EE86C`;
  turbo `0x38c8ff → 0x00E5FF`.
- Particle counts/lifetimes: `src/render/effects.ts`. Toast/HUD: `src/ui/hud.ts` + `style.css`.
