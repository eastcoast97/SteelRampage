import * as THREE from 'three';
import { MAX_MISSILES, MAX_MINES, MAX_NUKES, type CarSpec } from '../game/specs';
import { buildRocket } from './rocket';
import { buildMine } from './mine';
import { buildNuke } from './nuke';

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

export interface Loadout {
  group: THREE.Group;
  missiles: THREE.Object3D[];
  mines: THREE.Object3D[];
  /** world position of the next missile to leave the rack */
  missileMuzzle(index: number, out: THREE.Vector3): THREE.Vector3;
  /** world position of the next mine to fall off the bumper */
  mineAnchor(index: number, out: THREE.Vector3): THREE.Vector3;
  /** world position of the warhead in its cradle */
  nukeMuzzle(out: THREE.Vector3): THREE.Vector3;
  sync(missiles: number, mines: number, nukes: number): void;
}

const railMat = new THREE.MeshStandardMaterial({ color: 0x3a3742, roughness: 0.65, metalness: 0.55 });

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

/** a bumper clamp: the shared mine, laid face-out (+Z) and sized to the bumper */
function mineMesh(): THREE.Group {
  const holder = new THREE.Group();
  const m = buildMine().group;
  m.rotation.x = Math.PI / 2;     // axis +Y becomes +Z, so the indicator faces aft
  m.scale.setScalar(0.4);
  holder.add(m);
  return holder;
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
  for (let i = 0; i < MAX_MISSILES; i++) {
    const m = missileMesh();
    // centre tube sits slightly forward so the rack reads as a cluster
    const lane = i - (MAX_MISSILES - 1) / 2;
    m.position.set(lane * sx * 0.52, rackY, rackZ + (i === 1 ? -0.06 : 0));
    m.visible = false;
    group.add(m);
    missiles.push(m);
  }

  // --- mines: clamped along the rear bumper, alternating height ---
  const mines: THREE.Object3D[] = [];
  const bumperZ = sz + 0.12;
  for (let i = 0; i < MAX_MINES; i++) {
    const m = mineMesh();
    const col = i % 3, row = Math.floor(i / 3);
    m.position.set((col - 1) * sx * 0.56, hoodY - 0.42 - row * 0.3, bumperZ);
    m.rotation.z = (i * 1.7) % Math.PI;     // break up the repetition
    m.visible = false;
    group.add(m);
    mines.push(m);
  }

  // --- the nuke: one warhead, strapped high on the rear deck in a cradle ---
  // Above the missile rail rather than beside it. You are carrying ONE of these
  // and everyone else needs to be able to see that from across the arena, which
  // a tube lost among three others would not do.
  const nukeY = rackY + 0.46;
  const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.9), railMat);
  cradle.position.set(0, nukeY - 0.3, rackZ - 0.12);
  cradle.castShadow = true;
  group.add(cradle);

  const nukes: THREE.Object3D[] = [];
  for (let i = 0; i < MAX_NUKES; i++) {
    const holder = new THREE.Group();
    const n = buildNuke();              // no plume — it is not burning on the rack
    n.rotation.x = -Math.PI / 2;        // nose +Y becomes nose -Z
    holder.add(n);
    holder.position.set(0, nukeY, rackZ - 0.12);
    holder.visible = false;
    group.add(holder);
    nukes.push(holder);
  }

  const sync = (nMissiles: number, nMines: number, nNukes: number) => {
    for (let i = 0; i < missiles.length; i++) missiles[i].visible = i < nMissiles;
    for (let i = 0; i < mines.length; i++) mines[i].visible = i < nMines;
    for (let i = 0; i < nukes.length; i++) nukes[i].visible = i < nNukes;
    // the rack only makes sense when something is on it
    rail.visible = nMissiles > 0;
    cradle.visible = nNukes > 0;
  };
  sync(0, 0, 0);

  return {
    group, missiles, mines, sync,
    nukeMuzzle: (out) => nukes[0].getWorldPosition(out),
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
