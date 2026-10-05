import * as THREE from 'three';
import type { Vehicle } from './vehicle';
import { buildRocket } from '../render/rocket';
import { buildMine } from '../render/mine';
import { buildNuke } from '../render/nuke';
import { MAX_MISSILES, MAX_MINES, MAX_NUKES } from './specs';

export type PickupType = 'health' | 'missiles' | 'turbo' | 'shield' | 'overdrive' | 'mines' | 'special' | 'nuke';

const RESPAWN_TIME: Record<PickupType, number> = {
  health: 11,
  missiles: 11,
  turbo: 9,
  shield: 18,
  overdrive: 22,
  mines: 14,
  special: 16,
  nuke: 40,
};

/** canonical order — index is what goes over the wire for guest sync */
// APPEND new types — the index is the wire format, so reordering desyncs guests
export const PICKUP_TYPE_ORDER: PickupType[] = ['health', 'missiles', 'turbo', 'shield', 'overdrive', 'mines', 'special', 'nuke'];

/** respawn shuffle pool: sockets cycle types so locations can't be farmed by
 *  memory. Weighted — offense stays most common; overdrive never shuffles in
 *  (it keeps its dedicated roaming socket). */
const SHUFFLE_POOL: [PickupType, number][] = [
  ['missiles', 28], ['health', 22], ['turbo', 16], ['mines', 14], ['special', 12], ['shield', 8],
];
function rollShuffleType(): PickupType {
  let total = 0;
  for (const [, w] of SHUFFLE_POOL) total += w;
  let r = Math.random() * total;
  for (const [t, w] of SHUFFLE_POOL) { r -= w; if (r <= 0) return t; }
  return 'missiles';
}

interface Pickup {
  type: PickupType;
  pos: THREE.Vector3;
  /** roaming pickups relocate among these sockets on each respawn */
  alts?: THREE.Vector3[];
  mesh: THREE.Group;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  /** light shaft + halo + floor glow that make the socket visible at range */
  beacon: { group: THREE.Group; shaft: THREE.Mesh; halo: THREE.Mesh; glow: THREE.Mesh };
  /** only the nuke socket gets one — the map-wide "it is over there" marker */
  bolt?: { group: THREE.Group; mat: THREE.ShaderMaterial };
  active: boolean;
  timer: number;
  /** >0 while playing the acquire implosion */
  shrinkT: number;
  /** >0 while playing the respawn pop-in */
  popT: number;
}

/** a pickup will not respawn while a living vehicle camps within this radius */
const HOLD_RADIUS = 12;

// design system palette — see docs/DESIGN-SYSTEM.md
export const PICKUP_COLORS: Record<PickupType, number> = {
  health: 0x2ee86c,    // Vital Green
  missiles: 0xff6a1a,  // Hunter Orange
  turbo: 0xffe44d,     // Bolt Yellow
  shield: 0x5c7cff,    // Aegis Indigo
  overdrive: 0xff44dd, // reserved magenta
  mines: 0x9a9aa6,     // Graphite trim (body is dark, red dot is the signal)
  special: 0xc94dff,   // Special violet — matches the special-meter bar
  nuke: 0xaaff00,      // Hazard Lime — the only lime beacon on the map
};
const COLORS = PICKUP_COLORS;

/**
 * The shared furniture every socket gets: a light shaft you can see across the
 * arena, a floor glow, and a halo that counter-rotates against the icon.
 *
 * The icons were already readable up close but a socket was invisible until you
 * were nearly on top of it, so pickups were something you stumbled into rather
 * than something you drove at. The beacon is what makes them a destination; the
 * icon still does the job of saying WHICH pickup it is.
 */

/**
 * The nuke's signal: a lightning bolt tall enough to see over the buildings,
 * from anywhere on the map.
 *
 * There is exactly ONE nuke and it roams between three sockets, so without a
 * long-range marker finding it means memorising three coordinates. This is the
 * Black Ops mystery-box idea: you do not hunt the item, you look up, find the
 * bolt, and drive at it — and because the bolt moves with the socket, "where is
 * it right now" stays a live question every respawn.
 *
 * Deliberately NOT the normal beacon scaled up. A 5m shaft is a "something is
 * here" marker read from the street; this is a landmark read from across the
 * arena, so it is a hard-edged zigzag (a soft column at that height just looks
 * like fog) with a charge pulse travelling up it.
 */
const BOLT_H = 72;      // clears the buildings AND the skyline silhouette

function buildBolt(color: number): { group: THREE.Group; mat: THREE.ShaderMaterial } {
  const group = new THREE.Group();

  // zigzag ribbon: a vertical strip of quads kinked left/right as it climbs
  const segs = 9, halfW = 2.8;
  const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
  let x = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * BOLT_H;
    if (i > 0) x += (i % 2 ? 1 : -1) * (3.4 - t * 2.0);
    // taper with height so it reads as a bolt rather than a wall
    // only a gentle taper: shrinking it toward the top is what made the bolt
    // fade to nothing at map range, which is the exact distance it exists for
    const w = halfW * (1 - t * 0.3);
    verts.push(x - w, y, 0, x + w, y, 0);
    uvs.push(0, t, 1, t);
    if (i < segs) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uFade: { value: 1 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uFade;
      varying vec2 vUv;
      void main() {
        // bright core down the middle of the strip, fading to the edges
        float core = 1.0 - abs(vUv.x - 0.5) * 2.0;
        core = pow(core, 1.6);
        // thins out with height, so the bolt does not end in a hard line
        float rise = mix(1.0, pow(1.0 - vUv.y, 0.9), 0.55);
        // charge pulse running upward
        float pulse = smoothstep(0.16, 0.0, abs(fract(uTime * 0.42) - vUv.y));
        float a = core * rise * (0.85 + pulse * 1.5) * uFade;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), pulse * 0.6), a);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  // two crossed copies so the bolt has no viewing angle where it vanishes
  for (const rot of [0, Math.PI / 2]) {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.y = rot;
    m.renderOrder = 7;
    group.add(m);
  }
  return { group, mat };
}

function buildBeacon(color: number): { group: THREE.Group; shaft: THREE.Mesh; halo: THREE.Mesh; glow: THREE.Mesh } {
  const group = new THREE.Group();
  const add = (o: THREE.Object3D) => { group.add(o); return o; };

  // tapered shaft, brightest at the base, fading out as it rises
  const shaftGeo = new THREE.CylinderGeometry(0.95, 0.34, 5.0, 16, 1, true);
  const pos = shaftGeo.getAttribute('position');
  const alpha = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + 2.5) / 5.0;         // 0 at the foot, 1 at the top
    alpha[i] = Math.pow(1 - t, 1.7);
  }
  shaftGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const shaft = new THREE.Mesh(shaftGeo, new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uFade: { value: 1 } },
    vertexShader: `
      attribute float aAlpha;
      varying float vA;
      void main() { vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform vec3 uColor; uniform float uFade;
      varying float vA;
      void main() { gl_FragColor = vec4(uColor, vA * 0.5 * uFade); }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  }));
  shaft.position.y = 1.9;
  shaft.renderOrder = 6;
  add(shaft);

  // soft pool on the ground under it
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -0.72;
  glow.renderOrder = 5;
  add(glow);

  // halo that counter-rotates against the icon
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.95, 0.045, 8, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  halo.rotation.x = Math.PI / 2;
  add(halo);

  return { group, shaft, halo, glow };
}

function buildPickupMesh(type: PickupType): THREE.Group {
  const g = new THREE.Group();
  const color = COLORS[type];
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3,
  });
  let core: THREE.Object3D;
  if (type === 'health') {
    core = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.3), mat);
    (core as THREE.Mesh).add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 0.3), mat));
  } else if (type === 'missiles') {
    // the shared rocket — identical to the one on your rack and in flight
    const rocket = buildRocket({ plume: true });
    rocket.rotation.z = -0.55;   // dynamic launch-angle pose (the spin sells it)
    core = rocket;
  } else if (type === 'turbo') {
    // thunderbolt
    const bolt = new THREE.Shape();
    bolt.moveTo(0.05, 0.55);
    bolt.lineTo(-0.32, -0.02);
    bolt.lineTo(-0.05, -0.02);
    bolt.lineTo(-0.18, -0.55);
    bolt.lineTo(0.3, 0.08);
    bolt.lineTo(0.02, 0.08);
    bolt.closePath();
    core = new THREE.Mesh(
      new THREE.ExtrudeGeometry(bolt, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1 }),
      mat,
    );
    core.position.y = 0.1;
  } else if (type === 'shield') {
    // unmistakable: a glowing bubble, same look as the on-car shield effect
    core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), mat);
    const bubble = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 16, 12),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    core.add(bubble);
  } else if (type === 'overdrive') {
    core = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 4), mat);
    const inv = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 4), mat);
    inv.rotation.x = Math.PI;
    inv.position.y = -0.55;
    core.add(inv);
    core.position.y = 0.28;
  } else if (type === 'special') {
    // special energy cell: violet octahedron in a spinning halo — matches the
    // special-meter magenta so the association is instant
    core = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0), mat);
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.05, 8, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    halo.rotation.x = Math.PI / 2.6;
    core.add(halo);
  } else if (type === 'nuke') {
    // the shared warhead, nose-up, leaning back on its fins the way it sits in
    // a cradle — identical to the one on your deck and the one in flight
    core = buildNuke();
    core.rotation.z = -0.3;
    core.position.y = 0.1;
  } else {
    // the shared mine — identical to the clamps on your bumper and to one armed
    // in the road
    core = buildMine().group;
  }
  g.add(core);
  return g;
}

export class PickupManager {
  private pickups: Pickup[] = [];
  private time = 0;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene, points: { pos: THREE.Vector3; type: PickupType; alts?: THREE.Vector3[] }[]) {
    this.scene = scene;
    for (const p of points) {
      const mesh = buildPickupMesh(p.type);
      mesh.position.copy(p.pos);
      scene.add(mesh);
      // socket ring stays on the ground even while the pickup is collected —
      // it teaches spawn locations and telegraphs the respawn
      const ringMat = new THREE.MeshBasicMaterial({
        color: PICKUP_COLORS[p.type], transparent: true, opacity: 0.4, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.1, 24), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.pos.x, p.pos.y - 0.75, p.pos.z);
      scene.add(ring);
      const beacon = buildBeacon(PICKUP_COLORS[p.type]);
      beacon.group.position.copy(p.pos);
      scene.add(beacon.group);
      let bolt: Pickup['bolt'];
      if (p.type === 'nuke') {
        bolt = buildBolt(PICKUP_COLORS.nuke);
        bolt.group.position.copy(p.pos);
        scene.add(bolt.group);
      }
      this.pickups.push({
        type: p.type, pos: p.pos.clone(), alts: p.alts,
        mesh, ring, ringMat, beacon, bolt, active: true, timer: 0, shrinkT: 0, popT: 0,
      });
    }
  }

  update(dt: number, vehicles: Vehicle[], onCollect: (v: Vehicle, type: PickupType) => void) {
    this.time += dt;
    for (const p of this.pickups) {
      // acquire implosion (90ms scale-down)
      if (p.shrinkT > 0) {
        p.shrinkT -= dt;
        // flare UP and out, then snap away — a pure implosion read as the pickup
        // being deleted rather than consumed
        const t = 1 - p.shrinkT / 0.16;
        p.mesh.scale.setScalar(Math.max(0.01, (1 + t * 1.4) * (1 - t * t)));
        p.mesh.rotation.y += dt * 14;
        p.mesh.position.y = p.pos.y + t * 1.1;
        if (p.shrinkT <= 0) {
          p.mesh.visible = false;
          p.mesh.scale.setScalar(1);
          p.mesh.position.y = p.pos.y;
        }
      }
      if (!p.active) {
        p.timer -= dt;
        p.beacon.group.visible = false;
        // the bolt means "there is a nuke here right now". Leaving it up while
        // the socket is empty sends people across the map for nothing — and
        // since the socket moves on every respawn it would be pointing at the
        // wrong place anyway.
        if (p.bolt) p.bolt.group.visible = false;
        // socket ring brightens as respawn approaches
        p.ringMat.opacity = 0.08 + 0.25 * (1 - Math.min(1, p.timer / RESPAWN_TIME[p.type]));
        if (p.timer <= 0) {
          // anti-spawn-camping: hold while anyone lingers on the socket
          let camped = false;
          for (const v of vehicles) {
            if (v.alive && v.position.distanceToSquared(p.pos) < HOLD_RADIUS * HOLD_RADIUS) { camped = true; break; }
          }
          if (camped) continue;
          // roaming pickups relocate on each respawn
          if (p.alts && p.alts.length > 1) {
            // pick from the sockets it is NOT currently on, so it always moves —
            // a uniform pick repeats the same spot 1 time in 3 and the item stops
            // feeling like it roams at all
            const away = p.alts.filter((a) => a.distanceToSquared(p.pos) > 1);
            const pool = away.length ? away : p.alts;
            const next = pool[Math.floor(Math.random() * pool.length)];
            p.pos.copy(next);
            p.mesh.position.copy(next);
            p.ring.position.set(next.x, next.y - 0.75, next.z);
            p.beacon.group.position.copy(next);
            p.bolt?.group.position.copy(next);
          }
          // TYPE SHUFFLE: sockets cycle through the weighted pool on respawn
          // so weapon locations can't be farmed by memory (overdrive keeps
          // its dedicated roaming socket)
          // the two dedicated sockets keep their type forever — rerolling one
          // would delete that weapon from the match permanently
          if (p.type !== 'overdrive' && p.type !== 'nuke') this.applyType(p, rollShuffleType());
          p.active = true;
          p.mesh.visible = true;
          p.popT = 0.15;
          p.ringMat.opacity = 0.4;
          p.beacon.group.visible = true;
          // light the bolt on the same frame the socket restocks — the active
          // path below does not run until the next tick, which left a one-frame
          // hole where the nuke was there but unmarked
          if (p.bolt) p.bolt.group.visible = true;
        }
        continue;
      }
      // respawn pop-in
      if (p.popT > 0) {
        p.popT -= dt;
        p.mesh.scale.setScalar(Math.min(1, 1 - p.popT / 0.15));
      }
      p.mesh.rotation.y += dt * 2.2;
      const bob = Math.sin(this.time * 2.4 + p.pos.x) * 0.15;
      p.mesh.position.y = p.pos.y + bob;
      // the halo counter-rotates and breathes against the icon's spin, which is
      // what stops the socket reading as a static prop
      const b = p.beacon;
      b.group.visible = true;
      b.halo.rotation.z -= dt * 1.4;
      b.halo.position.y = bob * 0.6;
      b.halo.scale.setScalar(1 + Math.sin(this.time * 3.1 + p.pos.z) * 0.06);
      const pulse = 0.82 + Math.sin(this.time * 2.0 + p.pos.x) * 0.18;
      (b.shaft.material as THREE.ShaderMaterial).uniforms.uFade.value = pulse;
      (b.glow.material as THREE.MeshBasicMaterial).opacity = 0.16 + pulse * 0.1;
      if (p.bolt) {
        p.bolt.group.visible = true;
        p.bolt.mat.uniforms.uTime.value = this.time;
        // crackle: mostly bright with occasional dropouts, so it flickers like
        // a bolt instead of breathing like the ordinary beacons
        const flick = 0.8 + Math.sin(this.time * 17.3) * 0.12 + Math.sin(this.time * 5.1) * 0.08;
        p.bolt.mat.uniforms.uFade.value = flick;
        p.bolt.group.rotation.y += dt * 0.25;
      }

      for (const v of vehicles) {
        if (!v.alive) continue;
        if (v.position.distanceToSquared(p.mesh.position) < 2.4 * 2.4) {
          // don't waste full pickups — a full rack leaves the missiles for others
          if (p.type === 'health' && v.health >= v.spec.maxHealth) continue;
          if (p.type === 'missiles' && v.missiles >= MAX_MISSILES) continue;
          if (p.type === 'turbo' && v.turboMeter >= v.spec.turboMax - 0.1) continue;
          if (p.type === 'mines' && v.minesAmmo >= MAX_MINES) continue;
          if (p.type === 'special' && v.specialEnergy >= 1) continue;
          if (p.type === 'nuke' && v.nukes >= MAX_NUKES) continue;
          p.active = false;
          // kill the bolt on the same frame it is taken, not on the next tick
          if (p.bolt) p.bolt.group.visible = false;
          // ±30% jitter so respawn timers can't be memorized and camped
          p.timer = RESPAWN_TIME[p.type] * (0.7 + Math.random() * 0.6);
          p.shrinkT = 0.16; // flare-and-go, see the branch above
          onCollect(v, p.type);
          break;
        }
      }
    }
  }

  /** swap a socket's type: rebuild the icon mesh + retint the socket ring */
  private applyType(p: Pickup, type: PickupType): void {
    if (p.type === type) return;
    const wasVisible = p.mesh.visible;
    this.scene.remove(p.mesh);
    p.type = type;
    p.mesh = buildPickupMesh(type);
    p.mesh.position.copy(p.pos);
    p.mesh.visible = wasVisible;
    this.scene.add(p.mesh);
    p.ringMat.color.setHex(PICKUP_COLORS[type]);
    const c = PICKUP_COLORS[type];
    (p.beacon.shaft.material as THREE.ShaderMaterial).uniforms.uColor.value.setHex(c);
    (p.beacon.halo.material as THREE.MeshBasicMaterial).color.setHex(c);
    (p.beacon.glow.material as THREE.MeshBasicMaterial).color.setHex(c);
  }

  /** guest sync: host streams each socket's current type index */
  setTypeByIndex(i: number, typeIdx: number): void {
    const p = this.pickups[i];
    const t = PICKUP_TYPE_ORDER[typeIdx];
    if (p && t) this.applyType(p, t);
  }

  nearestActive(type: PickupType, from: THREE.Vector3): THREE.Vector3 | null {
    let best: Pickup | null = null;
    let bestD = Infinity;
    for (const p of this.pickups) {
      if (!p.active || p.type !== type) continue;
      const d = p.pos.distanceToSquared(from);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? best.pos.clone() : null;
  }
}
