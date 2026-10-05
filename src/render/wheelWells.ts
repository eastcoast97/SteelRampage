import type { CarSpec } from '../game/specs';

/**
 * Where the wheel wells are in each AI-generated body.
 *
 * `tools/blender/autocut_wheels.py` deletes the fused-in tyres from the Meshy
 * meshes and reports the hub geometry it found; these numbers are that report,
 * normalised so they survive the body being rescaled to each archetype's size.
 * Without them the rig mounts a stock-sized wheel at a stock position and you
 * get a small wheel rattling around inside a big empty arch.
 *
 * Units: fractions of the SCALED body's own half-length, except `trackX` which
 * is a fraction of its half-width. The cut script always uses R_FRAC = 0.26, so
 * every body's well radius is the same fraction — keep the two in step.
 *
 * Axis note: the models arrive with their length on X and are yawed -90° at
 * load (carModels MODEL_YAW), which maps model +X to car +Z. Blender's glTF
 * importer leaves X alone, so the axle positions it reports are car Z with the
 * same sign — negative is the nose, since car forward is -Z.
 */
export interface WheelWell {
  /** [front, rear] hub positions along Z, as fractions of half-length */
  axleZ: [number, number];
  /** half-track, as a fraction of the body's half-width */
  trackX: number;
  /** hub height above the body's lowest point, as a fraction of half-length */
  hubY: number;
}

/** well radius as a fraction of half-length — must match R_FRAC in autocut_wheels.py */
export const WELL_RADIUS_FRAC = 0.26;

/** how much of the well the tyre fills; the rest reads as arch clearance */
export const WELL_FILL = 0.9;

const WELLS: Partial<Record<CarSpec['build'], WheelWell>> = {
  speed: { axleZ: [-0.494, 0.651], trackX: 0.686, hubY: 0.247 },
  tank: { axleZ: [-0.646, 0.540], trackX: 0.615, hubY: 0.247 },
  sports: { axleZ: [-0.433, 0.635], trackX: 0.693, hubY: 0.247 },
  suv: { axleZ: [-0.694, 0.594], trackX: 0.615, hubY: 0.246 },
  hearse: { axleZ: [-0.654, 0.595], trackX: 0.643, hubY: 0.246 },
  ambulance: { axleZ: [-0.618, 0.566], trackX: 0.654, hubY: 0.246 },
  // cut in phase 3.2 by the older per-model script, same 0.26 radius fraction
  muscle: { axleZ: [-0.579, 0.579], trackX: 0.857, hubY: 0.247 },
};

/** fleet average — covers a body we haven't measured (e.g. a new AI model) */
const DEFAULT_WELL: WheelWell = { axleZ: [-0.606, 0.576], trackX: 0.676, hubY: 0.247 };

export function getWheelWell(build: CarSpec['build']): WheelWell {
  return WELLS[build] ?? DEFAULT_WELL;
}
