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

  const REAR_Z = 0.78, FRONT_Z = -1.12, wheelR = 0.42;
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
  sawArm.position.set(-0.36, 0.92, 0.12);    // at his left hand, hanging outboard
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
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc6cad2, roughness: 0.18, metalness: 1 });
  const makeWheel = (r: number, halfWidth: number) => {
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, halfWidth * 2, 22), rubber);
    tyre.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.46, r * 0.46, halfWidth * 2.1, 14), chrome);
    rim.rotation.z = Math.PI / 2;
    spin.add(tyre, rim);
    for (let k = 0; k < 6; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 1.5, r * 1.75, 0.025), chrome);
      spoke.rotation.x = (k / 6) * Math.PI;
      spin.add(spoke);
    }
    spin.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    return spin;
  };
  const frontSteer = new THREE.Group();
  frontSteer.position.set(0, wheelR, FRONT_Z);
  const frontSpin = makeWheel(wheelR * 0.98, 0.07);
  frontSteer.add(frontSpin);
  content.add(frontSteer);
  const rearSpin = makeWheel(wheelR, 0.115);
  rearSpin.position.set(0, wheelR, REAR_Z);
  content.add(rearSpin);
  // The generated body has its own wheels baked into the same fused shell, and
  // they are far better looking than these — spoked, photoreal. Drawing both
  // gives the vehicle FOUR wheels (the same trap phase 3.3 hit on the cars).
  // These stay in the tree so the interface and the rig are unchanged, but they
  // are only shown when the generated body failed to load.
  frontSteer.visible = !model;
  rearSpin.visible = !model;

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
