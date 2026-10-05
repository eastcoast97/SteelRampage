import * as THREE from 'three';

/**
 * Bone lookup for the generated rider.
 *
 * The rig comes from an AI service, so the joint names are whatever that
 * service happened to emit — mixamo-style (`mixamorig:LeftArm`), plain
 * (`LeftArm`, `L_UpperArm`), or something else entirely. Hard-coding one
 * convention would break the moment the model is regenerated, so every bone is
 * resolved by matching against a list of candidate spellings, case- and
 * separator-insensitive.
 *
 * `report()` prints what was actually found, which is the first thing to look at
 * when the rider stops moving.
 */

export interface RiderBones {
  hips: THREE.Bone | null;
  spine: THREE.Bone | null;
  /** the saw arm */
  armL: THREE.Bone | null;
  foreArmL: THREE.Bone | null;
  handL: THREE.Bone | null;
  /** the arm that stays on the bars */
  armR: THREE.Bone | null;
  foreArmR: THREE.Bone | null;
  upLegL: THREE.Bone | null;
  upLegR: THREE.Bone | null;
  legL: THREE.Bone | null;
  legR: THREE.Bone | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** first bone whose normalised name contains ALL of a candidate's tokens */
function find(bones: THREE.Bone[], candidates: string[][]): THREE.Bone | null {
  for (const tokens of candidates) {
    for (const b of bones) {
      const n = norm(b.name);
      if (tokens.every((t) => n.includes(t))) return b;
    }
  }
  return null;
}

/**
 * Every bone's REST rotation, captured before anything poses it.
 *
 * A rig's rest pose is not all-identity — each bone carries the rotation that
 * builds the A-pose. Writing `bone.rotation.set(...)` therefore does not pose
 * the skeleton, it DESTROYS it, and the skinned mesh collapses into something
 * that renders as nothing at all. Poses must be applied as offsets from rest.
 */
const REST = new WeakMap<THREE.Bone, THREE.Euler>();

/** set a bone to its rest rotation plus this offset */
export function poseBone(b: THREE.Bone | null, dx: number, dy = 0, dz = 0) {
  if (!b) return;
  const rest = REST.get(b);
  if (!rest) { b.rotation.set(dx, dy, dz); return; }
  b.rotation.set(rest.x + dx, rest.y + dy, rest.z + dz);
}

export function collectBones(root: THREE.Object3D): { bones: THREE.Bone[]; map: RiderBones } {
  const bones: THREE.Bone[] = [];
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      const b = o as THREE.Bone;
      bones.push(b);
      if (!REST.has(b)) REST.set(b, b.rotation.clone());
    }
  });

  // ordered by specificity: "leftforearm" must beat "leftarm", so it is tried first
  const map: RiderBones = {
    hips: find(bones, [['hips'], ['pelvis'], ['root']]),
    spine: find(bones, [['spine02'], ['spine2'], ['chest'], ['spine01'], ['spine']]),
    foreArmL: find(bones, [['leftforearm'], ['leftlowerarm'], ['lforearm'], ['forearml'], ['leftelbow']]),
    foreArmR: find(bones, [['rightforearm'], ['rightlowerarm'], ['rforearm'], ['forearmr'], ['rightelbow']]),
    handL: find(bones, [['lefthand'], ['lhand'], ['handl']]),
    armL: find(bones, [['leftarm'], ['leftupperarm'], ['leftshoulder'], ['larm'], ['arml']]),
    armR: find(bones, [['rightarm'], ['rightupperarm'], ['rightshoulder'], ['rarm'], ['armr']]),
    upLegL: find(bones, [['leftupleg'], ['leftthigh'], ['leftupperleg'], ['lupleg']]),
    upLegR: find(bones, [['rightupleg'], ['rightthigh'], ['rightupperleg'], ['rupleg']]),
    legL: find(bones, [['leftleg'], ['leftshin'], ['leftcalf'], ['leftknee']]),
    legR: find(bones, [['rightleg'], ['rightshin'], ['rightcalf'], ['rightknee']]),
  };
  // `leftarm` also matches `leftforearm`; if the search collided, drop the dupe
  if (map.armL && map.armL === map.foreArmL) map.armL = null;
  if (map.armR && map.armR === map.foreArmR) map.armR = null;
  if (map.legL && map.legL === map.upLegL) map.legL = null;
  if (map.legR && map.legR === map.upLegR) map.legR = null;
  return { bones, map };
}

export function report(bones: THREE.Bone[], map: RiderBones): Record<string, string | number> {
  const out: Record<string, string | number> = { total: bones.length };
  for (const [k, v] of Object.entries(map)) out[k] = v ? (v as THREE.Bone).name : '— MISSING —';
  return out;
}

/**
 * Fold a standing A-pose character into a riding position.
 *
 * The rig is generated standing because that is what rigs reliably; a seated
 * mesh confuses the joint fitter. So the seat, the bend at the hips, the knees
 * and the arms reaching to the bars are all applied here as bone rotations.
 */
export function poseSeated(m: RiderBones) {
  poseBone(m.spine, -0.25);                  // leaning forward onto the bars
  poseBone(m.upLegL, -1.25, 0.1, 0.16);      // thighs forward, splayed round the tank
  poseBone(m.upLegR, -1.25, -0.1, -0.16);
  poseBone(m.legL, 1.1);                     // knees bent back to the pegs
  poseBone(m.legR, 1.1);
  poseBone(m.armR, -0.85, 0.3, 0.5);         // right hand out to the bar
  poseBone(m.foreArmR, -0.3);
}
