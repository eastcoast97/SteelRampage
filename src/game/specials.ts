import type { SpecialId } from './specs';

/**
 * Special-weapon tuning, and the text the menu uses to explain it.
 *
 * These numbers used to live as loose consts inside game.ts, which was fine
 * while nothing else needed them. The moment the vehicle-select screen started
 * quoting a weapon's range and damage, that became two copies of every figure —
 * and the one in the menu would be the one nobody notices has gone stale. So
 * the constants live here, game.ts imports them, and SPECIAL_INFO is built FROM
 * them rather than repeating them in prose. Retune a weapon and the briefing
 * retunes with it.
 *
 * Same rule as rocket.ts, mine.ts and laneAt() on the skyloop: anything that
 * appears in more than one place gets built once.
 */

// ---- the default weapon every car carries ----
export const MG_RANGE = 68;
export const MG_DAMAGE = 2.2;

// ---- VIPER: nitro ram ----
export const DASH_BASE = 12;
export const DASH_TIME = 1.8;

// ---- HELLCAT: twin miniguns ----
export const MINIGUN_SHOT = 3.5;
export const MINIGUN_TIME = 4;

// ---- SCORCH: flamethrower ----
export const FLAME_DPS = 20;
export const FLAME_RANGE = 13;
export const FLAME_TIME = 3.2;

// ---- RAMPART: auto-turret ----
export const TURRET_SHOT = 2.0;
export const TURRET_RANGE = 48;
export const TURRET_TIME = 5;

// ---- JUGGERNAUT: seismic slam ----
export const SLAM_DAMAGE = 22;
export const SLAM_RADIUS = 12.1;

// ---- MORTIS: remote bomb ----
export const BOMB_DAMAGE = 29;
export const BOMB_FUSE = 4;

// ---- MEDIC: adrenaline ----
export const REPAIR_HEAL = 45;

// ---- REAPER: the saw ----
export const SAW_DAMAGE = 36;
export const SAW_THROW_RANGE = 34;
export const SAW_CHARGE_TIME = 5.0;
export const SAW_GRIND_MIN_SPEED = 7;

/** per-special cooldown while the 45s window is open */
export const SPECIAL_RETRIGGER: Record<SpecialId, number> = {
  dash: 3, minigun: 5, flame: 3.5, turret: 6, slam: 4, bomb: 1, repair: 7, chainsaw: 3,
};

export interface SpecialInfo {
  /** what the player presses, and what has to be true first */
  how: string;
  /** the shape of the attack, in one line */
  effect: string;
  /** headline figures for the briefing panel */
  stats: { label: string; value: string }[];
}

const m = (n: number) => `${n} m`;
const s = (n: number) => `${n}s`;

export const SPECIAL_INFO: Record<SpecialId, SpecialInfo> = {
  dash: {
    how: 'RCLICK / E — needs a full bar',
    effect: 'Hurls you forward; the car itself becomes the weapon. Damage scales with how fast you close.',
    stats: [
      { label: 'DAMAGE', value: `${DASH_BASE}+ on impact` },
      { label: 'RANGE', value: 'contact' },
      { label: 'DURATION', value: s(DASH_TIME) },
    ],
  },
  minigun: {
    how: 'RCLICK / E — needs a full bar',
    effect: 'Both barrels open up. Hold the trigger and keep the nose on target.',
    stats: [
      { label: 'DAMAGE', value: `${MINIGUN_SHOT} / shot` },
      { label: 'RANGE', value: m(MG_RANGE) },
      { label: 'DURATION', value: s(MINIGUN_TIME) },
    ],
  },
  flame: {
    how: 'RCLICK / E — needs a full bar',
    effect: 'A cone of fire out of the nose. Short reach, and it burns anything held in it.',
    stats: [
      { label: 'DAMAGE', value: `${FLAME_DPS} / sec` },
      { label: 'RANGE', value: `${m(FLAME_RANGE)} cone` },
      { label: 'DURATION', value: s(FLAME_TIME) },
    ],
  },
  turret: {
    how: 'RCLICK / E — needs a full bar',
    effect: 'The roof gun picks its own targets, in any direction, while you drive.',
    stats: [
      { label: 'DAMAGE', value: `${TURRET_SHOT} / shot` },
      { label: 'RANGE', value: `${m(TURRET_RANGE)}, 360°` },
      { label: 'DURATION', value: s(TURRET_TIME) },
    ],
  },
  slam: {
    how: 'RCLICK / E — needs a full bar',
    effect: 'Drops the whole weight of the truck. A ring of force throws everything around you off its wheels.',
    stats: [
      { label: 'DAMAGE', value: `${SLAM_DAMAGE}` },
      { label: 'RANGE', value: `${m(SLAM_RADIUS)} radius` },
      { label: 'DURATION', value: 'instant' },
    ],
  },
  bomb: {
    how: 'RCLICK / E to lob — press again to detonate',
    effect: 'Leaves it where you choose. Blow it as they drive over, or let the fuse do it.',
    stats: [
      { label: 'DAMAGE', value: `${BOMB_DAMAGE}` },
      { label: 'RANGE', value: 'where you drop it' },
      { label: 'FUSE', value: `${s(BOMB_FUSE)} or on command` },
    ],
  },
  repair: {
    how: 'RCLICK / E — needs a full bar, and damage to repair',
    effect: 'Field repair on the move. The only way to get armour back without finding a pickup.',
    stats: [
      { label: 'RESTORES', value: `${REPAIR_HEAL} armour` },
      { label: 'RANGE', value: 'self' },
      { label: 'DURATION', value: 'instant' },
    ],
  },
  chainsaw: {
    how: 'HOLD RCLICK / E to charge — RELEASE to throw',
    effect: `Wheelie and drag the saw on the road to charge it, then let go and he hurls it. It comes back to his hand. No bar to earn first — grinding IS the cost. Needs ${SAW_GRIND_MIN_SPEED} m/s to bite.`,
    stats: [
      { label: 'DAMAGE', value: `${SAW_DAMAGE}, pierces armour` },
      { label: 'RANGE', value: m(SAW_THROW_RANGE) },
      { label: 'CHARGE', value: `${s(SAW_CHARGE_TIME)} of grinding` },
    ],
  },
};
