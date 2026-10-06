import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CarSpec } from '../game/specs';
import { buildLoadout } from './loadout';
import type { CarMeshResult } from './carMesh';
import { getCarModel, getSawModel, getRiderModel } from './carModels';
import { collectBones, poseSeated, type RiderBones } from './riderRig';

/**
 * REAPER — a photoreal chopper, a rigged rider, and a real chainsaw, composed
 * from THREE separately generated models.
 *
 * They have to be separate. A Higgsfield/Meshy mesh comes back as a single
 * fused shell, so a rider generated sitting on the bike is welded to it and can
 * never move an arm. Generated alone and standing, he comes back RIGGED — a
 * 24-joint humanoid skeleton — and is folded into a riding pose through his own
 * bones, which is also what lets his arm swing the saw.
 *
 * MEASUREMENTS below come from tools/blender/cut_bike_wheels.py, which cuts the
 * bike's baked wheels out so real spinning ones can take their place, and prints
 * what it measured. Do NOT replace them with numbers read off the cut body: the
 * wheels were its longest parts, so what remains is far shorter than the
 * vehicle, and scaling against it produced a bike several times too big. Blender
 * and the exported glTF agree on the length axis and its scale (verified), so
 * these transfer directly; glTF y is Blender z.
 */

/** full length INCLUDING the wheels, in the model's own units */
const MODEL_LEN = 2.023;
const AXLE_F = -0.7193, AXLE_R = 0.6848;   // along the length axis (model x)
const R_F = 0.2694, R_R = 0.3495;
const GROUND_Y = -0.4468;                  // model height at the tarmac
const AXLE_MID = -0.0173;

export interface ReaperResult extends CarMeshResult {
  /** pivots at the rear axle — rotate to raise the nose */
  wheelieNode: THREE.Object3D;
  frontSteer: THREE.Object3D;
  frontSpin: THREE.Object3D;
  rearSpin: THREE.Object3D;
  sawArm: THREE.Object3D;
  sawBar: THREE.Object3D;
  sawHand: THREE.Object3D;
  idleArm: THREE.Object3D;
  rider: THREE.Object3D;
  /** the rider's resolved skeleton — the arm bones the saw pose drives */
  bones: RiderBones | null;
  /** world-space tip of the bar — the grind contact point */
  sawTip(out: THREE.Vector3): THREE.Vector3;
  /** 0..1 — friction heat, drives the fire on the bar */
  setCharge(t: number): void;
  /** hands the saw to the scene so it can fly, and takes it back after */
  releaseSaw(): THREE.Object3D | null;
  retrieveSaw(): void;
}

/** longest axis of a bounding box, as [axis, length] */
function longest(b: THREE.Box3): ['x' | 'y' | 'z', number] {
  const s = b.getSize(new THREE.Vector3());
  if (s.x >= s.y && s.x >= s.z) return ['x', s.x];
  if (s.z >= s.y) return ['z', s.z];
  return ['y', s.y];
}

export function buildReaper(spec: CarSpec, _colorOverride?: number): ReaperResult {
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  // The rig's body origin sits at suspension rest height (REST_LEN +
  // WHEEL_RADIUS ~= 0.98), not on the road. Everything below is authored with
  // y = 0 at the tarmac, because that is the only frame in which "the bar is
  // touching the road" can be expressed.
  chassis.position.y = -0.98;
  group.add(chassis);

  const K = (spec.size.z * 2) / MODEL_LEN;
  const FRONT_Z = (AXLE_F - AXLE_MID) * K;
  const REAR_Z = (AXLE_R - AXLE_MID) * K;
  const FRONT_R = R_F * K, REAR_R = R_R * K;

  // Everything that leaves the ground on a wheelie hangs off this node, whose
  // pivot is the REAR AXLE: rotate it and the nose comes up while the back wheel
  // stays exactly where it is, which is what a wheelie is.
  const wheelieNode = new THREE.Group();
  wheelieNode.position.set(0, REAR_R, REAR_Z);
  chassis.add(wheelieNode);
  const content = new THREE.Group();
  content.position.set(0, -REAR_R, -REAR_Z);   // undo the pivot: children keep tarmac coords
  wheelieNode.add(content);

  // ------------------------------------------------------------- the bike
  const model = getCarModel('bike');
  const rider = new THREE.Group();
  content.add(rider);
  if (model) {
    const body = model.body.clone(true);
    body.scale.setScalar(K);
    // Placed in MODEL axes, BEFORE the yaw: x is the length, y is up. Doing it
    // after the rotation means measuring a world-axis box of a rotated object,
    // which is not the object's own extent — that mistake is what put the bike
    // sideways at four times its size.
    body.position.set(-AXLE_MID * K, -GROUND_Y * K, 0);
    const yaw = new THREE.Group();
    yaw.rotation.y = -Math.PI / 2;    // model +x (length) -> game -z (nose forward)
    yaw.add(body);
    rider.add(yaw);
  }

  // ------------------------------------------------------------- the rider
  let bones: RiderBones | null = null;
  const sawArm = new THREE.Group();
  const sawHand = new THREE.Group();
  const idleArm = new THREE.Group();
  const riderSrc = getRiderModel();
  if (riderSrc) {
    // SkeletonUtils.clone, NOT Object3D.clone: a plain clone copies the mesh but
    // leaves it bound to the ORIGINAL skeleton, so every REAPER on the field
    // would share one set of bones and pose in lockstep.
    const man = cloneSkinned(riderSrc) as THREE.Object3D;
    man.traverse((o: THREE.Object3D) => {
      if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; }
    });
    const got = collectBones(man);
    bones = got.map;

    // MEASURE HIM BY HIS BONES, NOT HIS GEOMETRY. A SkinnedMesh's geometry
    // bounding box is the bind-pose mesh in its own local frame, which here is
    // 0.017 units tall — the armature carries a 0.01 scale and the bone
    // positions are ~100x larger to match. Scaling off the geometry therefore
    // multiplied him by 105, which put his skeleton 100m in the air spread over
    // 75m, and the skinned mesh drew far outside the view. The bones are the
    // only thing that reports his real height.
    man.updateMatrixWorld(true);
    const _p = new THREE.Vector3();
    let lo = Infinity, hi = -Infinity;
    for (const b of got.bones) {
      b.getWorldPosition(_p);
      lo = Math.min(lo, _p.y);
      hi = Math.max(hi, _p.y);
    }
    // bones reach the top of the neck, not the crown: allow for the head
    const boned = Math.max(1e-3, (hi - lo) * 1.16);
    man.scale.setScalar(man.scale.x * (1.78 / boned));
    poseSeated(bones);
    // HE FACES THE CAMERA, NOT THE ROAD. The hero image was shot front-on, so
    // the generated model's forward is +Z while the bike's is -Z — measured, his
    // shoulder-line normal came back [0,0,1] — and he rode the whole thing
    // sitting backwards. Turn him round.
    man.rotation.y = Math.PI;
    // seated: measured so the HIP bone lands at saddle height rather than
    // eyeballing the model's own origin, which sits wherever the generator put it
    man.position.set(0, -0.10, 0.30);
    rider.add(man);
    // The saw hangs off his LEFT HAND BONE, so it follows the arm by itself and
    // there is no second pose system to keep in step.
    //
    // UNDO THE BONE'S SCALE. The armature carries a 0.01 scale (its bone
    // positions are ~100x to match), so anything parented to a bone inherits
    // that: the saw rendered at 1.1 * 0.0094 = ONE CENTIMETRE, and all you could
    // see of it was the fire particles, which are emitted in world space.
    if (bones.handL) {
      bones.handL.add(sawArm);
      man.updateMatrixWorld(true);
      const hs = bones.handL.getWorldScale(new THREE.Vector3());
      sawArm.scale.setScalar(1 / Math.max(1e-4, hs.x));
    } else {
      rider.add(sawArm);
    }
  } else {
    rider.add(sawArm);
  }
  sawArm.add(sawHand);
  rider.add(idleArm);

  // ------------------------------------------------------------- the saw
  const sawBar = new THREE.Group();
  sawArm.add(sawBar);
  const BLADE = 1.1;
  let sawMesh: THREE.Object3D | null = null;
  const sawRestPos = new THREE.Vector3();
  const sawRestRot = new THREE.Euler();
  const sawRestScale = new THREE.Vector3(1, 1, 1);
  const sawSrc = getSawModel();
  if (sawSrc) {
    const saw = sawSrc.clone(true);
    const sb = new THREE.Box3().setFromObject(saw);
    const [axis, len] = longest(sb);
    // normalise to a fixed length on whichever axis came back longest, then lay
    // that axis down -Z so "the bar points forward" holds either way
    saw.scale.setScalar(BLADE / Math.max(1e-3, len));
    if (axis === 'x') saw.rotation.y = Math.PI / 2;
    else if (axis === 'y') saw.rotation.x = Math.PI / 2;
    const sc = new THREE.Box3().setFromObject(saw).getCenter(new THREE.Vector3());
    saw.position.set(-sc.x, -sc.y, -sc.z - BLADE * 0.45);   // grip at the pivot
    saw.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    sawBar.add(saw);
    sawMesh = saw;
    sawRestPos.copy(saw.position);
    sawRestRot.copy(saw.rotation);
    sawRestScale.copy(saw.scale);
  }

  // Fire on the bar: a thin emissive core whose LENGTH tracks the charge, so the
  // bar reads as its own meter. The flames are particles (effects.bladeFire) —
  // a solid flame mesh has no ragged edge, and fire is nothing but ragged edge.
  const fire = new THREE.MeshStandardMaterial({
    color: 0xff6a10, emissive: 0xff3c00, emissiveIntensity: 0.45,
    roughness: 0.5, transparent: true, opacity: 0.85,
  });
  const flameSheath = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, BLADE), fire);
  flameSheath.visible = false;
  sawBar.add(flameSheath);
  const tip = new THREE.Object3D();
  tip.position.set(0, 0, -BLADE);
  sawBar.add(tip);

  // ------------------------------------------------------------- wheels
  // The rig drives FOUR pivots and does `children[0].rotation.set(spin,0,0)`
  // every frame, which WIPES a tyre's own axis rotation and leaves it lying flat
  // in the road — so each wheel sits inside a spinner group. A bike doubles the
  // pivots onto two axles and leaves the second of each pair empty.
  const makeWheel = (r: number) => {
    const spin = new THREE.Group();
    if (model?.wheel) {
      // the AI wheel the fleet already ships: hand-built primitives next to a
      // photoreal bike read as cardboard
      const w = model.wheel.clone(true);
      const ws = new THREE.Box3().setFromObject(w).getSize(new THREE.Vector3());
      w.scale.setScalar((r * 2) / Math.max(1e-3, Math.max(ws.y, ws.z)));
      const c = new THREE.Box3().setFromObject(w).getCenter(new THREE.Vector3());
      w.position.sub(c);
      w.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      spin.add(w);
    }
    return spin;
  };
  const frontSteer = new THREE.Group();
  frontSteer.position.set(0, FRONT_R, FRONT_Z);
  const frontSpin = makeWheel(FRONT_R);
  frontSteer.add(frontSpin);
  content.add(frontSteer);
  const rearSpin = makeWheel(REAR_R);
  rearSpin.position.set(0, REAR_R, REAR_Z);
  content.add(rearSpin);

  const wheels: THREE.Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(0, REAR_R, i < 2 ? FRONT_Z : REAR_Z);
    pivot.add(new THREE.Group());   // the rig writes rotation into children[0]
    group.add(pivot);
    wheels.push(pivot);
  }

  // Carried ammo is modelled at car scale; on a bike a full-size warhead is as
  // long as the vehicle, so the whole mount shrinks and rides behind the seat.
  const loadout = buildLoadout(spec, 1.5, 1.05);
  loadout.group.scale.setScalar(0.5);
  chassis.add(loadout.group);

  const _t = new THREE.Vector3();
  return {
    group, wheels, wheelRadius: REAR_R, chassis, loadout,
    wheelieNode, frontSteer, frontSpin, rearSpin,
    sawArm, sawBar, sawHand, idleArm, rider, bones,
    sawTip: (out) => { tip.getWorldPosition(_t); return out.copy(_t); },
    setCharge: (t) => {
      const lit = t > 0.02;
      flameSheath.visible = lit;
      if (lit) {
        flameSheath.scale.set(1, 1, 0.12 + t * 0.9);
        flameSheath.position.z = -(BLADE * (0.12 + t * 0.9)) / 2;
        fire.emissiveIntensity = 0.5 + t * 1.9;
      }
    },
    // The thrown saw leaves his hand and flies on its own, so it is reparented
    // to the scene for the flight and handed back after. Reparenting keeps the
    // ONE saw he actually had rather than spawning a second.
    releaseSaw: () => {
      if (!sawMesh) return null;
      sawBar.remove(sawMesh);
      return sawMesh;
    },
    retrieveSaw: () => {
      if (!sawMesh) return;
      sawMesh.position.copy(sawRestPos);
      sawMesh.rotation.copy(sawRestRot);
      sawMesh.scale.copy(sawRestScale);
      sawBar.add(sawMesh);
    },
  };
}
