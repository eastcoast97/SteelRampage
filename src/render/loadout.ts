import * as THREE from 'three';
import type { CarSpec } from '../game/specs';
import { buildRocket } from './rocket';

/**
 * Visible ammunition carried on the car.
 *
 * Missiles sit on a rack behind the cab and leave it when fired; mines cling to
 * the rear bumper and drop off when deployed. Both exist so the ammo counters in
 * the corner of the HUD are not the only way to know what you are carrying —
 * you can see your own loadout, and so can the player behind you.
 *
 * These are decorative only: no colliders, and the authoritative counts stay on
 * the Vehicle. `sync()` just shows or hides the right number of mounts, so it is
 * cheap enough to call every frame and correct no matter how the count changed
 * (pickup, fire, respawn, or a network snapshot).
 */

export const MAX_MOUNTED_MISSILES = 3;
export const MAX_MOUNTED_MINES = 6;

export interface Loadout {
  group: THREE.Group;
  missiles: THREE.Object3D[];
  mines: THREE.Object3D[];
  /** world position of the next missile to leave the rack */
  missileMuzzle(index: number, out: THREE.Vector3): THREE.Vector3;
  /** world position of the next mine to fall off the bumper */
  mineAnchor(index: number, out: THREE.Vector3): THREE.Vector3;
  sync(missiles: number, mines: number): void;
}

const railMat = new THREE.MeshStandardMaterial({ color: 0x3a3742, roughness: 0.65, metalness: 0.55 });
const mineShell = new THREE.MeshStandardMaterial({ color: 0x2a2730, roughness: 0.6, metalness: 0.45 });
const mineLight = new THREE.MeshStandardMaterial({
  color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.4, roughness: 0.4,
});

/** a rack missile: the shared rocket, laid nose-forward (-Z) and sized to the rail */
function missileMesh(): THREE.Group {
  const holder = new THREE.Group();
  // no plume — it is not burning until you fire it
  const rocket = buildRocket();
  rocket.rotation.x = -Math.PI / 2;    // nose +Y becomes nose -Z
  rocket.scale.setScalar(0.72);
  holder.add(rocket);
  return holder;
}

/** a bumper mine — squat puck with a live indicator */
function mineMesh(): THREE.Group {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.1, 8), mineShell);
  shell.rotation.x = Math.PI / 2;
  // +Z is rearward once mounted on the bumper, so the live indicator has to be
  // on that face or it is buried in the bodywork and never seen
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), mineLight);
  lamp.position.z = 0.07;
  g.add(shell, lamp);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

export function buildLoadout(spec: CarSpec, roofY: number, hoodY: number): Loadout {
  const { x: sx, z: sz } = spec.size;
  const group = new THREE.Group();

  // --- missile rack: a rail on the REAR deck, three tubes across it ---
  // Sits well behind the cab: at roof height over the cabin it tangled with the
  // roof MG housing every build mounts there, and the tubes stopped reading as
  // missiles at all.
  const rackY = roofY - 0.34;
  const rackZ = sz * 0.74;
  const rail = new THREE.Mesh(new THREE.BoxGeometry(sx * 1.5, 0.07, 0.5), railMat);
  rail.position.set(0, rackY - 0.12, rackZ);
  rail.castShadow = true;
  group.add(rail);

  const missiles: THREE.Object3D[] = [];
  for (let i = 0; i < MAX_MOUNTED_MISSILES; i++) {
    const m = missileMesh();
    // centre tube sits slightly forward so the rack reads as a cluster
    const lane = i - (MAX_MOUNTED_MISSILES - 1) / 2;
    m.position.set(lane * sx * 0.52, rackY, rackZ + (i === 1 ? -0.06 : 0));
    m.visible = false;
    group.add(m);
    missiles.push(m);
  }

  // --- mines: clamped along the rear bumper, alternating height ---
  const mines: THREE.Object3D[] = [];
  const bumperZ = sz + 0.12;
  for (let i = 0; i < MAX_MOUNTED_MINES; i++) {
    const m = mineMesh();
    const col = i % 3, row = Math.floor(i / 3);
    m.position.set((col - 1) * sx * 0.56, hoodY - 0.42 - row * 0.3, bumperZ);
    m.rotation.z = (i * 1.7) % Math.PI;     // break up the repetition
    m.visible = false;
    group.add(m);
    mines.push(m);
  }

  const sync = (nMissiles: number, nMines: number) => {
    for (let i = 0; i < missiles.length; i++) missiles[i].visible = i < nMissiles;
    for (let i = 0; i < mines.length; i++) mines[i].visible = i < nMines;
    // the rack only makes sense when something is on it
    rail.visible = nMissiles > 0;
  };
  sync(0, 0);

  return {
    group, missiles, mines, sync,
    missileMuzzle: (index, out) => {
      const m = missiles[Math.max(0, Math.min(missiles.length - 1, index))];
      return m.getWorldPosition(out);
    },
    mineAnchor: (index, out) => {
      const m = mines[Math.max(0, Math.min(mines.length - 1, index))];
      return m.getWorldPosition(out);
    },
  };
}
