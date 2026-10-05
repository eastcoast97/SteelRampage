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

export function collectBones(root: THREE.Object3D): { bones: THREE.Bone[]; map: RiderBones } {
  const bones: THREE.Bone[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });

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
  const set = (b: THREE.Bone | null, x: number, y = 0, z = 0) => { if (b) b.rotation.set(x, y, z); };
  set(m.spine, -0.28);                 // leaning forward onto the bars
  set(m.upLegL, -1.35, 0.1, 0.18);     // thighs forward and splayed round the tank
  set(m.upLegR, -1.35, -0.1, -0.18);
  set(m.legL, 1.15);                   // knees bent back to the pegs
  set(m.legR, 1.15);
  set(m.armR, -0.95, 0.35, 0.55);      // right hand out to the bar
  set(m.foreArmR, -0.35);
}
