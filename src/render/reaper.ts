import * as THREE from 'three';
import type { CarSpec } from '../game/specs';
import { buildLoadout } from './loadout';
import type { CarMeshResult } from './carMesh';

/**
 * REAPER — a bike with a rider swinging a chainsaw.
 *
 * Built from primitives rather than generated through the Higgsfield pipeline
 * like the other eight, and that is deliberate: the AI meshes arrive as a single
 * fused shell (see tools/blender/cut_wheels.py — 41k verts, ONE connected
 * component), so nothing on them can be posed. This vehicle needs a rider who
 * leans, and a saw that drops to the road to grind and then swings through an
 * arc to slam. Those have to be separate nodes with their own pivots, so the
 * model is authored here where they can be.
 *
 * Named pivots the game drives:
 *   `sawArm`  — rotates down to grind, swings across to slam
 *   `sawBar`  — the blade itself; its tip is where sparks are emitted
 *   `rider`   — leans forward under power, back on the wheelie
 */

export interface ReaperResult extends CarMeshResult {
  sawArm: THREE.Object3D;
  sawBar: THREE.Object3D;
  rider: THREE.Object3D;
  /** world-space tip of the blade — the grind contact point */
  sawTip(out: THREE.Vector3): THREE.Vector3;
}

export function buildReaper(spec: CarSpec, colorOverride?: number): ReaperResult {
  const color = colorOverride ?? spec.color;
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  // The rig's body origin sits at the suspension rest height (REST_LEN +
  // WHEEL_RADIUS), not on the road — measured at 0.98 for every build. This
  // model is authored with y=0 at the tarmac because that is the only frame in
  // which "the blade touches the road" is expressible, so the whole chassis
  // drops by that amount. Without it the bike floats a metre in the air.
  chassis.position.y = -0.98;
  group.add(chassis);

  const frameMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.7 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.22, metalness: 0.95 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.65, metalness: 0.4 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: spec.accent, emissive: spec.accent, emissiveIntensity: 0.45, roughness: 0.45, metalness: 0.3,
  });
  const leatherMat = new THREE.MeshStandardMaterial({ color: 0x2a2228, roughness: 0.85, metalness: 0.05 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc89a74, roughness: 0.8, metalness: 0 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xd8dce4, roughness: 0.25, metalness: 0.95 });

  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material,
               x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  // --- frame: a spine from the headstock back to the tail, engine slung under
  const spine = add(chassis, new THREE.BoxGeometry(0.16, 0.14, 1.5), frameMat, 0, 0.5, 0);
  spine.rotation.x = -0.06;
  add(chassis, new THREE.BoxGeometry(0.3, 0.3, 0.46), darkMat, 0, 0.36, 0.05);        // engine block
  add(chassis, new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), chromeMat, 0.14, 0.3, 0.42).rotation.z = Math.PI / 2;
  // tank + seat
  const tank = add(chassis, new THREE.SphereGeometry(0.2, 12, 8), frameMat, 0, 0.66, -0.16);
  tank.scale.set(1, 0.72, 1.7);
  const seat = add(chassis, new THREE.BoxGeometry(0.22, 0.09, 0.5), leatherMat, 0, 0.64, 0.34);
  seat.rotation.x = -0.1;
  // tail + plate
  add(chassis, new THREE.BoxGeometry(0.26, 0.07, 0.3), darkMat, 0, 0.6, 0.66);
  add(chassis, new THREE.BoxGeometry(0.2, 0.14, 0.02), accentMat, 0, 0.47, 0.8);
  // exhausts
  for (const sx of [-1, 1]) {
    const pipe = add(chassis, new THREE.CylinderGeometry(0.055, 0.07, 0.8, 8), chromeMat, sx * 0.17, 0.33, 0.3);
    pipe.rotation.x = Math.PI / 2 - 0.08;
  }
  // forks + bars
  const forks = add(chassis, new THREE.CylinderGeometry(0.045, 0.045, 0.78, 8), chromeMat, 0, 0.5, -0.62);
  forks.rotation.x = 0.42;
  const bars = add(chassis, new THREE.CylinderGeometry(0.03, 0.03, 0.56, 8), darkMat, 0, 0.78, -0.52);
  bars.rotation.z = Math.PI / 2;
  // headlamp
  const lamp = add(chassis, new THREE.SphereGeometry(0.11, 10, 8), chromeMat, 0, 0.72, -0.68);
  lamp.scale.z = 0.5;
  add(chassis, new THREE.CircleGeometry(0.09, 12),
    new THREE.MeshBasicMaterial({ color: 0xfff2cc }), 0, 0.72, -0.73);

  // --- rider: hunched forward, knees up. Blocky on purpose — it matches the
  // kit-bashed look of the car weapons rather than fighting it.
  const rider = new THREE.Group();
  rider.position.set(0, 0.62, 0.18);
  chassis.add(rider);
  const torso = add(rider, new THREE.BoxGeometry(0.3, 0.42, 0.24), leatherMat, 0, 0.22, -0.06);
  torso.rotation.x = -0.38;
  add(rider, new THREE.BoxGeometry(0.34, 0.1, 0.26), accentMat, 0, 0.1, -0.02);        // harness
  const head = add(rider, new THREE.SphereGeometry(0.13, 12, 10), darkMat, 0, 0.52, -0.16);
  head.scale.set(1, 1.05, 1.1);
  add(rider, new THREE.BoxGeometry(0.2, 0.07, 0.03),
    new THREE.MeshBasicMaterial({ color: 0xff5a1a }), 0, 0.52, -0.27);                 // visor
  // a ragged mane out the back of the helmet — "funky", and it reads at speed
  for (let i = 0; i < 5; i++) {
    const t = (i - 2) / 2;
    const hair = add(rider, new THREE.BoxGeometry(0.04, 0.05, 0.26), accentMat,
      t * 0.08, 0.54 + Math.abs(t) * -0.03, 0.0);
    hair.rotation.x = -0.5 + Math.abs(t) * 0.2;
    hair.rotation.z = t * 0.4;
  }
  // legs tucked
  for (const sx of [-1, 1]) {
    const thigh = add(rider, new THREE.BoxGeometry(0.11, 0.1, 0.34), leatherMat, sx * 0.14, 0.0, -0.08);
    thigh.rotation.x = 0.35;
    const shin = add(rider, new THREE.BoxGeometry(0.1, 0.26, 0.1), leatherMat, sx * 0.15, -0.16, -0.22);
    shin.rotation.x = -0.25;
    void shin;
    void thigh;
  }
  // left arm stays on the bars
  const armL = add(rider, new THREE.BoxGeometry(0.09, 0.09, 0.42), leatherMat, -0.17, 0.26, -0.3);
  armL.rotation.x = 0.5;
  add(rider, new THREE.SphereGeometry(0.055, 8, 6), skinMat, -0.2, 0.17, -0.47);

  // --- the saw, on its own pivot so it can drop to the road and swing
  const sawArm = new THREE.Group();
  // pivot at the rider's right shoulder
  sawArm.position.set(0.19, 0.26, -0.04);
  rider.add(sawArm);
  const armR = add(sawArm, new THREE.BoxGeometry(0.09, 0.09, 0.4), leatherMat, 0.02, -0.02, -0.16);
  armR.rotation.x = 0.3;
  void armR;

  const sawBar = new THREE.Group();
  sawBar.position.set(0.06, -0.06, -0.3);
  sawArm.add(sawBar);
  // engine housing
  add(sawBar, new THREE.BoxGeometry(0.16, 0.2, 0.26), darkMat, 0, 0, 0.08);
  add(sawBar, new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8), chromeMat, 0, 0.1, 0.06).rotation.z = Math.PI / 2;
  // the bar: long, flat, pointing forward
  const bar = add(sawBar, new THREE.BoxGeometry(0.055, 0.17, 1.15), bladeMat, 0, 0, -0.62);
  void bar;
  // teeth down both edges — crude, but they catch the light and read as a chain
  for (let i = 0; i < 16; i++) {
    const z = -0.1 - (i / 15) * 1.05;
    for (const sy of [-1, 1]) {
      const tooth = add(sawBar, new THREE.BoxGeometry(0.07, 0.05, 0.05), chromeMat, 0, sy * 0.105, z);
      tooth.rotation.x = sy * 0.4;
    }
  }
  // tip marker: an empty at the far end, so the grind sparks come off the point
  // that is actually touching the road rather than the blade's centre
  const tip = new THREE.Object3D();
  tip.position.set(0, -0.09, -1.2);
  sawBar.add(tip);

  // resting pose: carried high and angled across the bike
  sawArm.rotation.set(-0.5, 0, -0.5);

  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = false; } });

  // --- wheels on the normal steer/spin rig ---
  // The rig drives FOUR pivots and, critically, does `children[0].rotation.set(spin,0,0)`
  // every frame — so the tyre cannot live directly under the pivot with its own
  // axis rotation, or that rotation is wiped and the wheel renders as a flat
  // disc lying in the road. The tyre goes inside a SPINNER group instead, which
  // is what the rig actually turns.
  //
  // A bike has two wheels, so the second pair of pivots gets an empty spinner:
  // the suspension still solves per-corner (which is what keeps the arcade model
  // upright) while only two tyres are drawn.
  const wheelR = 0.33;
  const tyreGeo = new THREE.CylinderGeometry(wheelR, wheelR, 0.17, 18);
  const rimGeo = new THREE.CylinderGeometry(wheelR * 0.42, wheelR * 0.42, 0.19, 10);
  const spokeGeo = new THREE.BoxGeometry(0.035, wheelR * 1.55, 0.04);
  const wheels: THREE.Object3D[] = [];
  const corners: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  corners.forEach(([sx, sz], i) => {
    const pivot = new THREE.Group();
    pivot.position.set(0, wheelR, sz * 0.62);
    const spinner = new THREE.Group();
    pivot.add(spinner);
    // sx < 0 draws the tyre; the duplicate on the same axle stays empty
    if (sx < 0) {
      const tyre = new THREE.Mesh(tyreGeo, darkMat);
      tyre.rotation.z = Math.PI / 2;
      const rim = new THREE.Mesh(rimGeo, chromeMat);
      rim.rotation.z = Math.PI / 2;
      spinner.add(tyre, rim);
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.Mesh(spokeGeo, chromeMat);
        spoke.rotation.x = (k / 3) * Math.PI;
        spinner.add(spoke);
      }
      spinner.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    }
    void i;
    group.add(pivot);
    wheels.push(pivot);
  });

  const loadout = buildLoadout(spec, 1.25, 0.85);
  loadout.group.scale.setScalar(0.62);
  chassis.add(loadout.group);

  const _t = new THREE.Vector3();
  return {
    group, wheels, wheelRadius: wheelR, chassis, loadout,
    sawArm, sawBar, rider,
    sawTip: (out) => { tip.getWorldPosition(_t); return out.copy(_t); },
  };
}
