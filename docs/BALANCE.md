# Steel Rampage — Damage & Armor Balance

## Armor: percentage mitigation with diminishing returns

Every vehicle has the same **100 HP pool**. Durability comes from an armor rating:

```
damageTaken = raw × 100 / (100 + armor)
mitigation% = armor / (armor + 100)
effectiveHP = 100 × (1 + armor / 100)
```

Applied in ONE place: `Vehicle.takeDamage` (src/game/vehicle.ts). Never mitigate at
the weapon site.

**One documented exception: `takeDamage(..., pierce = true)` skips mitigation
entirely, and only the nuke passes it.** The nuke's whole job is to take a fixed
fraction of the bar off anything. Mitigated, its 48 would be half a VIPER and a
sixth of a JUGGERNAUT — i.e. worst against the exact target you were saving it
for. Piercing is still a single place (the formula has not moved), just a flag.

Why not flat reduction: flat DR zeroes out the machine gun against tanks (breaking the
damage hierarchy) and double-dips vs multi-hit weapons. Percentage DR scales every
weapon identically and asymptotes — armor can never reach immunity.

| Vehicle | Armor | Mitigation | Effective HP |
|---|---|---|---|
| VIPER | 0 | 0% | 100 |
| SCORCH | 25 | 20% | 125 |
| JACKRABBIT | 30 | 23% | 130 |
| HELLCAT | 55 | 35% | 155 |
| MEDIC | 85 | 46% | 185 |
| MORTIS | 90 | 47% | 190 |
| RAMPART | 115 | 53% | 215 |
| JUGGERNAUT | 200 | 67% | 300 |

## Damage hierarchy (raw, pre-mitigation)

**APEX — Nuke: 48, ARMOR-PIERCING, radius 22.** Deliberately outside the hierarchy
below and the only thing that outranks a missile. Pickup only, capacity 1, no overdrive
multiplier — overdrive scales the weapons you use repeatedly, and 48 piercing is
already the game's ceiling. Unguided and slow (`NUKE_SPEED` 30 m/s) so it is a
read-and-dodge weapon, not a sniper rifle. `NUKE_FUSE` (3.2) is the proximity
radius AND feeds the full-damage band through `explosionAt`'s `directR` — **a
weapon's direct-hit band must be ≥ its fuse radius** or every "direct" hit is
quietly scaled down by falloff and the weapon never deals its stated damage.

**MAX — Targeted missile: 34.** Dumbfire (no lock): 26. Direct hits (< 2.6 m from
blast center) take zero splash falloff so a landed missile always outranks specials.

**MID — Specials: hard-capped at `SPECIAL_CAP = 29` (0.85 × locked missile) per
activation per victim** via the *damage ledger* (`Vehicle.specialLedger`, metered by
`Game.drawSpecialBudget`, cleared on each activation). This makes "specials never
exceed a targeted missile" an invariant, not a tuning hope:

- Remote bomb 29 (single instance) · Nitro-ram `12 + 0.5×closingSpeed`, clamped 29
- Mine 24 · Slam 22×falloff · Flame 20/s · Turret 2.0/shot · Minigun 3.5/shot
- DoT specials draw from the ledger each tick; once a victim's 29 budget is spent,
  flame/turret deal 0 and the minigun reverts to base MG damage.

**MIN — Machine gun: 2.2/hit** (~23 dps perfect, ~15 real after spread/range).
Overdrive pickup: MG ×1.75 = 3.85, missile ×1.5 = 51 — tiers preserved.

**Rams: clamped ≤ 18** (`RAM_CAP`) — physics can't outclass weapons.

## Verified numbers (headless, 2026-07-16)

- 34 raw vs 30 armor → 26.2 taken; vs 115 armor → 15.8 (formula exact)
- Locked missile direct hit: 34.0 raw ✓ top of hierarchy
- Turret full 5s activation on one victim: 29.0 raw ✓ ledger cap
- Full-speed nitro-ram: 29.0 raw ✓ clamp
- 12 MG hits: 26.4 raw (= 12 × 2.2 exact)

### Nuke (headless, 2026-10-05)

- Direct hit on armor 0: **48.0 taken** — exactly the stated damage, no falloff
- Same blast, armor 115 at 1 m further: 42.7 taken (mitigated it would be 19.9)
- Armor 0 vs armor 200 at matched range: 43.1 vs 43.8 — **armor is irrelevant ✓**
- Owner takes 0 (excluded from `explosionAt` like every other blast)
- 90s soak with nukes seeded into 8 of 24 sockets: 5 fired, 3 kills, bots
  1383–2210 m, no leaked projectiles

### Nuke availability (10 simulated minutes of a live match)

As a shuffle weight it was unfindable: **one appearance in 10 minutes**, first at
117 s, never at match start (initial socket types come from the arena's PICKUP_
markers and no arena authors a nuke marker), and only 31 sockets rerolled in the
whole match. On a dedicated roaming socket instead: **on the map 65% of the
match, taken 5 times, longest gap 47 s.** One nuke exists at any moment, which is
what makes it a place on the map worth contesting rather than a lottery.

## TTK reference (locked missiles / sustained MG @23dps)

VIPER 3 missiles / 4.3s MG · HELLCAT 5 / 6.7s · RAMPART 7 / 9.3s · JUGGERNAUT 9 / 13s

## Missile lock-on (cone acquisition with hysteresis)

State machine in `Game.updateLock` (per vehicle, bots included):
`NO LOCK → ACQUIRING (progress += dt/LOCK_TIME while best candidate holds) → LOCKED (sticky)`.
Constants: `LOCK_RANGE 78`, `LOCK_CONE cos 36.9°`, `LOCK_TIME 0.9s`, `LOCK_DECAY 3.0/s`
(out-of-cone progress fully resets in 0.33s). Retention uses a wider cone
(`LOCK_KEEP_CONE cos 0.72`, `LOCK_KEEP_RANGE 86`) so edge wiggle doesn't strobe the
lock; losing line-of-sight breaks it. Candidate switch resets progress. Dumbfire is
always available (no target → straight flight, 26 raw vs locked 34). UI: LOCKING
progress ring (conic-gradient) → "LOCKED — FIRE" + two-blip sfx on the rising edge.

Verified: progress 0.56 @ 0.5s (exact), lock @ 0.9s, decay 1→0.5 in 0.167s (exact),
held at dot 0.756, dropped at dot 0.61, LOS break drops lock, dumbfire dealt 26.0 raw.

## Tuning knobs (src/game/game.ts, top of file)

All constants live in one block: `MISSILE_DAMAGE_LOCKED/DUMB`, `SPECIAL_CAP`,
`RAM_CAP`, `MG_DAMAGE`, per-special values. Armor ratings: `armor` in specs.ts.
Keep the invariant: `SPECIAL_CAP < MISSILE_DAMAGE_LOCKED` and `RAM_CAP < DUMB`.
The nuke sits above both on purpose; `NUKE_DAMAGE` is the only value allowed to.
Carry limits (`MAX_MISSILES` / `MAX_MINES` / `MAX_NUKES`) live in specs.ts and are
imported by the pickup, the collect, the car's visible rack and the HUD — all four
used to hardcode them separately.
