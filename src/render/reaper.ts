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
  /** where the bar leaves the engine — fire runs from here to the tip */
  sawRoot(out: THREE.Vector3): THREE.Vector3;
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

interface SawFit {
  /** model -> sawBar rotation, already carrying the normalising scale */
  basis: THREE.Matrix4;
  scale: number;
  /** the hand position, in the rotated+scaled frame */
  grip: THREE.Vector3;
  /** bar ends, RELATIVE TO THE GRIP (i.e. already in sawBar space) */
  tip: THREE.Vector3;
  root: THREE.Vector3;
}

/**
 * Work out how a generated chainsaw is actually built, so the rider can hold it
 * by the handle.
 *
 * None of this is inferable from a bounding box, which is what the first version
 * tried: it laid the longest axis down -Z and slid the mesh back by 45% of its
 * length, which happened to point the ENGINE forward and leave the pivot in the
 * middle of the cutting bar. The model is generated, so its axes, its facing and
 * even its length axis can change on any regeneration — everything here is
 * measured from the vertices instead.
 *
 * The three facts that make it work:
 *  - the BAR is the thin end. A chainsaw's cross-section is tiny along the bar
 *    and large across the engine, so binning the cross-sectional area along the
 *    length axis tells you which end is which (measured 0.011 vs 0.38).
 *  - UP is the sparse side. The handles are thin tubes and the engine and tank
 *    are a solid block, so the extreme band with FEWER vertices is the top.
 *  - the GRIP is the top handle: the thin structure in the top band, over the
 *    engine rather than over the bar.
 */
function fitSaw(saw: THREE.Object3D, targetLen: number): SawFit {
  saw.updateMatrixWorld(true);
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  saw.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      pts.push(v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).clone());
    }
  });

  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());
  const ax: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  const sz = [size.x, size.y, size.z];
  const L = sz.indexOf(Math.max(...sz));
  const [A0, A1] = [0, 1, 2].filter((a) => a !== L);
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  const at = (p: THREE.Vector3, a: number) => p[ax[a]];
  const span = Math.max(1e-6, sz[L]);

  // cross-section area along the length axis
  const N = 10;
  const bins = [...Array(N)].map(() => ({ n: 0, mn: [1e9, 1e9], mx: [-1e9, -1e9] }));
  for (const p of pts) {
    const k = Math.min(N - 1, Math.max(0, Math.floor(((at(p, L) - lo[L]) / span) * N)));
    const b = bins[k];
    b.n++;
    for (let j = 0; j < 2; j++) {
      const c = at(p, j === 0 ? A0 : A1);
      if (c < b.mn[j]) b.mn[j] = c;
      if (c > b.mx[j]) b.mx[j] = c;
    }
  }
  const area = bins.map((b) => (b.n ? (b.mx[0] - b.mn[0]) * (b.mx[1] - b.mn[1]) : 0));
  const headArea = (area[0] + area[1]) / 2, tailArea = (area[N - 1] + area[N - 2]) / 2;
  const barAtMin = headArea < tailArea;              // the thin end is the bar
  const barDirL = barAtMin ? -1 : 1;

  // UP: of the two cross axes, the one the bar is TALL in (a bar is tall and
  // thin), and the sign that points at the sparse, handle-bearing side.
  const barZone = pts.filter((p) => {
    const t = (at(p, L) - lo[L]) / span;
    return barAtMin ? t < 0.25 : t > 0.75;
  });
  const ext = (list: THREE.Vector3[], a: number) => {
    let mn = 1e9, mx = -1e9;
    for (const p of list) { const c = at(p, a); if (c < mn) mn = c; if (c > mx) mx = c; }
    return [mn, mx] as const;
  };
  const e0 = ext(barZone, A0), e1 = ext(barZone, A1);
  const U = (e0[1] - e0[0]) >= (e1[1] - e1[0]) ? A0 : A1;
  const W = U === A0 ? A1 : A0;
  // engine half = everything past the bar
  const engine = pts.filter((p) => {
    const t = (at(p, L) - lo[L]) / span;
    return barAtMin ? t > 0.45 : t < 0.55;
  });
  const uRange = Math.max(1e-6, hi[U] - lo[U]);
  const bandN = (sign: number) =>
    engine.filter((p) => (sign > 0 ? at(p, U) > hi[U] - 0.15 * uRange
                                   : at(p, U) < lo[U] + 0.15 * uRange)).length;
  const upSign = bandN(1) <= bandN(-1) ? 1 : -1;     // thin tubes up, solid block down

  // GRIP: the REAR HANDLE — the trigger loop at the very back.
  //
  // The top handle was tried first and is wrong for this vehicle in two ways.
  // It sits near the middle of the saw, so he only reaches 0.70m past his fist,
  // and the grind is specified as dragging the bar on the tarmac: measured
  // against the rig (shoulder 1.71m, arm reach 0.42m) the lowest the tip could
  // ever get was 0.68m ABOVE the road, with the whole arm and a full body lean
  // optimised for it. Off the rear handle the reach is 1.06m and the bar makes
  // the road. It is also how a chainsaw is actually held one-handed — that loop
  // carries the throttle, and the hand goes THROUGH it, which is why its
  // centroid is the right point rather than a surface.
  //
  // Found the same way as the bar: walk in from the far end while the section
  // stays thin. The handle is a tube, the engine behind it is a block.
  const maxArea = Math.max(...area);
  let handL = barAtMin ? hi[L] : lo[L];
  for (let i = 0; i < N; i++) {
    const k = barAtMin ? N - 1 - i : i;
    if (area[k] > maxArea * 0.35) { handL = lo[L] + ((k + (barAtMin ? 1 : 0)) / N) * span; break; }
  }
  const rearBand = engine.filter((p) => barAtMin ? at(p, L) > handL : at(p, L) < handL);
  // fall back to the top handle if this saw has no rear loop to speak of
  const topBand = engine.filter((p) => upSign > 0 ? at(p, U) > hi[U] - 0.28 * uRange
                                                  : at(p, U) < lo[U] + 0.28 * uRange);
  const pool = rearBand.length > 40 ? rearBand : (topBand.length ? topBand : engine);
  const grip = new THREE.Vector3();
  for (const p of pool) grip.add(p);
  grip.multiplyScalar(1 / Math.max(1, pool.length));

  // BAR line: the extreme along the bar direction, on the bar's own cross-centre
  const barU = (ext(barZone, U)[0] + ext(barZone, U)[1]) / 2;
  const barW = (ext(barZone, W)[0] + ext(barZone, W)[1]) / 2;
  const tipL = barAtMin ? lo[L] : hi[L];
  // the root is where the section stops being a bar
  let rootL = tipL;
  const barArea = Math.max(1e-9, barAtMin ? headArea : tailArea);
  for (let i = 0; i < N; i++) {
    const k = barAtMin ? i : N - 1 - i;
    if (area[k] > barArea * 2.5) { rootL = lo[L] + ((k + (barAtMin ? 0 : 1)) / N) * span; break; }
  }
  const mk = (l: number) => {
    const p = new THREE.Vector3();
    p[ax[L]] = l; p[ax[U]] = barU; p[ax[W]] = barW;
    return p;
  };
  const tip = mk(tipL), root = mk(rootL);

  // model -> sawBar: the bar runs down -Z and the saw's own up becomes +Y
  const f = new THREE.Vector3(); f[ax[L]] = barDirL;
  const u = new THREE.Vector3(); u[ax[U]] = upSign;
  const zT = f.clone().negate();
  const yT = u.clone().sub(zT.clone().multiplyScalar(u.dot(zT))).normalize();
  const xT = new THREE.Vector3().crossVectors(yT, zT);
  const scale = targetLen / span;
  const rot = new THREE.Matrix4().set(
    xT.x, xT.y, xT.z, 0,
    yT.x, yT.y, yT.z, 0,
    zT.x, zT.y, zT.z, 0,
    0, 0, 0, 1,
  );
  // every measured point goes through the SAME transform the mesh will get
  const into = (p: THREE.Vector3) => p.clone().applyMatrix4(rot).multiplyScalar(scale);
  const gripT = into(grip), tipT = into(tip), rootT = into(root);
  const basis = rot.clone().scale(new THREE.Vector3(scale, scale, scale));
  return { basis, scale, grip: gripT, tip: tipT.sub(gripT), root: rootT.sub(gripT) };
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
  // Total length, nose of the bar to the back of the rear handle. Held by the
  // TOP HANDLE the usable reach is only about 0.63 of this (the hand sits over
  // the engine, not on the end), which is what the grind pose has to work with.
  const SAW_LEN = 1.35;
  let sawMesh: THREE.Object3D | null = null;
  const sawRestPos = new THREE.Vector3();
  const sawRestRot = new THREE.Euler();
  const sawRestScale = new THREE.Vector3(1, 1, 1);
  // bar geometry in sawBar space, filled in by the fit below; the fallbacks are
  // only ever used if the model is missing
  const barTip = new THREE.Vector3(0, 0, -SAW_LEN * 0.5);
  const barRoot = new THREE.Vector3(0, 0, -SAW_LEN * 0.15);
  const sawSrc = getSawModel();
  if (sawSrc) {
    const saw = sawSrc.clone(true);
    const fit = fitSaw(saw, SAW_LEN);
    // The hand goes on the TOP HANDLE and the bar points away down -Z. Both used
    // to be guessed: the old code laid the longest axis down -Z and slid the mesh
    // back by a fraction of its length, which on this model put the ENGINE
    // forward and the pivot in the middle of the blade — he gripped the cutting
    // edge. Neither end of a chainsaw is identifiable from a bounding box, so
    // both are measured (see fitSaw).
    saw.applyMatrix4(fit.basis);     // carries the normalising scale
    saw.position.sub(fit.grip);      // the hand ends up at the pivot
    saw.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    sawBar.add(saw);
    sawMesh = saw;
    sawRestPos.copy(saw.position);
    sawRestRot.copy(saw.rotation);
    sawRestScale.copy(saw.scale);
    barTip.copy(fit.tip);
    barRoot.copy(fit.root);
  }

  // Fire on the bar: a thin emissive core whose LENGTH tracks the charge, so the
  // bar reads as its own meter. The flames are particles (effects.bladeFire) —
  // a solid flame mesh has no ragged edge, and fire is nothing but ragged edge.
  const fire = new THREE.MeshStandardMaterial({
    color: 0xff6a10, emissive: 0xff3c00, emissiveIntensity: 0.45,
    roughness: 0.5, transparent: true, opacity: 0.85,
  });
  // The sheath lies ALONG THE REAL BAR, not along the pivot's -Z. The bar hangs
  // below and outboard of the hand, so an axis-aligned box at the origin floated
  // in the air beside the saw.
  const barLen = Math.max(0.05, barTip.distanceTo(barRoot));
  const barAxis = barTip.clone().sub(barRoot).normalize();
  const flameSheath = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.17, barLen), fire);
  flameSheath.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), barAxis);
  flameSheath.visible = false;
  sawBar.add(flameSheath);
  const tip = new THREE.Object3D();
  tip.position.copy(barTip);
  sawBar.add(tip);
  const root = new THREE.Object3D();
  root.position.copy(barRoot);
  sawBar.add(root);

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
    sawRoot: (out) => { root.getWorldPosition(_t); return out.copy(_t); },
    setCharge: (t) => {
      const lit = t > 0.02;
      flameSheath.visible = lit;
      if (lit) {
        // grows from the bar's ROOT toward its TIP along the bar's own line —
        // the bar hangs below and outboard of the hand, so anything measured
        // from the pivot's -Z burns in mid-air beside the saw
        const f = 0.12 + t * 0.9;
        flameSheath.scale.set(1, 1, f);
        flameSheath.position.copy(barRoot).addScaledVector(barAxis, (barLen * f) / 2);
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
