import * as THREE from 'three';

/**
 * Ground clutter: rubble, weeds, litter, kerbside junk and stains.
 *
 * The arenas are architecturally dense but read clean — big flat lots with
 * nothing on them, which is what makes a game map look like a game map. This
 * scatters thousands of small decorative items with no colliders, so the
 * driving surface is unchanged and the whole pass costs a handful of draw
 * calls (one InstancedMesh per clutter type).
 *
 * Placement is validated against an occupancy grid built from the scene's own
 * mesh bounds rather than a list of keep-out rectangles, so the scatter follows
 * whatever the Blender arena actually contains, including assets this file
 * knows nothing about. It can't use physics raycasts for this: Rapier's query
 * pipeline is empty until the first world.step(), and buildArena runs long
 * before that, so every cast comes back null.
 */

/** deterministic PRNG so every client scatters identically */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** shortest distance from a point to a segment, in the XZ plane */
function distToSegment(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0, dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / len2)) : 0;
  return Math.hypot(px - (x0 + dx * t), pz - (z0 + dz * t));
}

export interface ScatterOpts {
  scene: THREE.Scene;
  half: number;
  streets: [number, number, number, number, number][];
  /** keep clutter off these entirely — spawns, pickups, boost pads */
  keepClear: THREE.Vector3[];
  /** warm sunbaked town vs cold wet harbour */
  palette: 'warm' | 'cold';
  seed: number;
}

interface Placement {
  x: number;
  z: number;
  /** distance to the nearest road edge; negative means on the road */
  edge: number;
}

const GRID_CELL = 2;

/**
 * Mark every grid cell covered by something standing on the ground.
 *
 * Anything large in BOTH horizontal axes is scenery rather than an obstacle —
 * the ground plane, the sky dome, the skyline cylinder, the harbour water — and
 * marking those would occupy the entire map. Long thin boxes are walls and do
 * count, so the test is on the SMALLER of the two extents.
 */
function buildOccupancy(scene: THREE.Scene, half: number): { grid: Uint8Array; n: number } {
  const n = Math.ceil((half * 2) / GRID_CELL);
  const grid = new Uint8Array(n * n);
  const box = new THREE.Box3();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    box.setFromObject(m);
    if (!isFinite(box.min.x) || box.max.y <= 0.4) return;
    const ex = box.max.x - box.min.x, ez = box.max.z - box.min.z;
    if (Math.min(ex, ez) > 40) return;
    const i0 = Math.max(0, Math.floor((box.min.x + half) / GRID_CELL));
    const i1 = Math.min(n - 1, Math.floor((box.max.x + half) / GRID_CELL));
    const j0 = Math.max(0, Math.floor((box.min.z + half) / GRID_CELL));
    const j1 = Math.min(n - 1, Math.floor((box.max.z + half) / GRID_CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * n + i] = 1;
  });
  return { grid, n };
}

/**
 * Find valid clutter positions. `onRoad` picks whether we want spots on the
 * driving surface (for stains and grit) or off it (for everything solid).
 */
function samplePlacements(
  o: ScatterOpts, occ: { grid: Uint8Array; n: number },
  rng: () => number, count: number, onRoad: boolean,
): Placement[] {
  const out: Placement[] = [];
  for (let tries = 0; tries < count * 14 && out.length < count; tries++) {
    const x = (rng() * 2 - 1) * (o.half - 4);
    const z = (rng() * 2 - 1) * (o.half - 4);

    let edge = Infinity;
    for (const [x0, z0, x1, z1, w] of o.streets) {
      edge = Math.min(edge, distToSegment(x, z, x0, z0, x1, z1) - w / 2);
    }
    if (onRoad) {
      if (edge > -1.5) continue;            // want to be well inside a lane
    } else if (edge < 1.0 || edge > 13) {
      // hug the kerbs: on the road is wrong, and the far middle of a lot is
      // where clutter stops reading as roadside and starts looking random
      continue;
    }

    if (o.keepClear.some((p) => Math.hypot(p.x - x, p.z - z) < 7)) continue;

    const i = Math.floor((x + o.half) / GRID_CELL);
    const j = Math.floor((z + o.half) / GRID_CELL);
    if (i < 0 || j < 0 || i >= occ.n || j >= occ.n || occ.grid[j * occ.n + i]) continue;

    out.push({ x, z, edge });
  }
  return out;
}

/** one InstancedMesh, filled from a per-instance transform callback */
function instance(
  scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material,
  spots: Placement[], place: (m: THREE.Object3D, p: Placement, i: number) => void,
  tint?: (c: THREE.Color, i: number) => void,
): THREE.InstancedMesh | null {
  if (!spots.length) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  spots.forEach((p, i) => {
    dummy.position.set(p.x, 0, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    place(dummy, p, i);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (tint) { tint(col, i); mesh.setColorAt(i, col); }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (tint && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

/** crossed alpha quads — reads as a tuft of dry grass from any angle */
function tuftGeometry(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  // merged by hand rather than pulling in BufferGeometryUtils for two planes
  const geo = new THREE.BufferGeometry();
  const posA = a.getAttribute('position').array as Float32Array;
  const posB = b.getAttribute('position').array as Float32Array;
  const uvA = a.getAttribute('uv').array as Float32Array;
  const normA = a.getAttribute('normal').array as Float32Array;
  const normB = b.getAttribute('normal').array as Float32Array;
  const pos = new Float32Array(posA.length + posB.length);
  pos.set(posA, 0); pos.set(posB, posA.length);
  const nrm = new Float32Array(normA.length + normB.length);
  nrm.set(normA, 0); nrm.set(normB, normA.length);
  const uv = new Float32Array(uvA.length * 2);
  uv.set(uvA, 0); uv.set(uvA, uvA.length);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const idxA = Array.from(a.getIndex()!.array);
  const offset = posA.length / 3;
  geo.setIndex([...idxA, ...idxA.map((i) => i + offset)]);
  a.dispose(); b.dispose();
  return geo;
}

/** a ragged tuft silhouette — blades fanning up from the base */
function tuftTexture(warm: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  for (let i = 0; i < 16; i++) {
    const x = 6 + Math.random() * 52;
    const h = 20 + Math.random() * 40;
    const lean = (Math.random() - 0.5) * 16;
    const shade = warm ? 70 + Math.random() * 45 : 55 + Math.random() * 35;
    g.strokeStyle = warm
      ? `rgb(${shade + 40},${shade + 28},${Math.round(shade * 0.55)})`
      : `rgb(${Math.round(shade * 0.7)},${shade + 14},${Math.round(shade * 0.6)})`;
    g.lineWidth = 1.2 + Math.random() * 1.4;
    g.beginPath();
    g.moveTo(x, 64);
    g.quadraticCurveTo(x + lean * 0.4, 64 - h * 0.6, x + lean, 64 - h);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** soft dark blot for oil stains and damp patches */
function stainTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  for (let i = 0; i < 14; i++) {
    const x = 34 + Math.random() * 60, y = 34 + Math.random() * 60;
    const r = 10 + Math.random() * 28;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(10,9,12,0.55)');
    grd.addColorStop(0.6, 'rgba(14,12,16,0.26)');
    grd.addColorStop(1, 'rgba(14,12,16,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

export function addScatter(o: ScatterOpts): THREE.Object3D[] {
  const rng = mulberry32(o.seed);
  const occ = buildOccupancy(o.scene, o.half);
  const added: THREE.Object3D[] = [];
  const warm = o.palette === 'warm';
  const push = (m: THREE.Object3D | null) => { if (m) added.push(m); };

  const concrete = new THREE.MeshStandardMaterial({
    color: warm ? 0x6f6554 : 0x4e525a, roughness: 0.97, metalness: 0.03,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x2b2a2e, roughness: 0.75, metalness: 0.45,
  });
  const timber = new THREE.MeshStandardMaterial({
    color: warm ? 0x7a5c3a : 0x5b4a39, roughness: 0.92,
  });
  const litterMat = new THREE.MeshStandardMaterial({
    color: warm ? 0xbdb29b : 0x8e9399, roughness: 0.9, side: THREE.DoubleSide,
  });

  // --- rubble: small angular chunks along every kerb, the workhorse of the pass
  const rubble = samplePlacements(o, occ, rng, 1900, false);
  push(instance(o.scene, new THREE.DodecahedronGeometry(0.17, 0), concrete, rubble, (m) => {
    const s = 0.4 + rng() * 1.5;
    m.scale.set(s, s * (0.45 + rng() * 0.5), s);
    m.rotation.set(rng() * 3, rng() * 6.28, rng() * 3);
    m.position.y = 0.03 + s * 0.05;
  }, (c) => {
    // broken kerb, old asphalt and dirt-caked stone all end up in the same pile
    const v = 0.5 + rng() * 0.7;
    c.setRGB(v, v * (0.9 + rng() * 0.12), v * (0.76 + rng() * 0.18));
  }));

  // --- grit flecks strewn further out, flat to the ground
  const grit = samplePlacements(o, occ, rng, 1200, false);
  push(instance(o.scene, new THREE.CircleGeometry(0.22, 5), concrete, grit, (m) => {
    const s = 0.5 + rng() * 1.3;
    m.scale.set(s, s, s);
    m.rotation.set(-Math.PI / 2, 0, rng() * 6.28);
    m.position.y = 0.015;
  }, (c) => {
    const v = 0.4 + rng() * 0.6;
    c.setRGB(v, v * 0.95, v * 0.86);
  }));

  // --- weed tufts in the kerb line and lot cracks
  const tufts = samplePlacements(o, occ, rng, 1700, false);
  const tuftMat = new THREE.MeshStandardMaterial({
    map: tuftTexture(warm), transparent: true, alphaTest: 0.35,
    side: THREE.DoubleSide, roughness: 1,
  });
  push(instance(o.scene, tuftGeometry(), tuftMat, tufts, (m) => {
    const s = 0.4 + rng() * 0.65;
    m.scale.set(s, s * (0.8 + rng() * 0.7), s);
    m.rotation.y = rng() * 6.28;
  }, (c) => {
    // scorched yellow through to the odd green survivor
    const dry = rng();
    c.setRGB(0.85 + rng() * 0.2, 0.7 + dry * 0.3, 0.35 + dry * 0.25);
  }));

  // --- litter: flat scraps of paper and plastic that catch the light
  const litter = samplePlacements(o, occ, rng, 320, false);
  push(instance(o.scene, new THREE.PlaneGeometry(0.3, 0.42), litterMat, litter, (m) => {
    m.rotation.set(-Math.PI / 2 + (rng() - 0.5) * 0.5, rng() * 6.28, 0);
    m.position.y = 0.02;
    const s = 0.6 + rng() * 0.9;
    m.scale.set(s, s, s);
  }));

  // --- kerbside junk: tyres and pallets, only hard against the edge where a
  // car has no business being anyway
  const junk = samplePlacements(o, occ, rng, 260, false).filter((p) => p.edge < 4.5);
  const tyres = junk.filter((_, i) => i % 2 === 0);
  const pallets = junk.filter((_, i) => i % 2 === 1);
  push(instance(o.scene, new THREE.TorusGeometry(0.33, 0.13, 6, 12), darkMetal, tyres, (m) => {
    m.rotation.set(-Math.PI / 2, 0, rng() * 6.28);
    m.position.y = 0.13;
    const s = 0.8 + rng() * 0.5;
    m.scale.set(s, s, s);
  }));
  push(instance(o.scene, new THREE.BoxGeometry(1.0, 0.14, 0.8), timber, pallets, (m) => {
    m.rotation.set((rng() - 0.5) * 0.3, rng() * 6.28, (rng() - 0.5) * 0.3);
    m.position.y = 0.08;
  }));

  // --- stains on the driving surface: oil drips, damp patches, tyre scuff
  const stains = samplePlacements(o, occ, rng, 320, true);
  const stainMat = new THREE.MeshBasicMaterial({
    map: stainTexture(), transparent: true, opacity: warm ? 0.5 : 0.68,
    depthWrite: false,
  });
  const stainMesh = instance(o.scene, new THREE.PlaneGeometry(1, 1), stainMat, stains, (m) => {
    m.rotation.set(-Math.PI / 2, 0, rng() * 6.28);
    m.position.y = 0.025;
    const s = 1.6 + rng() * 4.5;
    m.scale.set(s, s, s);
  });
  if (stainMesh) {
    stainMesh.castShadow = false;
    stainMesh.receiveShadow = false;
    stainMesh.renderOrder = 1;      // sit on the road without z-fighting it
    added.push(stainMesh);
  }

  return added;
}
