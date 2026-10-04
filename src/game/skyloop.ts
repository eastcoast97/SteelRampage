import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PickupType } from './pickups';

/**
 * THE SKYLOOP — a continuous elevated circuit around the whole arena.
 *
 * A Hot-Wheels-style track: it climbs, drops, banks through the corners, and
 * has deliberate break-out gaps where the guard rail stops and a kicker ramp
 * throws you off the side to land on the street below. Two on-ramps let you get
 * up there from ground level.
 *
 * Design rules this follows, learned the hard way earlier in the project:
 *
 * - **Drivable, never scripted.** Phase 1.11 removed a scripted loop because it
 *   felt out-of-control and physics-defying. Nothing here moves the car; it is
 *   ordinary collider geometry and the car drives on it under its own physics.
 * - **It follows the perimeter road.** Routing the centreline along an existing
 *   street guarantees the whole thing is clear of buildings without needing an
 *   occupancy test, and means falling off always drops you onto tarmac.
 * - **Pylons stand in the verge, not the carriageway.** The deck is wider than
 *   the road, so its outer edge overhangs into the empty strip between the
 *   perimeter road and the arena wall. Legs go there, leaving the ground-level
 *   route underneath completely unobstructed.
 * - **Segment colliders overlap.** A car at 40 m/s will catch on any seam
 *   between two flush boxes, so each deck segment is built slightly long.
 */

export interface SkyLoopOpts {
  world: RAPIER.World;
  scene: THREE.Scene;
  /** half-extent of the arena; the loop is inset from this */
  half: number;
  /** material for the deck surface — shares the arena's road maps */
  deckMaterial: THREE.Material;
  /** darker trim material for rails, pylons and ramps */
  trimMaterial: THREE.Material;
  /** emissive accent for rail tops and kicker lips */
  neonMaterial: THREE.Material;
}

export interface SkyLoopResult {
  boostPads: { x: number; y: number; z: number; hx: number; hz: number }[];
  pickupPoints: { pos: THREE.Vector3; type: PickupType }[];
}

const DECK_HALF_W = 8;        // 16m deck — two cars abreast with room to fight
const DECK_THICK = 0.35;
const RAIL_H = 1.15;
const SEG_OVERLAP = 1.25;     // deck segments run long so seams can't catch
const PYLON_EVERY = 5;        // samples between support legs

/** corner radius and straight extent of the rounded-rect centreline */
const CORNER_R = 34;

interface Sample {
  pos: THREE.Vector3;
  /** unit tangent along the track */
  fwd: THREE.Vector3;
  /** banked up vector */
  up: THREE.Vector3;
  /** arc length from the start */
  s: number;
  /** curvature sign, for banking */
  bank: number;
}

/**
 * Walk a rounded rectangle, returning evenly spaced 2D centreline points with
 * the local curvature at each.
 */
function centreline(extent: number, spacing: number): { x: number; z: number; curve: number }[] {
  const pts: { x: number; z: number; curve: number }[] = [];
  const straight = extent - CORNER_R;
  const push = (x: number, z: number, curve: number) => pts.push({ x, z, curve });

  // four straights and four corner arcs, laid out clockwise from the north edge
  const corners: [number, number, number][] = [
    [straight, -straight, -Math.PI / 2],      // NE, arc start angle
    [straight, straight, 0],                  // SE
    [-straight, straight, Math.PI / 2],       // SW
    [-straight, -straight, Math.PI],          // NW
  ];
  const edges: [number, number, number, number][] = [
    [-straight, -extent, straight, -extent],  // north
    [extent, -straight, extent, straight],    // east
    [straight, extent, -straight, extent],    // south
    [-extent, straight, -extent, -straight],  // west
  ];

  for (let i = 0; i < 4; i++) {
    const [x0, z0, x1, z1] = edges[i];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.round(len / spacing));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, 0);
    }
    const [cx, cz, a0] = corners[i];
    const arcLen = (Math.PI / 2) * CORNER_R;
    const an = Math.max(3, Math.round(arcLen / spacing));
    for (let k = 0; k < an; k++) {
      const a = a0 + (Math.PI / 2) * (k / an);
      push(cx + Math.cos(a) * CORNER_R, cz + Math.sin(a) * CORNER_R, 1);
    }
  }
  return pts;
}

/** smooth a per-sample scalar so banking eases in and out of corners */
function smooth(values: number[], passes: number): number[] {
  let v = values.slice();
  const n = v.length;
  for (let p = 0; p < passes; p++) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = (v[(i - 1 + n) % n] + v[i] * 2 + v[(i + 1) % n]) / 4;
    }
    v = out;
  }
  return v;
}

export function buildSkyLoop(o: SkyLoopOpts): SkyLoopResult {
  const { world, scene } = o;
  const extent = o.half - 22;                 // sits over the perimeter road
  const raw = centreline(extent, 5.5);
  const n = raw.length;

  // height profile: two crests and two dips around the lap, so there is always
  // a climb to launch off and a drop to land in
  const bankRaw = raw.map((p) => p.curve);
  const banked = smooth(bankRaw, 6);
  const samples: Sample[] = [];
  let arc = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const y = 12.5 + Math.sin(t * Math.PI * 4) * 4.2;
    const prev = raw[(i - 1 + n) % n];
    const next = raw[(i + 1) % n];
    const fwd = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z).normalize();
    if (i > 0) arc += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
    // bank into the turn: roll the deck about its own forward axis
    const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const bankAngle = banked[i] * 0.42 * turnSign(prev, raw[i], next);
    const up = new THREE.Vector3(0, 1, 0).applyAxisAngle(fwd, bankAngle).normalize();
    samples.push({
      pos: new THREE.Vector3(raw[i].x, y, raw[i].z),
      fwd, up, s: arc, bank: bankAngle,
    });
    void side;
  }

  // break-out gaps: rail stops, a kicker lip throws the car clear of the deck.
  // Placed on the descending side of a crest so you are already going downhill.
  const gaps = [0.17, 0.42, 0.67, 0.92].map((t) => Math.floor(t * n));
  const GAP_SAMPLES = 4;
  const inGap = (i: number) => gaps.some((g) => {
    const d = Math.abs(((i - g + n + n / 2) % n) - n / 2);
    return d < GAP_SAMPLES;
  });

  // on-ramps climb from street level at two opposite points
  const ramps = [Math.floor(n * 0.04), Math.floor(n * 0.54)];
  const inRamp = (i: number) => ramps.some((r) => {
    const d = Math.abs(((i - r + n + n / 2) % n) - n / 2);
    return d < 3;
  });

  buildDeck(o, samples);
  buildRails(o, samples, (i) => inGap(i) || inRamp(i));
  buildKickers(o, samples, gaps);
  buildPylons(o, samples);
  for (const r of ramps) buildOnRamp(o, samples, r);

  // reward using the track: boosts on the climbs, pickups at the crests
  const boostPads: SkyLoopResult['boostPads'] = [];
  const pickupPoints: SkyLoopResult['pickupPoints'] = [];
  for (let k = 0; k < 4; k++) {
    const i = Math.floor(((k + 0.5) / 4) * n);
    const sm = samples[i];
    boostPads.push({ x: sm.pos.x, y: sm.pos.y + 0.12, z: sm.pos.z, hx: 4, hz: 4 });
  }
  for (let k = 0; k < 2; k++) {
    const i = Math.floor(((k + 0.25) / 2) * n);
    const sm = samples[i];
    pickupPoints.push({
      pos: new THREE.Vector3(sm.pos.x, sm.pos.y + 1.0, sm.pos.z),
      type: k === 0 ? 'missiles' : 'turbo',
    });
  }
  return { boostPads, pickupPoints };
}

/** which way the centreline is turning at this point, +1 or -1 */
function turnSign(
  a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number },
): number {
  const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
  return cross >= 0 ? 1 : -1;
}

/** orientation matrix for a sample: forward along the track, up banked */
function basisOf(sm: Sample, m: THREE.Matrix4, q: THREE.Quaternion): THREE.Quaternion {
  const right = new THREE.Vector3().crossVectors(sm.up, sm.fwd).normalize();
  const up = new THREE.Vector3().crossVectors(sm.fwd, right).normalize();
  m.makeBasis(right, up, sm.fwd);
  return q.setFromRotationMatrix(m);
}

function buildDeck(o: SkyLoopOpts, s: Sample[]) {
  const n = s.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const right = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const sm = s[i];
    right.crossVectors(sm.up, sm.fwd).normalize();
    const l = new THREE.Vector3().copy(sm.pos).addScaledVector(right, -DECK_HALF_W);
    const r = new THREE.Vector3().copy(sm.pos).addScaledVector(right, DECK_HALF_W);
    pos.push(l.x, l.y, l.z, r.x, r.y, r.z);
    const v = sm.s / 14;
    uv.push(0, v, 1, v);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1;
    const c = ((i + 1) % n) * 2, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, o.deckMaterial);
  mesh.receiveShadow = true;
  o.scene.add(mesh);

  // One trimesh for the whole deck, built from the exact vertices we just drew.
  // A chain of per-segment boxes was tried first and does not work: in a banked
  // corner the overlapping rotated boxes push their inner corners up through
  // the surface, and probing the inner lanes found 0.59-0.86m ridges there even
  // though the centreline was flawless. A trimesh matches the visual surface
  // exactly, so there is nothing to protrude and no seam to catch.
  const body = o.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  o.world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(pos), new Uint32Array(idx)).setFriction(0.9),
    body,
  );
  void m; void q;
}

function buildRails(o: SkyLoopOpts, s: Sample[], skip: (i: number) => boolean) {
  const n = s.length;
  const body = o.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const right = new THREE.Vector3();
  const railGeo: THREE.BufferGeometry[] = [];

  for (let i = 0; i < n; i++) {
    if (skip(i)) continue;
    const a = s[i], b = s[(i + 1) % n];
    const len = a.pos.distanceTo(b.pos) + SEG_OVERLAP;
    right.crossVectors(a.up, a.fwd).normalize();
    basisOf(a, m, q);
    for (const side of [-1, 1]) {
      const mid = new THREE.Vector3().addVectors(a.pos, b.pos).multiplyScalar(0.5)
        .addScaledVector(right, side * DECK_HALF_W)
        .addScaledVector(a.up, RAIL_H / 2);
      o.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.22, RAIL_H / 2, len / 2)
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setFriction(0.06),
        body,
      );
      const g = new THREE.BoxGeometry(0.44, RAIL_H, len);
      g.applyQuaternion(q);
      g.translate(mid.x, mid.y, mid.z);
      railGeo.push(g);
    }
  }
  // one merged mesh rather than hundreds of boxes
  o.scene.add(new THREE.Mesh(mergeGeometries(railGeo), o.trimMaterial));
}

/**
 * Break-out kickers: a short lip angled up and outward at each rail gap. Hit it
 * with speed and you leave the track entirely and land on the street below —
 * which is the whole point of the gaps.
 */
function buildKickers(o: SkyLoopOpts, s: Sample[], gaps: number[]) {
  const n = s.length;
  const body = o.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const allPos: number[] = [];
  const allIdx: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const right = new THREE.Vector3();

  const LEN = 13;        // long and shallow: ~5 degrees at the leading edge
  const HALF_W = 3.4;
  const RISE = 1.15;     // outer lip height at the far end
  const INNER_RISE = 0.5;

  for (const g of gaps) {
    const sm = s[g % n];
    right.crossVectors(sm.up, sm.fwd).normalize();
    const outward = right.dot(sm.pos) >= 0 ? 1 : -1;
    basisOf(sm, m, q);

    // Build the wedge directly in world space with its LEADING EDGE FLUSH to
    // the deck. Earlier versions were a raised slab that had to be pitched and
    // buried to avoid presenting a blunt face, and they still stopped cars dead
    // — a wedge with a zero-height leading edge cannot be hit side-on at all.
    const base = sm.pos.clone().addScaledVector(right, outward * HALF_W * 0.45);
    const fwd = sm.fwd.clone();
    const side = right.clone().multiplyScalar(outward);
    const up = sm.up.clone();
    const vert = (along: number, across: number, rise: number) =>
      base.clone()
        .addScaledVector(fwd, along)
        .addScaledVector(side, across)
        .addScaledVector(up, rise + 0.04);

    // 0,1 = flush leading edge; 2,3 = raised trailing edge (outer side higher)
    const vs = [
      vert(0, -HALF_W, 0), vert(0, HALF_W, 0),
      vert(LEN, -HALF_W, INNER_RISE), vert(LEN, HALF_W, RISE),
      // thin skirt underneath so the collider is a closed volume
      vert(LEN, -HALF_W, INNER_RISE - 0.25), vert(LEN, HALF_W, RISE - 0.25),
    ];
    const o0 = allPos.length / 3;
    for (const v of vs) allPos.push(v.x, v.y, v.z);
    allIdx.push(
      o0 + 0, o0 + 1, o0 + 3, o0 + 0, o0 + 3, o0 + 2,   // ramp surface
      o0 + 4, o0 + 5, o0 + 1, o0 + 4, o0 + 1, o0 + 0,   // underside
      o0 + 2, o0 + 3, o0 + 5, o0 + 2, o0 + 5, o0 + 4,   // back face
    );
  }

  if (!allPos.length) return;
  o.world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(allPos), new Uint32Array(allIdx))
      .setFriction(0.9),
    body,
  );
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3));
  geo.setIndex(allIdx);
  geo.computeVertexNormals();
  o.scene.add(new THREE.Mesh(geo, o.neonMaterial));
}

/** support legs, dropped from the deck's OUTER edge into the verge */
function buildPylons(o: SkyLoopOpts, s: Sample[]) {
  const n = s.length;
  const body = o.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const geos: THREE.BufferGeometry[] = [];
  const right = new THREE.Vector3();
  for (let i = 0; i < n; i += PYLON_EVERY) {
    const sm = s[i];
    right.crossVectors(sm.up, sm.fwd).normalize();
    // outward is whichever side points away from the arena centre
    const outward = right.dot(sm.pos) >= 0 ? 1 : -1;
    const foot = new THREE.Vector3().copy(sm.pos)
      .addScaledVector(right, outward * (DECK_HALF_W - 0.9));
    // Stop short of the deck. A leg run all the way to the surface pokes up
    // THROUGH it at the outer edge and becomes an invisible bollard on the
    // racing line — it stopped a 37 m/s test run dead.
    const h = Math.max(1, foot.y - DECK_THICK * 2 - 0.9);
    o.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.75, h / 2, 0.75).setTranslation(foot.x, h / 2, foot.z),
      body,
    );
    const g = new THREE.BoxGeometry(1.5, h, 1.5);
    g.translate(foot.x, h / 2, foot.z);
    geos.push(g);
  }
  const mesh = new THREE.Mesh(mergeGeometries(geos), o.trimMaterial);
  mesh.castShadow = true;
  o.scene.add(mesh);
}

/** a straight climb from street level up to the deck */
function buildOnRamp(o: SkyLoopOpts, s: Sample[], at: number) {
  const n = s.length;
  const sm = s[at % n];
  const right = new THREE.Vector3().crossVectors(sm.up, sm.fwd).normalize();
  const inward = right.dot(sm.pos) >= 0 ? -1 : 1;
  // Drop the top end UNDER the deck and lengthen the run. A ramp whose top
  // meets the deck surface exactly leaves a lip at the junction — probing the
  // inner lanes found 0.6-0.86m steps there, which is enough to clip a car at
  // speed. Sliding it below means the deck always wins the overlap and the
  // ramp simply disappears beneath it.
  const top = new THREE.Vector3().copy(sm.pos).addScaledVector(sm.up, -0.55);
  const run = sm.pos.y * 4.6;                 // ~12 degree climb
  const foot = new THREE.Vector3().copy(top).addScaledVector(right, inward * run).setY(0);

  const dir = new THREE.Vector3().subVectors(top, foot);
  const len = dir.length();
  dir.normalize();
  const mid = new THREE.Vector3().addVectors(top, foot).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);

  const body = o.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  o.world.createCollider(
    RAPIER.ColliderDesc.cuboid(DECK_HALF_W * 0.8, 0.3, len / 2)
      .setTranslation(mid.x, mid.y, mid.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setFriction(0.9),
    body,
  );
  const geo = new THREE.BoxGeometry(DECK_HALF_W * 1.6, 0.5, len);
  geo.applyQuaternion(q);
  geo.translate(mid.x, mid.y, mid.z);
  const mesh = new THREE.Mesh(geo, o.deckMaterial);
  mesh.receiveShadow = true;
  o.scene.add(mesh);
}

/** merge a list of geometries without pulling in BufferGeometryUtils */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (!list.length) return new THREE.BufferGeometry();
  let vCount = 0, iCount = 0;
  for (const g of list) {
    vCount += g.getAttribute('position').count;
    iCount += g.getIndex() ? g.getIndex()!.count : 0;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const nAttr = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    pos.set(p.array as Float32Array, vo * 3);
    if (nAttr) nrm.set(nAttr.array as Float32Array, vo * 3);
    const gi = g.getIndex();
    if (gi) {
      for (let k = 0; k < gi.count; k++) idx[io + k] = gi.getX(k) + vo;
      io += gi.count;
    }
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
