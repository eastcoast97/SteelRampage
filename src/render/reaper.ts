import * as THREE from 'three';
import type { CarSpec } from '../game/specs';
import { buildLoadout } from './loadout';
import type { CarMeshResult } from './carMesh';

/**
 * REAPER — a chopper with a bare-chested rider swinging a burning blade.
 *
 * Authored here rather than generated through the Higgsfield pipeline like the
 * other seven, for a reason that has nothing to do with looks: those bodies come
 * back as a single fused shell (41k verts, ONE connected component — see
 * tools/blender/cut_wheels.py), so nothing on them can be posed. This vehicle
 * needs an arm that drops a blade to the tarmac, holds it there, and then whips
 * forward. That has to be a rig.
 *
 * The first pass was boxes and it read as a Lego figure. The shapes here are
 * chosen to get the SILHOUETTE right at the distance you actually see other
 * vehicles from, which is what sells a bike: a long raked fork throwing the
 * front wheel way out, a fat rear tyre, a low tank, and a rider whose shoulders
 * are clearly wider than his waist. Lathes and tapered cylinders do that;
 * stacked boxes cannot.
 *
 * Named pivots the game drives:
 *   `sawArm`  — shoulder: drops the blade to the road, then whips it forward
 *   `sawBar`  — the blade; spins its teeth and carries the fire
 *   `rider`   — leans back as the front wheel comes up
 *   `setCharge(t)` — 0..1, how far the fire has climbed the blade
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
  rider: THREE.Object3D;
  /** world-space tip of the blade — the grind contact point */
  sawTip(out: THREE.Vector3): THREE.Vector3;
  /** 0..1 — friction heat, drives the fire on the blade and the rider's hair */
  setCharge(t: number): void;
}

/** a body segment that tapers: shoulders wide, waist narrow */
function taper(rTop: number, rBot: number, h: number, seg = 10): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
}

export function buildReaper(spec: CarSpec, colorOverride?: number): ReaperResult {
  const color = colorOverride ?? spec.color;
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  // The rig's body origin sits at suspension rest height (REST_LEN +
  // WHEEL_RADIUS ≈ 0.98), not on the road. This model is authored with y=0 at
  // the tarmac because that is the only frame in which "the blade touches the
  // road" is expressible, so the whole chassis drops by that much.
  chassis.position.y = -0.98;
  group.add(chassis);

  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.75 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc6cad2, roughness: 0.16, metalness: 1 });
  const black = new THREE.MeshStandardMaterial({ color: 0x121216, roughness: 0.55, metalness: 0.6 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.92, metalness: 0.05 });
  // deliberately dark and matte: the sunbaked preset runs bloom at strength 3.0
  // and a lighter skin blew out to cream plastic
  const skin = new THREE.MeshStandardMaterial({ color: 0x8a5a38, roughness: 0.92, metalness: 0 });
  const denim = new THREE.MeshStandardMaterial({ color: 0x3b4252, roughness: 0.9, metalness: 0.02 });
  const bone = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.6, metalness: 0.1 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8b8f98, roughness: 0.3, metalness: 0.95 });
  // fire on the hair and the blade — emissive so bloom catches it, and its
  // intensity doubles as the charge readout
  // base intensity is LOW: these sit at 1.4 and the sunbaked bloom turned every
  // flame into a white slab. The charge pushes it up instead.
  const fire = new THREE.MeshStandardMaterial({
    color: 0xff6a10, emissive: 0xff3c00, emissiveIntensity: 0.45,
    roughness: 0.5, transparent: true, opacity: 0.85,
  });
  const fireCore = new THREE.MeshBasicMaterial({
    color: 0xffc050, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const put = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material,
               x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  // ---------------------------------------------------------------- chopper
  // Everything that leaves the ground on a wheelie hangs off this node, whose
  // pivot is the REAR AXLE — rotate it and the nose comes up while the back
  // wheel stays exactly where it is, which is what a wheelie is.
  const REAR_Z = 0.78, FRONT_Z = -1.1, wheelR = 0.42;
  const wheelieNode = new THREE.Group();
  wheelieNode.position.set(0, wheelR, REAR_Z);
  chassis.add(wheelieNode);
  const content = new THREE.Group();
  content.position.set(0, -wheelR, -REAR_Z);   // undo the pivot, so children keep tarmac coords
  wheelieNode.add(content);

  const bike = new THREE.Group();
  content.add(bike);

  const backbone = put(bike, taper(0.055, 0.075, 1.25, 8), black, 0, 0.62, 0.05);
  backbone.rotation.x = Math.PI / 2 - 0.12;
  const downtube = put(bike, taper(0.05, 0.06, 0.95, 8), black, 0, 0.5, -0.5);
  downtube.rotation.x = 0.55;

  // V-twin — the visual centre of mass of any chopper
  for (const lean of [-0.42, 0.42]) {
    const jug = put(bike, taper(0.11, 0.13, 0.34, 10), steel, 0, 0.5, 0.06 + lean * 0.22);
    jug.rotation.x = lean;
    for (let f = 0; f < 4; f++) {
      const fin = put(bike, new THREE.BoxGeometry(0.26, 0.015, 0.26), chrome,
        0, 0.42 + f * 0.075, 0.06 + lean * 0.22 - (f * 0.075) * Math.tan(lean));
      fin.rotation.x = lean;
    }
  }
  put(bike, new THREE.BoxGeometry(0.3, 0.24, 0.34), black, 0, 0.33, 0.12);

  // teardrop tank, lathed so it reads as a tank rather than a crate
  const tankPts: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    tankPts.push(new THREE.Vector2(Math.sin(t * Math.PI) * 0.17 + 0.005, -0.33 + t * 0.66));
  }
  const tank = put(bike, new THREE.LatheGeometry(tankPts, 14), paint, 0, 0.78, -0.12);
  tank.rotation.x = Math.PI / 2;
  tank.scale.set(1, 1, 0.78);

  const seat = put(bike, taper(0.13, 0.1, 0.42, 8), black, 0, 0.7, 0.4);
  seat.rotation.set(Math.PI / 2 - 0.08, 0, 0);
  seat.scale.set(1, 1, 0.55);
  for (const sx of [-1, 1]) {
    const sissy = put(bike, taper(0.02, 0.02, 0.5, 6), chrome, sx * 0.1, 0.88, 0.72);
    sissy.rotation.x = -0.25;
  }
  put(bike, new THREE.TorusGeometry(0.1, 0.02, 6, 14), chrome, 0, 1.11, 0.66).rotation.x = 0.3;

  // RAKE: long forks throwing the front wheel out front. This is most of what
  // makes the silhouette read as a chopper and not a commuter bike.
  const FORK_LEN = 1.25, RAKE = 0.62;
  for (const sx of [-1, 1]) {
    const fork = put(bike, taper(0.035, 0.045, FORK_LEN, 8), chrome, sx * 0.13, 0.72, -0.82);
    fork.rotation.x = RAKE;
  }
  put(bike, taper(0.07, 0.07, 0.22, 10), black, 0, 1.0, -0.5).rotation.x = RAKE;

  // skull nacelle with horns, straight off the reference
  const skull = put(bike, new THREE.SphereGeometry(0.15, 12, 10), bone, 0, 1.0, -0.66);
  skull.scale.set(0.85, 1, 1.15);
  for (const sx of [-1, 1]) {
    put(bike, new THREE.SphereGeometry(0.05, 8, 6), black, sx * 0.06, 1.03, -0.78);
    const horn = put(bike, new THREE.ConeGeometry(0.045, 0.3, 7), paint, sx * 0.12, 1.1, -0.6);
    horn.rotation.set(-0.5, 0, -sx * 0.5);
  }
  put(bike, new THREE.CircleGeometry(0.07, 12),
    new THREE.MeshBasicMaterial({ color: 0xfff0c0 }), 0, 0.93, -0.8).rotation.y = Math.PI;

  const bars = put(bike, taper(0.022, 0.022, 0.64, 8), black, 0, 1.12, -0.56);
  bars.rotation.z = Math.PI / 2;
  for (const sx of [-1, 1]) {
    put(bike, taper(0.03, 0.03, 0.12, 8), black, sx * 0.27, 1.12, -0.56).rotation.z = Math.PI / 2;
  }

  for (const dz of [0, 0.1]) {
    const pipe = put(bike, taper(0.045, 0.058, 1.15, 8), chrome, 0.2 + dz * 0.3, 0.36 + dz * 0.1, 0.18);
    pipe.rotation.set(Math.PI / 2 - 0.1, 0.08, 0);
  }

  // ---------------------------------------------------------------- rider
  const rider = new THREE.Group();
  rider.position.set(0, 0.74, 0.3);
  content.add(rider);

  put(rider, taper(0.17, 0.13, 0.26, 10), skin, 0, 0.12, -0.02);        // waist
  const chest = put(rider, taper(0.2, 0.17, 0.3, 10), skin, 0, 0.36, -0.07);
  chest.rotation.x = -0.3;
  chest.scale.set(1.15, 1, 0.8);
  for (const sx of [-1, 1]) {
    put(rider, new THREE.SphereGeometry(0.085, 10, 8), skin, sx * 0.085, 0.45, -0.16)
      .scale.set(1, 0.8, 0.6);                                           // pec
    put(rider, new THREE.SphereGeometry(0.095, 10, 8), skin, sx * 0.21, 0.5, -0.09);  // deltoid
  }
  for (let i = 0; i < 3; i++) {
    put(rider, new THREE.BoxGeometry(0.17, 0.05, 0.03), skin, 0, 0.3 - i * 0.07, -0.19 + i * 0.015);
  }

  const head = put(rider, new THREE.SphereGeometry(0.105, 12, 10), skin, 0, 0.67, -0.17);
  head.scale.set(0.95, 1.1, 1);
  put(rider, new THREE.BoxGeometry(0.13, 0.07, 0.1), skin, 0, 0.61, -0.21);
  put(rider, new THREE.BoxGeometry(0.17, 0.05, 0.02), black, 0, 0.69, -0.26);
  const hairFlames: THREE.Mesh[] = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const h = 0.15 + ((i * 37) % 11) / 90;
    const f = put(rider, new THREE.ConeGeometry(0.026, h, 6), fire,
      Math.cos(a) * 0.05, 0.75 + h * 0.3, -0.15 + Math.sin(a) * 0.045);
    // raked back over the shoulders — flame streaming off a rider at speed,
    // not a crown standing straight up
    f.rotation.set(-1.0 + Math.sin(a) * 0.35, 0, Math.cos(a) * 0.3);
    hairFlames.push(f);
  }

  // legs forward onto the pegs, chopper style
  for (const sx of [-1, 1]) {
    const thigh = put(rider, taper(0.085, 0.07, 0.46, 8), denim, sx * 0.13, 0.02, -0.2);
    thigh.rotation.set(Math.PI / 2 - 0.22, 0, 0);
    const shin = put(rider, taper(0.065, 0.055, 0.42, 8), denim, sx * 0.145, -0.16, -0.42);
    shin.rotation.set(Math.PI / 2 + 0.55, 0, 0);
    put(rider, new THREE.BoxGeometry(0.09, 0.07, 0.19), black, sx * 0.15, -0.34, -0.55);
  }

  const armL = put(rider, taper(0.055, 0.05, 0.4, 8), skin, -0.22, 0.42, -0.34);
  armL.rotation.set(Math.PI / 2 - 0.45, 0, -0.25);
  const foreL = put(rider, taper(0.05, 0.044, 0.34, 8), skin, -0.25, 0.3, -0.56);
  foreL.rotation.set(Math.PI / 2 - 0.1, 0, -0.1);
  put(rider, new THREE.SphereGeometry(0.05, 8, 6), black, -0.26, 0.26, -0.7);

  // ---------------------------------------------------------------- the saw
  const sawArm = new THREE.Group();
  sawArm.position.set(-0.22, 0.48, -0.1);     // LEFT shoulder
  rider.add(sawArm);
  const armS = put(sawArm, taper(0.055, 0.05, 0.38, 8), skin, -0.04, -0.1, -0.1);
  armS.rotation.set(Math.PI / 2 - 0.3, 0, -0.2);
  const foreS = put(sawArm, taper(0.05, 0.045, 0.32, 8), skin, -0.07, -0.26, -0.26);
  foreS.rotation.set(Math.PI / 2 - 0.1, 0, -0.1);

  const sawBar = new THREE.Group();
  sawBar.position.set(-0.08, -0.36, -0.42);
  sawArm.add(sawBar);
  put(sawBar, new THREE.BoxGeometry(0.13, 0.17, 0.3), black, 0, 0, 0.14);
  put(sawBar, taper(0.035, 0.035, 0.2, 8), chrome, 0, 0.1, 0.1).rotation.z = Math.PI / 2;
  put(sawBar, new THREE.BoxGeometry(0.1, 0.09, 0.16), black, 0, -0.02, -0.06);
  // a LONG bar — in the reference the blade is nearly as long as the bike
  const BLADE = 1.45;
  put(sawBar, new THREE.BoxGeometry(0.045, 0.15, BLADE), steel, 0, 0, -0.14 - BLADE / 2);
  put(sawBar, new THREE.ConeGeometry(0.075, 0.2, 4), steel, 0, 0, -0.14 - BLADE - 0.08)
    .rotation.set(Math.PI / 2, 0, Math.PI / 4);
  for (let i = 0; i < 20; i++) {
    const z = -0.2 - (i / 19) * (BLADE - 0.1);
    for (const sy of [-1, 1]) {
      const tooth = put(sawBar, new THREE.BoxGeometry(0.06, 0.045, 0.045), chrome, 0, sy * 0.095, z);
      tooth.rotation.x = sy * 0.45;
    }
  }
  // the fire the friction builds — a sheath that grows down the blade with charge
  // The mesh carries only a THIN glow hugging the steel. A big flame cone was
  // tried twice — as a box it read as a plank, as a cone it read as a horn —
  // because a smooth solid has no ragged edge and fire is nothing but ragged
  // edge. The actual flames are particles, emitted along the bar from game.render
  // using the same fire flipbook as the flamethrower, which already looks right.
  const flameSheath = put(sawBar, new THREE.BoxGeometry(0.07, 0.19, BLADE * 0.98), fire,
    0, 0, -0.14 - BLADE / 2);
  const flameCore = put(sawBar, new THREE.BoxGeometry(0.05, 0.13, BLADE), fireCore,
    0, 0, -0.14 - BLADE / 2);
  flameSheath.visible = false;
  flameCore.visible = false;

  const tip = new THREE.Object3D();
  tip.position.set(0, -0.07, -0.14 - BLADE);
  sawBar.add(tip);

  sawArm.rotation.set(-0.6, -0.95, 0.15);     // held out to his LEFT, levelled

  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });

  // ---------------------------------------------------------------- wheels
  // The visible wheels are OURS, inside `content`, so they pitch with the bike
  // on a wheelie. The rig's four pivots still exist — vehicle.syncVisual writes
  // suspension travel and steering into them every frame — but they draw
  // nothing, because a bike has two wheels and they have to lift with the body.
  // Suspension travel is not shown; on a bike at arcade scale nobody misses it.
  const makeWheel = (r: number, halfWidth: number) => {
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, halfWidth * 2, 20), rubber);
    tyre.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, halfWidth * 2.1, 12), chrome);
    rim.rotation.z = Math.PI / 2;
    spin.add(tyre, rim);
    for (let k = 0; k < 5; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 1.6, r * 1.7, 0.03), chrome);
      spoke.rotation.x = (k / 5) * Math.PI;
      spin.add(spoke);
    }
    spin.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    return spin;
  };
  const frontSteer = new THREE.Group();
  frontSteer.position.set(0, wheelR, FRONT_Z);
  const frontSpin = makeWheel(wheelR * 0.98, 0.075);
  frontSteer.add(frontSpin);
  content.add(frontSteer);
  const rearSpin = makeWheel(wheelR, 0.115);
  rearSpin.position.set(0, wheelR, REAR_Z);
  content.add(rearSpin);

  const wheels: THREE.Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(0, wheelR, i < 2 ? FRONT_Z : REAR_Z);
    pivot.add(new THREE.Group());     // the rig writes rotation into children[0]
    group.add(pivot);
    wheels.push(pivot);
  }

  // Carried ammo is modelled at car scale; on a bike a full-size warhead is as
  // long as the vehicle, so the whole mount shrinks and rides the sissy bar.
  const loadout = buildLoadout(spec, 1.5, 1.05);
  loadout.group.scale.setScalar(0.55);
  chassis.add(loadout.group);

  const _t = new THREE.Vector3();
  return {
    group, wheels, wheelRadius: wheelR, chassis, loadout,
    wheelieNode, frontSteer, frontSpin, rearSpin,
    sawArm, sawBar, rider,
    sawTip: (out) => { tip.getWorldPosition(_t); return out.copy(_t); },
    setCharge: (t) => {
      const lit = t > 0.02;
      flameSheath.visible = lit;
      flameCore.visible = lit;
      if (lit) {
        // the fire climbs the blade as friction builds, so the bar IS the charge
        // meter — you can read an opponent's REAPER without any HUD
        // the glow creeps DOWN the bar from the handle as the heat builds, so
        // the blade itself is the charge meter — you can read an enemy REAPER
        // without any HUD at all
        flameSheath.scale.set(1, 1, 0.12 + t * 0.9);
        flameCore.scale.set(1, 1, 0.1 + t * 0.9);
        flameSheath.position.z = -0.14 - (BLADE * (0.12 + t * 0.9)) / 2;
        flameCore.position.z = flameSheath.position.z;
        (flameSheath.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5 + t * 1.9;
      }
      fire.emissiveIntensity = 1.1 + t * 1.6;    // the hair burns harder too
      for (const f of hairFlames) f.scale.setScalar(0.9 + t * 0.5);
    },
  };
}
