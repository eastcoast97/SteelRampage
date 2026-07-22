import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PickupType } from './pickups';
import type { PedZone } from './peds';
import { getArenaBuilding, getArenaScene } from '../render/carModels';

/** Arena 4.0 "Sunbaked Junction" — 320×320 organic town, modelled on classic
 *  Twisted Metal small-town maps: central ROUNDABOUT with a clock tower,
 *  diagonal MAIN AVENUE that runs straight through the two neon tunnels,
 *  a perpendicular cross avenue, connector streets, and a rounded-rectangle
 *  PERIMETER LOOP with arc corners. Irregular blocks, warm sun-baked palette.
 *  Layout constants here MUST match the Blender arena generator (docs/BLENDER.md). */
export const ARENA_HALF = 160;

/** Poly Haven CC0 photoscans (public/textures/) — loaded at bootstrap; the
 *  canvas texture builders composite markings/wear ON TOP of these bases and
 *  fall back to pure-procedural when absent. */
export const SURFACE_IMAGES: {
  asphaltDiff?: HTMLImageElement;
  asphaltRough?: HTMLImageElement;
  concreteDiff?: HTMLImageElement;
} = {};

export async function loadSurfaceTextures(): Promise<void> {
  const load = (src: string) => new Promise<HTMLImageElement | undefined>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
  const [ad, ar, cd] = await Promise.all([
    load('/textures/asphalt_01_diff_1k.jpg'),
    load('/textures/asphalt_01_rough_1k.jpg'),
    load('/textures/concrete_floor_diff_1k.jpg'),
  ]);
  SURFACE_IMAGES.asphaltDiff = ad;
  SURFACE_IMAGES.asphaltRough = ar;
  SURFACE_IMAGES.concreteDiff = cd;
}

export const ARENAS = [
  { name: 'SUNBAKED JUNCTION', desc: 'small-town roundabout, tunnels, skyway' },
  { name: 'NEON DOCKS', desc: 'night harbor — warehouses, cranes, containers' },
];

/** street segments [x0,z0,x1,z1,width] — single source of truth, also drawn
 *  on the radar. Diagonal avenues stop at the roundabout (r=22). */
export const STREETS: [number, number, number, number, number][] = [
  // main avenue, (1,-1) diagonal — passes through both neon tunnels
  [-126, 126, -15.6, 15.6, 18],
  [15.6, -15.6, 126, -126, 18],
  // cross avenue, (1,1) diagonal
  [-126, -126, -15.6, -15.6, 14],
  [15.6, 15.6, 126, 126, 14],
  // perimeter loop straights
  [-108, -138, 108, -138, 14],
  [-108, 138, 108, 138, 14],
  [138, -108, 138, 108, 14],
  [-138, -108, -138, 108, 14],
  // connector streets (x=±88, z=±88) — placed to thread between the tunnel
  // portals (≤69) and the skyway pylons (77)
  [88, -138, 88, 138, 12],
  [-88, -138, -88, 138, 12],
  [-138, 88, 138, 88, 12],
  [-138, -88, 138, -88, 12],
];
/** perimeter corner arcs [cx,cz,r,thetaStart,thetaLen,width] */
export const ARCS: [number, number, number, number, number, number][] = [
  [108, -108, 30, -Math.PI / 2, Math.PI / 2, 14],   // NE
  [108, 108, 30, 0, Math.PI / 2, 14],               // SE
  [-108, 108, 30, Math.PI / 2, Math.PI / 2, 14],    // SW
  [-108, -108, 30, Math.PI, Math.PI / 2, 14],       // NW
];
export const ROUNDABOUT = { r: 22, w: 13, islandR: 15.5 };

/** NEON DOCKS street grid: harbor road east, main drag, service road west,
 *  three crossing avenues, perimeter edges. */
export const STREETS_DOCKS: [number, number, number, number, number][] = [
  [118, -138, 118, 138, 16],    // harbor road (along the waterfront)
  [-30, -138, -30, 138, 14],    // main drag
  [-118, -138, -118, 138, 12],  // west service road
  [-138, -90, 138, -90, 14],    // north avenue
  [-138, 0, 138, 0, 14],        // centre avenue
  [-138, 90, 138, 90, 14],      // south avenue
  [-138, -138, 138, -138, 12],  // north perimeter
  [-138, 138, 138, 138, 12],    // south perimeter
];
/** junction pad list per arena [x,z,size] */
export const JUNCTIONS_DOCKS: [number, number, number][] = [
  [118, -90, 20], [118, 0, 20], [118, 90, 20],
  [-30, -90, 18], [-30, 0, 18], [-30, 90, 18],
  [-118, -90, 16], [-118, 0, 16], [-118, 90, 16],
  [118, -138, 18], [118, 138, 18], [-30, -138, 16], [-30, 138, 16], [-118, -138, 14], [-118, 138, 14],
];

export interface ArenaData {
  spawnPoints: { pos: THREE.Vector3; yaw: number }[];
  pickupPoints: { pos: THREE.Vector3; type: PickupType; alts?: THREE.Vector3[] }[];
  barrelPoints: THREE.Vector3[];
  pedZones: PedZone[];
  /** which SKY_PRESETS entry was used — hosts share it so guests match */
  skyIdx: number;
  /** sky gradient colors — used to build the reflection environment map */
  envColors: { top: string; hor: string };
  /** auto-turbo strips (y = surface height so pads work on elevated track) */
  boostPads: { x: number; y: number; z: number; hx: number; hz: number }[];
  /** gas pumps — shootable super-barrels (bigger blast, chains the cluster) */
  pumpPoints: THREE.Vector3[];
  /** the clock tower's collider body — removed when the tower collapses */
  towerBody?: RAPIER.RigidBody;
}

// ---------------------------------------------------------------- helpers

/** exact-collider box — for surfaces cars drive on/along (walls, tunnel, deck) */
function addBox(
  world: RAPIER.World, scene: THREE.Scene, mat: THREE.Material | THREE.Material[],
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  yaw = 0, castShadow = true,
): void {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.6), body);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
  mesh.position.set(cx, cy, cz);
  mesh.rotation.y = yaw;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

/**
 * Place a Blender-authored asset. Meshes named `COL_*` are collision proxies:
 * they become Rapier cuboid colliders and are NOT rendered. Everything else is
 * rendered. This is what lets the arena be authored in Blender while we keep
 * exact control of the physics footprint (see docs/BLENDER.md).
 */
function placeBlenderAsset(
  world: RAPIER.World, scene: THREE.Scene, src: THREE.Group,
  cx: number, cz: number, yaw = 0, scale = 1,
): void {
  const root = src.clone(true);
  root.position.set(cx, 0, cz);
  root.rotation.y = yaw;
  root.scale.setScalar(scale);
  root.updateWorldMatrix(true, true);

  const proxies: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (o.name.startsWith('COL_')) { proxies.push(mesh); return; }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });

  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  for (const p of proxies) {
    p.updateWorldMatrix(true, false);
    p.matrixWorld.decompose(pos, quat, scl);
    p.geometry.computeBoundingBox();
    const bb = p.geometry.boundingBox!;
    // half-extents in world units
    const hx = ((bb.max.x - bb.min.x) / 2) * Math.abs(scl.x);
    const hy = ((bb.max.y - bb.min.y) / 2) * Math.abs(scl.y);
    const hz = ((bb.max.z - bb.min.z) / 2) * Math.abs(scl.z);
    // geometry may not be centred on its origin — offset into world space
    const ctr = new THREE.Vector3(
      (bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2,
    ).multiply(scl).applyQuaternion(quat).add(pos);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(ctr.x, ctr.y, ctr.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.6), body);
    p.parent?.remove(p);   // proxy is physics-only
  }
  scene.add(root);
}

/** Make a Rapier cuboid from a collision-proxy mesh's world transform.
 *  Handles rotation (ramps, skyway segments) and off-origin geometry. */
function colliderFromProxy(world: RAPIER.World, p: THREE.Mesh): RAPIER.RigidBody {
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  p.updateWorldMatrix(true, false);
  p.matrixWorld.decompose(pos, quat, scl);
  p.geometry.computeBoundingBox();
  const bb = p.geometry.boundingBox!;
  const hx = ((bb.max.x - bb.min.x) / 2) * Math.abs(scl.x);
  const hy = ((bb.max.y - bb.min.y) / 2) * Math.abs(scl.y);
  const hz = ((bb.max.z - bb.min.z) / 2) * Math.abs(scl.z);
  const ctr = new THREE.Vector3(
    (bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2,
  ).multiply(scl).applyQuaternion(quat).add(pos);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(ctr.x, ctr.y, ctr.z)
      .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.6), body);
  return body;
}

/**
 * Consume the complete Blender-authored arena (public/models/arena.glb).
 * Object-name prefixes route each node (docs/BLENDER.md):
 *   COL_*      → Rapier cuboid collider, stripped from render
 *   SPAWN_*    → spawn point (yaw derived from the empty's orientation)
 *   PICKUP_t_* → pickup socket of type t
 *   BARREL_*   → explosive barrel spawn
 *   BOOST_*    → boost pad zone (box → x/z extents + surface height)
 *   PED_*      → pedestrian zone rectangle
 *   (rest)     → rendered geometry
 * NOTE: the glTF axis convention imports the Blender layout rigidly rotated
 * (Blender +Y → -Z). That's fine BECAUSE everything — geometry, colliders and
 * markers — comes through the same transform. Never mix old hardcoded
 * coordinates with GLB-derived ones.
 */
function consumeArenaGLB(
  world: RAPIER.World, scene: THREE.Scene, src: THREE.Group,
): Pick<ArenaData, 'spawnPoints' | 'pickupPoints' | 'barrelPoints' | 'pedZones' | 'boostPads' | 'pumpPoints' | 'towerBody'> {
  const root = src.clone(true);
  root.updateWorldMatrix(true, true);

  const spawnPoints: ArenaData['spawnPoints'] = [];
  const pickupPoints: ArenaData['pickupPoints'] = [];
  const barrelPoints: ArenaData['barrelPoints'] = [];
  const pedZones: PedZone[] = [];
  const boostPads: ArenaData['boostPads'] = [];
  const pumpPoints: THREE.Vector3[] = [];
  let towerBody: RAPIER.RigidBody | undefined;
  const strip: THREE.Object3D[] = [];
  const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();

  const rectOf = (m: THREE.Mesh) => {
    // NOTE: the exporter bakes transforms into vertex data (export_apply), so
    // marker positions must come from the geometry bounding-box CENTRE, not
    // the node transform (which is identity).
    m.updateWorldMatrix(true, false);
    m.matrixWorld.decompose(wp, wq, ws);
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox!;
    const ctr = new THREE.Vector3(
      (bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2,
    ).multiply(ws).applyQuaternion(wq).add(wp);
    return {
      x: ctr.x, y: ctr.y, z: ctr.z,
      hx: ((bb.max.x - bb.min.x) / 2) * Math.abs(ws.x),
      hz: ((bb.max.z - bb.min.z) / 2) * Math.abs(ws.z),
    };
  };

  root.traverse((o) => {
    const n = o.name;
    if (n.startsWith('COL_')) {
      const body = colliderFromProxy(world, o as THREE.Mesh);
      if (n === 'COL_ClockTower') towerBody = body;   // removable on collapse
      strip.push(o);
    } else if (n.startsWith('PUMP_')) {
      o.getWorldPosition(wp);
      pumpPoints.push(new THREE.Vector3(wp.x, 0.95, wp.z));
      strip.push(o);
    } else if (n.startsWith('SPAWN_')) {
      o.getWorldPosition(wp);
      o.getWorldQuaternion(wq);
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(wq);
      spawnPoints.push({ pos: new THREE.Vector3(wp.x, 1.2, wp.z), yaw: Math.atan2(-f.x, -f.z) });
      strip.push(o);
    } else if (n.startsWith('PICKUP_')) {
      const type = n.split('_')[1] as PickupType;
      o.getWorldPosition(wp);
      const pos = wp.clone();
      if (type === 'overdrive') {
        // overdrive roams: clock-tower island socket + two shop plazas
        pickupPoints.push({ pos, type, alts: [pos.clone(), new THREE.Vector3(44, 0.9, 0), new THREE.Vector3(0, 0.9, 44)] });
      } else {
        pickupPoints.push({ pos, type });
      }
      strip.push(o);
    } else if (n.startsWith('BARREL_')) {
      o.getWorldPosition(wp);
      barrelPoints.push(new THREE.Vector3(wp.x, 0.95, wp.z));
      strip.push(o);
    } else if (n.startsWith('BOOST_')) {
      const r = rectOf(o as THREE.Mesh);
      boostPads.push({ x: r.x, y: Math.max(0, r.y - 0.09), z: r.z, hx: r.hx, hz: r.hz });
      strip.push(o);
    } else if (n.startsWith('PED_')) {
      const r = rectOf(o as THREE.Mesh);
      pedZones.push({ x: r.x, z: r.z, hx: r.hx, hz: r.hz });
      strip.push(o);
    } else if ((o as THREE.Mesh).isMesh) {
      (o as THREE.Mesh).castShadow = true;
      (o as THREE.Mesh).receiveShadow = true;
    }
  });
  for (const o of strip) o.parent?.remove(o);
  scene.add(root);
  return { spawnPoints, pickupPoints, barrelPoints, pedZones, boostPads, pumpPoints, towerBody };
}

/** anti-snag prop: rounded collider at ~92% of the visual footprint so
 *  grazing hits deflect instead of stopping the car */
function addProp(
  world: RAPIER.World, scene: THREE.Scene, mat: THREE.Material | THREE.Material[],
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  yaw = 0,
): void {
  const R = 0.35;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
  );
  world.createCollider(
    RAPIER.ColliderDesc.roundCuboid(
      Math.max(0.05, hx * 0.92 - R),
      Math.max(0.05, hy - R),
      Math.max(0.05, hz * 0.92 - R),
      R,
    ).setFriction(0.4),
    body,
  );
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
  mesh.position.set(cx, cy, cz);
  mesh.rotation.y = yaw;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function addDecoBox(
  scene: THREE.Scene, mat: THREE.Material,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number, yaw = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
  mesh.position.set(cx, cy, cz);
  mesh.rotation.y = yaw;
  scene.add(mesh);
  return mesh;
}

function addRamp(
  world: RAPIER.World, scene: THREE.Scene, mat: THREE.Material,
  cx: number, cz: number, yaw: number,
  length = 12, width = 8, height = 3.2,
): void {
  const pitch = Math.atan2(height, length);
  const halfLen = Math.sqrt(length * length + height * height) / 2;
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
  const q = qYaw.multiply(qPitch);
  const cy = height / 2 - 0.15;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, 0.3, halfLen).setFriction(0.5), body);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.6, halfLen * 2), mat);
  mesh.position.set(cx, cy, cz);
  mesh.quaternion.copy(q);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ---------------------------------------------------------------- textures

function makeGroundTexture(): THREE.CanvasTexture {
  // "roaming zone": warm worn concrete — clearly distinct from dark asphalt roads
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  if (SURFACE_IMAGES.concreteDiff) {
    // Poly Haven photoscan base, graded warm to match the sun-baked palette
    g.drawImage(SURFACE_IMAGES.concreteDiff, 0, 0, 512, 512);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = '#b8a68e';
    g.fillRect(0, 0, 512, 512);
    g.globalCompositeOperation = 'source-over';
  } else {
    g.fillStyle = '#6a6157';   // warm sun-baked concrete
    g.fillRect(0, 0, 512, 512);
  }
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(${86 + Math.random() * 40}, ${74 + Math.random() * 34}, ${60 + Math.random() * 30}, 0.3)`;
    const s = 10 + Math.random() * 50;
    g.fillRect(Math.random() * 512, Math.random() * 512, s, s);
  }
  // concrete expansion joints (large grid — reads as plaza paving)
  g.strokeStyle = 'rgba(30, 26, 34, 0.3)';
  g.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * 512;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(512, p); g.stroke();
  }
  g.strokeStyle = 'rgba(20, 16, 24, 0.35)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 22; i++) {
    g.beginPath();
    let x = Math.random() * 512, y = Math.random() * 512;
    g.moveTo(x, y);
    for (let j = 0; j < 5; j++) { x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 90; g.lineTo(x, y); }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20, 20);   // 320m arena — keep paving density constant
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** NFS-grade asphalt: layered grain + oil-polished wheel tracks + worn paint.
 *  Returns albedo + roughness maps; the roughness map is what gives the road
 *  its wet-look specular sheen down the driving lines. */
function makeRoadMaps(kind: 'boulevard' | 'highway'): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const W = 512, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const rc = document.createElement('canvas');
  rc.width = W / 2; rc.height = H / 2;
  const rg = rc.getContext('2d')!;

  // --- base asphalt: Poly Haven photoscan when loaded, procedural fallback.
  //     Markings/wear composite on top either way. ---
  if (SURFACE_IMAGES.asphaltDiff) {
    g.drawImage(SURFACE_IMAGES.asphaltDiff, 0, 0, W, W);
    g.drawImage(SURFACE_IMAGES.asphaltDiff, 0, W, W, W);
    // grade the photo down to our moody near-black road tone
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = '#55525e';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  } else {
    g.fillStyle = '#232028';
    g.fillRect(0, 0, W, H);
  }
  if (SURFACE_IMAGES.asphaltRough) {
    rg.drawImage(SURFACE_IMAGES.asphaltRough, 0, 0, rc.width, rc.width);
    rg.drawImage(SURFACE_IMAGES.asphaltRough, 0, rc.width, rc.width, rc.width);
  } else {
    rg.fillStyle = 'rgb(215,215,215)';           // fairly rough by default
    rg.fillRect(0, 0, rc.width, rc.height);
  }

  // large-scale tonal drift (sun-bleached vs freshly-sealed bands)
  for (let i = 0; i < 14; i++) {
    const y = Math.random() * H, h = 90 + Math.random() * 240;
    g.fillStyle = `rgba(${30 + Math.random() * 16},${28 + Math.random() * 14},${36 + Math.random() * 16},0.22)`;
    g.fillRect(0, y, W, h);
  }
  // fine aggregate grain
  for (let i = 0; i < 12000; i++) {
    const v = 20 + Math.random() * 38;
    g.fillStyle = `rgba(${v},${v - 1},${v + 6},${0.10 + Math.random() * 0.32})`;
    const s = 1 + Math.random() * 2.2;
    g.fillRect(Math.random() * W, Math.random() * H, s, s);
  }
  // patched repairs (darker, smoother in the roughness map)
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    const w = 50 + Math.random() * 140, h = 40 + Math.random() * 200;
    g.fillStyle = `rgba(${18 + Math.random() * 12},${17 + Math.random() * 10},${23 + Math.random() * 12},0.55)`;
    g.fillRect(x, y, w, h);
    rg.fillStyle = 'rgba(150,150,150,0.6)';
    rg.fillRect(x / 2, y / 2, w / 2, h / 2);
  }
  // tar-sealed cracks (dark gloss lines)
  for (let i = 0; i < 20; i++) {
    g.strokeStyle = 'rgba(8,7,11,0.75)';
    g.lineWidth = 1.4 + Math.random() * 2.2;
    g.beginPath();
    let x = Math.random() * W, y = Math.random() * H;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += (Math.random() - 0.5) * 100; y += Math.random() * 100; g.lineTo(x, y); }
    g.stroke();
    rg.strokeStyle = 'rgba(110,110,110,0.7)';
    rg.lineWidth = 1.4;
    rg.beginPath(); rg.moveTo(x / 2, y / 2);   // partial trace is fine — just sheen flecks
    rg.lineTo(x / 2 - 30, y / 2 - 60); rg.stroke();
  }

  // --- oil-polished wheel tracks: darker albedo + MUCH smoother roughness ---
  // (this is the NFS look: the driving lines catch the sun/headlights)
  const laneCenters = kind === 'boulevard' ? [0.155, 0.345, 0.655, 0.845] : [0.17, 0.5, 0.83];
  for (const lc of laneCenters) {
    for (const off of [-0.048, 0.048]) {          // two tyre tracks per lane
      const tx = (lc + off) * W;
      const grd = g.createLinearGradient(tx - 20, 0, tx + 20, 0);
      grd.addColorStop(0, 'rgba(6,6,9,0)');
      grd.addColorStop(0.5, 'rgba(6,6,9,0.55)');
      grd.addColorStop(1, 'rgba(6,6,9,0)');
      g.fillStyle = grd; g.fillRect(tx - 20, 0, 40, H);
      const rgrd = rg.createLinearGradient((tx - 20) / 2, 0, (tx + 20) / 2, 0);
      rgrd.addColorStop(0, 'rgba(95,95,95,0)');
      rgrd.addColorStop(0.5, 'rgba(95,95,95,0.85)');
      rgrd.addColorStop(1, 'rgba(95,95,95,0)');
      rg.fillStyle = rgrd; rg.fillRect((tx - 20) / 2, 0, 20, rc.height);
    }
  }

  // --- lane paint (drawn, then weathered) ---
  const paint = (x: number, w: number, color: string, dash?: [number, number]) => {
    g.fillStyle = color;
    if (!dash) { g.fillRect(x - w / 2, 0, w, H); }
    else { for (let y = 0; y < H; y += dash[0] + dash[1]) g.fillRect(x - w / 2, y, w, dash[0]); }
    rg.fillStyle = 'rgba(160,160,160,0.8)';      // paint is smoother than asphalt
    rg.fillRect((x - w / 2) / 2, 0, w / 2, rc.height);
  };
  const white = 'rgba(226,224,214,0.92)', yellow = 'rgba(255,196,40,0.94)';
  if (kind === 'boulevard') {
    paint(30, 9, white);                          // solid edges
    paint(W - 30, 9, white);
    paint(W / 2 - 7, 7, yellow);                  // double-yellow centreline
    paint(W / 2 + 7, 7, yellow);
    paint(W * 0.25, 7, white, [56, 64]);          // dashed lane dividers
    paint(W * 0.75, 7, white, [56, 64]);
  } else {
    paint(26, 9, white);
    paint(W - 26, 9, white);
    paint(W / 3, 7, white, [56, 64]);
    paint((2 * W) / 3, 7, white, [56, 64]);
  }
  // weathering: eat random bites out of the paint
  g.fillStyle = 'rgba(35,32,40,0.75)';
  for (let i = 0; i < 260; i++) {
    const s = 2 + Math.random() * 7;
    g.fillRect(Math.random() * W, Math.random() * H, s, s * (0.5 + Math.random()));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const rough = new THREE.CanvasTexture(rc);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  return { map: tex, rough };
}

/** junction pad: plain asphalt + zebra crosswalks on all four sides + stop lines */
function makeJunctionMaps(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const S = 512;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rc = document.createElement('canvas'); rc.width = rc.height = S / 2;
  const rg = rc.getContext('2d')!;
  g.fillStyle = '#232028'; g.fillRect(0, 0, S, S);
  rg.fillStyle = 'rgb(210,210,210)'; rg.fillRect(0, 0, S / 2, S / 2);
  for (let i = 0; i < 5000; i++) {
    const v = 20 + Math.random() * 36;
    g.fillStyle = `rgba(${v},${v - 1},${v + 6},${0.12 + Math.random() * 0.3})`;
    const s = 1 + Math.random() * 2.2;
    g.fillRect(Math.random() * S, Math.random() * S, s, s);
  }
  // polished centre (every car crosses here — worn smooth)
  const ctr = g.createRadialGradient(S / 2, S / 2, 30, S / 2, S / 2, S / 2);
  ctr.addColorStop(0, 'rgba(8,8,11,0.4)'); ctr.addColorStop(1, 'rgba(8,8,11,0)');
  g.fillStyle = ctr; g.fillRect(0, 0, S, S);
  const rctr = rg.createRadialGradient(S / 4, S / 4, 15, S / 4, S / 4, S / 4);
  rctr.addColorStop(0, 'rgba(110,110,110,0.8)'); rctr.addColorStop(1, 'rgba(110,110,110,0)');
  rg.fillStyle = rctr; rg.fillRect(0, 0, S / 2, S / 2);
  // zebra crosswalks + stop lines on each edge
  g.fillStyle = 'rgba(222,220,210,0.85)';
  const stripe = 18, gap = 16, inset = 26, bandW = 56;
  for (let x = 60; x < S - 60; x += stripe + gap) {
    g.fillRect(x, inset, stripe, bandW);              // top band
    g.fillRect(x, S - inset - bandW, stripe, bandW);  // bottom band
    g.fillRect(inset, x, bandW, stripe);              // left band
    g.fillRect(S - inset - bandW, x, bandW, stripe);  // right band
  }
  g.fillStyle = 'rgba(226,224,214,0.9)';
  g.fillRect(60, inset + bandW + 12, S - 120, 8);      // stop lines
  g.fillRect(60, S - inset - bandW - 20, S - 120, 8);
  g.fillRect(inset + bandW + 12, 60, 8, S - 120);
  g.fillRect(S - inset - bandW - 20, 60, 8, S - 120);
  // weathering
  g.fillStyle = 'rgba(35,32,40,0.7)';
  for (let i = 0; i < 160; i++) {
    const s = 2 + Math.random() * 8;
    g.fillRect(Math.random() * S, Math.random() * S, s, s);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { map: tex, rough: new THREE.CanvasTexture(rc) };
}

/** arc/annulus strip with RADIAL UVs — v follows the arc so lane markings flow
 *  around the curve (roundabout, perimeter corners). thetaLen 2π = full ring. */
function arcRoadGeometry(
  rMid: number, halfW: number, thetaStart = 0, thetaLen = Math.PI * 2, segs = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const arcLen = rMid * thetaLen;
  const n = segs || Math.max(12, Math.round(arcLen / 1.6));
  // whole texture repeats along the arc → seamless wrap on full rings
  const vRepeat = Math.max(1, Math.round(arcLen / 26));
  for (let i = 0; i <= n; i++) {
    const t = thetaStart + (i / n) * thetaLen;
    const cs = Math.cos(t), sn = Math.sin(t);
    pos.push(cs * (rMid - halfW), 0, sn * (rMid - halfW));
    pos.push(cs * (rMid + halfW), 0, sn * (rMid + halfW));
    const v = (i / n) * vRepeat;
    uv.push(0, v, 1, v);
    if (i < n) {
      const a = i * 2;
      // winding chosen so face normals point +Y (visible from above)
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

type BuildingKind = 'glass' | 'concrete' | 'brick';

/** albedo + normal + roughness for a facade so flat box faces catch light with
 *  real relief (recessed windows, panel seams, brick courses). */
function makeBuildingTextures(kind: BuildingKind, cols: number, floors: number, tint: number) {
  const S = 256;
  const alb = document.createElement('canvas'); alb.width = alb.height = S;
  const nrm = document.createElement('canvas'); nrm.width = nrm.height = S;
  const rgh = document.createElement('canvas'); rgh.width = rgh.height = S;
  const a = alb.getContext('2d')!;
  const n = nrm.getContext('2d')!;
  const r = rgh.getContext('2d')!;
  const base = new THREE.Color(tint);
  n.fillStyle = 'rgb(128,128,255)'; n.fillRect(0, 0, S, S);           // flat normal
  r.fillStyle = kind === 'glass' ? '#333' : '#c8c8c8'; r.fillRect(0, 0, S, S);

  // paint a faked inset bevel into the normal map (windows/panels recessed)
  const bevel = (x: number, y: number, w: number, h: number, e = 3) => {
    n.fillStyle = 'rgb(90,128,235)'; n.fillRect(x, y, e, h);          // left → +X tilt
    n.fillStyle = 'rgb(166,128,235)'; n.fillRect(x + w - e, y, e, h); // right → -X tilt
    n.fillStyle = 'rgb(128,90,235)'; n.fillRect(x, y, w, e);          // top → +Y tilt
    n.fillStyle = 'rgb(128,166,235)'; n.fillRect(x, y + h - e, w, e); // bottom → -Y tilt
  };

  if (kind === 'brick') {
    // brick courses, offset rows
    a.fillStyle = `rgb(${base.r * 210 | 0},${base.g * 150 | 0},${base.b * 140 | 0})`;
    a.fillRect(0, 0, S, S);
    const bh = 9, bw = 26;
    for (let y = 0, row = 0; y < S; y += bh, row++) {
      for (let x = -bw; x < S; x += bw) {
        const ox = (row % 2) * (bw / 2);
        const v = 0.75 + Math.random() * 0.35;
        a.fillStyle = `rgb(${base.r * 210 * v | 0},${base.g * 150 * v | 0},${base.b * 138 * v | 0})`;
        a.fillRect(x + ox + 1, y + 1, bw - 2, bh - 2);
      }
      n.fillStyle = 'rgb(128,150,240)'; n.fillRect(0, y, S, 1.5);      // mortar course relief
    }
  } else if (kind === 'concrete') {
    a.fillStyle = `rgb(${base.r * 200 | 0},${base.g * 200 | 0},${base.b * 205 | 0})`;
    a.fillRect(0, 0, S, S);
    for (let i = 0; i < 260; i++) {                                    // weathering blotches + stains
      a.fillStyle = `rgba(${20 + Math.random() * 60},${20 + Math.random() * 55},${28 + Math.random() * 55},${0.06 + Math.random() * 0.14})`;
      const s = 6 + Math.random() * 34;
      a.fillRect(Math.random() * S, Math.random() * S, s, s);
    }
    for (let x = 0; x < S; x += S / cols) { n.fillStyle = 'rgb(150,128,240)'; n.fillRect(x, 0, 1.5, S); }
  } else {
    a.fillStyle = `rgb(${18 + base.r * 40 | 0},${24 + base.g * 46 | 0},${38 + base.b * 60 | 0})`;
    a.fillRect(0, 0, S, S);                                           // dark glass curtain wall
  }

  // window grid — recessed panels, some warmly lit (interiors)
  const mx = 14, my = 12;
  const cw = (S - mx * 2) / cols;
  const ch = (S - my * 2) / floors;
  const gw = cw * (kind === 'glass' ? 0.82 : 0.6);
  const gh = ch * (kind === 'glass' ? 0.74 : 0.58);
  for (let fx = 0; fx < cols; fx++) {
    for (let fy = 0; fy < floors; fy++) {
      const wx = mx + fx * cw + (cw - gw) / 2;
      const wy = my + fy * ch + (ch - gh) / 2;
      const lit = Math.random() < 0.4;
      a.fillStyle = lit
        ? `rgba(${232 + Math.random() * 22},${186 + Math.random() * 40},${96 + Math.random() * 46},0.96)`
        : `rgba(${14 + Math.random() * 16},${20 + Math.random() * 20},${34 + Math.random() * 26},0.96)`;
      a.fillRect(wx, wy, gw, gh);
      bevel(wx, wy, gw, gh);
      r.fillStyle = lit ? '#e0e0e0' : '#202028';                      // glass is glossy
      r.fillRect(wx, wy, gw, gh);
    }
  }

  const map = new THREE.CanvasTexture(alb); map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(nrm);
  const roughnessMap = new THREE.CanvasTexture(rgh);
  return { map, normalMap, roughnessMap };
}

function makeSignTexture(lines: string[], bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = fg;
  g.lineWidth = 10;
  g.strokeRect(12, 12, 488, 232);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const fs = lines.length > 1 ? 64 : 84;
  g.font = `italic 900 ${fs}px "Arial Black", sans-serif`;
  lines.forEach((line, i) => {
    g.fillText(line, 256, 128 + (i - (lines.length - 1) / 2) * (fs + 14));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- arena

export function buildArena(world: RAPIER.World, scene: THREE.Scene, forcedSkyIdx?: number, arenaIdx = 0): ArenaData {
  const H = ARENA_HALF;

  // --- sky: real gradient dome + sun + stars, three moods rotating per match ---
  // fog is tuned to each preset's HORIZON color so distant buildings melt
  // into the sky instead of silhouetting against it
  // 'sunbaked' is the signature mood (classic TM small-town sepia haze) and is
  // weighted to appear most often; day/night keep variety
  const SKY_PRESETS = [
    { name: 'sunbaked', top: '#9a7c55', mid: '#c29d6d', hor: '#e2c493', sunColor: 0xffe0b0, sunI: 3.2, hemiS: 0xe8cfa0, hemiG: 0x7a6a52, hemiI: 2.0, fog: 0xc9a877, sil: '#6b5238', stars: false, sunPos: [95, 55, 35] as const, sunVis: '#fff2cc' },
    { name: 'day', top: '#3a7bd5', mid: '#7db8e8', hor: '#d8e8f0', sunColor: 0xfff4e0, sunI: 3.8, hemiS: 0xcfe8ff, hemiG: 0x8a8578, hemiI: 2.4, fog: 0xc2d8e8, sil: '#8aa4bc', stars: false, sunPos: [70, 120, 40] as const, sunVis: '#ffffff' },
    { name: 'night', top: '#05060f', mid: '#0c1226', hor: '#1c2a4a', sunColor: 0xaac8ff, sunI: 1.2, hemiS: 0x4a5a9c, hemiG: 0x1c1c2a, hemiI: 1.1, fog: 0x141e34, sil: '#080b16', stars: true, sunPos: [60, 90, -80] as const, sunVis: '#e8f0ff' },
    // index 3: NEON DOCKS signature — violet night, magenta harbor haze
    { name: 'neonNight', top: '#0a0618', mid: '#16103a', hor: '#3d1a4e', sunColor: 0xb8c8ff, sunI: 1.4, hemiS: 0x5a4ab0, hemiG: 0x1a1428, hemiI: 1.3, fog: 0x1c1234, sil: '#0c0a1c', stars: true, sunPos: [-70, 80, 50] as const, sunVis: '#e8ecff' },
  ];
  // weighted pick for the town; the docks always run their neon night
  const roll = Math.random();
  const skyIdx = forcedSkyIdx ?? (arenaIdx === 1 ? 3 : roll < 0.5 ? 0 : roll < 0.75 ? 1 : 2);
  const sky = SKY_PRESETS[skyIdx];

  // gradient dome
  const domeCanvas = document.createElement('canvas');
  domeCanvas.width = 2; domeCanvas.height = 512;
  const dg = domeCanvas.getContext('2d')!;
  const grad = dg.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, sky.top);
  grad.addColorStop(0.55, sky.mid);
  grad.addColorStop(0.82, sky.hor);
  grad.addColorStop(1, sky.hor);
  dg.fillStyle = grad;
  dg.fillRect(0, 0, 2, 512);
  const domeTex = new THREE.CanvasTexture(domeCanvas);
  domeTex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(700, 24, 16),
    new THREE.MeshBasicMaterial({ map: domeTex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  dome.renderOrder = -10;
  scene.add(dome);

  // visible sun/moon disc aligned with the light direction
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(sky.name === 'day' ? 30 : 22, 24),
    new THREE.MeshBasicMaterial({ color: sky.sunVis, fog: false }),
  );
  sunDisc.position.set(sky.sunPos[0], sky.sunPos[1], sky.sunPos[2]).normalize();
  sunDisc.position.multiplyScalar(650);
  sunDisc.lookAt(0, 0, 0);
  sunDisc.renderOrder = -9;
  scene.add(sunDisc);

  // stars on the upper dome
  if (sky.stars) {
    const starPos = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) {
      const a = Math.random() * Math.PI * 2;
      const el = 0.12 + Math.random() * 1.4;
      const r = 660;
      starPos[i * 3] = Math.cos(a) * Math.cos(el) * r;
      starPos[i * 3 + 1] = Math.sin(el) * r;
      starPos[i * 3 + 2] = Math.sin(a) * Math.cos(el) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 1.7, sizeAttenuation: false, fog: false,
      transparent: true, opacity: sky.name === 'night' ? 0.9 : 0.45,
    }));
    stars.renderOrder = -9;
    scene.add(stars);
  }

  // distant backdrop ring: ROLLING HILLS with a sparse small-town skyline —
  // sits inside the fog band, hides the arena edge (TM small-town horizon)
  {
    const sc = document.createElement('canvas');
    sc.width = 1024; sc.height = 128;
    const sg = sc.getContext('2d')!;
    // far hill layer (lighter, hazier)
    sg.fillStyle = sky.name === 'night' ? '#0b1020' : 'rgba(140,110,78,0.55)';
    sg.beginPath();
    sg.moveTo(0, 128);
    for (let x = 0; x <= 1024; x += 8) {
      const h = 46 + Math.sin(x * 0.011) * 22 + Math.sin(x * 0.037 + 2) * 9;
      sg.lineTo(x, 128 - h);
    }
    sg.lineTo(1024, 128); sg.closePath(); sg.fill();
    // near hill layer
    sg.fillStyle = sky.sil;
    sg.beginPath();
    sg.moveTo(0, 128);
    for (let x = 0; x <= 1024; x += 8) {
      const h = 26 + Math.sin(x * 0.017 + 5) * 14 + Math.sin(x * 0.051) * 6;
      sg.lineTo(x, 128 - h);
    }
    sg.lineTo(1024, 128); sg.closePath(); sg.fill();
    // sparse low-town silhouettes + water towers along the ridge line
    let x = 30;
    while (x < 1024) {
      const w = 14 + Math.random() * 26;
      const base = 26 + Math.sin(x * 0.017 + 5) * 14;
      const h = 8 + Math.random() * 16;
      sg.fillRect(x, 128 - base - h, w, h + 4);
      if (Math.random() < 0.25) {   // water tower: legs + tank
        sg.fillRect(x + w + 8, 128 - base - 18, 2, 18);
        sg.fillRect(x + w + 4, 128 - base - 26, 10, 9);
      }
      if (sky.name === 'night') {
        sg.fillStyle = 'rgba(255, 214, 140, 0.5)';
        for (let k = 0; k < 3; k++) sg.fillRect(x + 2 + Math.random() * (w - 4), 128 - base - h + 2 + Math.random() * (h - 4), 2, 2);
        sg.fillStyle = sky.sil;
      }
      x += w + 40 + Math.random() * 90;
    }
    const silTex = new THREE.CanvasTexture(sc);
    silTex.wrapS = THREE.RepeatWrapping;
    silTex.repeat.set(3, 1);
    silTex.colorSpace = THREE.SRGBColorSpace;
    const skyline = new THREE.Mesh(
      new THREE.CylinderGeometry(420, 420, 84, 48, 1, true),
      new THREE.MeshBasicMaterial({ map: silTex, transparent: true, side: THREE.BackSide, fog: true }),
    );
    skyline.position.y = 38;
    scene.add(skyline);
  }

  scene.background = new THREE.Color(sky.top);
  scene.fog = new THREE.Fog(sky.fog, 175, 530);

  const hemi = new THREE.HemisphereLight(sky.hemiS, sky.hemiG, sky.hemiI);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(sky.sunColor, sky.sunI);
  sun.position.set(sky.sunPos[0], sky.sunPos[1], sky.sunPos[2]);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -H - 10;
  sun.shadow.camera.right = H + 10;
  sun.shadow.camera.top = H + 10;
  sun.shadow.camera.bottom = -H - 10;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // --- ground ---
  const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(H, 0.5, H).setTranslation(0, -0.5, 0).setFriction(0.7), floorBody);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(H * 2, H * 2),
    new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // --- roads: NFS-grade layered asphalt with specular sheen ---
  const roadMaterial = (kind: 'boulevard' | 'highway', repY: number) => {
    const maps = makeRoadMaps(kind);
    maps.map.repeat.set(1, repY);
    maps.rough.repeat.set(1, repY);
    return new THREE.MeshStandardMaterial({
      map: maps.map, roughnessMap: maps.rough, roughness: 1,
      metalness: 0.06, envMapIntensity: 0.75,
    });
  };

  // --- STREET NETWORK: segments at arbitrary angles + arcs + roundabout ---
  const segRoad = (x0: number, z0: number, x1: number, z1: number, w: number, y: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, len),
      roadMaterial(w >= 16 ? 'boulevard' : 'highway', Math.max(1, Math.round(len / 26))),
    );
    mesh.rotation.x = -Math.PI / 2;
    // plane length axis is local +Y; rotate it onto the segment direction
    mesh.rotation.z = Math.atan2(x1 - x0, z1 - z0) + Math.PI;
    mesh.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };
  const layoutStreets = arenaIdx === 1 ? STREETS_DOCKS : STREETS;
  layoutStreets.forEach(([x0, z0, x1, z1, w], i) => segRoad(x0, z0, x1, z1, w, 0.03 + (i % 4) * 0.004));

  // perimeter corner arcs (town only — the docks are a hard grid)
  for (const [cx, cz, r, th0, thLen, w] of (arenaIdx === 1 ? [] : ARCS)) {
    const arc = new THREE.Mesh(arcRoadGeometry(r, w / 2, th0, thLen), roadMaterial('highway', 1));
    arc.material.map!.repeat.set(1, 1);
    arc.material.roughnessMap!.repeat.set(1, 1);
    arc.position.set(cx, 0.028, cz);
    arc.receiveShadow = true;
    scene.add(arc);
  }

  // ROUNDABOUT: ring + drivable pavers island (TM-style — cut across at will)
  if (arenaIdx === 0) {
    const ring = new THREE.Mesh(
      arcRoadGeometry(ROUNDABOUT.r, ROUNDABOUT.w / 2), roadMaterial('highway', 1));
    ring.material.map!.repeat.set(1, 1);
    ring.material.roughnessMap!.repeat.set(1, 1);
    ring.position.y = 0.07;
    ring.receiveShadow = true;
    scene.add(ring);
    const island = new THREE.Mesh(
      new THREE.CircleGeometry(ROUNDABOUT.islandR, 40),
      new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 0.9, color: 0xc9b590 }),
    );
    (island.material as THREE.MeshStandardMaterial).map!.repeat.set(2, 2);
    island.rotation.x = -Math.PI / 2;
    island.position.y = 0.075;
    island.receiveShadow = true;
    scene.add(island);
  }

  // junction pads with crosswalks + stop lines at every street crossing
  const junctionMaps = makeJunctionMaps();
  const junction = (x: number, z: number, size: number, yaw = 0, y = 0.08) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({
        map: junctionMaps.map, roughnessMap: junctionMaps.rough, roughness: 1,
        metalness: 0.06, envMapIntensity: 0.75,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = yaw;
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };
  if (arenaIdx === 1) {
    for (const [jx, jz, size] of JUNCTIONS_DOCKS) junction(jx, jz, size);
  } else {
    // diagonal avenues × connectors — all four crossings coincide at (±88,±88)
    junction(88, -88, 26, Math.PI / 4); junction(-88, 88, 26, Math.PI / 4);
    junction(88, 88, 26, Math.PI / 4); junction(-88, -88, 26, Math.PI / 4);
    // connectors × perimeter (T-junctions)
    for (const s of [1, -1]) {
      junction(s * 88, -138, 18); junction(s * 88, 138, 18);
      junction(138, s * 88, 18); junction(-138, s * 88, 18);
    }
  }

  // curbs: showcase streets only (diagonals near the roundabout + island edge)
  const curbMat = new THREE.MeshStandardMaterial({ color: 0x9a8d7a, roughness: 0.82 });
  // lip stays below the bloom threshold — a brighter one blows out into blobs
  const curbLipMat = new THREE.MeshStandardMaterial({ color: 0xaa9d88, roughness: 0.85 });
  const curbRun = (cx: number, cz: number, hx: number, hz: number, yaw = 0) => {
    addDecoBox(scene, curbMat, cx, 0.11, cz, hx, 0.11, hz, yaw);
    addDecoBox(scene, curbLipMat, cx, 0.225, cz, hx * 0.96, 0.02, hz * 0.96, yaw);
  };
  if (arenaIdx === 0) {
    // island ring curb (40 short segments around the roundabout island)
    for (let i = 0; i < 40; i++) {
      const t = (i / 40) * Math.PI * 2;
      const r = ROUNDABOUT.islandR + 0.3;
      curbRun(Math.cos(t) * r, Math.sin(t) * r, 1.3, 0.3, -t);
    }
    // avenue curbs from the roundabout out to the tunnel portals (both diagonals),
    // set just off the 18m avenue edges; d = distance along the diagonal
    for (const s of [1, -1]) {
      for (const side of [1, -1]) {
        // main avenue (1,-1): runs from d=24 to d=38 (portal at ~39.6)
        const d0 = 24, d1 = 38, dm = (d0 + d1) / 2, hl = (d1 - d0) / 2;
        const off = (18 / 2 + 0.4) * side;
        // unit along = (0.707, -0.707); unit perp = (0.707, 0.707)
        curbRun(s * dm * 0.707 + off * 0.707, -s * dm * 0.707 + off * 0.707, hl, 0.3, Math.PI / 4);
        // cross avenue (1,1)
        const off2 = (14 / 2 + 0.4) * side;
        curbRun(s * dm * 0.707 + off2 * 0.707, s * dm * 0.707 - off2 * 0.707, hl, 0.3, -Math.PI / 4);
      }
    }
  } else {
    // NEON DOCKS: black harbor water beyond the east wall, catching the sky
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(360, 700),
      new THREE.MeshStandardMaterial({
        color: 0x06121e, roughness: 0.15, metalness: 0.85,
        envMapIntensity: 1.2,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(H + 180, -0.4, 0);
    scene.add(water);
  }

  // boost pad chevron visual (shared by both arena paths)
  const chevronTex = (() => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(255, 150, 20, 0.95)';
    for (const off of [0, 44, 88]) {
      g.beginPath();
      g.moveTo(off, 8); g.lineTo(off + 30, 32); g.lineTo(off, 56);
      g.lineTo(off + 14, 56); g.lineTo(off + 44, 32); g.lineTo(off + 14, 8);
      g.closePath();
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const padVisual = (x: number, y: number, z: number, alongX: boolean) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 3.6),
      new THREE.MeshStandardMaterial({
        map: chevronTex, transparent: true,
        emissive: 0xffffff, emissiveMap: chevronTex, emissiveIntensity: 1.1,
        roughness: 0.6,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    if (!alongX) mesh.rotation.z = Math.PI / 2;
    mesh.position.set(x, y + 0.09, z);
    scene.add(mesh);
  };

  // ============== BLENDER-AUTHORED ARENA (arena.glb) ==============
  // All structures, colliders and gameplay markers come from the GLB;
  // everything above (sky, ground, roads, curbs) plus the return below is
  // the only code-side contribution. Falls through to the procedural city
  // if the GLB failed to load.
  const glb = getArenaScene(arenaIdx);
  if (glb) {
    const data = consumeArenaGLB(world, scene, glb);
    for (const pad of data.boostPads) padVisual(pad.x, pad.y, pad.z, pad.hx >= pad.hz);
    return { ...data, skyIdx, envColors: { top: sky.top, hor: sky.hor } };
  }

  // --- materials ---
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4d4460, roughness: 0.9 });
  const rampMat = new THREE.MeshStandardMaterial({ color: 0x6e6455, roughness: 0.75 });
  const platMat = new THREE.MeshStandardMaterial({ color: 0x46516b, roughness: 0.8 });
  const neonMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0xff5500, emissiveIntensity: 2.2, roughness: 0.4 });
  const neonCyanMat = new THREE.MeshStandardMaterial({ color: 0x22ccff, emissive: 0x11aaff, emissiveIntensity: 2.0, roughness: 0.4 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x24202c, roughness: 0.95 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x33303c, roughness: 0.8 });

  // --- perimeter walls + neon trim ---
  const wallH = 4;
  addBox(world, scene, wallMat, 0, wallH / 2, -H - 1, H + 2, wallH / 2, 1);
  addBox(world, scene, wallMat, 0, wallH / 2, H + 1, H + 2, wallH / 2, 1);
  addBox(world, scene, wallMat, -H - 1, wallH / 2, 0, 1, wallH / 2, H + 2);
  addBox(world, scene, wallMat, H + 1, wallH / 2, 0, 1, wallH / 2, H + 2);
  addDecoBox(scene, neonMat, 0, wallH + 0.15, -H - 1, H + 2, 0.12, 0.5);
  addDecoBox(scene, neonMat, 0, wallH + 0.15, H + 1, H + 2, 0.12, 0.5);
  addDecoBox(scene, neonMat, -H - 1, wallH + 0.15, 0, 0.5, 0.12, H + 2);
  addDecoBox(scene, neonMat, H + 1, wallH + 0.15, 0, 0.5, 0.12, H + 2);

  // --- central interchange: N-S boulevard bridges the E-W street (widened) ---
  const deckTop = 3.7;
  addBox(world, scene, platMat, 0, (deckTop - 0.6) / 2, -8.2, 10, (deckTop - 0.6) / 2, 1.2);
  addBox(world, scene, platMat, 0, (deckTop - 0.6) / 2, 8.2, 10, (deckTop - 0.6) / 2, 1.2);
  addBox(world, scene, platMat, 0, deckTop - 0.3, 0, 10, 0.3, 9.4);
  addDecoBox(scene, neonCyanMat, 0, deckTop + 0.08, -9.25, 10, 0.1, 0.15);
  addDecoBox(scene, neonCyanMat, 0, deckTop + 0.08, 9.25, 10, 0.1, 0.15);
  addBox(world, scene, platMat, -9.6, deckTop + 0.25, 0, 0.4, 0.25, 9.4);
  addBox(world, scene, platMat, 9.6, deckTop + 0.25, 0, 0.4, 0.25, 9.4);
  // high end must face the deck: yaw π when approaching from +Z, yaw 0 from -Z
  addRamp(world, scene, rampMat, 0, 17, Math.PI, 14, 10, deckTop - 0.15);  // south approach
  addRamp(world, scene, rampMat, 0, -17, 0, 14, 10, deckTop - 0.15);       // north approach

  // --- city blocks: 4 buildings per quadrant, alleys ≥13m (6.5×) ---
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x2a2530, roughness: 0.7, metalness: 0.35 });
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x3a3640, roughness: 0.6, metalness: 0.5 });
  const KINDS: BuildingKind[] = ['glass', 'concrete', 'brick'];
  const building = (cx: number, cz: number, hx: number, hy: number, hz: number, tint: number, yaw = 0, kindIdx = 0) => {
    const kind = KINDS[kindIdx % 3];
    const cols = Math.max(3, Math.round(hx * 0.95));
    const floors = Math.max(3, Math.round(hy * 0.85));
    const tex = makeBuildingTextures(kind, cols, floors, tint);
    const sideMat = new THREE.MeshStandardMaterial({
      map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      metalness: kind === 'glass' ? 0.55 : 0.1, roughness: 0.9,
      emissive: 0xffffff, emissiveMap: tex.map, emissiveIntensity: kind === 'glass' ? 0.18 : 0.32,
    });
    // main mass keeps the full-footprint collider
    addProp(world, scene, [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat], cx, hy, cz, hx, hy, hz, yaw);

    // --- decorative architecture (no colliders) ---
    const q = yaw;
    // base plinth — a darker, slightly wider ground band
    addDecoBox(scene, trimMat, cx, 0.7, cz, hx * 1.04, 0.7, hz * 1.04, q);
    // parapet cap ringing the roof (cornice)
    addDecoBox(scene, trimMat, cx, hy * 2 + 0.25, cz, hx * 1.03, 0.35, hz * 1.03, q);
    // horizontal floor ledges break up the facade
    const bands = Math.max(1, Math.round(hy / 2.5));
    for (let b = 1; b <= bands; b++) {
      const by = (hy * 2) * (b / (bands + 1));
      addDecoBox(scene, trimMat, cx, by, cz, hx * 1.015, 0.14, hz * 1.015, q);
    }
    // corner pilasters — vertical relief that gives real silhouette
    const cxr = Math.cos(q), szr = Math.sin(q);
    for (const [ox, oz] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]] as const) {
      const px = cx + ox * cxr - oz * szr;
      const pz = cz + ox * szr + oz * cxr;
      addDecoBox(scene, trimMat, px, hy, pz, 0.35, hy, 0.35, q);
    }
    // rooftop clutter — AC units, vents, a stair penthouse
    const roofY = hy * 2 + 0.5;
    addDecoBox(scene, ventMat, cx + hx * 0.3, roofY + 0.4, cz - hz * 0.2, hx * 0.35, 0.6, hz * 0.28, q);
    addDecoBox(scene, ventMat, cx - hx * 0.35, roofY + 0.25, cz + hz * 0.3, 0.5, 0.4, 0.5, q);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 1.4, 8), ventMat);
    stack.position.set(cx - hx * 0.2, roofY + 0.7, cz - hz * 0.35);
    stack.castShadow = true;
    scene.add(stack);
  };
  const blocks: [number, number, number, number, number][] = [
    [26, 26, 6, 3.5, 6],
    [52, 30, 7, 5, 6],
    [30, 54, 6, 7, 6],
    [56, 56, 6, 4.5, 5],
  ];
  const tints = [0x4a3f55, 0x5c4438, 0x52405c, 0x40485a, 0x55404a, 0x463c58, 0x584842, 0x3f4652];
  let ti = 0;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    blocks.forEach(([bx, bz, hx, hy, hz], i) => {
      const hVar = hy + ((sx * 3 + sz * 5 + i) % 3) * 0.8;
      // STAGE 1: the NE-quadrant corner block is authored in Blender (recessed
      // windows, roof assets, COL_ proxy). Rest still procedural for now.
      const blenderSrc = getArenaBuilding();
      if (blenderSrc && i === 0 && sx === 1 && sz === 1) {
        placeBlenderAsset(world, scene, blenderSrc, bx * sx, bz * sz, 0.06);
        ti++;
        return;
      }
      building(bx * sx, bz * sz, hx, hVar, hz, tints[ti % tints.length], (sx * sz * (i + 1)) * 0.06, ti++);
    });
  }

  // --- rooftop billboards ---
  const billboard = (x: number, y: number, z: number, yaw: number, lines: string[], bg: string, fg: string) => {
    const tex = makeSignTexture(lines, bg, fg);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 5.5),
      new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.7, side: THREE.DoubleSide }),
    );
    panel.position.set(x, y, z);
    panel.rotation.y = yaw;
    scene.add(panel);
    addDecoBox(scene, canopyMat, x, y - 3.4, z, 0.3, 1.2, 0.3, yaw);
  };
  billboard(30, 18.5, 54, Math.PI * 0.25, ['STEEL', 'RAMPAGE'], '#1a1020', '#ff7a20');
  billboard(-30, 18.5, -54, Math.PI * 1.25, ["VINNY'S", 'AUTO PARTS'], '#102018', '#7dffb0');

  // --- gas station (SE outer apron) ---
  building(106, -102, 4, 2.5, 3, 0x3c4048);
  addDecoBox(scene, canopyMat, 98, 4.6, -92, 6, 0.3, 5);
  addDecoBox(scene, neonCyanMat, 98, 4.25, -92, 6.05, 0.08, 5.05);
  for (const [px, pz] of [[93.5, -88], [102.5, -88], [93.5, -96], [102.5, -96]] as const) {
    addProp(world, scene, canopyMat, px, 2.2, pz, 0.3, 2.2, 0.3);
  }
  const gasTex = makeSignTexture(['GAS'], '#701818', '#ffd898');
  const gasSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 2.5),
    new THREE.MeshStandardMaterial({ map: gasTex, emissive: 0xffffff, emissiveMap: gasTex, emissiveIntensity: 0.8, side: THREE.DoubleSide }),
  );
  gasSign.position.set(91, 5.8, -92);
  gasSign.rotation.y = -Math.PI / 2;
  scene.add(gasSign);
  addProp(world, scene, canopyMat, 91, 2.2, -92, 0.3, 2.2, 0.3);

  // --- shield bunkers (outer apron, E and W) ---
  const bunkerMat = new THREE.MeshStandardMaterial({ color: 0x6b5e82, roughness: 0.85 });
  addProp(world, scene, bunkerMat, 104, 1.8, -14, 1, 1.8, 7);
  addProp(world, scene, bunkerMat, 98, 1.8, -8, 7, 1.8, 1);
  addProp(world, scene, bunkerMat, -104, 1.8, 14, 1, 1.8, 7);
  addProp(world, scene, bunkerMat, -98, 1.8, 8, 7, 1.8, 1);

  // --- stunt ramps on the outer apron ---
  addRamp(world, scene, rampMat, 100, 34, -Math.PI / 2, 10, 7, 2.6);
  addRamp(world, scene, rampMat, -100, -34, Math.PI / 2, 10, 7, 2.6);
  addRamp(world, scene, rampMat, 34, 100, Math.PI, 10, 7, 2.6);
  addRamp(world, scene, rampMat, -34, -100, 0, 10, 7, 2.6);

  // --- streetlights (thin colliders: 0.10 physics vs 0.14 visual) ---
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c2836, roughness: 0.8 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffc86a, emissiveIntensity: 2.6 });
  const streetlight = (x: number, z: number, facing: number) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 2.6, z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 2.6, 0.1), body);
    addDecoBox(scene, poleMat, x, 2.6, z, 0.14, 2.6, 0.14);
    const armX = x + Math.sin(facing) * 1.4;
    const armZ = z + Math.cos(facing) * 1.4;
    addDecoBox(scene, poleMat, (x + armX) / 2, 5.1, (z + armZ) / 2, Math.abs(armX - x) / 2 + 0.08, 0.08, Math.abs(armZ - z) / 2 + 0.08);
    addDecoBox(scene, lampMat, armX, 5.0, armZ, 0.35, 0.1, 0.35);
  };
  for (const c of [-100, -70, -40, 40, 70, 100]) {
    streetlight(-12.8, c, Math.PI / 2);
    streetlight(12.8, c, -Math.PI / 2);
    streetlight(c, -12.8, 0);
    streetlight(c, 12.8, Math.PI);
  }

  // --- corner light towers ---
  for (const [px, pz] of [[-114, -114], [114, -114], [-114, 114], [114, 114]] as const) {
    addDecoBox(scene, poleMat, px, 6, pz, 0.5, 6, 0.5);
    addDecoBox(scene, neonCyanMat, px, 12.2, pz, 1.1, 0.35, 1.1);
  }

  // --- street clutter (rounded colliders — no snagging) ---
  const wreckMat = new THREE.MeshStandardMaterial({ color: 0x3a3230, roughness: 0.95, metalness: 0.3 });
  const wreck = (x: number, z: number, yaw: number) => {
    addProp(world, scene, wreckMat, x, 0.55, z, 0.95, 0.55, 2.0, yaw);
    addDecoBox(scene, wreckMat, x, 1.25, z, 0.8, 0.28, 1.0, yaw);
  };
  wreck(15, -52, 0.25);
  wreck(-15, 34, -0.12);
  wreck(15.5, 88, 2.9);
  wreck(-95, -15, 1.7);   // off the ring's west lane — was a highway snag
  const dumpMat = new THREE.MeshStandardMaterial({ color: 0x2a4034, roughness: 0.9 });
  addProp(world, scene, dumpMat, -44, 1, 44, 2, 1, 1, 0.3);
  addProp(world, scene, dumpMat, 44, 1, -44, 2, 1, 1, -0.4);

  // --- the SKYWAY: an elevated roller-coaster track you drive with full
  //     control — on-ramps both ends, rolling humps, guard rails, real physics ---
  const trackMat = new THREE.MeshStandardMaterial({
    color: 0xff6d00, roughness: 0.5, metalness: 0.2,
    emissive: 0xff4400, emissiveIntensity: 0.25,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xffa040, emissive: 0xff7710, emissiveIntensity: 1.4, roughness: 0.4,
  });
  const SKY_Z = -78;
  const skySeg = (x0: number, x1: number, yA: number, yB: number) => {
    const len = Math.hypot(x1 - x0, yB - yA);
    const phi = Math.atan2(yB - yA, x1 - x0);
    const cx = (x0 + x1) / 2;
    const cy = (yA + yB) / 2 - 0.25;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), phi);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, SKY_Z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(len / 2, 0.25, 5).setFriction(0.7), body);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, 10), trackMat);
    deck.position.set(cx, cy, SKY_Z);
    deck.quaternion.copy(q);
    deck.castShadow = true;
    deck.receiveShadow = true;
    scene.add(deck);
    // guard rails (collidable — keeps you on at speed, still jumpable over humps)
    for (const zOff of [-4.85, 4.85]) {
      const railBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy + 0.55, SKY_Z + zOff).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
      );
      world.createCollider(RAPIER.ColliderDesc.cuboid(len / 2, 0.3, 0.15).setFriction(0.1), railBody);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.6, 0.3), railMat);
      rail.position.set(cx, cy + 0.55, SKY_Z + zOff);
      rail.quaternion.copy(q);
      scene.add(rail);
    }
    // support pylons every segment
    addDecoBox(scene, canopyMat, cx, cy / 2, SKY_Z + 4, 0.4, Math.max(0.4, cy / 2), 0.4);
    addDecoBox(scene, canopyMat, cx, cy / 2, SKY_Z - 4, 0.4, Math.max(0.4, cy / 2), 0.4);
  };
  // profile: west on-ramp → flats & humps (airtime at speed) → east on-ramp
  skySeg(-68, -48, 0.1, 6.5);    // west climb
  skySeg(-48, -36, 6.5, 6.5);
  skySeg(-36, -26, 6.5, 5.6);    // gentle dip
  skySeg(-26, -12, 5.6, 7.4);    // crest — airtime only at boosted speeds
  skySeg(-12, 0, 7.4, 6.2);
  skySeg(0, 10, 6.2, 6.2);       // flat (boost pad)
  skySeg(10, 22, 6.2, 7.0);      // second crest
  skySeg(22, 34, 7.0, 5.8);
  skySeg(34, 48, 5.8, 6.5);
  skySeg(48, 68, 6.5, 0.1);      // east descent

  const boostPads: ArenaData['boostPads'] = [];
  const buildPad = (x: number, z: number, alongX: boolean, y = 0) => {
    padVisual(x, y, z, alongX);
    boostPads.push(alongX ? { x, y, z, hx: 3.5, hz: 1.8 } : { x, y, z, hx: 1.8, hz: 3.5 });
  };
  buildPad(-58, -78, true);   // skyway west approach (under the on-ramp start)
  buildPad(58, -78, true);    // skyway east approach
  buildPad(5, -78, true, 6.2); // ON the skyway deck — chain the humps at speed
  buildPad(-26, 78, true);    // south ring straight
  buildPad(26, 78, true);
  buildPad(0, -52, false);    // boulevard approaches
  buildPad(0, 52, false);
  buildPad(-52, 0, true);
  buildPad(52, 0, true);

  // --- spawn points: on the ring, facing along it ---
  const spawnPoints = [
    { pos: new THREE.Vector3(78, 1.2, 0), yaw: 0 },
    { pos: new THREE.Vector3(-78, 1.2, 0), yaw: Math.PI },
    { pos: new THREE.Vector3(0, 1.2, 78), yaw: Math.PI / 2 },
    { pos: new THREE.Vector3(0, 1.2, -78), yaw: -Math.PI / 2 },
    { pos: new THREE.Vector3(55, 1.2, 55), yaw: Math.PI * 0.25 },
    { pos: new THREE.Vector3(-55, 1.2, -55), yaw: -Math.PI * 0.75 },
    { pos: new THREE.Vector3(55, 1.2, -55), yaw: -Math.PI * 0.25 },
    { pos: new THREE.Vector3(-55, 1.2, 55), yaw: Math.PI * 0.75 },
  ];

  // --- items: offense central/high-risk, defense peripheral (LEVEL-DESIGN.md §4) ---
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const pickupPoints: ArenaData['pickupPoints'] = [
    // HIGH-RISK / OFFENSE
    { pos: P(0, deckTop + 1.0, 0), type: 'missiles' },              // bridge deck
    { pos: P(0, 0.9, 0), type: 'overdrive', alts: [P(0, 0.9, 0), P(41, 0.9, 41), P(-41, 0.9, -41)] }, // roams
    { pos: P(78, 0.9, 0), type: 'missiles' },                       // ring medians
    { pos: P(-78, 0.9, 0), type: 'missiles' },
    { pos: P(20, 0.9, -78), type: 'missiles' },   // under the skyway
    { pos: P(-20, 0.9, 78), type: 'missiles' },
    { pos: P(-12, 8.5, -78), type: 'missiles' },  // skyway big crest — earn it
    { pos: P(22, 8.1, -78), type: 'turbo' },      // skyway second crest
    { pos: P(41, 0.9, -41), type: 'mines' },                        // plaza pockets
    { pos: P(-41, 0.9, 41), type: 'mines' },
    { pos: P(38, 0.9, -28), type: 'mines' },
    // PERIPHERAL / DEFENSE & UTILITY
    { pos: P(100, 0.9, -11), type: 'shield' },                      // bunkers
    { pos: P(-100, 0.9, 11), type: 'shield' },
    { pos: P(105, 0.9, 105), type: 'turbo' },                       // outer corners
    { pos: P(-105, 0.9, -105), type: 'turbo' },
    { pos: P(-105, 0.9, 60), type: 'turbo' },
    { pos: P(38, 0.9, 28), type: 'health' },                        // quadrant alleys
    { pos: P(-38, 0.9, -28), type: 'health' },
    { pos: P(0, 0.9, -105), type: 'health' },
    { pos: P(-38, 0.9, 28), type: 'health' },
  ];

  const barrelPoints = [
    // gas station cluster
    P(98, 0.95, -92).clone(), P(96, 0.95, -89), P(99.5, 0.95, -89.5),
    // ring chamfer hazards
    P(62, 0.95, 48), P(-62, 0.95, -48), P(48, 0.95, -62), P(-48, 0.95, 62),
    // boulevard median hazards
    P(0, 0.95, 40), P(0, 0.95, -40), P(40, 0.95, 0), P(-40, 0.95, 0),
  ];

  // --- pedestrian zones: sidewalks + plaza pockets ---
  const pedZones: PedZone[] = [
    { x: 12.8, z: -60, hx: 1.8, hz: 45 },
    { x: -12.8, z: 60, hx: 1.8, hz: 45 },
    { x: 60, z: 12.8, hx: 45, hz: 1.8 },
    { x: -60, z: -12.8, hx: 45, hz: 1.8 },
    { x: 41, z: 41, hx: 4, hz: 4 },
    { x: -41, z: -41, hx: 4, hz: 4 },
    { x: 41, z: -41, hx: 4, hz: 4 },
    { x: -41, z: 41, hx: 4, hz: 4 },
  ];

  return { spawnPoints, pickupPoints, barrelPoints, pedZones, boostPads, pumpPoints: [], skyIdx, envColors: { top: sky.top, hor: sky.hor } };
}
