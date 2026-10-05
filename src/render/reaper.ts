import * as THREE from 'three';
import type { CarSpec } from '../game/specs';
import { buildLoadout } from './loadout';
import type { CarMeshResult } from './carMesh';
import { getCarModel, getSawModel } from './carModels';

/**
 * REAPER — a photoreal chopper with a bare-chested rider, carrying a real
 * chainsaw.
 *
 * Both halves are Higgsfield/Meshy generated (the phase-3.1 pipeline), but they
 * are generated SEPARATELY and that is the whole trick. These meshes come back
 * as a single fused shell — one connected component of 41k verts — so anything
 * modelled into the body is frozen there forever. The saw has to drop to the
 * tarmac, hold a grind, and then whip overhead, so it cannot be part of the
 * body. It is its own model on its own pivot, placed at the rider's left hand.
 *
 * What is still built here, and why:
 *   - the WHEELIE pivot, because the body must rotate about the rear axle
 *   - the WHEELS, because a fused body cannot spin its own
 *   - the fire, because it tracks a gameplay value
 *
 * Named pivots the game drives:
 *   `sawArm`  — shoulder: drops the bar to the road, then whips it overhead
 *   `sawBar`  — the saw itself; the fire rides it
 *   `setCharge(t)` — 0..1, how far the heat has climbed the bar
 */

export interface ReaperResult extends CarMeshResult {
  /** pivots at the rear axle — rotate to raise the nose */
  wheelieNode: THREE.Object3D;
  /** the two visible wheels: spin and steer them from the rig's values */
  frontSteer: THREE.Object3D;
  frontSpin: THREE.Object3D;
  rearSpin: THREE.Object3D;
  sawArm: THREE.Object3D;
  sawBar: THREE.Object3D;
  /** kept so the game's arm toggles stay valid against the generated body */
  sawHand: THREE.Object3D;
  idleArm: THREE.Object3D;
  rider: THREE.Object3D;
  /** world-space tip of the bar — the grind contact point */
  sawTip(out: THREE.Vector3): THREE.Vector3;
  /** 0..1 — friction heat, drives the fire on the bar */
  setCharge(t: number): void;
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

  // measured by the wheel cut: axles at model y -0.671 / +0.629 with radii
  // 0.30 / 0.36, on a body 1.899 long that we scale to spec.size.z * 2
  const MODEL_LEN = 1.899, K = (spec.size.z * 2) / MODEL_LEN;
  const FRONT_Z = -0.671 * K, REAR_Z = 0.629 * K;
  const FRONT_R = 0.297 * K, REAR_R = 0.356 * K;   // per-wheel, as measured
  const wheelR = REAR_R;                          // the rig's single radius
  const wheelieNode = new THREE.Group();
  wheelieNode.position.set(0, wheelR, REAR_Z);
  chassis.add(wheelieNode);
  const content = new THREE.Group();
  content.position.set(0, -wheelR, -REAR_Z);   // undo the pivot: children keep tarmac coords
  wheelieNode.add(content);

  // ------------------------------------------------------------- the body
  const model = getCarModel('bike');
  const rider = new THREE.Group();          // the generated body stands in for the rider
  content.add(rider);
  if (model) {
    const body = model.body.clone(true);
    // Scale and seat it from its OWN bounds. A generated mesh arrives at an
    // arbitrary size, centred on its own centroid rather than standing on
    // anything, so hard-coding either would be guesswork.
    const bb = new THREE.Box3().setFromObject(body);
    const size = bb.getSize(new THREE.Vector3());
    body.scale.setScalar((spec.size.z * 2) / Math.max(1e-3, size.z));
    const bb2 = new THREE.Box3().setFromObject(body);
    const c = bb2.getCenter(new THREE.Vector3());
    body.position.set(-c.x, -bb2.min.y, -c.z);   // centred, standing on the road
    rider.add(body);
  }

  // ------------------------------------------------------------- the saw
  const sawArm = new THREE.Group();
  // Mounted LOW and outboard. At shoulder height the 1.2m bar simply cannot
  // reach the tarmac — the grind pose solved to a tip 0.49m in the air.
  // NOTE the sign: the body carries MODEL_YAW = PI to face the right way down
  // the track, which mirrors the rider in this (unrotated) frame — his left hand
  // is at POSITIVE x here.
  sawArm.position.set(0.3, 0.92, -0.05);     // at his left hand
  rider.add(sawArm);
  const sawHand = new THREE.Group();         // the generated arm cannot move, but
  sawArm.add(sawHand);                       // the game's toggles stay harmless
  const idleArm = new THREE.Group();
  rider.add(idleArm);

  const sawBar = new THREE.Group();
  sawArm.add(sawBar);
  const BLADE = 1.2;
  const sawSrc = getSawModel();
  if (sawSrc) {
    const saw = sawSrc.clone(true);
    const sb = new THREE.Box3().setFromObject(saw);
    const [axis, len] = longest(sb);
    // Normalise to a 1.2m saw whatever came back, then lay its long axis down
    // -Z, so "the bar points forward" holds regardless of the axis it arrived on.
    saw.scale.setScalar(BLADE / Math.max(1e-3, len));
    if (axis === 'x') saw.rotation.y = Math.PI / 2;
    else if (axis === 'y') saw.rotation.x = Math.PI / 2;
    const sb2 = new THREE.Box3().setFromObject(saw);
    const sc = sb2.getCenter(new THREE.Vector3());
    saw.position.set(-sc.x, -sc.y, -sc.z - BLADE * 0.5);   // grip at the pivot, bar out front
    saw.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    sawBar.add(saw);
  }

  // Fire on the bar: a thin emissive core whose LENGTH tracks the charge, so the
  // bar reads as its own meter. The flames are particles (effects.bladeFire) —
  // a solid flame mesh has no ragged edge and fire is nothing but ragged edge.
  const fire = new THREE.MeshStandardMaterial({
    color: 0xff6a10, emissive: 0xff3c00, emissiveIntensity: 0.45,
    roughness: 0.5, transparent: true, opacity: 0.85,
  });
  const flameSheath = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.2, BLADE), fire);
  flameSheath.visible = false;
  sawBar.add(flameSheath);

  const tip = new THREE.Object3D();
  tip.position.set(0, 0, -BLADE);
  sawBar.add(tip);

  // ------------------------------------------------------------- wheels
  // The rig drives FOUR pivots and does `children[0].rotation.set(spin,0,0)`
  // every frame, which WIPES a tyre's own axis rotation and leaves it lying flat
  // in the road — so each tyre sits inside a spinner group. A bike doubles the
  // pivots onto two axles and leaves the second of each pair empty.
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.93, metalness: 0.04 });
  // dulled right down: at roughness 0.18 the rims blew out to white discs under
  // the sunbaked preset's bloom and the wheels read as balloons
  const chrome = new THREE.MeshStandardMaterial({ color: 0x8d9099, roughness: 0.42, metalness: 0.9 });
  // Prefer the AI wheel the fleet already ships: hand-built primitives next to a
  // photoreal bike read as cardboard, and this one is already paid for.
  const makeWheel = (r: number, halfWidth: number) => {
    const spin = new THREE.Group();
    if (model?.wheel) {
      const w = model.wheel.clone(true);
      const wb = new THREE.Box3().setFromObject(w);
      const ws = wb.getSize(new THREE.Vector3());
      // scale on its DIAMETER, which is its largest cross-section, not its width
      const dia = Math.max(ws.y, ws.z);
      w.scale.setScalar((r * 2) / Math.max(1e-3, dia));
      const wb2 = new THREE.Box3().setFromObject(w);
      w.position.sub(wb2.getCenter(new THREE.Vector3()));
      w.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      spin.add(w);
      return spin;
    }
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, halfWidth * 2, 22), rubber);
    tyre.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, halfWidth * 2.1, 14), chrome);
    rim.rotation.z = Math.PI / 2;
    spin.add(tyre, rim);
    // laced spokes, thin: a solid disc reads as a scooter wheel, and the
    // original was a wire wheel
    for (let k = 0; k < 8; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 0.5, r * 1.82, 0.016), chrome);
      spoke.rotation.x = (k / 8) * Math.PI;
      spin.add(spoke);
    }
    spin.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    return spin;
  };
  const frontSteer = new THREE.Group();
  frontSteer.position.set(0, FRONT_R, FRONT_Z);
  const frontSpin = makeWheel(FRONT_R, 0.055);     // thin front, like the original
  frontSteer.add(frontSpin);
  content.add(frontSteer);
  const rearSpin = makeWheel(REAR_R, 0.105);       // fat rear
  rearSpin.position.set(0, REAR_R, REAR_Z);
  content.add(rearSpin);
  // The generated body's own wheels are CUT OUT in Blender
  // (tools/blender/cut_bike_wheels.py) precisely so these can exist: a fused
  // shell cannot spin its own wheels, and a bike with frozen wheels at 30 m/s
  // reads as broken. Mounted at the axle positions the cut measured.

  const wheels: THREE.Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(0, wheelR, i < 2 ? FRONT_Z : REAR_Z);
    pivot.add(new THREE.Group());   // the rig writes rotation into children[0]
    group.add(pivot);
    wheels.push(pivot);
  }

  // Carried ammo is modelled at car scale; on a bike a full-size warhead is as
  // long as the vehicle, so the whole mount shrinks and rides behind the seat.
  const loadout = buildLoadout(spec, 1.5, 1.05);
  loadout.group.scale.setScalar(0.55);
  chassis.add(loadout.group);

  const _t = new THREE.Vector3();
  return {
    group, wheels, wheelRadius: wheelR, chassis, loadout,
    wheelieNode, frontSteer, frontSpin, rearSpin,
    sawArm, sawBar, sawHand, idleArm, rider,
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
  };
}
